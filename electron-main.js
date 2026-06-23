// ─── Lager — Electron main process ───────────────────────────────────────────
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const path = require("path");
const http = require("http");
const os   = require("os");

const PORT    = 3000;
const TIMEOUT = 800;

let mainWindow = null;
let tray       = null;
let serverUrl  = null;

// ─── Kontrollera om en specifik host:port svarar som Lager-server ─────────────
function probeLagerServer(host, port) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: "/api/network", timeout: TIMEOUT }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          // Bekräfta att det faktiskt är vår server (har ips-fältet)
          if (json && Array.isArray(json.ips)) resolve(true);
          else resolve(false);
        } catch { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ─── Scanna nätverket efter en Lager-server ───────────────────────────────────
// Hämtar alla lokala /24-subnät och testar alla 254 adresser parallellt.
// På ett typiskt hemmanätverk tar detta 1–3 sekunder.
async function scanNetwork(port) {
  const interfaces = os.networkInterfaces();
  const subnets = new Set();

  Object.values(interfaces).flat().forEach(iface => {
    if (iface.family === "IPv4" && !iface.internal) {
      const parts = iface.address.split(".");
      subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
    }
  });

  if (subnets.size === 0) return null;

  for (const subnet of subnets) {
    const checks = [];
    for (let i = 1; i <= 254; i++) {
      checks.push({ host: `${subnet}.${i}`, promise: probeLagerServer(`${subnet}.${i}`, port) });
    }
    const results = await Promise.all(checks.map(c => c.promise));
    for (let i = 0; i < results.length; i++) {
      if (results[i]) {
        const found = checks[i].host;
        console.log(`[discovery] Lager-server hittad på ${found}:${port}`);
        return found;
      }
    }
  }
  return null;
}

// ─── Hitta servern (huvud-logik) ──────────────────────────────────────────────
async function findServer() {
  console.log("[discovery] Kollar localhost...");

  // 1. Finns det redan en lokal server?
  const localOk = await probeLagerServer("127.0.0.1", PORT);
  if (localOk) {
    console.log("[discovery] Lokal server hittad.");
    return `http://127.0.0.1:${PORT}`;
  }

  // 2. Scanna nätverket (t.ex. Raspberry Pi)
  console.log("[discovery] Ingen lokal server — scannar nätverket...");
  const remoteHost = await scanNetwork(PORT);
  if (remoteHost) {
    return `http://${remoteHost}:${PORT}`;
  }

  // 3. Ingen server hittad — visa tydligt felmeddelande
  console.log("[discovery] Ingen server hittades.");
  return null;
}

// ─── Skapa fönstret ───────────────────────────────────────────────────────────
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 600,
    title: "Lager",
    backgroundColor: "#F5F5F7",
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    show: false,
  });

  mainWindow.loadURL(url);
  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (!u.startsWith(url)) { shell.openExternal(u); return { action: "deny" }; }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ─── System tray ─────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAQ0lEQVQ4jWNgGAVkgv8MGBhYGBgY/hMh6z8IA6MBgxEGBgaG/5iMpJoGsmE0YDBiNGCwYjRgsGI0YLBiNBgFpAIAWNACIb2Pz0QAAAAASUVORK5CYII="
  );
  tray = new Tray(icon);
  tray.setToolTip(`Lager${serverUrl ? ` — ${serverUrl}` : ""}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: serverUrl ? `Server: ${serverUrl}` : "Ansluter...", enabled: false },
    { type: "separator" },
    { label: "Öppna Lager", click: () => { if (mainWindow) mainWindow.show(); else if (serverUrl) createWindow(serverUrl); } },
    { label: "Avsluta", click: () => app.quit() },
  ]));
  tray.on("double-click", () => { if (mainWindow) mainWindow.show(); else if (serverUrl) createWindow(serverUrl); });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createTray();

  serverUrl = await findServer();

  if (!serverUrl) {
    dialog.showErrorBox(
      "Lager — Ingen server hittad",
      "Kunde inte hitta Lager-servern på nätverket.\n\n" +
      "Kontrollera att:\n" +
      "• Raspberry Pi:n eller serverdatorn är påslagen\n" +
      "• Du är ansluten till samma wifi/nätverk\n" +
      "• Servern körs (pm2 status på Pi:n)\n\n" +
      "Starta om Lager när servern är igång."
    );
    app.quit();
    return;
  }

  console.log(`[discovery] Ansluter till: ${serverUrl}`);

  // Uppdatera tray-tooltip med rätt URL
  tray.setToolTip(`Lager — ${serverUrl}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Server: ${serverUrl}`, enabled: false },
    { type: "separator" },
    { label: "Öppna Lager", click: () => { if (mainWindow) mainWindow.show(); else createWindow(serverUrl); } },
    { label: "Avsluta", click: () => app.quit() },
  ]));

  createWindow(serverUrl);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverUrl) createWindow(serverUrl);
});
