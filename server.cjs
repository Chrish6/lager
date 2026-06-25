const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors    = require("cors");
const path    = require("path");
const os      = require("os");
const fs      = require("fs");

const PORT = process.env.PORT || 3000;

// ── mDNS — registrera lager.local på nätverket ────────────────────────────────
try {
  const { Bonjour } = require("bonjour-service");
  const bonjour = new Bonjour();
  bonjour.publish({
    name: "lager",
    type: "http",
    port: Number(PORT),
    host: "lager.local",
    txt: { path: "/" }
  });
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

const stats = { started: Date.now(), requests: 0, errors: 0 };

app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));
app.use(express.static(path.join(__dirname, "dist")));

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/network", (req, res) => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === "IPv4" && !i.internal)
    .map(i => i.address);
  res.json({ ips, port: PORT });
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
    res.json({ ok: true, items: filtered });
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
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

  const [itemsRow, usersRow, salesRow] = await Promise.all([
    dbGet("ow:items"), dbGet("ow:users"), dbGet("ow:sales")
  ]);
  const items = itemsRow ? JSON.parse(itemsRow.value) : [];
  const users = usersRow ? JSON.parse(usersRow.value) : [];
  const sales = salesRow ? JSON.parse(salesRow.value) : [];

  res.json({
    uptime: `${h}t ${m}m ${s}s`,
    requests: stats.requests, errors: stats.errors,
    dbSize: (dbSize/1024).toFixed(1)+" KB",
    items: items.length, users: users.length, sales: sales.length,
    ips, port: PORT,
    totalValue: items.reduce((a,i)=>a+(i.price||0)*(i.quantity||0),0),
    salesTotal: sales.reduce((a,s)=>a+s.total,0),
    recentReqs: [],
  });
});

app.post("/admin/api/restart", (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 500);
});

app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lager Admin</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#F0F2F5;color:#1a1a2e}.header{background:linear-gradient(135deg,#1B3A6B,#CC1B2B);color:#fff;padding:20px 24px;display:flex;align-items:center;justify-content:space-between}.title{font-size:20px;font-weight:800}.container{max-width:900px;margin:0 auto;padding:24px 16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}.card{background:#fff;border-radius:12px;padding:16px;border:1px solid #e2e8f0}.label{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:6px}.value{font-size:28px;font-weight:800;color:#1B3A6B}.green{color:#22c55e}.section{background:#fff;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden}.sh{padding:14px 18px;border-bottom:1px solid #f1f5f9;font-weight:700;font-size:13px;background:#fafbfc}.sb{padding:16px 18px}.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f8fafc;font-size:13px}.row:last-child{border:none}.chip{background:#1B3A6B15;color:#1B3A6B;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:700;font-family:monospace;margin:2px;display:inline-block;cursor:pointer}.btn{padding:9px 18px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;border:none}.btn-red{background:#CC1B2B;color:#fff}.app-link{display:inline-flex;align-items:center;gap:6px;background:#1B3A6B;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px}</style>
</head><body>
<div class="header"><div class="title">Lager Admin</div><a href="/" class="app-link">Öppna app</a></div>
<div class="container">
<div class="grid">
  <div class="card"><div class="label">Drifttid</div><div class="value" id="uptime">—</div></div>
  <div class="card"><div class="label">Artiklar</div><div class="value" id="items">—</div></div>
  <div class="card"><div class="label">Försäljningar</div><div class="value" id="sales">—</div></div>
  <div class="card"><div class="label">Lagervärde</div><div class="value green" id="val">—</div></div>
</div>
<div class="section"><div class="sh">Serverinfo</div><div class="sb">
  <div class="row"><span>Databasstorlek</span><span id="db">—</span></div>
  <div class="row"><span>Nätverksadresser</span><div id="ips"></div></div>
</div></div>
</div>
<script>
async function load() {
  const d = await fetch('/admin/api/status').then(r=>r.json());
  document.getElementById('uptime').textContent = d.uptime;
  document.getElementById('items').textContent = d.items;
  document.getElementById('sales').textContent = d.sales;
  document.getElementById('val').textContent = d.totalValue.toLocaleString('sv-SE')+' kr';
  document.getElementById('db').textContent = d.dbSize;
  document.getElementById('ips').innerHTML = d.ips.map(ip=>
    \`<span class="chip" onclick="navigator.clipboard.writeText('http://\${ip}:\${d.port}')" title="Klicka för att kopiera">http://\${ip}:\${d.port}</span>\`
  ).join('');
}
load(); setInterval(load, 5000);
</script></body></html>`);
});

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

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
