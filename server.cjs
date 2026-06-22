const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 3000;
const db = new Database(path.join(__dirname, "lager.db"));

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "dist")));

// ── Databas setup ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER DEFAULT (strftime('%s','now')));
  CREATE TABLE IF NOT EXISTS request_log (id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT, key TEXT, ts INTEGER DEFAULT (strftime('%s','now')));
`);

// ── Statistik i minnet ────────────────────────────────────────────────────────
const stats = { started: Date.now(), requests: 0, errors: 0 };

function logReq(method, key) {
  stats.requests++;
  db.prepare("INSERT INTO request_log(method,key) VALUES(?,?)").run(method, key);
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.get("/api/:key", (req, res) => {
  try {
    logReq("GET", req.params.key);
    const r = db.prepare("SELECT value FROM store WHERE key=?").get(req.params.key);
    res.json(r || null);
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

app.post("/api/:key", (req, res) => {
  try {
    logReq("POST", req.params.key);
    db.prepare("INSERT OR REPLACE INTO store(key,value,updated_at) VALUES(?,?,strftime('%s','now'))").run(req.params.key, req.body.value);
    res.json({ ok: true });
  } catch (e) { stats.errors++; res.status(500).json({ error: e.message }); }
});

app.delete("/api/:key", (req, res) => {
  try {
    db.prepare("DELETE FROM store WHERE key=?").run(req.params.key);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Nätverksinfo — returnerar serverns IP-adresser ────────────────────────────
app.get("/api/network", (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips = Object.values(interfaces).flat()
    .filter(i => i.family === "IPv4" && !i.internal)
    .map(i => i.address);
  res.json({ ips, port: PORT });
});

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get("/admin/api/status", (req, res) => {
  const uptimeS = Math.floor((Date.now() - stats.started) / 1000);
  const h = Math.floor(uptimeS / 3600);
  const m = Math.floor((uptimeS % 3600) / 60);
  const s = uptimeS % 60;
  const uptime = `${h}t ${m}m ${s}s`;

  const dbSize = (() => { try { return require("fs").statSync(path.join(__dirname,"lager.db")).size; } catch { return 0; } })();
  const recentReqs = db.prepare("SELECT method, key, ts FROM request_log ORDER BY ts DESC LIMIT 20").all();

  // Hämta app-data för stats
  const itemsRow = db.prepare("SELECT value FROM store WHERE key='ow:items'").get();
  const usersRow = db.prepare("SELECT value FROM store WHERE key='ow:users'").get();
  const salesRow = db.prepare("SELECT value FROM store WHERE key='ow:sales'").get();
  const items = itemsRow ? JSON.parse(itemsRow.value) : [];
  const users = usersRow ? JSON.parse(usersRow.value) : [];
  const sales = salesRow ? JSON.parse(salesRow.value) : [];

  const interfaces = os.networkInterfaces();
  const ips = Object.values(interfaces).flat().filter(i=>i.family==="IPv4"&&!i.internal).map(i=>i.address);

  res.json({
    uptime, requests: stats.requests, errors: stats.errors,
    dbSize: (dbSize/1024).toFixed(1)+" KB",
    items: items.length, users: users.length, sales: sales.length,
    recentReqs, ips, port: PORT,
    totalValue: items.reduce((a,i)=>a+(i.price||0)*(i.quantity||0),0),
    salesTotal: sales.reduce((a,s)=>a+s.total,0),
  });
});

app.post("/admin/api/restart", (req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 500); // PM2 startar om automatiskt
});

app.post("/admin/api/clear-log", (req, res) => {
  db.prepare("DELETE FROM request_log").run();
  res.json({ ok: true });
});

// ── Admin Panel HTML ──────────────────────────────────────────────────────────
app.get("/admin", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lager Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F0F2F5;color:#1a1a2e;min-height:100vh}
  .header{background:linear-gradient(135deg,#1B3A6B,#CC1B2B);color:#fff;padding:20px 24px;display:flex;align-items:center;justify-content:space-between}
  .logo{display:flex;align-items:center;gap:10px}
  .bars{display:flex;gap:3px}.bar{width:5px;border-radius:3px;background:#fff}
  .title{font-size:20px;font-weight:800;letter-spacing:.5px}
  .subtitle{font-size:12px;opacity:.7;margin-top:2px}
  .badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;display:flex;align-items:center;gap:5px}
  .online{background:#22c55e20;color:#22c55e;border:1px solid #22c55e40}
  .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .container{max-width:900px;margin:0 auto;padding:24px 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
  .card{background:#fff;border-radius:12px;padding:16px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .card-label{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px;display:flex;align-items:center;gap:5px}
  .card-value{font-size:28px;font-weight:800;color:#1B3A6B}
  .card-value.green{color:#22c55e}
  .card-value.red{color:#CC1B2B}
  .section{background:#fff;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:16px;overflow:hidden}
  .section-header{padding:14px 18px;border-bottom:1px solid #f1f5f9;font-weight:700;font-size:13px;display:flex;justify-content:space-between;align-items:center;background:#fafbfc}
  .section-body{padding:16px 18px}
  .info-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f8fafc;font-size:13px}
  .info-row:last-child{border:none}
  .info-label{color:#64748b;font-weight:500}
  .info-value{font-weight:700;color:#1a1a2e}
  .ip-chip{background:#1B3A6B15;color:#1B3A6B;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:700;font-family:monospace;margin:2px;display:inline-block;cursor:pointer}
  .ip-chip:hover{background:#1B3A6B25}
  .btn{padding:9px 18px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;border:none;display:inline-flex;align-items:center;gap:6px;transition:.15s}
  .btn-red{background:#CC1B2B;color:#fff}.btn-red:hover{background:#a81522}
  .btn-gray{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}.btn-gray:hover{background:#e2e8f0}
  .btn-blue{background:#1B3A6B;color:#fff}.btn-blue:hover{background:#15305a}
  .log-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f8fafc;font-size:12px}
  .log-row:last-child{border:none}
  .method{padding:2px 7px;border-radius:4px;font-weight:700;font-size:10px;min-width:38px;text-align:center}
  .get{background:#dbeafe;color:#1d4ed8}
  .post{background:#dcfce7;color:#16a34a}
  .log-key{flex:1;color:#475569;font-family:monospace}
  .log-time{color:#94a3b8;font-size:11px}
  .app-link{display:inline-flex;align-items:center;gap:6px;background:#1B3A6B;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px}
  .app-link:hover{background:#15305a}
  .updated{font-size:11px;color:#94a3b8;margin-top:6px;text-align:right}
</style>
</head>
<body>
<div class="header">
  <div class="logo">
    <div class="bars">
      <div class="bar" style="height:28px"></div>
      <div class="bar" style="height:20px"></div>
    </div>
    <div>
      <div class="title">Lager Admin</div>
      <div class="subtitle">Serverpanel</div>
    </div>
  </div>
  <div style="display:flex;gap:10px;align-items:center">
    <div class="badge online"><div class="dot"></div> Online</div>
    <a href="/" class="app-link">&#10132; Öppna app</a>
  </div>
</div>

<div class="container">

  <div class="grid" id="stats-grid">
    <div class="card"><div class="card-label">Drifttid</div><div class="card-value" id="s-uptime">—</div></div>
    <div class="card"><div class="card-label">Requests</div><div class="card-value" id="s-req">—</div></div>
    <div class="card"><div class="card-label">Artiklar</div><div class="card-value" id="s-items">—</div></div>
    <div class="card"><div class="card-label">Användare</div><div class="card-value" id="s-users">—</div></div>
    <div class="card"><div class="card-label">Försäljningar</div><div class="card-value" id="s-sales">—</div></div>
    <div class="card"><div class="card-label">Lagervärde</div><div class="card-value green" id="s-val">—</div></div>
  </div>

  <div class="section">
    <div class="section-header">
      Serverinfo
      <div style="display:flex;gap:8px">
        <button class="btn btn-gray" onclick="clearLog()">Rensa logg</button>
        <button class="btn btn-red" onclick="restartServer()">&#8635; Starta om</button>
      </div>
    </div>
    <div class="section-body">
      <div class="info-row"><span class="info-label">Databasstorlek</span><span class="info-value" id="s-db">—</span></div>
      <div class="info-row"><span class="info-label">Fel</span><span class="info-value red" id="s-err">—</span></div>
      <div class="info-row">
        <span class="info-label">Nätverksadresser</span>
        <div id="s-ips"></div>
      </div>
      <div class="info-row">
        <span class="info-label">Total försäljning</span>
        <span class="info-value green" id="s-stotal">—</span>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">Senaste requests <span id="log-count" style="font-size:11px;color:#94a3b8"></span></div>
    <div class="section-body" id="log-body" style="max-height:300px;overflow-y:auto">Laddar...</div>
  </div>

  <div class="updated" id="updated"></div>
</div>

<script>
async function load() {
  try {
    const d = await fetch('/admin/api/status').then(r=>r.json());
    document.getElementById('s-uptime').textContent = d.uptime;
    document.getElementById('s-req').textContent = d.requests;
    document.getElementById('s-items').textContent = d.items;
    document.getElementById('s-users').textContent = d.users;
    document.getElementById('s-sales').textContent = d.sales;
    document.getElementById('s-val').textContent = d.totalValue.toLocaleString('sv-SE')+' kr';
    document.getElementById('s-db').textContent = d.dbSize;
    document.getElementById('s-err').textContent = d.errors;
    document.getElementById('s-stotal').textContent = d.salesTotal.toLocaleString('sv-SE')+' kr';
    document.getElementById('s-ips').innerHTML = d.ips.map(ip=>
      \`<span class="ip-chip" onclick="navigator.clipboard.writeText('http://\${ip}:\${d.port}')" title="Klicka för att kopiera">http://\${ip}:\${d.port}</span>\`
    ).join('');
    document.getElementById('log-count').textContent = '('+d.recentReqs.length+' senaste)';
    document.getElementById('log-body').innerHTML = d.recentReqs.length===0
      ? '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:20px">Inga requests ännu</div>'
      : d.recentReqs.map(r=>{
          const t = new Date(r.ts*1000).toLocaleTimeString('sv-SE');
          const key = r.key.replace('ow:','');
          return \`<div class="log-row"><span class="method \${r.method.toLowerCase()}">\${r.method}</span><span class="log-key">\${key}</span><span class="log-time">\${t}</span></div>\`;
        }).join('');
    document.getElementById('updated').textContent = 'Uppdaterad: '+new Date().toLocaleTimeString('sv-SE');
  } catch(e) {
    document.getElementById('log-body').innerHTML = '<div style="color:#CC1B2B;font-size:13px">Kunde inte nå servern</div>';
  }
}

async function restartServer() {
  if (!confirm('Starta om servern? Appen pausas i några sekunder.')) return;
  await fetch('/admin/api/restart', {method:'POST'});
  setTimeout(()=>location.reload(), 3000);
}

async function clearLog() {
  await fetch('/admin/api/clear-log', {method:'POST'});
  load();
}

load();
setInterval(load, 5000);
</script>
</body>
</html>`);
});

// ── Catch-all för React router ────────────────────────────────────────────────
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ── Hitta IP-adresser ─────────────────────────────────────────────────────────
function getIPs() {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces).flat().filter(i=>i.family==="IPv4"&&!i.internal).map(i=>i.address);
}

// ── Starta server ─────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log("\n========================================");
  console.log("         Lager - Server igang");
  console.log("========================================");
  console.log(`  Lokalt:   http://localhost:${PORT}`);
  getIPs().forEach(ip => {
    console.log(`  Natverk:  http://${ip}:${PORT}`);
  });
  console.log("----------------------------------------");
  console.log(`  Admin:    http://localhost:${PORT}/admin`);
  console.log("========================================\n");
});
