const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors    = require("cors");
const path    = require("path");
const os      = require("os");
const fs      = require("fs");

const PORT = process.env.PORT || 3000;

// Förhindra att servern kraschar av oväntade fel (t.ex. mDNS-konflikter)
process.on("uncaughtException", (err) => {
  console.error("[Ohanterat fel — servern fortsätter]:", err.message);
  throttledNotify("serverError", "Serverfel upptäckt",
    `<p>Ett ohanterat fel inträffade på servern:</p><p style="font-family:monospace;background:#f4f5f7;padding:10px;border-radius:6px">${err.message}</p><p>Servern fortsatte köra, men det kan vara värt att kontrollera loggen (<code>pm2 logs lager</code>).</p>`);
});
process.on("unhandledRejection", (err) => {
  console.error("[Ohanterad rejection — servern fortsätter]:", err?.message || err);
  throttledNotify("serverError", "Serverfel upptäckt",
    `<p>Ett ohanterat asynkront fel inträffade på servern:</p><p style="font-family:monospace;background:#f4f5f7;padding:10px;border-radius:6px">${err?.message || err}</p><p>Servern fortsatte köra, men det kan vara värt att kontrollera loggen (<code>pm2 logs lager</code>).</p>`);
});

// ── mDNS — registrera lager.local på nätverket ────────────────────────────────
try {
  const { Bonjour } = require("bonjour-service");
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: "lager",
    type: "http",
    port: Number(PORT),
    host: "lager.local",
    txt: { path: "/" }
  });
  // Fånga asynkrona fel (t.ex. "name already in use") så servern inte kraschar
  if (service && service.on) {
    service.on("error", (err) => {
      console.log("  mDNS:     Bonjour-varning -", err.message);
    });
  }
} catch (e) {
  console.log("  mDNS:     Bonjour ej tillgängligt -", e.message);
}

const app  = express();
const DB_PATH = path.join(__dirname, "lager.db");

// ── Databas ───────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // WAL-läge — bättre samtidighet, mindre risk för "database is locked"
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");

  db.run(`CREATE TABLE IF NOT EXISTS store (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  // Separat tabell för bilder — en rad per artikel-id.
  // data = JSON-array av base64-bilder. updated_at för cache-busting.
  db.run(`CREATE TABLE IF NOT EXISTS images (
    item_id TEXT PRIMARY KEY,
    data TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  db.run("ALTER TABLE images ADD COLUMN updated_at INTEGER DEFAULT 0", () => {});
  db.run(`CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT,
    key TEXT,
    ts INTEGER DEFAULT (strftime('%s','now'))
  )`);
});

function dbGet(key) {
  return new Promise((resolve, reject) => {
    db.get("SELECT value FROM store WHERE key=?", [key], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });
}
function dbSet(key, value) {
  return new Promise((resolve, reject) => {
    db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES(?,?,strftime('%s','now'))", [key, value], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}
function dbDel(key) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM store WHERE key=?", [key], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ── E-postnotiser (Gmail via app-lösenord) ────────────────────────────────────
const nodemailer = require("nodemailer");

async function getEmailConfig() {
  const row = await dbGet("ow:emailconfig");
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function makeTransport(cfg) {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: cfg.fromEmail, pass: cfg.appPassword },
  });
}

// Skickar ett mejl om notistypen är aktiverad i inställningarna. Fel loggas men kraschar aldrig servern.
async function sendNotification(type, subject, bodyHtml) {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !cfg.enabled || !cfg.fromEmail || !cfg.appPassword || !cfg.adminEmail) return;
    if (cfg.notifTypes && cfg.notifTypes[type] === false) return; // explicit avstängd
    const transport = makeTransport(cfg);
    await transport.sendMail({
      from: `"Lager" <${cfg.fromEmail}>`,
      to: cfg.adminEmail,
      subject: `[Lager] ${subject}`,
      html: `<div style="font-family:sans-serif;font-size:14px;color:#141820">${bodyHtml}
        <p style="color:#94a3b8;font-size:11px;margin-top:20px">Skickat automatiskt av Lager-systemet · ${new Date().toLocaleString("sv-SE")}</p></div>`,
    });
    console.log(`[email] Skickade notis: ${type}`);
  } catch (e) {
    console.error(`[email] Kunde inte skicka notis (${type}):`, e.message);
  }
}

// Enkel spärr så samma feltyp inte spammar admin — max 1 mejl per typ var 30:e minut
const lastNotifSent = {};
function throttledNotify(type, subject, bodyHtml, cooldownMinutes = 30) {
  const now = Date.now();
  const last = lastNotifSent[type] || 0;
  if (now - last < cooldownMinutes * 60 * 1000) return;
  lastNotifSent[type] = now;
  sendNotification(type, subject, bodyHtml);
}


const stats = { started: Date.now(), requests: 0, errors: 0 };

// ── Enhetsspårning (i minnet) ─────────────────────────────────────────────────
// Spårar varje aktiv enhet per IP: senaste aktivitet, antal anrop, inloggad användare.
const devices = new Map(); // ip -> { ip, firstSeen, lastSeen, count, user, userAgent }
// Live-flöde av senaste händelser (köp, ändringar m.m.) som frontend rapporterar.
const liveFeed = []; // { type, description, user, ip, ts }
const MAX_FEED = 60;

function clientIp(req) {
  let ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString();
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  return ip.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));

// Spåra alla API-anrop (men inte statiska filer eller admin-pollning)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    const ip = clientIp(req);
    const now = Date.now();
    let d = devices.get(ip);
    if (!d) { d = { ip, firstSeen: now, lastSeen: now, count: 0, user: null, userAgent: req.headers["user-agent"] || "" }; devices.set(ip, d); }
    d.lastSeen = now;
    d.count++;
    // Användarnamn skickas med som header från frontend om inloggad
    const u = req.headers["x-lager-user"];
    if (u) d.user = decodeURIComponent(u);
  }
  next();
});

app.use(express.static(path.join(__dirname, "dist")));

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/network", (req, res) => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === "IPv4" && !i.internal)
    .map(i => i.address);
  res.json({ ips, port: PORT });
});

// ── DELTA-SYNK — måste ligga FÖRE /api/:key så den inte fångas av den ─────────
// Returnerar bara artiklar ändrade efter ?since=<tidsstämpel i ms>.
app.get("/api/delta", async (req, res) => {
  try {
    stats.requests++;
    const since = Number(req.query.since) || 0;
    const row = await dbGet("ow:items");
    const items = row ? JSON.parse(row.value) : [];
    const changed = items.filter(i => (i.updatedAt || 0) > since);
    const allIds = items.map(i => i.id);
    const maxUpdatedAt = items.reduce((a, i) => Math.max(a, i.updatedAt || 0), 0);
    res.json({ changed, allIds, maxUpdatedAt, total: items.length });
  } catch (e) {
    stats.errors++;
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/:key", async (req, res) => {
  try {
    stats.requests++;
    const r = await dbGet(req.params.key);
    res.json(r);
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

app.post("/api/:key", async (req, res) => {
  try {
    stats.requests++;
    if (req.body.value === undefined) {
      return res.status(400).json({ error: "value saknas i body" });
    }
    // SKYDD: vägra skriva över ow:items med tom lista om det redan finns data
    if (req.params.key === "ow:items" && req.body.value === "[]") {
      const existing = await dbGet("ow:items");
      if (existing && existing.value && existing.value !== "[]" && existing.value.length > 10) {
        return res.status(400).json({ error: "Vägrar tömma befintligt lager" });
      }
    }
    await dbSet(req.params.key, req.body.value);
    res.json({ ok: true });
  } catch (e) {
    stats.errors++;
    console.error(`[FEL] POST /api/${req.params.key}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/:key", async (req, res) => {
  try {
    await dbDel(req.params.key);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Item-level operations (undviker att skriva över andras ändringar) ─────────
// Uppdatera/lägg till EN artikel
app.post("/api/item/upsert", async (req, res) => {
  try {
    stats.requests++;
    const item = req.body.item;
    if (!item || !item.id) return res.status(400).json({ error: "item.id krävs" });
    const row = await dbGet("ow:items");
    const items = row ? JSON.parse(row.value) : [];
    const idx = items.findIndex(i => i.id === item.id);
    if (idx >= 0) items[idx] = item;
    else items.push(item);
    await dbSet("ow:items", JSON.stringify(items));
    res.json({ ok: true, items });
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

// Ta bort EN artikel
app.post("/api/item/delete", async (req, res) => {
  try {
    stats.requests++;
    const id = req.body.id;
    const row = await dbGet("ow:items");
    const items = row ? JSON.parse(row.value) : [];
    const filtered = items.filter(i => i.id !== id);
    await dbSet("ow:items", JSON.stringify(filtered));
    // Ta bort eventuella bilder också
    db.run("DELETE FROM images WHERE item_id=?", [id]);
    res.json({ ok: true, items: filtered });
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

// ── REDIGERINGSLÅS ────────────────────────────────────────────────────────────
// Hålls i minnet (snabbt, ingen databas-overhead). Map: itemId → {user, action, ts}
// action: "edit" (redigerar) | "cart" (ligger i kassan)
const LOCK_TIMEOUT_MS = 20 * 60 * 1000; // 20 minuter
const locks = new Map();
// Vem väntar på en del: itemId → { user, ts } (för att meddela första användaren)
const waiting = new Map();

function lockInfo(itemId) {
  const lock = locks.get(itemId);
  if (!lock) return null;
  const age = Date.now() - lock.ts;
  if (age > LOCK_TIMEOUT_MS) { locks.delete(itemId); return null; } // utgånget lås
  return { ...lock, remainingMs: LOCK_TIMEOUT_MS - age };
}

// Försök ta ett lås. Returnerar {ok:true} eller {ok:false, lock:{...}} om upptaget.
app.post("/api/lock/acquire", (req, res) => {
  const { itemId, user, action } = req.body || {};
  if (!itemId || !user) return res.status(400).json({ error: "itemId och user krävs" });
  const existing = lockInfo(itemId);
  if (existing && existing.user !== user) {
    // Upptaget av någon annan — registrera att denna user väntar
    waiting.set(itemId, { user, ts: Date.now() });
    return res.json({
      ok: false,
      lockedBy: existing.user,
      action: existing.action,
      remainingMs: existing.remainingMs,
    });
  }
  // Ledigt eller redan mitt eget lås — ta/förnya det
  locks.set(itemId, { user, action: action || "edit", ts: Date.now() });
  res.json({ ok: true });
});

// Släpp ett lås (när man sparar/går ut)
app.post("/api/lock/release", (req, res) => {
  const { itemId, user } = req.body || {};
  const lock = locks.get(itemId);
  if (lock && lock.user === user) locks.delete(itemId);
  waiting.delete(itemId);
  res.json({ ok: true });
});

// Förnya lås (håll det vid liv medan man jobbar) + kolla om någon väntar
app.post("/api/lock/heartbeat", (req, res) => {
  const { itemId, user } = req.body || {};
  const lock = locks.get(itemId);
  if (lock && lock.user === user) {
    lock.ts = Date.now();
    const w = waiting.get(itemId);
    return res.json({ ok: true, waitingUser: w && w.user !== user ? w.user : null });
  }
  res.json({ ok: false }); // låset är inte längre mitt
});

// Kolla låsstatus för en eller flera delar
app.post("/api/lock/status", (req, res) => {
  const ids = req.body.ids || [];
  const result = {};
  for (const id of ids) {
    const info = lockInfo(id);
    if (info) result[id] = { user: info.user, action: info.action, remainingMs: info.remainingMs };
  }
  res.json({ locks: result });
});

// ── Bilder — hämta bilder för EN artikel ──────────────────────────────────────
app.get("/api/images/:id", (req, res) => {
  db.get("SELECT data FROM images WHERE item_id=?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ images: row ? JSON.parse(row.data) : [] });
  });
});

// Spara bilder för EN artikel
app.post("/api/images/:id", (req, res) => {
  const imgs = req.body.images || [];
  if (imgs.length === 0) {
    db.run("DELETE FROM images WHERE item_id=?", [req.params.id], () => res.json({ ok: true }));
  } else {
    db.run("INSERT OR REPLACE INTO images(item_id,data,updated_at) VALUES(?,?,strftime('%s','now'))",
      [req.params.id, JSON.stringify(imgs)], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
      });
  }
});

// ── Bild som CACHEBAR fil ─────────────────────────────────────────────────────
// Serverar EN bild som riktiga bytes med lång cache. Webbläsaren cachar den och
// hämtar den ALDRIG igen så länge URL:en är samma. URL:en innehåller ?v=<tid>
// så den uppdateras automatiskt när bilden ändras (cache-busting).
// /api/img/:id        → första bilden för artikeln
// /api/img/:id/:idx   → bild med visst index
app.get("/api/img/:id", (req, res) => sendImage(req, res, 0));
app.get("/api/img/:id/:idx", (req, res) => sendImage(req, res, parseInt(req.params.idx || "0", 10) || 0));

function sendImage(req, res, idx) {
  db.get("SELECT data FROM images WHERE item_id=?", [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).end();
    let imgs;
    try { imgs = JSON.parse(row.data); } catch { return res.status(404).end(); }
    const dataUrl = imgs[idx];
    if (!dataUrl || typeof dataUrl !== "string") return res.status(404).end();
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return res.status(404).end();
    const buf = Buffer.from(m[2], "base64");
    res.set("Content-Type", m[1]);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(buf);
  });
}

// ── SNABB BULK-RESTORE — tar emot backup i batchar, delar upp på servern ─────
app.post("/api/restore", async (req, res) => {
  try {
    stats.requests++;
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Ingen data mottogs (body tom)" });
    }
    const { items = [], sales = null, users = null, settings = null, suppliers = [], roles = null, lists = null, activitylog = null, favorites = null, mode = "replace", first = false } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items är inte en lista" });
    }
    if (items.length === 0) {
      return res.status(400).json({ error: "Tom batch (0 delar mottogs)" });
    }

    // Dela upp items i lätt lista + bilder
    const lightItems = [];
    const imageRows = [];
    for (const it of items) {
      const imgs = it.images || [];
      const light = { ...it, images: [], hasImages: imgs.length };
      lightItems.push(light);
      if (imgs.length > 0) imageRows.push([it.id, JSON.stringify(imgs)]);
    }

    // Hämta befintlig lista (för append), eller börja om (för first batch)
    let existing = [];
    if (!first) {
      const row = await dbGet("ow:items");
      existing = row ? JSON.parse(row.value) : [];
    }
    const combined = existing.concat(lightItems);

    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        if (first) db.run("DELETE FROM images");
        const stmt = db.prepare("INSERT OR REPLACE INTO images(item_id,data,updated_at) VALUES(?,?,strftime('%s','now'))");
        for (const [id, data] of imageRows) stmt.run(id, data);
        stmt.finalize();
        db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:items',?,strftime('%s','now'))", [JSON.stringify(combined)]);
        if (sales) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:sales',?,strftime('%s','now'))", [JSON.stringify(sales)]);
        if (users) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:users',?,strftime('%s','now'))", [JSON.stringify(users)]);
        if (settings) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:settings',?,strftime('%s','now'))", [JSON.stringify(settings)]);
        if (suppliers && suppliers.length) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:suppliers',?,strftime('%s','now'))", [JSON.stringify(suppliers)]);
        if (roles) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:roles',?,strftime('%s','now'))", [JSON.stringify(roles)]);
        if (lists) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:lists',?,strftime('%s','now'))", [JSON.stringify(lists)]);
        if (activitylog) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:activitylog',?,strftime('%s','now'))", [JSON.stringify(activitylog)]);
        if (favorites) db.run("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES('ow:favorites',?,strftime('%s','now'))", [JSON.stringify(favorites)]);
        db.run("COMMIT", (err) => err ? reject(err) : resolve());
      });
    });

    res.json({ ok: true, count: combined.length, items: combined });
  } catch (e) {
    stats.errors++;
    console.error("[FEL] restore:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get("/admin/api/status", async (req, res) => {
  const uptimeS = Math.floor((Date.now() - stats.started) / 1000);
  const h = Math.floor(uptimeS / 3600);
  const m = Math.floor((uptimeS % 3600) / 60);
  const s = uptimeS % 60;
  const dbSize = (() => { try { return fs.statSync(DB_PATH).size; } catch { return 0; } })();
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === "IPv4" && !i.internal).map(i => i.address);

  const [itemsRow, usersRow, salesRow, activityRow] = await Promise.all([
    dbGet("ow:items"), dbGet("ow:users"), dbGet("ow:sales"), dbGet("ow:activitylog")
  ]);
  const items = itemsRow ? JSON.parse(itemsRow.value) : [];
  const users = usersRow ? JSON.parse(usersRow.value) : [];
  const sales = salesRow ? JSON.parse(salesRow.value) : [];
  const activity = activityRow ? JSON.parse(activityRow.value) : [];

  // Försäljning idag och denna vecka
  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const weekAgo = now - 7*864e5;
  const salesToday = sales.filter(s => (s.soldAt||0) >= startOfDay.getTime());
  const salesWeek = sales.filter(s => (s.soldAt||0) >= weekAgo);
  const lowStock = items.filter(i => (i.quantity||0) <= 3).length;
  const reservedCount = items.reduce((a,i)=>a+((i.reservations&&i.reservations.length)||0),0);
  const totalQty = items.reduce((a,i)=>a+(i.quantity||0),0);

  // Aktiva enheter senaste 5 minuterna
  const activeWindow = now - 5*60*1000;
  const activeDevices = [...devices.values()].filter(d => d.lastSeen >= activeWindow).length;

  res.json({
    uptime: `${h}t ${m}m ${s}s`,
    uptimeSeconds: uptimeS,
    requests: stats.requests, errors: stats.errors,
    dbSize: (dbSize/1024).toFixed(1)+" KB",
    dbSizeBytes: dbSize,
    items: items.length, users: users.length, sales: sales.length,
    ips, port: PORT,
    totalValue: items.reduce((a,i)=>a+(i.price||0)*(i.quantity||0),0),
    salesTotal: sales.reduce((a,s)=>a+(s.total||0),0),
    salesTodayCount: salesToday.length,
    salesTodayValue: salesToday.reduce((a,s)=>a+(s.total||0),0),
    salesWeekCount: salesWeek.length,
    salesWeekValue: salesWeek.reduce((a,s)=>a+(s.total||0),0),
    lowStock, reservedCount, totalQty,
    activeDevices,
    activityCount: activity.length,
    recentReqs: [],
  });
});

// Anslutna enheter + live-flöde (för admin-panelen)
app.get("/admin/api/devices", (req, res) => {
  const now = Date.now();
  const list = [...devices.values()]
    .sort((a,b) => b.lastSeen - a.lastSeen)
    .map(d => ({
      ip: d.ip,
      user: d.user,
      count: d.count,
      lastSeenAgo: Math.floor((now - d.lastSeen)/1000),
      firstSeen: d.firstSeen,
      active: (now - d.lastSeen) < 5*60*1000,
      device: guessDevice(d.userAgent),
    }));
  res.json({ devices: list, feed: liveFeed.slice(0, MAX_FEED) });
});

// Frontend rapporterar en händelse (köp, ändring m.m.) till live-flödet
app.post("/admin/api/event", (req, res) => {
  const { type, description, user } = req.body || {};
  if (!type || !description) return res.status(400).json({ error: "type och description krävs" });
  liveFeed.unshift({ type, description, user: user||null, ip: clientIp(req), ts: Date.now() });
  if (liveFeed.length > MAX_FEED) liveFeed.length = MAX_FEED;
  res.json({ ok: true });
});

// ── E-postnotiser: händelser som klienten inte kan avgöra själv ska mejlas ──
// (stora köp, misslyckade inloggningar). Servern avgör tröskelvärden och skickar.
const failedLogins = {};
app.post("/admin/api/notify", async (req, res) => {
  const { type, ...data } = req.body || {};
  try {
    if (type === "large_sale") {
      const cfg = await getEmailConfig();
      const threshold = cfg?.largePurchaseThreshold ?? 10000;
      if ((data.total || 0) >= threshold) {
        await sendNotification("largePurchase", `Stort köp genomfört — ${Number(data.total).toLocaleString("sv-SE")} kr`,
          `<p>Ett köp på <strong>${Number(data.total).toLocaleString("sv-SE")} kr</strong> genomfördes.</p>
           <p>Kund: ${data.buyer || "Okänd"}<br>Säljare: ${data.soldBy || "Okänd"}</p>`);
      }
    } else if (type === "failed_login") {
      const ip = clientIp(req);
      const key = (data.username || "okänd") + "|" + ip;
      const now = Date.now();
      failedLogins[key] = (failedLogins[key] || []).filter(t => now - t < 15 * 60 * 1000);
      failedLogins[key].push(now);
      if (failedLogins[key].length >= 3) {
        await sendNotification("failedLogin", `Flera misslyckade inloggningsförsök — ${data.username || "okänd"}`,
          `<p>Minst 3 misslyckade inloggningsförsök på användarnamnet <strong>${data.username || "okänd"}</strong> från IP ${ip} under de senaste 15 minuterna.</p>`);
        failedLogins[key] = [];
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Testmejl så admin kan verifiera att inställningarna stämmer
app.get("/admin/api/email-test", async (req, res) => {
  try {
    const cfg = await getEmailConfig();
    if (!cfg || !cfg.fromEmail || !cfg.appPassword || !cfg.adminEmail) {
      return res.status(400).json({ ok:false, error: "Fyll i avsändare, app-lösenord och mottagare först." });
    }
    const transport = makeTransport(cfg);
    await transport.sendMail({
      from: `"Lager" <${cfg.fromEmail}>`,
      to: cfg.adminEmail,
      subject: "[Lager] Testmejl",
      html: `<div style="font-family:sans-serif;font-size:14px">Det här är ett testmejl från Lager-systemet. Om du ser det här fungerar e-postinställningarna korrekt.</div>`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

function guessDevice(ua) {
  if (!ua) return "Okänd";
  if (/iphone|ipad|ipod/i.test(ua)) return "iPhone/iPad";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/macintosh|mac os/i.test(ua)) return "Mac";
  if (/linux/i.test(ua)) return "Linux";
  return "Okänd";
}

app.post("/admin/api/restart", (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 500);
});

// Manuell trigger för automatisk backup (test)
app.get("/admin/api/backup-now", async (req, res) => {
  try {
    await runBackup();
    res.json({ ok: true, message: "Backup skapad i backups-mappen" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lager Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:#EEF1F5;color:#1a1a2e;padding-bottom:40px}
.header{background:linear-gradient(135deg,#1B3A6B,#CC1B2B);color:#fff;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.title{font-size:20px;font-weight:800;display:flex;align-items:center;gap:10px}
.dot{width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.7);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.6)}70%{box-shadow:0 0 0 8px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.container{max-width:1000px;margin:0 auto;padding:20px 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
.card{background:#fff;border-radius:12px;padding:15px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.label{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.value{font-size:26px;font-weight:800;color:#1B3A6B;line-height:1.1}
.value.green{color:#16a34a}.value.amber{color:#d97706}.value.red{color:#CC1B2B}
.sub{font-size:11px;color:#94a3b8;margin-top:3px}
.section{background:#fff;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.sh{padding:13px 18px;border-bottom:1px solid #eef1f5;font-weight:700;font-size:13px;background:#fafbfc;display:flex;align-items:center;justify-content:space-between}
.sb{padding:14px 18px}
.row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f5f7fa;font-size:13px}
.row:last-child{border:none}
.chip{background:#1B3A6B15;color:#1B3A6B;padding:5px 11px;border-radius:6px;font-size:12px;font-weight:700;font-family:monospace;margin:2px;display:inline-block;cursor:pointer}
.chip:hover{background:#1B3A6B25}
.btn{padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;border:none;display:inline-flex;align-items:center;gap:6px}
.btn-red{background:#CC1B2B;color:#fff}.btn-blue{background:#1B3A6B;color:#fff}.btn-ghost{background:#fff;color:#1B3A6B;border:1.5px solid #d7dee8}
.btn:active{transform:translateY(1px)}
.app-link{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.2);color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px}
.dev{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f5f7fa;font-size:13px}
.dev:last-child{border:none}
.dev .ip{font-family:monospace;font-weight:700;color:#1B3A6B}
.badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px}
.badge.on{background:#dcfce7;color:#16a34a}.badge.off{background:#f1f5f9;color:#94a3b8}
.feed-item{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #f5f7fa;font-size:13px;align-items:flex-start}
.feed-item:last-child{border:none}
.feed-ico{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px}
.muted{color:#94a3b8;font-size:11px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1B3A6B;color:#fff;padding:11px 20px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;z-index:50}
.toast.show{opacity:1}
.controls{display:flex;gap:10px;flex-wrap:wrap}
.empty{text-align:center;color:#94a3b8;padding:24px;font-size:13px}
</style>
</head><body>
<div class="header">
  <div class="title"><span class="dot"></span> Lager Admin</div>
  <a href="/" class="app-link">Öppna app →</a>
</div>
<div class="container">

  <div class="grid">
    <div class="card"><div class="label">Drifttid</div><div class="value" id="uptime">—</div></div>
    <div class="card"><div class="label">Aktiva enheter</div><div class="value green" id="activeDev">—</div><div class="sub">senaste 5 min</div></div>
    <div class="card"><div class="label">Artiklar</div><div class="value" id="items">—</div><div class="sub" id="totalQty"></div></div>
    <div class="card"><div class="label">Lagervärde</div><div class="value green" id="val">—</div></div>
  </div>

  <div class="grid">
    <div class="card"><div class="label">Försäljning idag</div><div class="value" id="salesToday">—</div><div class="sub" id="salesTodayVal"></div></div>
    <div class="card"><div class="label">Senaste 7 dagar</div><div class="value" id="salesWeek">—</div><div class="sub" id="salesWeekVal"></div></div>
    <div class="card"><div class="label">Lågt lager</div><div class="value amber" id="lowStock">—</div><div class="sub">≤ 3 i lager</div></div>
    <div class="card"><div class="label">Reserverade</div><div class="value" id="reserved">—</div></div>
  </div>

  <div class="section">
    <div class="sh">Serverstyrning</div>
    <div class="sb">
      <div class="controls">
        <button class="btn btn-blue" onclick="doBackup(this)"><span>💾</span> Skapa backup nu</button>
        <button class="btn btn-red" onclick="doRestart(this)"><span>🔄</span> Starta om servern</button>
        <button class="btn btn-ghost" onclick="load()"><span>↻</span> Uppdatera</button>
      </div>
      <div class="muted" style="margin-top:10px">Backup sparas i backup-mappen. Omstart tar några sekunder — appen kommer tillbaka automatiskt.</div>
    </div>
  </div>

  <div class="section">
    <div class="sh"><span>Anslutna enheter</span><span class="muted" id="devCount"></span></div>
    <div class="sb" id="devices"><div class="empty">Laddar…</div></div>
  </div>

  <div class="section">
    <div class="sh"><span>Live-aktivitet</span><span class="muted">uppdateras automatiskt</span></div>
    <div class="sb" id="feed"><div class="empty">Ingen aktivitet ännu</div></div>
  </div>

  <div class="section">
    <div class="sh">Serverinfo</div>
    <div class="sb">
      <div class="row"><span>Databasstorlek</span><span id="db">—</span></div>
      <div class="row"><span>Antal anrop sedan start</span><span id="reqs">—</span></div>
      <div class="row"><span>Fel sedan start</span><span id="errs">—</span></div>
      <div class="row"><span>Användare</span><span id="users">—</span></div>
      <div class="row"><span>Totalt antal försäljningar</span><span id="salesTotal">—</span></div>
      <div class="row"><span>Nätverksadresser</span><div id="ips" style="text-align:right"></div></div>
    </div>
  </div>

</div>
<div class="toast" id="toast"></div>
<script>
const kr = n => (n||0).toLocaleString('sv-SE')+' kr';
const feedStyle = {
  sale:{bg:'#dcfce7',c:'#16a34a',i:'🏷️'}, add:{bg:'#dbeafe',c:'#1B3A6B',i:'➕'},
  edit:{bg:'#fef3c7',c:'#d97706',i:'✏️'}, delete:{bg:'#fee2e2',c:'#CC1B2B',i:'🗑️'},
  reserve:{bg:'#fef3c7',c:'#d97706',i:'🔖'}, reverse:{bg:'#f1f5f9',c:'#64748b',i:'↩️'},
  login:{bg:'#e0e7ff',c:'#4f46e5',i:'🔑'}
};
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
function ago(s){if(s<60)return s+'s sedan';if(s<3600)return Math.floor(s/60)+'m sedan';return Math.floor(s/3600)+'t sedan';}

async function load(){
  try{
    const d = await fetch('/admin/api/status').then(r=>r.json());
    document.getElementById('uptime').textContent = d.uptime;
    document.getElementById('activeDev').textContent = d.activeDevices;
    document.getElementById('items').textContent = d.items;
    document.getElementById('totalQty').textContent = (d.totalQty||0)+' st totalt';
    document.getElementById('val').textContent = kr(d.totalValue);
    document.getElementById('salesToday').textContent = d.salesTodayCount;
    document.getElementById('salesTodayVal').textContent = kr(d.salesTodayValue);
    document.getElementById('salesWeek').textContent = d.salesWeekCount;
    document.getElementById('salesWeekVal').textContent = kr(d.salesWeekValue);
    document.getElementById('lowStock').textContent = d.lowStock;
    document.getElementById('reserved').textContent = d.reservedCount;
    document.getElementById('db').textContent = d.dbSize;
    document.getElementById('reqs').textContent = d.requests;
    document.getElementById('errs').textContent = d.errors;
    document.getElementById('users').textContent = d.users;
    document.getElementById('salesTotal').textContent = d.sales;
    document.getElementById('ips').innerHTML = d.ips.map(ip=>
      '<span class="chip" onclick="navigator.clipboard.writeText(\\'http://'+ip+':'+d.port+'\\');toast(\\'Adress kopierad\\')">http://'+ip+':'+d.port+'</span>'
    ).join('');
  }catch(e){}
}

async function loadDevices(){
  try{
    const d = await fetch('/admin/api/devices').then(r=>r.json());
    const dev = document.getElementById('devices');
    document.getElementById('devCount').textContent = d.devices.length+' totalt';
    if(!d.devices.length){ dev.innerHTML='<div class="empty">Inga enheter har anslutit ännu</div>'; }
    else dev.innerHTML = d.devices.map(x=>
      '<div class="dev"><span class="ip">'+x.ip+'</span>'+
      '<span class="badge '+(x.active?'on':'off')+'">'+(x.active?'aktiv':'inaktiv')+'</span>'+
      '<span style="color:#64748b">'+(x.device||'')+'</span>'+
      '<span style="margin-left:auto;text-align:right">'+
      (x.user?'<strong>'+x.user+'</strong>':'<span class="muted">ej inloggad</span>')+
      '<div class="muted">'+ago(x.lastSeenAgo)+' · '+x.count+' anrop</div></span></div>'
    ).join('');

    const feed = document.getElementById('feed');
    if(!d.feed.length){ feed.innerHTML='<div class="empty">Ingen aktivitet ännu</div>'; }
    else feed.innerHTML = d.feed.map(f=>{
      const s = feedStyle[f.type]||{bg:'#f1f5f9',c:'#64748b',i:'•'};
      const t = new Date(f.ts);
      return '<div class="feed-item"><div class="feed-ico" style="background:'+s.bg+';color:'+s.c+'">'+s.i+'</div>'+
        '<div style="flex:1"><div>'+f.description+'</div>'+
        '<div class="muted">'+(f.user?f.user+' · ':'')+(f.ip||'')+' · '+t.toLocaleTimeString('sv-SE',{hour:'2-digit',minute:'2-digit'})+'</div></div></div>';
    }).join('');
  }catch(e){}
}

async function doBackup(btn){
  btn.disabled=true; const o=btn.innerHTML; btn.innerHTML='<span>⏳</span> Skapar…';
  try{ const r=await fetch('/admin/api/backup-now').then(r=>r.json()); toast(r.ok?'Backup skapad':'Backup misslyckades'); }
  catch(e){ toast('Backup misslyckades'); }
  btn.disabled=false; btn.innerHTML=o;
}
async function doRestart(btn){
  if(!confirm('Starta om servern? Appen är otillgänglig några sekunder.'))return;
  btn.disabled=true; btn.innerHTML='<span>⏳</span> Startar om…';
  try{ await fetch('/admin/api/restart',{method:'POST'}); }catch(e){}
  toast('Servern startar om…');
  setTimeout(()=>{ let n=0; const iv=setInterval(async()=>{ try{ await fetch('/admin/api/status'); clearInterval(iv); location.reload(); }catch(e){ if(++n>20){clearInterval(iv);} } },1000); },1500);
}

load(); loadDevices();
setInterval(load, 5000);
setInterval(loadDevices, 4000);
</script></body></html>`);
});

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ── AUTOMATISK BACKUP — varje fredag kl 22:00 ────────────────────────────────
// Sparas i OneDrive så de synkas till molnet automatiskt
const ONEDRIVE_DIR = "C:\\Users\\chris\\OneDrive\\Lager-backups";
const LOCAL_BACKUP_DIR = path.join(__dirname, "backups");
// Använd OneDrive om mappen går att skapa, annars lokal mapp som reserv
function getBackupDir() {
  try {
    if (!fs.existsSync(ONEDRIVE_DIR)) {
      fs.mkdirSync(ONEDRIVE_DIR, { recursive: true });
      console.log(`[backup] Skapade OneDrive-mapp: ${ONEDRIVE_DIR}`);
    }
    // Testa att vi faktiskt kan skriva där
    fs.accessSync(ONEDRIVE_DIR, fs.constants.W_OK);
    return ONEDRIVE_DIR;
  } catch (e) {
    console.error(`[backup] Kunde inte använda OneDrive (${e.message}) — använder lokal mapp`);
    try { if (!fs.existsSync(LOCAL_BACKUP_DIR)) fs.mkdirSync(LOCAL_BACKUP_DIR); } catch {}
    return LOCAL_BACKUP_DIR;
  }
}

// ── Excel-backup — välorganiserad fil med två flikar ─────────────────────────
async function writeExcelBackup(filePath, items, sales, extra = {}) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const BLUE = "FF1B3A6B", LIGHT = "FFEEF2F8", WHITE = "FFFFFFFF";

  const styleHeader = (ws, n) => {
    const row = ws.getRow(1);
    for (let c = 1; c <= n; c++) {
      const cell = row.getCell(c);
      cell.font = { name: "Arial", bold: true, color: { argb: WHITE }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    }
    row.height = 26;
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };
  const zebra = (ws, nrows, ncols) => {
    for (let r = 2; r <= nrows; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= ncols; c++) row.getCell(c).font = { name: "Arial", size: 10 };
      if (r % 2 === 0) for (let c = 1; c <= ncols; c++)
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    }
  };

  // ── Flik 1: Lager ──
  const ws = wb.addWorksheet("Lager");
  ws.columns = [
    { header: "Lagernummer", width: 13 },
    { header: "Artikelnummer", width: 16 },
    { header: "Namn", width: 18 },
    { header: "Sida", width: 10 },
    { header: "Märke", width: 12 },
    { header: "Modell", width: 10 },
    { header: "Årsmodell", width: 13 },
    { header: "Kategori", width: 13 },
    { header: "Skick", width: 22 },
    { header: "Antal", width: 8 },
    { header: "Pris (kr)", width: 11 },
    { header: "Inköpspris (kr)", width: 14 },
    { header: "Placering", width: 14 },
    { header: "Reg.nr", width: 10 },
    { header: "Leverantör", width: 14 },
    { header: "Notering", width: 28 },
  ];
  const sorted = [...items].sort((a,b)=>(parseInt(a.stockNumber||"0")||0)-(parseInt(b.stockNumber||"0")||0));
  for (const it of sorted) {
    const arsmodell = [it.yearFrom, it.yearTo].filter(Boolean).join("–");
    const placering = [it.locationType, it.location].filter(Boolean).join(" ");
    ws.addRow([
      it.stockNumber||"", it.oem||"", it.name||"", it.side||"", it.make||"", it.model||"",
      arsmodell, it.category||"", it.condition||"", it.quantity||0, it.price||0, it.costPrice||0,
      placering, it.regNumber||"", it.supplier||"", it.notes||"",
    ]);
  }
  styleHeader(ws, 16);
  zebra(ws, sorted.length+1, 16);
  [1,10,11,12].forEach(c => ws.getColumn(c).alignment = { horizontal: "center" });

  // ── Flik 2: Säljlogg ──
  const ws2 = wb.addWorksheet("Säljlogg");
  ws2.columns = [
    { header: "Datum", width: 17 },
    { header: "Lagernummer", width: 13 },
    { header: "Artikelnummer", width: 16 },
    { header: "Namn", width: 18 },
    { header: "Sida", width: 10 },
    { header: "Antal", width: 7 },
    { header: "Pris exkl. moms (kr)", width: 18 },
    { header: "Moms (kr)", width: 11 },
    { header: "Pris inkl. moms (kr)", width: 18 },
    { header: "Total (kr)", width: 11 },
    { header: "Inköpspris (kr)", width: 14 },
    { header: "Vinst (kr)", width: 11 },
    { header: "Kund", width: 18 },
    { header: "Säljare", width: 12 },
    { header: "Betalning", width: 12 },
    { header: "Notering", width: 20 },
  ];
  const sortedSales = [...(sales||[])].sort((a,b)=>(b.soldAt||0)-(a.soldAt||0));
  for (const s of sortedSales) {
    const d = s.soldAt ? new Date(s.soldAt) : null;
    const datum = d ? `${d.toISOString().slice(0,10)} ${d.toTimeString().slice(0,5)}` : "";
    const exVat = s.priceExclVat!=null ? s.priceExclVat : Math.round((s.unitPrice||0)/1.25);
    const vat = s.vatPerUnit!=null ? s.vatPerUnit : ((s.unitPrice||0)-exVat);
    const snap = s.itemSnapshot || {};
    ws2.addRow([
      datum, s.itemStockNumber||snap.stockNumber||"", snap.oem||"", s.itemName||"", s.itemSide||"",
      s.qty||0, exVat, vat, s.unitPrice||0, s.total||0, s.costPrice||snap.costPrice||0,
      s.profit!=null?s.profit:"", s.buyer||"", s.soldBy||"", s.payMethod||"", s.note||"",
    ]);
  }
  styleHeader(ws2, 16);
  zebra(ws2, sortedSales.length+1, 16);
  [2,6,7,8,9,10,11,12].forEach(c => ws2.getColumn(c).alignment = { horizontal: "center" });

  // ── Flik 3: Reservationer ──
  const ws3 = wb.addWorksheet("Reservationer");
  ws3.columns = [
    { header: "Regnummer", width: 13 },
    { header: "Kund", width: 20 },
    { header: "Lagernummer", width: 13 },
    { header: "Artikelnummer", width: 16 },
    { header: "Namn", width: 18 },
    { header: "Sida", width: 10 },
    { header: "Pris (kr)", width: 11 },
    { header: "Notering", width: 24 },
    { header: "Reserverad av", width: 14 },
    { header: "Datum", width: 13 },
  ];
  const resRows = [];
  for (const it of items) {
    for (const r of (it.reservations||[])) {
      resRows.push({ r, it });
    }
  }
  resRows.sort((a,b)=>(a.r.regNumber||"").localeCompare(b.r.regNumber||""));
  for (const { r, it } of resRows) {
    const d = r.ts ? new Date(r.ts).toISOString().slice(0,10) : "";
    ws3.addRow([
      r.regNumber||"", r.customer||"", it.stockNumber||"", it.oem||"", it.name||"", it.side||"",
      it.price||0, r.note||"", r.by||"", d,
    ]);
  }
  styleHeader(ws3, 10);
  zebra(ws3, resRows.length+1, 10);
  [1,3,7,10].forEach(c => ws3.getColumn(c).alignment = { horizontal: "center" });

  // ── Flik 4: Aktivitetslogg ──
  const ws4 = wb.addWorksheet("Aktivitetslogg");
  ws4.columns = [
    { header: "Datum & tid", width: 18 },
    { header: "Typ", width: 14 },
    { header: "Beskrivning", width: 50 },
    { header: "Användare", width: 14 },
  ];
  const typeLabels = { sale:"Försäljning", add:"Tillagd", edit:"Redigerad", delete:"Borttagen", reserve:"Reserverad", reverse:"Ångrad", import:"Import" };
  const log = (extra.activitylog||[]);
  for (const e of log) {
    const d = e.ts ? new Date(e.ts) : null;
    const datum = d ? `${d.toISOString().slice(0,10)} ${d.toTimeString().slice(0,5)}` : "";
    ws4.addRow([ datum, typeLabels[e.type]||e.type||"", e.description||"", e.user||"" ]);
  }
  styleHeader(ws4, 4);
  zebra(ws4, log.length+1, 4);

  // ── Flik 5: Roller ──
  const ws5 = wb.addWorksheet("Roller");
  ws5.columns = [
    { header: "Roll", width: 18 },
    { header: "Antal behörigheter", width: 18 },
    { header: "Behörigheter", width: 70 },
  ];
  const roles = (extra.roles||[]);
  for (const role of roles) {
    const perms = Object.keys(role.permissions||{}).filter(k=>role.permissions[k]);
    ws5.addRow([ role.name||"", perms.length, perms.join(", ") ]);
  }
  styleHeader(ws5, 3);
  zebra(ws5, roles.length+1, 3);
  ws5.getColumn(2).alignment = { horizontal: "center" };

  await wb.xlsx.writeFile(filePath);
}

async function runBackup() {
  try {
    const [itemsRow, salesRow, usersRow, settingsRow, suppliersRow, rolesRow, listsRow, activityRow, favoritesRow] = await Promise.all([
      dbGet("ow:items"), dbGet("ow:sales"), dbGet("ow:users"), dbGet("ow:settings"), dbGet("ow:suppliers"),
      dbGet("ow:roles"), dbGet("ow:lists"), dbGet("ow:activitylog"), dbGet("ow:favorites")
    ]);
    const items = itemsRow ? JSON.parse(itemsRow.value) : [];
    // Samla ihop bilderna så backupen blir komplett
    const itemsWithImages = [];
    for (const it of items) {
      if (it.hasImages > 0) {
        const imgRow = await new Promise(r => db.get("SELECT data FROM images WHERE item_id=?", [it.id], (e,row)=>r(row)));
        let imgs = []; try { imgs = imgRow ? JSON.parse(imgRow.data) : []; } catch {}
        itemsWithImages.push({ ...it, images: imgs });
      } else {
        itemsWithImages.push(it);
      }
    }
    const parse = (row, def) => { try { return row ? JSON.parse(row.value) : def; } catch { return def; } };
    const data = {
      version: 4,
      exportedAt: new Date().toISOString(),
      auto: true,
      items: itemsWithImages,
      sales: parse(salesRow, []),
      users: parse(usersRow, []),
      settings: parse(settingsRow, null),
      suppliers: parse(suppliersRow, []),
      roles: parse(rolesRow, []),
      lists: parse(listsRow, null),
      activitylog: parse(activityRow, []),
      favorites: parse(favoritesRow, []),
    };
    const stamp = new Date().toISOString().slice(0,10);
    const BACKUP_DIR = getBackupDir();
    const file = path.join(BACKUP_DIR, `auto_backup_${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    console.log(`[backup] JSON-backup skapad: ${file} (${items.length} delar)`);

    // ── Excel-backup (välorganiserad, två flikar) ──
    try {
      await writeExcelBackup(path.join(BACKUP_DIR, `auto_backup_${stamp}.xlsx`), itemsWithImages, data.sales, { activitylog: data.activitylog, roles: data.roles });
      console.log(`[backup] Excel-backup skapad`);
    } catch (e) {
      console.error("[backup] Excel misslyckades:", e.message);
    }

    // Behåll bara de 8 senaste auto-backuperna (både .json och .xlsx)
    for (const ext of ["json", "xlsx"]) {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("auto_backup_") && f.endsWith(ext)).sort();
      while (files.length > 8) {
        const old = files.shift();
        try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch {}
      }
    }
  } catch (e) {
    console.error("[backup] Misslyckades:", e.message);
    throttledNotify("backupFailed", "Backup misslyckades",
      `<p>Den automatiska backupen misslyckades:</p><p style="font-family:monospace;background:#f4f5f7;padding:10px;border-radius:6px">${e.message}</p><p>Kontrollera att servern har diskutrymme och att backup-mappen är tillgänglig.</p>`, 60);
  }
}

// Kontrollera varje minut om det är fredag 22:00
let lastBackupKey = "";
setInterval(() => {
  const now = new Date();
  // 5 = fredag (0=söndag). 22:00.
  if (now.getDay() === 5 && now.getHours() === 22 && now.getMinutes() === 0) {
    const key = now.toISOString().slice(0,13); // unik per timme — kör bara en gång
    if (key !== lastBackupKey) {
      lastBackupKey = key;
      console.log("[backup] Fredag 22:00 — kör automatisk backup...");
      runBackup();
    }
  }
}, 60 * 1000);

// Kontrollera varje dag kl 09:00 om någon säljare varit inaktiv en tid (standard 7 dagar)
let lastInactivityCheckKey = "";
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 9 && now.getMinutes() === 0) {
    const key = now.toISOString().slice(0,10); // en gång per dag
    if (key !== lastInactivityCheckKey) {
      lastInactivityCheckKey = key;
      try {
        const cfg = await getEmailConfig();
        const days = cfg?.inactivityDays ?? 7;
        const [usersRow, activityRow] = await Promise.all([dbGet("ow:users"), dbGet("ow:activitylog")]);
        const users = usersRow ? JSON.parse(usersRow.value) : [];
        const activity = activityRow ? JSON.parse(activityRow.value) : [];
        const cutoff = Date.now() - days * 864e5;
        const inactive = [];
        for (const u of users) {
          if (u.role === "admin") continue; // huvudadmin behöver inte varnas om sig själv
          const lastEvent = activity.filter(a => a.user === u.username).sort((a,b)=>b.ts-a.ts)[0];
          if (!lastEvent || lastEvent.ts < cutoff) {
            inactive.push({ username: u.username, lastSeen: lastEvent ? new Date(lastEvent.ts).toLocaleDateString("sv-SE") : "aldrig registrerad aktivitet" });
          }
        }
        if (inactive.length) {
          const rows = inactive.map(x => `<li><strong>${x.username}</strong> — senast aktiv: ${x.lastSeen}</li>`).join("");
          await sendNotification("inactiveSeller", `${inactive.length} säljare inaktiva i ${days}+ dagar`,
            `<p>Följande användare har inte haft någon registrerad aktivitet (försäljning, inloggning m.m.) på minst ${days} dagar:</p><ul>${rows}</ul>`);
        }
      } catch (e) {
        console.error("[notify] Inaktivitetskontroll misslyckades:", e.message);
      }
    }
  }
}, 60 * 1000);

// ── Daglig sammanfattning — igår kl 08:00 ("Igår sålde ni X för Y kr") ──
let lastDailySummaryKey = "";
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() === 0) {
    const key = now.toISOString().slice(0,10);
    if (key !== lastDailySummaryKey) {
      lastDailySummaryKey = key;
      try {
        const cfg = await getEmailConfig();
        if (cfg?.notifTypes?.dailySummary === false) return;
        const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()-1).getTime();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const salesRow = await dbGet("ow:sales");
        const sales = salesRow ? JSON.parse(salesRow.value) : [];
        const yesterday = sales.filter(s => s.soldAt >= yesterdayStart && s.soldAt < todayStart);
        if (!yesterday.length) return; // ingen försäljning — inget mejl, för att inte spamma i onödan
        const rev = yesterday.reduce((a,s)=>a+s.total,0);
        const profit = yesterday.reduce((a,s)=>a+(s.profit||0),0);
        const dateStr = new Date(yesterdayStart).toLocaleDateString("sv-SE",{weekday:"long",day:"numeric",month:"long"});
        await sendNotification("dailySummary", `Igår sålde ni ${rev.toLocaleString("sv-SE")} kr`,
          `<p>Sammanfattning för <strong>${dateStr}</strong>:</p>
           <ul>
             <li>Intäkt: <strong>${rev.toLocaleString("sv-SE")} kr</strong></li>
             <li>Vinst: <strong style="color:${profit>=0?'#16a34a':'#CC1B2B'}">${profit.toLocaleString("sv-SE")} kr</strong></li>
             <li>Antal affärer: ${yesterday.length}</li>
           </ul>`);
      } catch (e) {
        console.error("[notify] Daglig sammanfattning misslyckades:", e.message);
      }
    }
  }
}, 60 * 1000);

// ── Veckosammanfattning — måndagar kl 08:00, för föregående vecka ──
let lastWeeklySummaryKey = "";
setInterval(async () => {
  const now = new Date();
  if (now.getDay() === 1 && now.getHours() === 8 && now.getMinutes() === 5) { // 08:05, efter dagssammanfattningen
    const key = now.toISOString().slice(0,10);
    if (key !== lastWeeklySummaryKey) {
      lastWeeklySummaryKey = key;
      try {
        const cfg = await getEmailConfig();
        if (cfg?.notifTypes?.weeklySummary === false) return;
        const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); // idag 00:00
        const weekStart = weekEnd - 7*864e5;
        const salesRow = await dbGet("ow:sales");
        const sales = salesRow ? JSON.parse(salesRow.value) : [];
        const week = sales.filter(s => s.soldAt >= weekStart && s.soldAt < weekEnd);
        if (!week.length) return;
        const rev = week.reduce((a,s)=>a+s.total,0);
        const profit = week.reduce((a,s)=>a+(s.profit||0),0);
        // Bästsäljande dag
        const byDay = {};
        week.forEach(s => { const d = new Date(s.soldAt).toLocaleDateString("sv-SE",{weekday:"long"}); byDay[d]=(byDay[d]||0)+s.total; });
        const bestDay = Object.entries(byDay).sort((a,b)=>b[1]-a[1])[0];
        // Per säljare
        const bySeller = {};
        week.forEach(s => { bySeller[s.soldBy]=(bySeller[s.soldBy]||0)+s.total; });
        const sellerRows = Object.entries(bySeller).sort((a,b)=>b[1]-a[1])
          .map(([name,v])=>`<li>${name}: ${v.toLocaleString("sv-SE")} kr</li>`).join("");
        await sendNotification("weeklySummary", `Veckans försäljning: ${rev.toLocaleString("sv-SE")} kr`,
          `<p>Sammanfattning för veckan som gick (${new Date(weekStart).toLocaleDateString("sv-SE")}–${new Date(weekEnd-864e5).toLocaleDateString("sv-SE")}):</p>
           <ul>
             <li>Intäkt: <strong>${rev.toLocaleString("sv-SE")} kr</strong></li>
             <li>Vinst: <strong style="color:${profit>=0?'#16a34a':'#CC1B2B'}">${profit.toLocaleString("sv-SE")} kr</strong></li>
             <li>Antal affärer: ${week.length}</li>
             ${bestDay?`<li>Bästa dag: ${bestDay[0]} (${bestDay[1].toLocaleString("sv-SE")} kr)</li>`:""}
           </ul>
           ${sellerRows?`<p><strong>Per säljare:</strong></p><ul>${sellerRows}</ul>`:""}`);
      } catch (e) {
        console.error("[notify] Veckosammanfattning misslyckades:", e.message);
      }
    }
  }
}, 60 * 1000);

// Manuell trigger för test: GET /admin/api/backup-now (registreras före catch-all nedan)

// ── Starta ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === "IPv4" && !i.internal).map(i => i.address);
  console.log("\n========================================");
  console.log("         Lager - Server igang");
  console.log("========================================");
  console.log(`  Lokalt:   http://localhost:${PORT}`);
  console.log(`  Natverk:  http://lager.local:${PORT}`);
  ips.forEach(ip => console.log(`  IP:       http://${ip}:${PORT}`));
  console.log(`  Admin:    http://localhost:${PORT}/admin`);
  console.log("========================================\n");
});
