import React, { useState, useEffect, useRef, useCallback, forwardRef } from "react";
import { VirtuosoGrid, Virtuoso } from "react-virtuoso";

// ── Error Boundary — fångar krascher och visar fel istället för vit skärm ─────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { console.error("App-krasch:", error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",padding:24,textAlign:"center",fontFamily:"sans-serif",background:"#F5F5F7"}}>
          <div style={{fontSize:48,marginBottom:16}}>⚠️</div>
          <div style={{fontWeight:700,fontSize:18,color:"#141820",marginBottom:8}}>Något gick fel</div>
          <div style={{fontSize:14,color:"#666",marginBottom:24,maxWidth:340}}>Appen stötte på ett problem. Tryck för att ladda om.</div>
          <button onClick={()=>window.location.reload()} style={{background:"#1B3A6B",color:"#fff",border:"none",borderRadius:8,padding:"12px 24px",fontSize:14,fontWeight:600,cursor:"pointer"}}>
            Ladda om appen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Storage — REST API mot lokal server ──────────────────────────────────────
// Appen och API:et serveras från samma server (server.js på port 3000),
// så en relativ sökväg fungerar alltid — oavsett om man når servern via
// localhost eller via en IP-adress på nätverket.
const API = "/api";

// ── Universell utskrift — fungerar i Electron, webbläsare och mobil ───────────
function printHtml(html) {
  // Metod 1: dold iframe (fungerar bäst i Electron)
  try {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    iframe.contentWindow.focus();
    setTimeout(() => {
      try { iframe.contentWindow.print(); } catch {}
      setTimeout(() => { try { document.body.removeChild(iframe); } catch {} }, 1000);
    }, 500);
    return true;
  } catch {
    // Metod 2: blob URL i ny flik
    const blob = new Blob([html], {type:"text/html"});
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (!w) { const a=document.createElement("a"); a.href=url; a.download="utskrift.html"; a.click(); }
    setTimeout(()=>URL.revokeObjectURL(url), 10000);
    return true;
  }
}

// Skapa en liten thumbnail (~120px) från en base64-bild — bara några KB
function makeThumbnail(dataUrl) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const maxW = 120;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.5));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch { resolve(null); }
  });
}

async function sget(k) {
  try { const r = await fetch(`${API}/${k}`).then(r=>r.json()); return r ? JSON.parse(r.value) : null; } catch { return null; }
}
async function sset(k,v) {
  try {
    const res = await fetch(`${API}/${k}`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({value:JSON.stringify(v)})
    });
    if (!res.ok) {
      console.error(`Sparning misslyckades för ${k}: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`Sparning misslyckades för ${k}:`, e.message);
    return false;
  }
}

// Item-level: uppdatera/lägg till EN artikel utan att skriva över andras ändringar
async function saveOneItem(item) {
  try {
    const r = await fetch(`${API}/item/upsert`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ item })
    }).then(r=>r.json());
    return r.items || null;
  } catch { return null; }
}
// Item-level: ta bort EN artikel
async function deleteOneItem(id) {
  try {
    const r = await fetch(`${API}/item/delete`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ id })
    }).then(r=>r.json());
    return r.items || null;
  } catch { return null; }
}

// Bilder — hämta för en artikel
async function getImages(id) {
  try {
    const r = await fetch(`${API}/images/${id}`).then(r=>r.json());
    return r.images || [];
  } catch { return []; }
}
// Bilder — spara för en artikel
async function setImages(id, images) {
  try {
    const r = await fetch(`${API}/images/${id}`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ images })
    });
    return r.ok;
  } catch { return false; }
}

// ── Redigeringslås — hindrar två användare från att ändra samma del samtidigt ──
async function lockAcquire(itemId, user, action) {
  try {
    return await fetch(`${API}/lock/acquire`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ itemId, user, action })
    }).then(r=>r.json());
  } catch { return { ok: true }; } // vid nätverksfel — blockera inte användaren
}
async function lockRelease(itemId, user) {
  try {
    await fetch(`${API}/lock/release`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ itemId, user })
    });
  } catch {}
}
async function lockHeartbeat(itemId, user) {
  try {
    return await fetch(`${API}/lock/heartbeat`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ itemId, user })
    }).then(r=>r.json());
  } catch { return { ok: true }; }
}
function fmtLockTime(ms) {
  const min = Math.ceil(ms / 60000);
  return min <= 1 ? "mindre än 1 min" : `~${min} min`;
}

// ─── Lösenordshashning — snabb enkel hash ─────────────────────────────────────
function hashPassword(plain) {
  // Enkel men tillräcklig hash för lokalt system
  let hash = 0;
  const str = plain + "lager_salt_2024";
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Promise.resolve("h_" + Math.abs(hash).toString(36) + "_" + str.length);
}

// ─── Session — håller användaren inloggad i 30 dagar ──────────────────────────
const SESSION_KEY = "lager_session";
const SESSION_DAYS = 30;
function saveSession(userId) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, expires: Date.now() + SESSION_DAYS*864e5 })); } catch {}
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { userId, expires } = JSON.parse(raw);
    if (Date.now() > expires) { localStorage.removeItem(SESSION_KEY); return null; }
    return userId;
  } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_ADMIN = { id:"admin", username:"admin", password:"admin123", role:"admin", permissions:{}, createdAt:Date.now() };

const DEFAULT_ITEMS = [];

const ALL_PERMISSIONS = [
  { key:"canView",        label:"Visa lager",      icon:"fa-eye" },
  { key:"canAdd",         label:"Lägg till del",   icon:"fa-plus" },
  { key:"canEdit",        label:"Redigera del",    icon:"fa-pen" },
  { key:"canDelete",      label:"Ta bort del",     icon:"fa-trash" },
  { key:"canSell",        label:"Sälj direkt (utan kassa)", icon:"fa-tag" },
  { key:"canUseCheckout", label:"Använd kassan (flera artiklar)", icon:"fa-cart-shopping" },
  { key:"canPrintReceipt",label:"Skriv ut kvitto", icon:"fa-receipt" },
  { key:"canExport",      label:"Exportera CSV",   icon:"fa-file-export" },
  { key:"canImport",      label:"Importera Excel/CSV", icon:"fa-file-import" },
  { key:"canViewLog",     label:"Visa säljlogg",   icon:"fa-chart-line" },
  { key:"canViewDashboard", label:"Visa dashboard", icon:"fa-table-cells-large" },
  { key:"canViewReports", label:"Visa rapporter",  icon:"fa-chart-pie" },
  { key:"canScan",        label:"Skanna QR-kod",   icon:"fa-qrcode" },
  { key:"canBulkEdit",    label:"Massredigera",    icon:"fa-layer-group" },
  { key:"canManageSuppliers", label:"Hantera leverantörer", icon:"fa-truck" },
  { key:"canBackup",      label:"Backup & återställning", icon:"fa-rotate" },
  { key:"canViewReservations", label:"Visa reservationer", icon:"fa-bookmark" },
  { key:"canAddReservations",  label:"Lägg till reservationer", icon:"fa-square-plus" },
  { key:"canEditReservations", label:"Ändra reservationer", icon:"fa-pen-to-square" },
  { key:"canViewActivityLog", label:"Visa aktivitetslogg", icon:"fa-clock-rotate-left" },
  { key:"canManageUsers", label:"Hantera användare", icon:"fa-users" },
  { key:"canManageSettings", label:"Ändra inställningar", icon:"fa-sliders" },
];

// Hjälpare: gör ett permissions-objekt med alla angivna nycklar satta till true
const permsFrom = (...keys) => Object.fromEntries(keys.map(k => [k, true]));

// Färdiga roller — admin kan redigera/lägga till/ta bort dessa.
// Sparas i ow:roles. Detta är standarduppsättningen som skapas första gången.
const DEFAULT_ROLES = [
  {
    id: "role_seller", name: "Säljare", color: "#1B3A6B",
    permissions: permsFrom("canView","canSell","canUseCheckout","canPrintReceipt","canScan","canViewReservations"),
  },
  {
    id: "role_warehouse", name: "Lagerarbetare", color: "#2E7D32",
    permissions: permsFrom("canView","canAdd","canEdit","canScan","canBulkEdit","canViewReservations","canAddReservations","canEditReservations"),
  },
  {
    id: "role_viewer", name: "Visning", color: "#757575",
    permissions: permsFrom("canView","canViewReservations"),
  },
];

const DEFAULT_CATEGORIES = ["Skärmar","Motorhuvar","Stötfångare","Dörrar","Spoilers","Sidokjolar","Bakluckor","Speglar","Rutor","Huvar","Övrigt"];
const DEFAULT_CONDITIONS = ["Ny","Begagnad - Gott skick","Begagnad - Liten spricka","Begagnad - Kräver lackering","Reservdelar / Skrotning"];
const DEFAULT_SIDES = ["","Vänster","Höger","Liksidig","Fram","Bak","Fram Vänster","Fram Höger","Bak Vänster","Bak Höger"];
const DEFAULT_LOCATION_TYPES = ["","Hylla","Låda","Hisshylla","Rum","Kontainer","Utomhus","Övrigt"];
// Bakåtkompatibilitet — dessa används som standard tills användaren redigerat listorna
const CATEGORIES = DEFAULT_CATEGORIES;
const CONDITIONS = DEFAULT_CONDITIONS;
const SIDES = DEFAULT_SIDES;
const LOCATION_TYPES = DEFAULT_LOCATION_TYPES;

// ── Bilmärkesgrupper ─────────────────────────────────────────────────────────
const BRAND_GROUPS = {
  "VW Group":       ["Volkswagen","VW","Audi","Skoda","Seat","Porsche","Lamborghini","Bentley","Cupra","MAN"],
  "Stellantis":     ["Peugeot","Citroën","Citroen","Opel","Vauxhall","Fiat","Alfa Romeo","Alfa-Romeo","Jeep","DS","Lancia","Chrysler","Dodge","Ram"],
  "Renault Group":  ["Renault","Dacia","Nissan","Mitsubishi"],
  "BMW Group":      ["BMW","Mini","Rolls-Royce"],
  "Mercedes Group": ["Mercedes","Mercedes-Benz","Smart","Maybach"],
  "Ford Group":     ["Ford","Lincoln"],
  "GM Group":       ["Chevrolet","Cadillac","Buick","GMC"],
  "Toyota Group":   ["Toyota","Lexus","Daihatsu","Hino"],
  "Honda Group":    ["Honda","Acura"],
  "Hyundai Group":  ["Hyundai","Kia","Genesis"],
  "Geely Group":    ["Volvo","Geely","Polestar","Lynk & Co"],
  "Tata Group":     ["Jaguar","Land Rover","Tata"],
  "Mazda":          ["Mazda"],
  "Subaru":         ["Subaru"],
  "Suzuki":         ["Suzuki"],
  "Tesla":          ["Tesla"],
};

// Normaliserar märkesnamn — "audi", "AUDI" → "Audi"
// Byggs från BRAND_GROUPS så det är alltid synkat
const MAKE_NORMALIZE = {};
Object.values(BRAND_GROUPS).flat().forEach(brand => {
  MAKE_NORMALIZE[brand.toLowerCase()] = brand;
});
// Extra stavningsvarianter
const MAKE_ALIASES = {
  "vw": "Volkswagen", "mercedes": "Mercedes-Benz", "merc": "Mercedes-Benz",
  "marcedes": "Mercedes-Benz", "merscedes": "Mercedes-Benz",
  "bmw": "BMW", "volov": "Volvo", "volvo": "Volvo",
  "citroen": "Citroën", "alfa romeo": "Alfa Romeo", "alfa-romeo": "Alfa Romeo",
  "land rover": "Land Rover", "landrover": "Land Rover",
  "rolls royce": "Rolls-Royce", "rollsroyce": "Rolls-Royce",
  "mini": "Mini", "seat": "Seat", "skoda": "Skoda",
  "peugeot": "Peugeot", "renault": "Renault", "dacia": "Dacia",
  "hyundai": "Hyundai", "hondai": "Hyundai", "kia": "Kia",
  "toyota": "Toyota", "honda": "Honda", "mazda": "Mazda",
  "ford": "Ford", "opel": "Opel", "fiat": "Fiat",
  "subaru": "Subaru", "suzuki": "Suzuki", "tesla": "Tesla",
  "nissan": "Nissan", "mitsubishi": "Mitsubishi",
};

function normalizeMake(make) {
  if (!make) return make;
  const m = make.trim().toLowerCase();
  if (MAKE_ALIASES[m]) return MAKE_ALIASES[m];
  if (MAKE_NORMALIZE[m]) return MAKE_NORMALIZE[m];
  // Kapitalisera första bokstaven om inget hittas
  return make.trim().charAt(0).toUpperCase() + make.trim().slice(1).toLowerCase();
}

function getBrandGroup(make) {
  if (!make) return null;
  const normalized = normalizeMake(make);
  const m = normalized.toLowerCase();
  for (const [group, brands] of Object.entries(BRAND_GROUPS)) {
    if (brands.some(b => b.toLowerCase() === m)) return group;
  }
  return null;
}

function genId(p="id") { return `${p}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }

// ── Universell kopiera-funktion — fungerar i Electron, webbläsare och HTTP ────
function copyText(text) {
  // Försök modern API först
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {
      legacyCopy(text);
    });
  }
  legacyCopy(text);
  return Promise.resolve();
}
function legacyCopy(text) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;left:-9999px;top:-9999px";
  document.body.appendChild(el);
  el.focus(); el.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(el);
}



const R="#CC1B2B", B="#1B3A6B", BG="#F4F5F7", WH="#FFFFFF", BD="#E2E5EA";
const TX="#141820", TM="#3D4451", MU="#8A90A0", GR="#16A34A", AM="#D97706";
const SH="0 1px 4px rgba(0,0,0,.08)", SH2="0 4px 20px rgba(0,0,0,.12)";

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@600;700;800&display=swap');
@import url('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css');
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;background:${BG};}
/* Blockera zoom på inputs för mobil */
@media (max-width:768px){
  input,select,textarea{font-size:16px!important;}
}
/* Landscape på mobil */
@media (max-width:768px) and (orientation:landscape){
  .page{padding-bottom:env(safe-area-inset-bottom)!important;}
}
/* PWA safe area — sätts via JS nedan */
.pwa-mode .topbar-safe{padding-top:env(safe-area-inset-top)!important;}
body{font-family:'Barlow',sans-serif;font-size:14px;color:${TX};-webkit-tap-highlight-color:transparent;}
input,select,textarea,button{font-family:'Barlow',sans-serif;outline:none;}
input:focus,select:focus,textarea:focus{border-color:${B}!important;box-shadow:0 0 0 3px ${B}18!important;}
select option{background:#fff;}
::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-thumb{background:#ccc;border-radius:3px}
@keyframes slideIn{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.page{animation:slideIn .2s ease both;}
.fade{animation:fadeIn .15s ease both;}

/* ── Responsive layout ── */
.app-shell{display:flex;height:100%;}
.sidebar{width:240px;flex-shrink:0;background:${WH};border-right:1px solid ${BD};display:flex;flex-direction:column;overflow-y:auto;}
.main-area{flex:1;overflow:hidden;position:relative;}
.content-wrap{max-width:900px;margin:0 auto;padding:20px 24px;}
.content-wrap-wide{max-width:1200px;margin:0 auto;padding:20px 24px;}
.card-grid{display:grid;grid-template-columns:1fr;gap:10px;}
.stat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}
.form-row{display:flex;flex-direction:column;gap:12px;}

@media(min-width:640px){
  .card-grid{grid-template-columns:repeat(2,1fr);}
  .stat-grid{grid-template-columns:repeat(3,1fr);}
}
@media(min-width:1024px){
  .card-grid{grid-template-columns:repeat(3,1fr);}
  .stat-grid{grid-template-columns:repeat(4,1fr);}
  .content-wrap{padding:28px 32px;}
  .content-wrap-wide{padding:28px 32px;}
  .form-row{flex-direction:row;}
}
@media(min-width:1280px){
  .card-grid{grid-template-columns:repeat(4,1fr);}
}

/* Desktop sidebar nav (hidden on mobile) */
@media(max-width:767px){
  .sidebar{display:none;}
  .desktop-only{display:none!important;}
}
@media(min-width:768px){
  .mobile-only{display:none!important;}
  .sidebar{display:flex;}
}
`;

// ─── Tiny UI ──────────────────────────────────────────────────────────────────
function Badge({ label, color=B, small }) {
  if (!label) return null;
  return <span style={{background:color+"18",color,border:`1px solid ${color}28`,borderRadius:4,padding:small?"1px 6px":"2px 8px",fontSize:small?10:11,fontWeight:600,letterSpacing:.3,whiteSpace:"nowrap",display:"inline-block"}}>{label}</span>;
}

function Btn({ children, variant="primary", small, full, disabled, onClick, style:sx={} }) {
  const v = { primary:{background:B,color:"#fff"}, red:{background:R,color:"#fff"}, success:{background:GR,color:"#fff"}, ghost:{background:WH,color:TM,border:`1px solid ${BD}`}, blue:{background:B+"12",color:B,border:`1px solid ${B}25`} };
  return <button disabled={disabled} onClick={onClick} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,padding:small?"5px 11px":"9px 16px",borderRadius:6,border:"none",fontWeight:600,fontSize:small?12:13,opacity:disabled?.45:1,width:full?"100%":"auto",cursor:"pointer",...v[variant],...sx}}>{children}</button>;
}

function Inp({ label, value, onChange, type="text", placeholder, min }) {
  return (
    <div style={{width:"100%"}}>
      {label && <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{label}</label>}
      <input type={type} value={value} onChange={onChange} placeholder={placeholder} min={min}
        style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,color:TX,background:WH}} />
    </div>
  );
}

function Sel({ label, value, onChange, options }) {
  return (
    <div style={{width:"100%"}}>
      {label && <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{label}</label>}
      <select value={value} onChange={onChange} style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,color:TX,background:WH,appearance:"none"}}>
        {options.map(o=><option key={o.v??o} value={o.v??o}>{o.l??o}</option>)}
      </select>
    </div>
  );
}

// Liten tagg för aktiva filter, med ✕ för att ta bort
function FilterTag({ label, onRemove }) {
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 6px 5px 11px",borderRadius:16,background:B+"12",border:`1px solid ${B}30`,color:B,fontSize:12,fontWeight:600,maxWidth:200}}>
      <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</span>
      <button onClick={onRemove} style={{background:B+"20",border:"none",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",color:B,flexShrink:0,padding:0}}>
        <i className="fa-solid fa-xmark" style={{fontSize:10}}/>
      </button>
    </span>
  );
}

function Field({ label, value, half }) {
  if (!value && value!==0) return null;
  return (
    <div style={{width:half?"calc(50% - 6px)":"100%",minWidth:0}}>
      <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:2}}>{label}</div>
      <div style={{fontSize:13,fontWeight:500,color:TX,wordBreak:"break-word"}}>{value}</div>
    </div>
  );
}

// ─── Page shell (handles scroll itself) ──────────────────────────────────────
function Page({ children, style:sx, noAnim, maxWidth, flush }) {
  // flush = sidan sköter sin egen scroll/layout (t.ex. kassan med fast fot)
  if (flush) {
    return (
      <div className={noAnim?"":"page"} style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",overflow:"hidden",background:BG,...sx}}>
        {children}
      </div>
    );
  }
  return (
    <div className={noAnim?"":"page"} style={{position:"absolute",inset:0,overflowY:"auto",WebkitOverflowScrolling:"touch",background:BG,...sx}}>
      <div style={maxWidth?{maxWidth,margin:"0 auto",width:"100%"}:{width:"100%"}}>
        {children}
      </div>
    </div>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────────
function TopBar({ title, onBack, right, subtitle }) {
  return (
    <div className="topbar-safe" style={{position:"sticky",top:0,zIndex:10,background:WH,borderBottom:`1px solid ${BD}`,boxShadow:SH,flexShrink:0}}><div style={{maxWidth:900,margin:"0 auto",display:"flex",alignItems:"center",minHeight:52,padding:"0 14px",gap:10}}>
      {onBack ? (
        <button onClick={onBack} style={{background:BG,border:`1px solid ${BD}`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",width:34,height:34,color:B,flexShrink:0,cursor:"pointer"}}>
          <svg viewBox="0 0 320 512" style={{width:12,height:12,fill:"currentColor"}}><path d="M9.4 233.4c-12.5 12.5-12.5 32.8 0 45.3l192 192c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L77.3 256 246.6 86.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-192 192z"/></svg>
        </button>
      ) : (
        <div style={{display:"flex",gap:3,flexShrink:0}}><div style={{width:5,height:26,background:R,borderRadius:3}}/><div style={{width:5,height:26,background:B,borderRadius:3}}/></div>
      )}
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:700,fontSize:17,color:TX,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.2}}>{title}</div>
        {subtitle&&<div style={{fontSize:10,color:MU,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>{subtitle}</div>}
      </div>
      {right && <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>{right}</div>}
    </div></div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
// ─── Icon — Font Awesome 6 (via CDN) ─────────────────────────────────────────
function Icon({ name, style={}, className="" }) {
  return <i className={`fa-solid fa-${name} ${className}`} style={{display:"inline-block",width:"1.25em",textAlign:"center",...style}} aria-hidden="true"/>;
}

// ─── Responsive hook ──────────────────────────────────────────────────────────
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return isMobile;
}

// ─── Desktop Sidebar ──────────────────────────────────────────────────────────
function Sidebar({ currentUser, isAdmin, can, push, currentPage, stack, setSession, toast$, cart }) {
  const cartCount = (cart||[]).reduce((a,r)=>a+r.qty,0);
  const [netInfo, setNetInfo] = useState(null);

  useEffect(() => {
    fetch("/api/network").then(r=>r.json()).then(setNetInfo).catch(()=>{});
  }, []);

  const navItems = [
    { icon:"house",        label:"Lager",          route:"inventory",  always:true },
    { icon:"cart-shopping",label:"Kassa",          route:"checkout",   show:(can("canUseCheckout")||isAdmin), badge:cartCount },
    { icon:"chart-line",   label:"Dashboard",      route:"dashboard",  show:(isAdmin||can("canViewDashboard")) },
    { icon:"chart-line",   label:"Rapporter",      route:"reports",    show:(isAdmin||can("canViewReports")) },
    { icon:"list",         label:"Säljlogg",       route:"saleslog",   show:(isAdmin||can("canViewLog")) },
    { icon:"bookmark",     label:"Reservationer",  route:"reservations", show:(isAdmin||can("canViewReservations")) },
    { icon:"clock-rotate-left", label:"Aktivitetslogg", route:"activitylog", show:(isAdmin||can("canViewActivityLog")) },
    { icon:"qrcode",       label:"Skanna",         route:"scan",       show:(isAdmin||can("canScan")) },
    { icon:"file-import",  label:"Importera",      route:"import",     show:(isAdmin||can("canImport")) },
    { icon:"layer-group",  label:"Massredigera",   route:"bulkedit",   show:(isAdmin||can("canBulkEdit")) },
    { icon:"qrcode",       label:"Etiketter",       route:"qrlabels",   show:isAdmin },
    { icon:"location-dot", label:"Platser",          route:"locationview", show:(isAdmin||can("canView")) },
    { icon:"truck",        label:"Leverantörer",   route:"suppliers",  show:(isAdmin||can("canManageSuppliers")) },
    { icon:"users",        label:"Användare",      route:"users",      show:(isAdmin||can("canManageUsers")) },
    { icon:"rotate",       label:"Backup",         route:"backup",     show:(isAdmin||can("canBackup")) },
    { icon:"sliders",      label:"Inställningar",  route:"settings",   show:(isAdmin||can("canManageSettings")) },
  ].filter(i => i.always || i.show);

  const active = stack[stack.length-1]?.name;

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      {/* Logo */}
      <div style={{padding:"18px 20px 14px",borderBottom:`1px solid ${BD}`}}>
        <div style={{display:"flex",gap:4,marginBottom:8}}>
          <div style={{width:5,height:28,background:R,borderRadius:3}}/><div style={{width:5,height:28,background:B,borderRadius:3}}/>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:TX,marginLeft:8,alignSelf:"center"}}>Lager</span>
        </div>
        {currentUser && (
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:28,height:28,borderRadius:7,background:isAdmin?R:B,display:"flex",alignItems:"center",justifyContent:"center",color:WH,fontWeight:800,fontSize:12,flexShrink:0}}>
              {currentUser.username[0].toUpperCase()}
            </div>
            <div style={{minWidth:0}}>
              <div style={{fontWeight:700,fontSize:12,color:TX,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{currentUser.username}</div>
              <div style={{fontSize:10,color:MU}}>{isAdmin?"Admin":"Användare"}</div>
            </div>
          </div>
        )}
      </div>

      {/* Nav items */}
      <nav style={{flex:1,overflowY:"auto",padding:"8px 10px"}}>
        {navItems.map(item => {
          const isActive = active === item.route;
          return (
            <button key={item.route} onClick={()=>push(item.route)}
              style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,border:"none",background:isActive?B+"10":"transparent",color:isActive?B:TM,fontWeight:isActive?700:500,fontSize:13,cursor:"pointer",marginBottom:2,textAlign:"left",position:"relative"}}>
              <Icon name={item.icon} style={{fontSize:15,color:isActive?B:MU,flexShrink:0}}/>
              <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</span>
              {item.badge>0 && <span style={{background:R,color:WH,borderRadius:10,padding:"1px 6px",fontSize:10,fontWeight:800}}>{item.badge}</span>}
              {isActive && <div style={{position:"absolute",left:0,top:4,bottom:4,width:3,background:B,borderRadius:2}}/>}
            </button>
          );
        })}
      </nav>

      {/* Nätverksadresser */}
      {netInfo?.ips?.length>0 && (
        <div style={{padding:"10px 12px",borderTop:`1px solid ${BD}`,background:BG}}>
          <div style={{fontSize:9,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>
            <i className="fa-solid fa-wifi" style={{marginRight:4}}/>Nå appen från nätverk
          </div>
          {netInfo.ips.map(ip=>(
            <div key={ip} onClick={()=>{
              const url = `http://${ip}:${netInfo.port}`;
              copyText(url).then(()=>toast$("Kopierad!","success"));
            }}
              style={{display:"flex",alignItems:"center",gap:6,padding:"4px 6px",borderRadius:5,cursor:"pointer",marginBottom:2,background:WH,border:`1px solid ${BD}`}}
              title="Klicka för att kopiera">
              <i className="fa-solid fa-copy" style={{fontSize:9,color:MU,flexShrink:0}}/>
              <span style={{fontSize:10,fontFamily:"monospace",fontWeight:700,color:B,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {ip}:{netInfo.port}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Logout */}
      {currentUser && (
        <div style={{padding:"10px",borderTop:`1px solid ${BD}`}}>
          <button onClick={()=>{clearSession();setSession(null);toast$("Utloggad");push("inventory");}}
            style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"9px 10px",borderRadius:8,border:"none",background:"transparent",color:R,fontWeight:500,fontSize:13,cursor:"pointer"}}>
            <Icon name="right-from-bracket" style={{fontSize:14,color:R}}/>
            Logga ut
          </button>
        </div>
      )}
    </div>
  );
}


export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}

function AppInner() {
  const [users, setUsers] = useState(null);
  const [items, setItems] = useState(null);
  const [session, setSession] = useState(() => loadSession());
  const [loaded, setLoaded] = useState(false);
  const lastSyncRef = useRef(0);
  const [toast, setToast] = useState(null);
  const tRef = useRef();
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  // Detektera PWA standalone-läge och lägg till klass på html
  useEffect(() => {
    const isPWA = window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
    if (isPWA) document.documentElement.classList.add("pwa-mode");
  }, []);

  // PWA install prompt
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
      setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const installApp = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") setShowInstallBanner(false);
    setInstallPrompt(null);
  };

  const [viewMode, setViewMode] = useState("cards");
  const [filters, setFilters] = useState({ cats:[], conds:[], sides:[], make:"", brandGroup:"", locationType:"", model:"", yearMin:"", yearMax:"", priceMin:"", priceMax:"", low:false, supplier:"", stockNums:"", artNums:"", reserved:false, noImage:false });
  const [search, setSearch] = useState("");
  const [sortPref, setSortPref] = useState({ by:"stockNumber", dir:"asc" });
  const applyFilters = useCallback(f => setFilters(f), []);
  // page stack: each entry = { name, props }
  const [stack, setStack] = useState([{ name:"inventory" }]);
  const push = (name, props={}) => setStack(s => [...s, { name, props }]);
  const pop  = () => setStack(s => s.length > 1 ? s.slice(0,-1) : s);
  const replace = (name, props={}) => setStack(s => [...s.slice(0,-1), { name, props }]);
  const current = stack[stack.length - 1];

  // ── Delbara länkar — synkar adressfältet med ?item=ID när en artikel visas ──
  // Gör att man kan kopiera URL:en och dela en specifik del med kollegor,
  // och att den artikeln öppnas direkt om länken klistras in i webbläsaren.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (current.name === "detail" && current.props?.item?.id) {
        url.searchParams.set("item", current.props.item.id);
      } else {
        url.searchParams.delete("item");
      }
      window.history.replaceState(null, "", url.toString());
    } catch {}
  }, [current]);

  useEffect(() => {
    (async () => {
      let u  = await sget("ow:users");     if (!u)  { u=[DEFAULT_ADMIN];  await sset("ow:users",u);  }
      let i  = await sget("ow:items");     if (!i)  { i=DEFAULT_ITEMS;    await sset("ow:items",i);  }
      let s  = await sget("ow:sales");     if (!s)  { s=[]; }
      let al = await sget("ow:activitylog"); if (!al) { al=[]; }
      let st = await sget("ow:settings"); if (!st) { st={ companyName:"", companyOrg:"", companyPhone:"", companyAddress:"", defaultMargin:40, currency:"SEK" }; }
      let sup = await sget("ow:suppliers"); if (!sup) { sup=[]; }
      let fav = await sget("ow:favorites"); if (!fav) { fav=[]; }
      let rl = await sget("ow:roles"); if (!rl || !Array.isArray(rl) || rl.length===0) { rl=DEFAULT_ROLES; await sset("ow:roles",rl); }
      let lst = await sget("ow:lists");
      if (!lst || typeof lst !== "object") { lst = { categories: DEFAULT_CATEGORIES, conditions: DEFAULT_CONDITIONS, sides: DEFAULT_SIDES, locationTypes: DEFAULT_LOCATION_TYPES }; await sset("ow:lists",lst); }
      else {
        lst = {
          categories: lst.categories || DEFAULT_CATEGORIES,
          conditions: lst.conditions || DEFAULT_CONDITIONS,
          sides: lst.sides || DEFAULT_SIDES,
          locationTypes: lst.locationTypes || DEFAULT_LOCATION_TYPES,
        };
      }

      // Strippa ev. inbäddade bilder så listan hålls lätt och snabb
      if (Array.isArray(i) && i.some(it=>it.images?.length>0)) {
        i = i.map(it => it.images?.length>0 ? {...it, images:[], hasImages:it.images.length} : it);
      }
      // Sätt delta-synk-vattenmärket till senaste kända ändring
      lastSyncRef.current = Array.isArray(i) ? i.reduce((a,it)=>Math.max(a,it.updatedAt||0),0) : 0;

      setUsers(u); setItems(i); setSales(s); setActivityLog(al); setSettings(st); setSuppliers(sup); setFavorites(fav); setRoles(rl); setLists(lst); setLoaded(true);

      // Öppna direkt på artikeln om URL:en innehåller ?item=ID (delad länk)
      try {
        const sharedId = new URL(window.location.href).searchParams.get("item");
        if (sharedId) {
          const found = i.find(x=>x.id===sharedId);
          if (found) setStack([{ name:"inventory" }, { name:"detail", props:{item:found} }]);
        }
      } catch {}
    })();
  }, []);

  // Håll en ref till stack så polling-intervallet aldrig återskapas
  const stackRef = useRef(stack);
  useEffect(() => { stackRef.current = stack; }, [stack]);

  useEffect(() => {
    // EN enda interval — delta-synk: hämtar BARA ändrade artiklar, inte hela listan
    const id = setInterval(async () => {
      const onEditPage = stackRef.current.some(s => ["edit","sell","checkout","bulkedit","import"].includes(s.name));
      if (onEditPage) return;
      try {
        const r = await fetch(`${API}/delta?since=${lastSyncRef.current}`).then(r=>r.json());
        if (!r || !Array.isArray(r.allIds)) return;
        lastSyncRef.current = r.maxUpdatedAt || lastSyncRef.current;
        setItems(prev => {
          // Inga ändringar och samma antal → behåll exakt samma referens (ingen re-render)
          if ((!r.changed || r.changed.length === 0) && prev.length === r.total) return prev;
          // Bygg en map för snabb uppslagning
          const map = new Map(prev.map(it => [it.id, it]));
          // Applicera ändrade artiklar (strippa ev. bilder för att hålla minnet lågt)
          for (const it of (r.changed || [])) {
            const light = it.images?.length>0 ? {...it, images:[], hasImages:it.images.length} : it;
            map.set(it.id, light);
          }
          // Ta bort artiklar som inte längre finns på servern
          const serverIds = new Set(r.allIds);
          for (const id of map.keys()) if (!serverIds.has(id)) map.delete(id);
          // Bevara serverns ordning
          return r.allIds.map(id => map.get(id)).filter(Boolean);
        });
      } catch {}
    }, 10000);
    return () => clearInterval(id);
  }, []); // Tom dependency — körs bara en gång

  const toast$ = useCallback((msg, type="info") => {
    setToast({msg,type}); clearTimeout(tRef.current);
    tRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const [sales, setSales] = useState([]);
  const [cart, setCart] = useState([]);
  const [activityLog, setActivityLog] = useState([]);
  const [settings, setSettings] = useState({ companyName:"", companyOrg:"", companyPhone:"", companyAddress:"", defaultMargin:40, currency:"SEK", lowStockAlert:2 });
  const [suppliers, setSuppliers] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [roles, setRoles] = useState(DEFAULT_ROLES);
  const [lists, setLists] = useState({ categories: DEFAULT_CATEGORIES, conditions: DEFAULT_CONDITIONS, sides: DEFAULT_SIDES, locationTypes: DEFAULT_LOCATION_TYPES });

  const saveSales     = useCallback(async v => { setSales(v);     await sset("ow:sales",v);     }, []);
  const saveItems     = useCallback(async v => { setItems(v);     await sset("ow:items",v);     }, []);
  const saveUsers     = useCallback(async v => { setUsers(v);     await sset("ow:users",v);     }, []);
  const saveSettings  = useCallback(async v => { setSettings(v); await sset("ow:settings",v);  }, []);
  const saveSuppliers = useCallback(async v => { setSuppliers(v);await sset("ow:suppliers",v); }, []);
  const saveRoles = useCallback(async v => { setRoles(v); await sset("ow:roles",v); }, []);
  const saveLists = useCallback(async v => { setLists(v); await sset("ow:lists",v); }, []);
  const saveFavorites = useCallback(async v => { setFavorites(v);await sset("ow:favorites",v); }, []);

  const logActivity = useCallback(async (type, description, extra={}) => {
    const entry = { id:genId("log"), type, description, ...extra, ts:Date.now() };
    setActivityLog(prev => {
      const next = [entry, ...prev].slice(0,500);
      sset("ow:activitylog", next);
      return next;
    });
  }, []);

  const addToCart = useCallback((item, qty=1) => {
    // Försök låsa delen för kassan — så ingen annan kan sälja/redigera den
    const meUser = session ? (users.find(u=>u.id===session)?.username || "Okänd") : "Okänd";
    lockAcquire(item.id, meUser, "cart").then(r => {
      if (!r.ok && r.lockedBy && r.lockedBy !== meUser) {
        toast$(`${r.lockedBy} ${r.action==="cart"?"har redan den i sin kassa":"redigerar den"} — kunde inte läggas till`, "error");
        return;
      }
      setCart(c => {
        const existing = c.find(r2 => r2.item.id === item.id);
        if (existing) return c.map(r2 => r2.item.id === item.id ? {...r2, qty: r2.qty + qty} : r2);
        return [...c, { item, qty, unitPrice: item.price, discountMode:"pct", discountPct:0, discountKr:0 }];
      });
    });
  }, [session, users]);
  const clearCart = useCallback(() => {
    // Släpp alla kassa-lås
    const meUser = session ? (users.find(u=>u.id===session)?.username || "Okänd") : "Okänd";
    setCart(c => { c.forEach(r => lockRelease(r.item.id, meUser)); return []; });
  }, [session, users]);

  // Must be before any early returns (Rules of Hooks)
  const isMobile = useIsMobile();

  if (!loaded) return (
    <div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <style>{CSS}</style>
      <div style={{width:32,height:32,border:`3px solid ${BD}`,borderTopColor:B,borderRadius:"50%",animation:"spin .8s linear infinite"}}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  const currentUser = session ? users.find(u=>u.id===session) : null;
  const isAdmin = currentUser?.role === "admin";
  const can = p => {
    if (!currentUser) return p==="canView";
    if (isAdmin) return true;
    // Behörighet från rollen (om användaren har en roll) + ev. egna extra behörigheter
    const role = currentUser.roleId ? roles.find(r => r.id === currentUser.roleId) : null;
    if (role?.permissions?.[p]) return true;
    return !!currentUser.permissions?.[p];
  };

  const sharedProps = { users, items, sales, cart, addToCart, clearCart, activityLog, logActivity, settings, saveSettings, suppliers, saveSuppliers, favorites, saveFavorites, saveItems, saveUsers, saveSales, roles, saveRoles, lists, saveLists, session, setSession, currentUser, isAdmin, can, toast$, push, pop, replace, viewMode, setViewMode, filters, applyFilters, search, setSearch, sortPref, setSortPref, setItems, setSales, setSettings, setSuppliers };
  const showSidebar = !isMobile && currentUser;

  return (
    <div style={{position:"fixed",inset:0,overflow:"hidden",background:BG,display:"flex",flexDirection:"column"}}>
      <style>{CSS}</style>

      {toast && (
        <div className="fade" style={{position:"fixed",bottom:20,left:"50%",transform:"translateX(-50%)",background:toast.type==="error"?R:toast.type==="success"?GR:B,color:"#fff",padding:"10px 20px",borderRadius:8,zIndex:999,fontSize:13,fontWeight:500,boxShadow:SH2,whiteSpace:"nowrap",pointerEvents:"none"}}>
          {toast.msg}
        </div>
      )}

      {/* PWA Install Banner */}
      {showInstallBanner && (
        <div style={{position:"fixed",bottom:0,left:0,right:0,background:B,color:WH,padding:"12px 16px",zIndex:998,display:"flex",alignItems:"center",gap:12,boxShadow:"0 -4px 20px rgba(0,0,0,.2)"}}>
          <div style={{width:36,height:36,background:R,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:18}}>
            <i className="fa-solid fa-box-open"/>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:13}}>Installera Lager</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,.7)"}}>Lägg till på hemskärmen</div>
          </div>
          <button onClick={installApp} style={{background:WH,color:B,border:"none",borderRadius:8,padding:"8px 14px",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0}}>
            Installera
          </button>
          <button onClick={()=>setShowInstallBanner(false)} style={{background:"none",border:"none",color:"rgba(255,255,255,.6)",fontSize:18,cursor:"pointer",padding:"4px",flexShrink:0}}>
            ✕
          </button>
        </div>
      )}

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        {/* Desktop sidebar */}
        {showSidebar && (
          <div style={{width:220,flexShrink:0,background:WH,borderRight:`1px solid ${BD}`,overflowY:"auto"}}>
            <Sidebar currentUser={currentUser} isAdmin={isAdmin} can={can} push={name=>push(name)} currentPage={current.name} stack={stack} setSession={setSession} toast$={toast$} cart={cart}/>
          </div>
        )}

        {/* Main content */}
        <div style={{flex:1,overflow:"hidden",position:"relative"}}>
          {current.name === "dashboard"    && <DashboardPage    {...sharedProps} />}
          {current.name === "inventory"    && <InventoryPage    {...sharedProps} {...current.props} />}
          {current.name === "detail"       && <DetailPage       {...sharedProps} {...current.props} />}
          {current.name === "filter"       && <FilterPage       {...sharedProps} {...current.props} />}
          {current.name === "edit"         && <EditPage         {...sharedProps} {...current.props} />}
          {current.name === "sell"         && <SellPage         {...sharedProps} {...current.props} />}
          {current.name === "checkout"     && <CheckoutPage     {...sharedProps} />}
          {current.name === "login"        && <LoginPage        {...sharedProps} />}
          {current.name === "users"        && <UsersPage        {...sharedProps} />}
          {current.name === "roles"        && <RolesPage        {...sharedProps} />}
          {current.name === "managelists"  && <ManageListsPage  {...sharedProps} />}
          {current.name === "editrole"     && <EditRolePage     {...sharedProps} {...current.props} />}
          {current.name === "edituser"     && <EditUserPage     {...sharedProps} {...current.props} />}
          {current.name === "perms"        && <PermsPage        {...sharedProps} {...current.props} />}
          {current.name === "saleslog"     && <SalesLogPage     {...sharedProps} />}
          {current.name === "reservations" && <ReservationsPage {...sharedProps} />}
          {current.name === "scan"         && <ScanPage         {...sharedProps} {...current.props} />}
          {current.name === "receipt"      && <ReceiptPage      {...sharedProps} {...current.props} />}
          {current.name === "qrlabels"     && <QrLabelsPage     {...sharedProps} {...current.props} />}
          {current.name === "locationview"  && <LocationViewPage {...sharedProps} {...current.props} />}
          {current.name === "import"       && <ImportPage       {...sharedProps} />}
          {current.name === "variants"     && <VariantsPage     {...sharedProps} {...current.props} />}
          {current.name === "reports"      && <ReportsPage      {...sharedProps} />}
          {current.name === "activitylog"  && <ActivityLogPage  {...sharedProps} />}
          {current.name === "settings"     && <SettingsPage     {...sharedProps} />}
          {current.name === "bulkedit"     && <BulkEditPage     {...sharedProps} />}
          {current.name === "suppliers"    && <SuppliersPage    {...sharedProps} />}
          {current.name === "backup"       && <BackupPage       {...sharedProps} />}
        </div>
      </div>
    </div>
  );
}



// ─── Checkout Page ────────────────────────────────────────────────────────────
function CheckoutPage({ cart, addToCart, clearCart, items, sales, saveItems, saveSales, currentUser, isAdmin, can, push, pop, toast$, logActivity }) {
  const [rows, setRows] = useState(() =>
    cart.map(r => ({ ...r, key: r.item.id + "-" + Date.now() }))
  );
  const [buyer, setBuyer] = useState("");
  const [payMethod, setPayMethod] = useState("kontant"); // kontant | swish | kort
  const [cashGiven, setCashGiven] = useState("");
  const [note, setNote] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const updateRow = (key, field, val) =>
    setRows(rs => rs.map(r => r.key===key ? {...r, [field]: val} : r));

  const removeRow = (key) => setRows(rs => rs.filter(r => r.key!==key));

  const VAT_RATE = 0.25;
  const addItemToRows = (item) => {
    setRows(rs => {
      const existing = rs.find(r => r.item.id===item.id);
      if (existing) return rs.map(r => r.item.id===item.id ? {...r, qty: r.qty+1} : r);
      return [...rs, { item, qty:1, unitPrice:item.price, priceMode:"incl", discountMode:"pct", discountPct:0, discountKr:0, key: item.id+"-"+Date.now() }];
    });
  };

  // rowTotal: unitPrice tolkas som inkl ELLER exkl moms beroende på radens priceMode.
  // finalPrice/lineTotal är alltid INKL moms (det kunden betalar).
  const rowTotal = r => {
    const base = r.discountMode==="pct"
      ? Math.round(r.unitPrice*(1-r.discountPct/100))
      : Math.max(0, r.unitPrice - r.discountKr);
    const fpIncl = (r.priceMode==="excl") ? Math.round(base*(1+VAT_RATE)) : base;
    const fpExcl = (r.priceMode==="excl") ? base : Math.round(base/(1+VAT_RATE));
    return { finalPrice: fpIncl, finalExcl: fpExcl, lineTotal: r.qty * fpIncl, lineExcl: r.qty * fpExcl };
  };

  const grandTotal = rows.reduce((a,r) => a + rowTotal(r).lineTotal, 0);
  const change = payMethod==="kontant" && cashGiven ? Math.max(0, Number(cashGiven) - grandTotal) : null;
  const canCheckout = rows.length > 0 && rows.every(r => r.qty > 0 && r.qty <= r.item.quantity);

  const checkout = async () => {
    if (!canCheckout) return;
    const now = Date.now();
    const receiptId = genId("rec");
    const saleEntries = rows.map(r => {
      const { finalPrice, finalExcl, lineTotal, lineExcl } = rowTotal(r);
      const effDisc = r.unitPrice>0 ? Math.round((1-(r.priceMode==="excl"?finalExcl:finalPrice)/r.unitPrice)*100) : 0;
      return {
        id: genId("sale"),
        receiptId,
        itemId: r.item.id,
        itemName: r.item.name,
        itemSku: r.item.sku,
        itemStockNumber: r.item.stockNumber||"",
        itemSide: r.item.side||"",
        qty: r.qty,
        unitPrice: finalPrice,
        priceInclVat: finalPrice,
        priceExclVat: finalExcl,
        vatPerUnit: finalPrice - finalExcl,
        vatRate: VAT_RATE,
        totalExclVat: lineExcl,
        totalVat: lineTotal - lineExcl,
        originalPrice: r.item.price,
        manualPrice: r.unitPrice !== r.item.price ? r.unitPrice : null,
        discount: effDisc,
        discountKr: r.unitPrice - finalPrice,
        total: lineTotal,
        costPrice: r.item.costPrice||0,
        profit: lineExcl - r.qty*(r.item.costPrice||0),
        buyer: buyer.trim()||"Okänd",
        payMethod,
        note: note.trim(),
        soldBy: currentUser?.username||"Okänd",
        soldAt: now,
        // Snapshot — gör att delen kan återskapas helt om man ångrar köpet
        itemSnapshot: {
          name:r.item.name, oem:r.item.oem, sku:r.item.sku, side:r.item.side,
          stockNumber:r.item.stockNumber, category:r.item.category, condition:r.item.condition,
          make:r.item.make, model:r.item.model, location:r.item.location, locationType:r.item.locationType,
          regNumber:r.item.regNumber, price:r.item.price, costPrice:r.item.costPrice,
          notes:r.item.notes, supplier:r.item.supplier,
        },
      };
    });

    // Deduct stock
    // Uppdatera varje såld artikel — ta bort om antal når 0
    let latestItems = items;
    for (const entry of saleEntries) {
      const it = latestItems.find(i=>i.id===entry.itemId);
      if (it) {
        const newQty = it.quantity - entry.qty;
        if (newQty <= 0) {
          const res = await deleteOneItem(entry.itemId);
          if (res) latestItems = res;
          else latestItems = latestItems.filter(i=>i.id!==entry.itemId);
        } else {
          const updatedItem = {...it, quantity:newQty, updatedAt:now};
          const res = await saveOneItem(updatedItem);
          if (res) latestItems = res;
          else latestItems = latestItems.map(i=>i.id===entry.itemId?updatedItem:i);
        }
      }
    }
    saveItems(latestItems);
    await saveSales([...saleEntries, ...(sales||[])]);
    logActivity&&logActivity("sale", `Kassaköp: ${saleEntries.reduce((a,e)=>a+e.qty,0)} delar för ${grandTotal.toLocaleString("sv-SE")} kr (${buyer.trim()||"Okänd"})`, { user: currentUser?.username });
    clearCart();

    toast$(`Kassa klar — ${grandTotal.toLocaleString("sv-SE")} kr`, "success");
    push("receipt", { sale: saleEntries[0], receiptRows: saleEntries, payMethod, cashGiven: Number(cashGiven)||0, change: change||0 });
  };

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const searchResults = searchQ.length > 1
    ? items.filter(i => i.quantity > 0 && (i.name.toLowerCase().includes(searchQ.toLowerCase()) || i.sku.toLowerCase().includes(searchQ.toLowerCase()))).slice(0,6)
    : [];

  return (
    <Page flush noAnim>
      <TopBar title="Kassa" onBack={pop} subtitle="Varukorg & betalning" right={
        rows.length>0 ? <button onClick={()=>setConfirmClear(true)} style={{background:"none",border:"none",color:R,fontWeight:600,fontSize:12}}>Töm korg</button> : null
      }/>
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px 14px 20px"}}>

        {/* Empty cart */}
        {rows.length===0 && (
          <div style={{textAlign:"center",padding:"60px 20px",color:MU}}>
            <Icon name="cart-shopping" style={{fontSize:48,display:"block",margin:"0 auto 16px",color:BD}}/>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Korgen är tom</div>
            <div style={{fontSize:13,marginBottom:20}}>Lägg till delar från lagerlistan med korg-knappen</div>
            <Btn onClick={()=>push("inventory")}>Gå till lagret</Btn>
          </div>
        )}

        {/* Cart rows */}
        {rows.map(r => {
          const { finalPrice, finalExcl, lineTotal, lineExcl } = rowTotal(r);
          const priceChanged = r.unitPrice !== r.item.price;
          const hasDisc = r.discountPct>0 || r.discountKr>0;
          const overStock = r.qty > r.item.quantity;
          return (
            <div key={r.key} style={{background:WH,borderRadius:10,border:`1px solid ${overStock?R:BD}`,padding:14,marginBottom:10}}>
              <div style={{display:"flex",gap:10,marginBottom:10}}>
                <div style={{width:44,height:44,borderRadius:7,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {(r.item.thumb||r.item.images?.[0])?<img src={r.item.thumb||r.item.images[0]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon name="wrench" style={{color:MU}}/>}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                    {r.item.stockNumber&&<span style={{background:B,color:WH,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:800,flexShrink:0}}>#{r.item.stockNumber}</span>}
                    <div style={{fontWeight:700,fontSize:13,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.item.name}{r.item.side?` — ${r.item.side}`:""}</div>
                  </div>
                  <div style={{fontSize:11,color:MU}}>I lager: <span style={{color:sc(r.item.quantity),fontWeight:600}}>{r.item.quantity} st</span></div>
                </div>
                <button onClick={()=>removeRow(r.key)} style={{background:"none",border:"none",color:MU,fontSize:16,padding:"2px 4px",flexShrink:0}}>✕</button>
              </div>

              {/* Qty + Price + Discount */}
              <div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr",gap:8,marginBottom:8}}>
                <div>
                  <label style={{display:"block",fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",marginBottom:3}}>Antal</label>
                  <div style={{display:"flex",alignItems:"center",border:`1.5px solid ${overStock?R:BD}`,borderRadius:6,overflow:"hidden"}}>
                    <button onClick={()=>updateRow(r.key,"qty",Math.max(1,r.qty-1))} style={{padding:"6px 8px",background:BG,border:"none",fontWeight:700,fontSize:14,cursor:"pointer"}}>−</button>
                    <input type="number" min="1" value={r.qty} onChange={e=>updateRow(r.key,"qty",Math.max(1,Number(e.target.value)))}
                      style={{width:"100%",textAlign:"center",border:"none",fontSize:13,fontWeight:700,padding:"6px 0",color:overStock?R:TX}}/>
                    <button onClick={()=>updateRow(r.key,"qty",r.qty+1)} style={{padding:"6px 8px",background:BG,border:"none",fontWeight:700,fontSize:14,cursor:"pointer"}}>+</button>
                  </div>
                  {overStock && <div style={{fontSize:9,color:R,fontWeight:700,marginTop:2}}>Max {r.item.quantity}</div>}
                </div>

                <div>
                  <label style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,fontWeight:700,color:priceChanged?B:MU,textTransform:"uppercase",marginBottom:3,gap:2}}>
                    <span>Pris/st</span>
                    <div style={{display:"flex",gap:2,background:BG,borderRadius:4,padding:1}}>
                      <button onClick={()=>updateRow(r.key,"priceMode","incl")} style={{padding:"1px 5px",borderRadius:3,border:"none",background:(r.priceMode||"incl")==="incl"?WH:"transparent",color:(r.priceMode||"incl")==="incl"?B:MU,fontSize:9,fontWeight:700,cursor:"pointer"}}>ink</button>
                      <button onClick={()=>updateRow(r.key,"priceMode","excl")} style={{padding:"1px 5px",borderRadius:3,border:"none",background:r.priceMode==="excl"?WH:"transparent",color:r.priceMode==="excl"?B:MU,fontSize:9,fontWeight:700,cursor:"pointer"}}>exk</button>
                    </div>
                  </label>
                  <input type="number" min="0" value={r.unitPrice} onChange={e=>updateRow(r.key,"unitPrice",Math.max(0,Number(e.target.value)))}
                    style={{width:"100%",padding:"7px 8px",border:`1.5px solid ${priceChanged?B:BD}`,borderRadius:6,fontSize:13,fontWeight:priceChanged?700:400,color:priceChanged?B:TX,background:priceChanged?B+"08":WH}}/>
                </div>

                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                    <label style={{fontSize:10,fontWeight:700,color:hasDisc?AM:MU,textTransform:"uppercase"}}>Rabatt</label>
                    <div style={{display:"flex",gap:2,background:BG,borderRadius:4,padding:1}}>
                      <button onClick={()=>{ updateRow(r.key,"discountMode","pct"); updateRow(r.key,"discountKr",0); }}
                        style={{padding:"2px 6px",borderRadius:3,border:"none",background:r.discountMode==="pct"?WH:"transparent",color:r.discountMode==="pct"?B:MU,fontSize:9,fontWeight:700,cursor:"pointer"}}>%</button>
                      <button onClick={()=>{ updateRow(r.key,"discountMode","kr"); updateRow(r.key,"discountPct",0); }}
                        style={{padding:"2px 6px",borderRadius:3,border:"none",background:r.discountMode==="kr"?WH:"transparent",color:r.discountMode==="kr"?B:MU,fontSize:9,fontWeight:700,cursor:"pointer"}}>kr</button>
                    </div>
                  </div>
                  {r.discountMode==="pct"
                    ? <input type="number" min="0" max="100" value={r.discountPct} onChange={e=>updateRow(r.key,"discountPct",Math.min(100,Math.max(0,Number(e.target.value))))}
                        placeholder="0" style={{width:"100%",padding:"7px 8px",border:`1.5px solid ${hasDisc?AM:BD}`,borderRadius:6,fontSize:13}}/>
                    : <input type="number" min="0" value={r.discountKr} onChange={e=>updateRow(r.key,"discountKr",Math.max(0,Number(e.target.value)))}
                        placeholder="0" style={{width:"100%",padding:"7px 8px",border:`1.5px solid ${hasDisc?AM:BD}`,borderRadius:6,fontSize:13}}/>
                  }
                </div>
              </div>

              {/* Row total */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:8,borderTop:`1px solid ${BD}50`}}>
                <div style={{fontSize:11,color:MU}}>{r.qty} st · {lineExcl.toLocaleString("sv-SE")} exkl + {(lineTotal-lineExcl).toLocaleString("sv-SE")} moms</div>
                <div style={{fontWeight:800,fontSize:15,color:B}}>{lineTotal.toLocaleString("sv-SE")} kr</div>
              </div>
            </div>
          );
        })}

        {/* Add more items search */}
        {rows.length>0 && (
          <div style={{marginBottom:14}}>
            {!searchOpen
              ? <button onClick={()=>setSearchOpen(true)} style={{width:"100%",padding:"10px",borderRadius:8,border:`1.5px dashed ${BD}`,background:"transparent",color:MU,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
                  <Icon name="plus"/> Lägg till fler delar
                </button>
              : <div>
                  <input autoFocus value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Sök artikel att lägga till..."
                    style={{width:"100%",padding:"10px 12px",border:`1.5px solid ${B}`,borderRadius:8,fontSize:13,marginBottom:6}}/>
                  {searchResults.length>0 && (
                    <div style={{background:WH,borderRadius:8,border:`1px solid ${BD}`,overflow:"hidden"}}>
                      {searchResults.map(i=>(
                        <button key={i.id} onClick={()=>{ addItemToRows(i); setSearchQ(""); setSearchOpen(false); }}
                          style={{width:"100%",textAlign:"left",padding:"10px 12px",border:"none",borderBottom:`1px solid ${BD}50`,background:WH,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div>
                            <div style={{fontWeight:600,fontSize:13}}>{i.name}{i.side?` — ${i.side}`:""}</div>
                            <div style={{fontSize:11,color:MU}}>{i.sku} · {i.quantity} i lager</div>
                          </div>
                          <div style={{fontWeight:700,color:B,fontSize:13}}>{i.price.toLocaleString("sv-SE")} kr</div>
                        </button>
                      ))}
                    </div>
                  )}
                  <button onClick={()=>{setSearchOpen(false);setSearchQ("");}} style={{marginTop:4,background:"none",border:"none",color:MU,fontSize:12,cursor:"pointer"}}>Avbryt</button>
                </div>
            }
          </div>
        )}

        {/* Buyer + Note */}
        {rows.length>0 && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14,display:"flex",flexDirection:"column",gap:10}}>
            <Inp label="Kund / köpare (valfritt)" value={buyer} onChange={e=>setBuyer(e.target.value)} placeholder="Namn"/>
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Notering (valfritt)</label>
              <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} placeholder="T.ex. fordonsinfo, avtalt pris..."
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"none",fontFamily:"inherit",color:TX}}/>
            </div>
          </div>
        )}

        {/* Payment method */}
        {rows.length>0 && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Betalningssätt</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
              {[["kontant","Kontant"],["swish","Swish"],["kort","Kort"]].map(([k,l])=>(
                <button key={k} onClick={()=>setPayMethod(k)}
                  style={{padding:"10px 6px",borderRadius:8,border:`2px solid ${payMethod===k?B:BD}`,background:payMethod===k?B+"08":WH,color:payMethod===k?B:TX,fontWeight:payMethod===k?700:500,fontSize:13,cursor:"pointer"}}>
                  {l}
                </button>
              ))}
            </div>
            {payMethod==="kontant" && (
              <div>
                <Inp label="Betalt med (kr)" type="number" min="0" value={cashGiven} onChange={e=>setCashGiven(e.target.value)} placeholder={grandTotal.toString()}/>
                {cashGiven && Number(cashGiven) >= grandTotal && (
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:8,padding:"10px 12px",background:GR+"10",borderRadius:8,border:`1px solid ${GR}30`}}>
                    <span style={{fontWeight:600,color:GR}}>Växel tillbaka</span>
                    <span style={{fontWeight:800,fontSize:16,color:GR}}>{(Number(cashGiven)-grandTotal).toLocaleString("sv-SE")} kr</span>
                  </div>
                )}
                {cashGiven && Number(cashGiven) < grandTotal && (
                  <div style={{marginTop:6,fontSize:11,color:R,fontWeight:600}}>
                    Saknas: {(grandTotal-Number(cashGiven)).toLocaleString("sv-SE")} kr
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Fast fot — sitter alltid längst ner (flex-barn, inte fixed) */}
      {rows.length>0 && (
        <div style={{flexShrink:0,background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 20px rgba(0,0,0,.08)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:12,color:MU}}>{rows.reduce((a,r)=>a+r.qty,0)} delar · {rows.length} artiklar</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:B}}>{grandTotal.toLocaleString("sv-SE")} kr</div>
          </div>
          <Btn full variant="red" onClick={checkout} disabled={!canCheckout} style={{padding:"13px",fontSize:15}}>
            <Icon name="cash-register"/> Slutför kassa
          </Btn>
        </div>
      )}

      {confirmClear && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmClear(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Töm korgen?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Alla {rows.length} artiklar tas bort från kassan.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmClear(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>{ setRows([]); clearCart(); setConfirmClear(false); }}>Töm</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}


// ─── Dashboard Page ───────────────────────────────────────────────────────────

// ─── Scan Page (QR / Streckkod simulering via kamera + manuell input) ─────────
function ScanPage({ items, push, pop, toast$ }) {
  const [manualCode, setManualCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const videoRef = useRef(null);
  const readerRef = useRef(null);

  useEffect(() => {
    return () => { stopCamera(); };
  }, []);

  const loadZXing = () => new Promise((resolve, reject) => {
    if (window.ZXing) { resolve(window.ZXing); return; }
    const s = document.createElement("script");
    s.src = "https://unpkg.com/@zxing/library@0.19.1/umd/index.min.js";
    s.onload = () => resolve(window.ZXing);
    s.onerror = reject;
    document.head.appendChild(s);
  });

  const startCamera = async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Webbläsaren saknar kamerastöd. Kräver HTTPS eller localhost.");
      return;
    }
    try {
      const ZXing = await loadZXing();
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      const reader = new ZXing.BrowserMultiFormatReader(hints);
      readerRef.current = reader;
      setScanning(true);
      await reader.decodeFromVideoDevice(null, videoRef.current, (result, err) => {
        if (result) {
          lookup(result.getText());
          stopCamera();
        }
      });
    } catch (err) {
      let msg = "Kunde inte starta kameran.";
      if (err?.name === "NotAllowedError") msg = "Kameraåtkomst nekades. Tillåt kameran i webbläsarens inställningar.";
      else if (err?.name === "NotFoundError") msg = "Ingen kamera hittades på enheten.";
      else if (err?.name === "NotReadableError") msg = "Kameran används redan av en annan app.";
      else if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") msg = "Kameran kräver HTTPS. Fungerar bara på localhost eller säkra anslutningar.";
      setCameraError(msg);
      setScanning(false);
      toast$(msg,"error");
    }
  };

  const stopCamera = () => {
    if (readerRef.current) {
      try { readerRef.current.reset(); } catch {}
      readerRef.current = null;
    }
    setScanning(false);
  };

  const lookup = (code) => {
    const c = code.trim();
    const matches = items.filter(i => i.oem===c || i.stockNumber===c || i.sku===c || i.id===c);
    if (matches.length === 0) {
      setLastResult(null);
      toast$(`Ingen artikel matchade: ${c}`,"error");
    } else if (matches.length > 1) {
      toast$(`Hittade ${matches.length} exemplar`,"success");
      push("variants", {sku: matches[0].sku});
    } else {
      setLastResult(matches[0]);
      toast$(`Hittade: ${matches[0].name}`,"success");
    }
  };

  const submitManual = () => {
    if (!manualCode.trim()) return;
    lookup(manualCode.trim());
    setManualCode("");
  };

  return (
    <Page>
      <TopBar title="Skanna" subtitle="QR-kod eller streckkod" onBack={()=>{stopCamera();pop();}}/>
      <div style={{padding:"14px 14px 60px"}}>

        <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,overflow:"hidden",marginBottom:14}}>
          {scanning?(
            <div style={{position:"relative",aspectRatio:"4/3",background:"#000"}}>
              <video ref={videoRef} autoPlay playsInline muted style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"70%",height:"35%",border:`3px solid ${B}`,borderRadius:8,boxShadow:"0 0 0 9999px rgba(0,0,0,.3)"}}/>
              <div style={{position:"absolute",bottom:12,left:0,right:0,textAlign:"center",color:"#fff",fontSize:12,fontWeight:600}}>Rikta mot QR-kod eller streckkod</div>
            </div>
          ):(
            <div style={{padding:40,textAlign:"center"}}>
              <div style={{display:"flex",gap:16,justifyContent:"center",marginBottom:14}}>
                <Icon name="qrcode" style={{fontSize:40,color:BD}}/>
                <Icon name="barcode" style={{fontSize:40,color:BD}}/>
              </div>
              <div style={{fontSize:13,color:MU,marginBottom:16}}>Starta kameran för att skanna QR-kod eller streckkod (EAN, UPC, Code128 m.fl.)</div>
              <Btn onClick={startCamera}><Icon name="camera"/> Starta kamera</Btn>
              {cameraError&&(
                <div style={{marginTop:14,background:R+"10",border:`1px solid ${R}30`,borderRadius:8,padding:"10px 12px",fontSize:12,color:R,textAlign:"left"}}>
                  <i className="fa-solid fa-triangle-exclamation" style={{marginRight:6}}/>{cameraError}
                </div>
              )}
            </div>
          )}
        </div>

        {scanning&&<Btn full variant="ghost" onClick={stopCamera} style={{marginBottom:14}}>Stäng kamera</Btn>}

        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <div style={{flex:1,height:1,background:BD}}/>
          <span style={{fontSize:11,color:MU,fontWeight:600}}>ELLER ANGE MANUELLT</span>
          <div style={{flex:1,height:1,background:BD}}/>
        </div>

        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <input value={manualCode} onChange={e=>setManualCode(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submitManual()} placeholder="Artikelnummer" style={{flex:1,padding:"10px 12px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13}}/>
          <Btn onClick={submitManual}>Sök</Btn>
        </div>

        {lastResult&&(
          <div onClick={()=>push("detail",{item:lastResult})} style={{background:GR+"10",border:`1px solid ${GR}30`,borderRadius:10,padding:14,cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
              <Icon name="check" style={{color:GR}}/>
              <span style={{fontSize:11,fontWeight:700,color:GR,textTransform:"uppercase"}}>Hittad artikel</span>
            </div>
            <div style={{fontWeight:700,fontSize:15}}>{lastResult.name}{lastResult.side?` — ${lastResult.side}`:""}</div>
            <div style={{fontSize:12,color:MU,marginTop:2}}>{lastResult.quantity} st i lager</div>
            <div style={{fontSize:12,color:B,fontWeight:600,marginTop:6}}>Tryck för att öppna →</div>
          </div>
        )}
      </div>
    </Page>
  );
}

// ─── Location View Page ────────────────────────────────────────────────────────
function LocationViewPage({ items, pop, push, can, isAdmin }) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(null);

  const locations = [...new Set(
    items.map(i => [i.locationType, i.location].filter(Boolean).join(" — ")).filter(Boolean)
  )].sort();

  const filtered = locations.filter(l => !search || l.toLowerCase().includes(search.toLowerCase()));
  const getItems = (loc) => items.filter(i => [i.locationType, i.location].filter(Boolean).join(" — ") === loc);

  return (
    <Page>
      <TopBar title="Platser" subtitle="Vad finns var" onBack={pop}/>
      <div style={{padding:"14px 14px 40px"}}>
        <div style={{position:"relative",marginBottom:14}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök plats, t.ex. Låda 3A…"
            style={{width:"100%",padding:"10px 10px 10px 30px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box",background:WH}}/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {filtered.map(loc => {
            const locItems = getItems(loc);
            const isOpen = expanded === loc;
            return (
              <div key={loc} style={{background:WH,borderRadius:10,border:`1.5px solid ${isOpen?B:BD}`,overflow:"hidden"}}>
                <div onClick={()=>setExpanded(isOpen?null:loc)} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",cursor:"pointer"}}>
                  <i className="fa-solid fa-location-dot" style={{fontSize:14,color:B,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:14,color:B}}>{loc}</div>
                    <div style={{fontSize:11,color:MU}}>{locItems.length} delar</div>
                  </div>
                  <i className={`fa-solid fa-chevron-${isOpen?"up":"down"}`} style={{fontSize:12,color:MU}}/>
                </div>
                {isOpen&&(
                  <div style={{borderTop:`1px solid ${BD}`}}>
                    {locItems.map(item=>(
                      <div key={item.id} onClick={()=>push("detail",{item})}
                        style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderBottom:`1px solid ${BD}`,cursor:"pointer",background:WH}}>
                        <span style={{background:B,color:WH,borderRadius:4,padding:"1px 6px",fontSize:11,fontWeight:800,flexShrink:0}}>#{item.stockNumber}</span>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
                          {item.oem&&<div style={{fontSize:10,color:MU,fontFamily:"monospace"}}>{item.oem}</div>}
                        </div>
                        <div style={{flexShrink:0,fontFamily:"'Barlow Condensed',sans-serif",fontSize:16,fontWeight:800,color:item.quantity===0?R:GR}}>{item.quantity}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length===0&&<div style={{textAlign:"center",color:MU,padding:40}}>Inga platser hittades</div>}
        </div>
      </div>
    </Page>
  );
}

// ─── QR Labels Page — generera & visa QR-koder för utskrift ───────────────────
function QrLabelsPage({ items, pop, preSelected }) {
  const [selected, setSelected] = useState(new Set(preSelected||[]));
  const [labelType, setLabelType] = useState("qr_full");
  const [search, setSearch] = useState("");

  const toggle = (id) => setSelected(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const selectAll = () => setSelected(new Set(filtered.map(i=>i.id)));
  const clearAll = () => setSelected(new Set());

  const filtered = items.filter(i => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [i.name, i.oem, i.stockNumber, i.make, i.location].some(f=>f?.toLowerCase().includes(q));
  });

  const qrUrl = (text) => `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
  const barcodeUrl = (text) => `https://barcodeapi.org/api/128/${encodeURIComponent(text)}`;

  const LABEL_TYPES = [
    { k:"qr_full",   l:"QR — Fullständig",  desc:"QR-kod + namn + lagernr + artikelnr" },
    { k:"qr_mini",   l:"QR — Mini",          desc:"Liten QR + lagernr" },
    { k:"barcode",   l:"Streckkod",          desc:"Code128 + lagernr + artikelnr" },
    { k:"price_tag", l:"Prislapp",           desc:"Pris + namn + lagernr" },
    { k:"full_card", l:"Komplett kort",      desc:"All info + QR" },
  ];

  const printSelected = () => {
    const toPrint = items.filter(i=>selected.has(i.id));
    if (toPrint.length===0) return;

    let labelHtml = "";
    if (labelType==="qr_full") {
      labelHtml = toPrint.map(i=>`<div class="label"><img src="${qrUrl(i.oem||i.stockNumber)}" style="width:90px;height:90px"/><div class="name">${i.name}${i.side?" — "+i.side:""}</div><div class="row-info"><span class="badge">#${i.stockNumber||"—"}</span></div><div class="art">${i.oem||"—"}</div></div>`).join("");
    } else if (labelType==="qr_mini") {
      labelHtml = toPrint.map(i=>`<div class="label" style="padding:6px"><img src="${qrUrl(i.oem||i.stockNumber)}" style="width:55px;height:55px"/><div style="font-weight:800;font-size:13px;color:#1B3A6B">#${i.stockNumber||"—"}</div><div style="font-size:9px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i.name}</div></div>`).join("");
    } else if (labelType==="barcode") {
      labelHtml = toPrint.map(i=>`<div class="label"><img src="${barcodeUrl(i.oem||i.stockNumber)}" style="width:100%;height:45px;object-fit:contain"/><div class="name">${i.name}${i.side?" — "+i.side:""}</div><div class="row-info"><span class="badge">#${i.stockNumber||"—"}</span></div><div class="art">${i.oem||"—"}</div></div>`).join("");
    } else if (labelType==="price_tag") {
      labelHtml = toPrint.map(i=>`<div class="label"><div style="font-size:26px;font-weight:900;color:#1B3A6B;line-height:1">${(i.price||0).toLocaleString("sv-SE")} kr</div><div class="name">${i.name}${i.side?" — "+i.side:""}</div><div class="row-info"><span class="badge">#${i.stockNumber||"—"}</span></div><div class="art">${i.oem||"—"}</div>${i.make?`<div style="font-size:9px;color:#888">${i.make}${i.model?" "+i.model:""}</div>`:""}</div>`).join("");
    } else {
      labelHtml = toPrint.map(i=>`<div class="label" style="text-align:left;display:flex;gap:8px;align-items:flex-start"><img src="${qrUrl(i.oem||i.stockNumber)}" style="width:65px;height:65px;flex-shrink:0"/><div style="flex:1;min-width:0"><div style="font-weight:800;font-size:12px;margin-bottom:3px">${i.name}${i.side?" — "+i.side:""}</div><div style="font-size:20px;font-weight:900;color:#1B3A6B;line-height:1;margin-bottom:3px">${(i.price||0).toLocaleString("sv-SE")} kr</div><div><span class="badge">#${i.stockNumber||"—"}</span></div><div style="font-size:9px;color:#666;margin-top:2px">Art: ${i.oem||"—"}</div>${i.make?`<div style="font-size:9px;color:#666">${i.make}${i.model?" "+i.model:""}</div>`:""}</div></div>`).join("");
    }

    const cols = labelType==="qr_mini"?4:labelType==="full_card"?1:3;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Etiketter</title>
    <style>@page{margin:8mm}body{font-family:sans-serif;margin:0;padding:0}.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px}.label{border:1px solid #ddd;border-radius:5px;padding:8px;text-align:center;break-inside:avoid;background:#fff}.name{font-weight:700;font-size:10px;margin:4px 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.art{font-size:8px;color:#888;font-family:monospace;margin-top:1px}.badge{background:#1B3A6B;color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;font-weight:800}.row-info{margin:3px 0}</style>
    </head><body><div class="grid">${labelHtml}</div>
    <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script></body></html>`;

    printHtml(html);
  };

  return (
    <Page>
      <TopBar title="Etiketter" onBack={pop} subtitle={`${selected.size} valda`}
        right={<Btn small onClick={printSelected} disabled={selected.size===0}><Icon name="print"/> Skriv ut</Btn>}/>
      <div style={{padding:"14px 14px 80px"}}>

        {/* Etikettyp */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:12,marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>Etiketttyp</div>
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            {LABEL_TYPES.map(t=>(
              <button key={t.k} onClick={()=>setLabelType(t.k)}
                style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:8,border:`2px solid ${labelType===t.k?B:BD}`,background:labelType===t.k?B+"08":WH,cursor:"pointer",textAlign:"left"}}>
                <div style={{width:16,height:16,borderRadius:"50%",border:`2px solid ${labelType===t.k?B:BD}`,background:labelType===t.k?B:WH,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {labelType===t.k&&<div style={{width:7,height:7,borderRadius:"50%",background:WH}}/>}
                </div>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:labelType===t.k?B:TX}}>{t.l}</div>
                  <div style={{fontSize:11,color:MU}}>{t.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Sök */}
        <div style={{position:"relative",marginBottom:10}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:13,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök namn, lagernr, artikelnr, märke…"
            style={{width:"100%",padding:"9px 9px 9px 30px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box"}}/>
        </div>

        {/* Välj */}
        <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"center"}}>
          <Btn variant="ghost" small onClick={selectAll}>Markera alla</Btn>
          <Btn variant="ghost" small onClick={clearAll}>Avmarkera</Btn>
          <span style={{marginLeft:"auto",fontSize:12,color:MU}}>{selected.size} av {items.length} valda</span>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {filtered.map(item=>(
            <div key={item.id} onClick={()=>toggle(item.id)}
              style={{background:WH,borderRadius:10,border:`2px solid ${selected.has(item.id)?B:BD}`,padding:"10px 12px",cursor:"pointer",display:"flex",gap:10,alignItems:"center"}}>
              <div style={{flexShrink:0,width:20,height:20,borderRadius:"50%",border:`2px solid ${selected.has(item.id)?B:BD}`,background:selected.has(item.id)?B:WH,display:"flex",alignItems:"center",justifyContent:"center"}}>
                {selected.has(item.id)&&<Icon name="check" style={{fontSize:9,color:WH}}/>}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
                <div style={{fontSize:11,color:MU,fontFamily:"monospace"}}>
                  <span style={{background:B,color:WH,borderRadius:3,padding:"0 4px",fontSize:10,fontWeight:800,marginRight:5}}>#{item.stockNumber}</span>
                  {item.oem||"—"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}


// ─── Receipt Page — PDF-liknande kvitto ───────────────────────────────────────
function ReceiptPage({ sale, receiptRows, payMethod, cashGiven, change, settings, pop }) {
  // receiptRows = multiple rows from checkout; sale = single row from direct sell
  const rows = receiptRows || [sale];
  const co = settings||{};
  const grandTotal = rows.reduce((a,r)=>a+r.total,0);
  const grandExclVat = rows.reduce((a,r)=>a+(r.totalExclVat!=null?r.totalExclVat:Math.round(r.total/1.25)),0);
  const grandVat = grandTotal - grandExclVat;
  const buyer = rows[0]?.buyer || "Okänd";
  const soldBy = rows[0]?.soldBy || "";
  const soldAt = rows[0]?.soldAt || Date.now();
  const receiptId = rows[0]?.receiptId || rows[0]?.id || "";
  const note = rows[0]?.note || "";
  const fmt = ts => new Date(ts).toLocaleDateString("sv-SE",{day:"numeric",month:"long",year:"numeric"})+" "+new Date(ts).toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"});

  const payLabel = payMethod==="swish"?"Swish":payMethod==="kort"?"Kortbetalning":"Kontant";

  const printReceipt = () => {
    const totalDisc = rows.reduce((a,r)=>a+(r.discountKr||0)*r.qty,0);
    const rowsHtml = rows.map(r => {
      const sn = r.itemStockNumber ? `#${r.itemStockNumber} — ` : "";
      return `<div style="margin-bottom:10px">
        <div style="font-weight:700;font-size:13px">${sn}${r.itemName}${r.itemSide?" — "+r.itemSide:""}</div>
        
        <div style="display:flex;justify-content:space-between;font-size:12px">
          <span>${r.qty} st x ${r.unitPrice.toLocaleString("sv-SE")} kr</span>
          <span>${r.total.toLocaleString("sv-SE")} kr</span>
        </div>
        ${r.discount>0?`<div style="color:#c77700;font-size:11px">Rabatt ${r.discount}% (-${((r.discountKr||0)*r.qty).toLocaleString("sv-SE")} kr)</div>`:""}
      </div>`;
    }).join('<div style="border-top:1px dashed #ddd;margin:8px 0"></div>');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Kvitto</title>
      <style>body{font-family:monospace;margin:0;padding:24px;max-width:400px}hr{border:none;border-top:2px dashed #ccc;margin:12px 0}.row{display:flex;justify-content:space-between}</style>
      </head><body>
      <div style="text-align:center;padding-bottom:16px;border-bottom:2px dashed #ccc;margin-bottom:16px">
        <div style="font-weight:800;font-size:20px;letter-spacing:2px">KVITTO</div>
      </div>
      <div style="font-size:11px;color:#555;margin-bottom:12px;line-height:1.7">
        <div>Datum: ${fmt(soldAt)}</div>
        <div>Säljare: ${soldBy}</div>
        ${buyer!=="Okänd"?`<div>Kund: ${buyer}</div>`:""}
        <div>Nr: #${receiptId.slice(-8).toUpperCase()}</div>
      </div>
      <hr/>
      ${rowsHtml}
      <hr/>
      ${totalDisc>0?`<div class="row" style="font-size:13px;color:#c77700;margin-bottom:4px"><span>Total rabatt</span><span>-${totalDisc.toLocaleString("sv-SE")} kr</span></div>`:""}
      <div class="row" style="font-size:22px;font-weight:800;margin:8px 0">
        <span>TOTALT</span><span>${grandTotal.toLocaleString("sv-SE")} kr</span>
      </div>
      <div style="font-size:12px;color:#555;line-height:1.7">
        <div>Betalning: ${payLabel}</div>
        ${payMethod==="kontant"&&cashGiven?`<div>Betalt: ${Number(cashGiven).toLocaleString("sv-SE")} kr &nbsp;·&nbsp; Växel: ${(change||0).toLocaleString("sv-SE")} kr</div>`:""}
      </div>
      ${note?`<div style="font-size:11px;color:#888;margin-top:8px;border-top:1px solid #eee;padding-top:8px">${note}</div>`:""}
      <div style="text-align:center;font-size:11px;color:#bbb;border-top:2px dashed #ccc;padding-top:14px;margin-top:14px">Tack för ditt köp!</div>
      <script>window.onload=()=>setTimeout(()=>window.print(),300)</script>
      </body></html>`;
    printHtml(html);
  };

  const totalDisc = rows.reduce((a,r)=>a+(r.discountKr||0)*r.qty,0);

  return (
    <Page>
      <TopBar title="Kvitto" onBack={pop} subtitle="Bevis på köp" right={<Btn small onClick={printReceipt}><Icon name="receipt"/> Skriv ut</Btn>}/>
      <div style={{padding:"14px 14px 60px"}}>
        <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,padding:20,fontFamily:"monospace"}}>

          <div style={{textAlign:"center",marginBottom:16,paddingBottom:16,borderBottom:`2px dashed ${BD}`}}>
            {co.companyName&&<div style={{fontWeight:800,fontSize:15,marginBottom:4}}>{co.companyName}</div>}
            {co.companyOrg&&<div style={{fontSize:11,color:MU}}>Org: {co.companyOrg}</div>}
            {co.companyPhone&&<div style={{fontSize:11,color:MU}}>Tel: {co.companyPhone}</div>}
            {co.companyAddress&&<div style={{fontSize:11,color:MU}}>{co.companyAddress}</div>}
            {co.companyName&&<div style={{margin:"10px 0",borderTop:`1px dashed ${BD}`}}/>}
            <div style={{fontWeight:800,fontSize:18,letterSpacing:2}}>KVITTO</div>
          </div>

          <div style={{fontSize:12,marginBottom:12,color:TM,lineHeight:1.8}}>
            <div>Datum: {fmt(soldAt)}</div>
            <div>Säljare: {soldBy}</div>
            {buyer!=="Okänd"&&<div>Kund: {buyer}</div>}
            <div style={{color:MU}}>Nr: #{receiptId.slice(-8).toUpperCase()}</div>
          </div>

          <div style={{borderTop:`1px dashed ${BD}`,padding:"12px 0",marginBottom:0}}>
            {rows.map((r,i)=>(
              <div key={r.id}>
                {i>0&&<div style={{height:1,background:`${BD}80`,margin:"8px 0"}}/>}
                <div style={{fontWeight:700,fontSize:13,marginBottom:2}}>{r.itemName}{r.itemSide?` — ${r.itemSide}`:""}</div>
                
                {(r.make||r.compatible)&&<div style={{fontSize:10,color:MU,marginBottom:4}}>{[r.make,r.model,r.yearFrom&&r.yearTo?r.yearFrom+"-"+r.yearTo:""].filter(Boolean).join(" ")||r.compatible}</div>}
                {r.manualPrice!=null&&(
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:MU,marginBottom:1}}>
                    <span>Ord. pris</span><span style={{textDecoration:"line-through"}}>{r.originalPrice.toLocaleString("sv-SE")} kr/st</span>
                  </div>
                )}
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                  <span>{r.qty} st × {r.unitPrice.toLocaleString("sv-SE")} kr</span>
                  <span style={{fontWeight:600}}>{r.total.toLocaleString("sv-SE")} kr</span>
                </div>
                {r.discount>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:AM}}><span>Rabatt {r.discount}%</span><span>-{((r.discountKr||0)*r.qty).toLocaleString("sv-SE")} kr</span></div>}
              </div>
            ))}
          </div>

          <div style={{borderTop:`2px dashed ${BD}`,marginTop:12,paddingTop:12}}>
            {totalDisc>0&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:AM,marginBottom:6}}>
                <span>Total rabatt</span><span>-{totalDisc.toLocaleString("sv-SE")} kr</span>
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:TM,marginBottom:3}}>
              <span>Summa exkl. moms</span><span>{grandExclVat.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:TM,marginBottom:6}}>
              <span>Moms (25%)</span><span>{grandVat.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:20,fontWeight:800,color:B,marginBottom:8}}>
              <span>TOTALT</span><span>{grandTotal.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{fontSize:12,color:TM,lineHeight:1.8}}>
              <div>Betalning: {payLabel}</div>
              {payMethod==="kontant"&&cashGiven>0&&<div>Betalt: {cashGiven.toLocaleString("sv-SE")} kr · Växel: <strong style={{color:GR}}>{(change||0).toLocaleString("sv-SE")} kr</strong></div>}
            </div>
          </div>

          {note&&<div style={{fontSize:12,color:TM,background:BG,borderRadius:6,padding:10,marginTop:12}}>{note}</div>}

          <div style={{textAlign:"center",fontSize:11,color:MU,paddingTop:14,marginTop:14,borderTop:`2px dashed ${BD}`}}>
            Tack för ditt köp!
          </div>
        </div>
      </div>
    </Page>
  );
}


// ─── Import Page — Excel-import av artiklar ───────────────────────────────────
function ImportPage({ items, saveItems, pop, push, toast$, can, isAdmin }) {
  if (!isAdmin && !can("canImport")) return <Page><TopBar title="Importera" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet för import.</div></Page>;
  const [step, setStep] = useState("upload"); // upload | preview | done
  const [parsed, setParsed] = useState([]);
  const [errors, setErrors] = useState([]);
  const [mode, setMode] = useState("add"); // add | replace
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  // ── Kolumnmappning (Excel-rubrik -> fältnamn) ──────────────────────────────
  const COL_MAP = {
    "namn": "name", "name": "name",
    "lagernummer": "stockNumber", "lagernr": "stockNumber", "stocknumber": "stockNumber",
    "kategori": "category", "category": "category",
    "sida": "side", "side": "side",
    "antal": "quantity", "quantity": "quantity", "qty": "quantity",
    "pris": "price", "price": "price",
    "inköpspris": "costPrice", "inkopspris": "costPrice", "costprice": "costPrice",
    "skick": "condition", "condition": "condition",
    "märke": "make", "marke": "make", "make": "make",
    "modell": "model", "model": "model",
    "årsmodell från": "yearFrom", "yearfrom": "yearFrom",
    "årsmodell till": "yearTo", "yearto": "yearTo",
    "leverantör": "supplier", "supplier": "supplier",
    "hylla": "location", "lagerplats": "location", "location": "location",
    "artikelnummer": "oem", "oem": "oem",
    "beskrivning": "description", "description": "description",
    "notering": "notes", "notes": "notes",
    "regnummer": "regNumber", "regnumber": "regNumber",
  };

  // ── Ladda ner mall ─────────────────────────────────────────────────────────
  const downloadTemplate = () => {
    const headers = ["Namn","Artikelnummer","Lagernummer","Lagerplats","Kategori","Sida","Antal","Pris","Inköpspris","Skick","Märke","Modell","Årsmodell från","Årsmodell till","Leverantör","Beskrivning","Notering"];
    const example = ["Bakstötfångare","2048800140","234","A3-07","Stötfångare","Bak","2","3500","1200","Begagnad - Gott skick","Mercedes-Benz","C-klass W204","2007","2014","Leverantör AB","Inkl. parkeringssensorer","Bra skick"];
    const csv = [headers.join(";"), example.join(";")].join("\n");
    const bom = "\uFEFF"; // BOM för svenska tecken i Excel
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lager_mall.csv";
    a.click();
  };

  // ── Parsa uppladdad fil (CSV eller XLSX via SheetJS) ───────────────────────
  const handleFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();

    try {
      let rows = [];

      if (ext === "csv") {
        const text = await file.text();
        const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
        const sep = lines[0].includes(";") ? ";" : ",";
        const headers = lines[0].split(sep).map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
        rows = lines.slice(1).map(line => {
          const vals = line.split(sep).map(v => v.trim().replace(/^["']|["']$/g, ""));
          const obj = {};
          headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
          return obj;
        });
      } else if (ext === "xlsx" || ext === "xls") {
        // Dynamisk import av SheetJS via CDN
        if (!window.XLSX) {
          await new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
            s.onload = res; s.onerror = rej;
            document.head.appendChild(s);
          });
        }
        const buf = await file.arrayBuffer();
        const wb = window.XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = window.XLSX.utils.sheet_to_json(ws, { defval: "" });
        rows = data.map(row => {
          const out = {};
          Object.entries(row).forEach(([k, v]) => { out[k.toLowerCase().trim()] = String(v ?? "").trim(); });
          return out;
        });
      } else {
        toast$("Stöder bara .csv, .xlsx och .xls", "error");
        return;
      }

      // Mappa kolumner → artikelfält
      const errs = [];
      const existingStockNumbers = new Set(items.map(i=>i.stockNumber));
      const usedInBatch = new Set();

      // Hitta minsta fria lagernummer
      const nextFreeStock = (used) => {
        let n = 1;
        while (used.has(String(n))) n++;
        return String(n);
      };

      const mapped = rows.map((row, idx) => {
        const item = { id: genId("imp"), images: [], updatedAt: Date.now() };
        Object.entries(row).forEach(([k, v]) => {
          const field = COL_MAP[k.toLowerCase().trim()];
          if (field) {
            if (["quantity","price","costPrice","yearFrom","yearTo"].includes(field)) {
              item[field] = v === "" ? (field === "quantity" ? 0 : undefined) : Number(String(v).replace(/[^0-9.-]/g,"")) || 0;
            } else {
              item[field] = v;
            }
          }
        });

        // Normalisera märket automatiskt
        if (item.make) item.make = normalizeMake(item.make);

        // Validering — Namn, Artikelnummer och Lagerplats är obligatoriska
        if (!item.name?.trim()) errs.push(`Rad ${idx+2}: Namn saknas`);
        if (!item.oem?.trim()) errs.push(`Rad ${idx+2}: Artikelnummer saknas`);
        if (!item.location?.trim()) errs.push(`Rad ${idx+2}: Lagerplats saknas`);

        // Lagernummer — använd angivet, annars auto-generera minsta fria
        if (!item.stockNumber?.trim()) {
          const free = nextFreeStock(new Set([...existingStockNumbers, ...usedInBatch]));
          item.stockNumber = free;
        } else if (existingStockNumbers.has(item.stockNumber) || usedInBatch.has(item.stockNumber)) {
          errs.push(`Rad ${idx+2}: Lagernummer ${item.stockNumber} används redan — bytt automatiskt`);
          item.stockNumber = nextFreeStock(new Set([...existingStockNumbers, ...usedInBatch]));
        }
        usedInBatch.add(item.stockNumber);

        // Artikelnummer alltid versaler
        if (item.oem) item.oem = item.oem.toUpperCase().trim();

        // SKU genereras automatiskt från artikelnumret — gör att flera rader med
        // samma artikelnummer (t.ex. tre likadana strålkastare) automatiskt grupperas
        // ihop som exemplar av samma del i lagret.
        item.sku = (item.oem||item.name||genId("x")).trim().toLowerCase().replace(/[^a-z0-9]/g,"");

        if (!item.quantity && item.quantity !== 0) item.quantity = 1;
        if (!item.price) item.price = 0;
        if (!item.category) item.category = "Övrigt";
        if (!item.condition) item.condition = "Begagnad - Gott skick";

        return item;
      }).filter(i => i.name?.trim() && i.oem?.trim() && i.location?.trim());

      setErrors(errs);
      setParsed(mapped);
      setStep("preview");
    } catch (e) {
      toast$("Kunde inte läsa filen: " + e.message, "error");
    }
  };

  // ── Genomför import ────────────────────────────────────────────────────────
  const doImport = async () => {
    setImporting(true);
    try {
      let newItems;
      if (mode === "replace") {
        // Nollställ — börja om från 1 med minsta fria nummer
        const usedReplace = new Set();
        const nextFree = (used) => { let n=1; while(used.has(String(n))) n++; return String(n); };
        newItems = parsed.map(p => {
          if (!p.stockNumber?.trim()) {
            p.stockNumber = nextFree(usedReplace);
          }
          usedReplace.add(p.stockNumber);
          return p;
        });
      } else if (mode === "sync") {
        // Synka — uppdatera befintliga (samma lagernummer), lägg till nya
        const existingByStock = {};
        items.forEach(i => { if (i.stockNumber) existingByStock[i.stockNumber] = i; });
        const merged = [...items];
        parsed.forEach(p => {
          const existing = existingByStock[p.stockNumber];
          if (existing) {
            // Uppdatera befintlig — bevara bilder och id
            const idx = merged.findIndex(i => i.id === existing.id);
            if (idx >= 0) merged[idx] = { ...p, id: existing.id, images: existing.images || [] };
          } else {
            merged.push(p);
          }
        });
        newItems = merged;
      } else {
        newItems = [...items, ...parsed];
      }
      await saveItems(newItems);
      toast$(`${parsed.length} artiklar importerade!`, "success");
      setStep("done");
    } catch (e) {
      toast$("Import misslyckades: " + e.message, "error");
    }
    setImporting(false);
  };

  return (
    <Page>
      <TopBar title="Importera" onBack={pop} subtitle="Excel / CSV"/>
      <div style={{padding:"14px 14px 60px"}}>

        {/* Steg 1 — Ladda upp */}
        {step === "upload" && (
          <>
            {/* Mall */}
            <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:14,marginBottom:14,display:"flex",gap:12,alignItems:"center"}}>
              <Icon name="file-export" style={{color:B,fontSize:20,flexShrink:0}}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13,marginBottom:2}}>Ladda ner mall</div>
                <div style={{fontSize:12,color:MU}}>CSV-fil med alla kolumner färdiga. Öppna i Excel, fyll i och spara.</div>
              </div>
              <Btn small onClick={downloadTemplate}>Ladda ner</Btn>
            </div>

            {/* Upload area */}
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor=B;}}
              onDragLeave={e=>{e.currentTarget.style.borderColor=BD;}}
              onDrop={e=>{e.preventDefault();e.currentTarget.style.borderColor=BD;handleFile(e.dataTransfer.files[0]);}}
              style={{border:`2px dashed ${BD}`,borderRadius:12,padding:"40px 20px",textAlign:"center",cursor:"pointer",background:WH,marginBottom:14,transition:"border-color .15s"}}>
              <Icon name="file-export" style={{fontSize:36,color:MU,display:"block",margin:"0 auto 12px"}}/>
              <div style={{fontWeight:700,fontSize:14,marginBottom:6}}>Klicka eller dra hit din fil</div>
              <div style={{fontSize:12,color:MU}}>.xlsx, .xls eller .csv</div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}}
                onChange={e=>handleFile(e.target.files[0])}/>
            </div>

            {/* Kolumnguide */}
            <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,overflow:"hidden"}}>
              <div style={{padding:"12px 14px",borderBottom:`1px solid ${BD}`,fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Kolumner som stöds</div>
              <div style={{padding:14,display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 16px"}}>
                {[["Namn","Obligatorisk"],["Artikelnummer","Obligatorisk"],["Lagerplats","Obligatorisk"],["Lagernummer","Auto om tom"],["Kategori",""],["Sida",""],["Antal",""],["Pris",""],["Inköpspris",""],["Skick",""],["Märke",""],["Modell",""],["Årsmodell från",""],["Årsmodell till",""],["Leverantör",""],["Beskrivning",""],["Notering",""]].map(([col,note])=>(
                  <div key={col} style={{fontSize:12,padding:"3px 0",display:"flex",justifyContent:"space-between",gap:4}}>
                    <span style={{fontWeight:600}}>{col}</span>
                    {note&&<span style={{fontSize:10,color:note==="Obligatorisk"?R:MU}}>{note}</span>}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Steg 2 — Förhandsgranska */}
        {step === "preview" && (
          <>
            {/* Fel */}
            {errors.length > 0 && (
              <div style={{background:R+"08",border:`1px solid ${R}30`,borderRadius:10,padding:12,marginBottom:12}}>
                <div style={{fontWeight:700,fontSize:12,color:R,marginBottom:6}}>Varningar ({errors.length})</div>
                {errors.map((e,i)=><div key={i} style={{fontSize:11,color:R,marginBottom:2}}>{e}</div>)}
              </div>
            )}

            {/* Importläge */}
            <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Importläge</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {[["add","Lägg till",`Lägger till ${parsed.length} nya artiklar`],["sync","Synka",`Uppdaterar befintliga, lägger till nya — inga dubbletter`],["replace","Ersätt allt",`Tar bort ${items.length} befintliga, lägger in ${parsed.length} nya`]].map(([k,l,desc])=>(
                  <button key={k} onClick={()=>setMode(k)} style={{padding:"12px 10px",borderRadius:8,border:`2px solid ${mode===k?B:BD}`,background:mode===k?B+"08":WH,textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontWeight:700,fontSize:13,color:mode===k?B:TX,marginBottom:3}}>{l}</div>
                    <div style={{fontSize:11,color:MU}}>{desc}</div>
                    {k==="replace"&&<div style={{fontSize:10,color:R,marginTop:3,fontWeight:600}}>⚠ Kan inte ångras</div>}
                  </button>
                ))}
              </div>
            </div>

            {/* Förhandsgranskning */}
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>{parsed.length} artiklar att importera</div>
            {parsed.slice(0,20).map((item,i)=>(
              <div key={i} style={{background:WH,borderRadius:8,border:`1px solid ${BD}`,padding:"10px 12px",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
                  <div style={{fontSize:11,color:MU}}>{item.sku} · {item.category} · {item.quantity} st</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0,marginLeft:10}}>
                  <div style={{fontWeight:700,color:B,fontSize:13}}>{(item.price||0).toLocaleString("sv-SE")} kr</div>
                  {item.make&&<div style={{fontSize:11,color:MU}}>{item.make}{item.model?` ${item.model}`:""}</div>}
                </div>
              </div>
            ))}
            {parsed.length > 20 && (
              <div style={{textAlign:"center",padding:"10px",fontSize:12,color:MU}}>... och {parsed.length-20} till</div>
            )}

            <div style={{display:"flex",gap:8,marginTop:14}}>
              <Btn full variant="ghost" onClick={()=>{setStep("upload");setParsed([]);setErrors([]);}}>Avbryt</Btn>
              <Btn full variant="red" onClick={doImport} disabled={importing}>
                {importing ? "Importerar..." : `Importera ${parsed.length} artiklar`}
              </Btn>
            </div>
          </>
        )}

        {/* Steg 3 — Klart */}
        {step === "done" && (
          <div style={{textAlign:"center",padding:"60px 20px"}}>
            <Icon name="check" style={{fontSize:48,color:GR,display:"block",margin:"0 auto 16px"}}/>
            <div style={{fontWeight:800,fontSize:18,marginBottom:8,color:GR}}>Import klar!</div>
            <div style={{fontSize:13,color:MU,marginBottom:24}}>{parsed.length} artiklar har lagts in i lagret.</div>
            <Btn onClick={()=>push("inventory")}>Gå till lagret</Btn>
          </div>
        )}

      </div>
    </Page>
  );
}

// ─── Reports Page ─────────────────────────────────────────────────────────────
function ReportsPage({ sales, items, users, can, isAdmin, push, pop }) {
  const [period, setPeriod] = useState("month");
  const now = Date.now();
  const ms = { today:864e5, week:7*864e5, month:30*864e5, year:365*864e5, all:Infinity };
  const filtered = (sales||[]).filter(s => now - s.soldAt < ms[period]);

  const totalRev   = filtered.reduce((a,s)=>a+s.total,0);
  const totalProfit= filtered.reduce((a,s)=>a+(s.profit||0),0);
  const totalQty   = filtered.reduce((a,s)=>a+s.qty,0);
  const avgSale    = filtered.length ? Math.round(totalRev/filtered.length) : 0;
  const margin     = totalRev>0 ? Math.round(totalProfit/totalRev*100) : 0;

  // Per-dag för minigraf (senaste 14 dagar)
  const days = Array.from({length:14},(_,i)=>{
    const d = new Date(); d.setDate(d.getDate()-13+i);
    const key = d.toLocaleDateString("sv-SE",{day:"numeric",month:"short"});
    const dayStart = new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
    const dayEnd   = dayStart + 864e5;
    const rev = (sales||[]).filter(s=>s.soldAt>=dayStart&&s.soldAt<dayEnd).reduce((a,s)=>a+s.total,0);
    return { key, rev };
  });
  const maxRev = Math.max(...days.map(d=>d.rev), 1);

  // Per säljare
  const bySeller = {};
  filtered.forEach(s=>{ bySeller[s.soldBy]=(bySeller[s.soldBy]||{rev:0,count:0}); bySeller[s.soldBy].rev+=s.total; bySeller[s.soldBy].count++; });
  const sellerList = Object.entries(bySeller).sort((a,b)=>b[1].rev-a[1].rev);

  // Per kategori
  const byCat = {};
  filtered.forEach(s=>{
    const item = items.find(i=>i.id===s.itemId);
    const cat = item?.category||"Okänd";
    byCat[cat]=(byCat[cat]||0)+s.total;
  });
  const catList = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).slice(0,6);

  const exportReport = () => {
    const rows = [["Datum","Artikel","Antal","Pris","Rabatt%","Totalt","Vinst","Säljare","Kund","Betalning"]];
    filtered.forEach(s=>rows.push([
      new Date(s.soldAt).toLocaleDateString("sv-SE"),
      s.itemName+(s.itemSide?` — ${s.itemSide}`:""),
      s.itemSku||"", s.qty, s.unitPrice, s.discount||0, s.total, s.profit||0, s.soldBy, s.buyer||"", s.payMethod||""
    ]));
    const bom="\uFEFF";
    const csv=rows.map(r=>r.join(";")).join("\n");
    const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([bom+csv],{type:"text/csv;charset=utf-8"}));
    a.download=`rapport_${period}_${new Date().toLocaleDateString("sv-SE").replace(/\//g,"-")}.csv`; a.click();
  };

  const S = ({l,v,c=TX,sub}) => (
    <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14}}>
      <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{l}</div>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:24,fontWeight:800,color:c,lineHeight:1.1}}>{v}</div>
      {sub&&<div style={{fontSize:11,color:MU,marginTop:2}}>{sub}</div>}
    </div>
  );

  return (
    <Page>
      <TopBar title="Rapporter" onBack={pop} subtitle="Försäljningsanalys" right={<Btn small onClick={exportReport}><Icon name="file-export"/> Export</Btn>}/>
      <div style={{padding:"14px 14px 60px"}}>

        {/* Period */}
        <div style={{display:"flex",gap:6,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
          {[["today","Idag"],["week","7 dagar"],["month","30 dagar"],["year","12 mån"],["all","Totalt"]].map(([k,l])=>(
            <button key={k} onClick={()=>setPeriod(k)} style={{flexShrink:0,padding:"7px 14px",borderRadius:20,border:`1.5px solid ${period===k?B:BD}`,background:period===k?B:WH,color:period===k?WH:TX,fontWeight:600,fontSize:12,cursor:"pointer"}}>
              {l}
            </button>
          ))}
        </div>

        {/* KPI grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10,marginBottom:16}}>
          <S l="Intäkt" v={totalRev.toLocaleString("sv-SE")+" kr"} c={B}/>
          <S l="Vinst" v={totalProfit.toLocaleString("sv-SE")+" kr"} c={totalProfit>=0?GR:R} sub={`${margin}% marginal`}/>
          <S l="Antal affärer" v={filtered.length} c={TX}/>
          <S l="Sålda delar" v={totalQty} sub={`Snitt ${avgSale.toLocaleString("sv-SE")} kr/affär`}/>
        </div>

        {/* Minigraf — senaste 14 dagar */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Senaste 14 dagarna</div>
          <div style={{display:"flex",alignItems:"flex-end",gap:3,height:60}}>
            {days.map(d=>(
              <div key={d.key} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                <div style={{width:"100%",background:d.rev>0?B:BD,borderRadius:3,height:d.rev>0?`${Math.max(4,Math.round(d.rev/maxRev*52))}px`:"4px",transition:"height .3s"}}/>
                <div style={{fontSize:8,color:MU,textAlign:"center",writingMode:"vertical-rl",transform:"rotate(180deg)",height:22,overflow:"hidden"}}>{d.key}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Per säljare */}
        {sellerList.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Per säljare</div>
            {sellerList.map(([name,{rev,count}],i)=>(
              <div key={name} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{width:22,height:22,borderRadius:"50%",background:B+"15",color:B,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{i+1}</div>
                <span style={{flex:1,fontSize:13,fontWeight:600}}>{name}</span>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:13,fontWeight:700,color:B}}>{rev.toLocaleString("sv-SE")} kr</div>
                  <div style={{fontSize:11,color:MU}}>{count} affärer</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Per kategori */}
        {catList.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Per kategori</div>
            {catList.map(([cat,rev])=>{
              const pct = Math.round(rev/totalRev*100);
              return (
                <div key={cat} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:600,marginBottom:4}}>
                    <span>{cat}</span>
                    <span>{rev.toLocaleString("sv-SE")} kr <span style={{color:MU,fontWeight:400}}>({pct}%)</span></span>
                  </div>
                  <div style={{height:6,background:BD,borderRadius:3,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${pct}%`,background:B,borderRadius:3,transition:"width .5s"}}/>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {filtered.length===0&&<div style={{textAlign:"center",padding:40,color:MU,fontSize:13}}>Inga försäljningar under vald period.</div>}
      </div>
    </Page>
  );
}

// ─── Activity Log Page ────────────────────────────────────────────────────────
function ActivityLogPage({ activityLog, users, can, isAdmin, currentUser, pop }) {
  if (!isAdmin && !can("canViewActivityLog")) return <Page><TopBar title="Aktivitetslogg" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [filter, setFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [search, setSearch] = useState("");

  const types = {
    sale:    { l:"Försäljning", c:GR, icon:"tag" },
    add:     { l:"Tillagd",      c:B,  icon:"plus" },
    edit:    { l:"Redigerad",    c:AM, icon:"pen" },
    delete:  { l:"Borttagen",    c:R,  icon:"trash" },
    reserve: { l:"Reserverad",   c:AM, icon:"bookmark" },
    reverse: { l:"Ångrad",       c:MU, icon:"rotate-left" },
    import:  { l:"Import",       c:TM, icon:"file-import" },
  };

  let log = (activityLog||[]);
  if (filter!=="all") log = log.filter(e=>e.type===filter);
  if (userFilter!=="all") log = log.filter(e=>e.user===userFilter);
  if (search.trim()) { const q=search.toLowerCase(); log = log.filter(e=>(e.description||"").toLowerCase().includes(q)||(e.user||"").toLowerCase().includes(q)); }

  const logUsers = ["all", ...new Set((activityLog||[]).map(e=>e.user).filter(Boolean))];
  const fmt = ts => { const d=new Date(ts); return d.toLocaleDateString("sv-SE",{day:"numeric",month:"short"})+" "+d.toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"}); };

  // Gruppera per dag för tydlighet
  const byDay = {};
  for (const e of log) {
    const day = new Date(e.ts).toLocaleDateString("sv-SE",{weekday:"long",day:"numeric",month:"long"});
    if (!byDay[day]) byDay[day]=[];
    byDay[day].push(e);
  }

  return (
    <Page>
      <TopBar title="Aktivitetslogg" onBack={pop} subtitle={`${log.length} händelser`}/>
      <div style={{padding:"14px 14px 60px"}}>
        {/* Sök */}
        <div style={{position:"relative",marginBottom:10}}>
          <Icon name="magnifying-glass" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:MU,fontSize:13}}/>
          <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök i loggen…"
            style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:8,padding:"9px 12px 9px 34px",fontSize:14,boxSizing:"border-box"}}/>
        </div>

        {/* Typ-filter */}
        <div style={{display:"flex",gap:6,marginBottom:8,overflowX:"auto",paddingBottom:4}}>
          <button onClick={()=>setFilter("all")} style={{flexShrink:0,padding:"6px 14px",borderRadius:20,border:`1.5px solid ${filter==="all"?B:BD}`,background:filter==="all"?B:WH,color:filter==="all"?WH:TX,fontWeight:600,fontSize:11,cursor:"pointer"}}>Alla</button>
          {Object.entries(types).map(([k,{l}])=>(
            <button key={k} onClick={()=>setFilter(k)} style={{flexShrink:0,padding:"6px 14px",borderRadius:20,border:`1.5px solid ${filter===k?B:BD}`,background:filter===k?B:WH,color:filter===k?WH:TX,fontWeight:600,fontSize:11,cursor:"pointer"}}>{l}</button>
          ))}
        </div>

        {/* Användar-filter (om fler än en användare loggats) */}
        {logUsers.length>2&&(
          <div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
            {logUsers.map(u=>(
              <button key={u} onClick={()=>setUserFilter(u)} style={{flexShrink:0,padding:"5px 12px",borderRadius:20,border:`1.5px solid ${userFilter===u?AM:BD}`,background:userFilter===u?AM:WH,color:userFilter===u?WH:TM,fontWeight:600,fontSize:11,cursor:"pointer"}}>{u==="all"?"Alla användare":u}</button>
            ))}
          </div>
        )}

        {log.length===0?(
          <div style={{textAlign:"center",padding:50,color:MU}}>
            <Icon name="clock-rotate-left" style={{fontSize:42,display:"block",margin:"0 auto 14px",color:BD}}/>
            <div style={{fontWeight:700,fontSize:15,marginBottom:6}}>Ingen aktivitet att visa</div>
            <div style={{fontSize:13}}>Försäljningar, ändringar och reservationer dyker upp här.</div>
          </div>
        ):(
          Object.entries(byDay).map(([day,entries])=>(
            <div key={day} style={{marginBottom:18}}>
              <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>{day}</div>
              {entries.map(e=>{
                const t = types[e.type]||{l:e.type,c:MU,icon:"circle"};
                return (
                  <div key={e.id} style={{background:WH,borderRadius:8,border:`1px solid ${BD}`,padding:"10px 12px",marginBottom:6,display:"flex",gap:10,alignItems:"flex-start"}}>
                    <div style={{width:28,height:28,borderRadius:7,background:t.c+"18",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <i className={`fa-solid fa-${t.icon}`} style={{color:t.c,fontSize:12}}/>
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600,lineHeight:1.35}}>{e.description}</div>
                      {e.user&&<div style={{fontSize:11,color:MU,marginTop:1}}>av {e.user}</div>}
                    </div>
                    <div style={{fontSize:11,color:MU,flexShrink:0,whiteSpace:"nowrap"}}>{new Date(e.ts).toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"})}</div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </Page>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────
function SettingsPage({ settings, saveSettings, items, sales, users, push, pop, toast$, can, isAdmin, saveItems }) {
  if (!isAdmin && !can("canManageSettings")) return <Page><TopBar title="Inställningar" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [f, setF] = useState(settings||{});
  const [confirmClear, setConfirmClear] = useState(false);
  const U = (k,v) => setF(p=>({...p,[k]:v}));

  const save = async () => { await saveSettings(f); toast$("Inställningar sparade","success"); };

  const clearInventory = async () => {
    await saveItems([]);
    toast$("Lagret nollställt","success");
    setConfirmClear(false);
  };

  return (
    <Page>
      <TopBar title="Inställningar" onBack={pop} subtitle="System & konfiguration" right={<Btn small onClick={save}>Spara</Btn>}/>
      <div style={{padding:"14px 14px 60px",display:"flex",flexDirection:"column",gap:14}}>

        {/* Företagsinfo */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Företagsinformation (visas på kvitton)</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Inp label="Företagsnamn" value={f.companyName||""} onChange={e=>U("companyName",e.target.value)} placeholder="Mitt Bildelar AB"/>
            <Inp label="Org.nummer" value={f.companyOrg||""} onChange={e=>U("companyOrg",e.target.value)} placeholder="556123-4567"/>
            <Inp label="Telefon" value={f.companyPhone||""} onChange={e=>U("companyPhone",e.target.value)} placeholder="010-123 45 67"/>
            <Inp label="Adress" value={f.companyAddress||""} onChange={e=>U("companyAddress",e.target.value)} placeholder="Gatan 1, 123 45 Stad"/>
          </div>
        </div>

        {/* Prissättning */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Prissättning</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Inp label="Standardmarginal (%)" type="number" min="0" max="500" value={f.defaultMargin||40} onChange={e=>U("defaultMargin",Number(e.target.value))}/>
            <div style={{fontSize:12,color:MU}}>Används som förslag när du lägger till en ny artikel med inköpspris.</div>
          </div>
        </div>

        {/* Statistik */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Systeminfo</div>
          {[["Artiklar i lager", items?.length||0],["Försäljningar totalt", sales?.length||0],["Användare", users?.length||0]].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${BD}50`,fontSize:13}}>
              <span style={{color:MU}}>{l}</span><span style={{fontWeight:700}}>{v}</span>
            </div>
          ))}
        </div>

        {/* Genvägar */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Hantera</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>push("suppliers")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="truck" style={{color:B}}/><span style={{fontSize:13,fontWeight:600}}>Leverantörer</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("managelists")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="list-check" style={{color:B}}/><span style={{fontSize:13,fontWeight:600}}>Hantera listor (kategorier, skick m.m.)</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("backup")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",borderBottom:`1px solid ${BD}50`,cursor:"pointer",textAlign:"left"}}>
              <Icon name="rotate" style={{color:B}}/> <span style={{fontSize:13,fontWeight:600}}>Backup & Återställning</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
            <button onClick={()=>push("activitylog")} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}>
              <Icon name="list" style={{color:B}}/><span style={{fontSize:13,fontWeight:600}}>Aktivitetslogg</span><Icon name="arrow-up" style={{marginLeft:"auto",color:MU,transform:"rotate(90deg)"}}/>
            </button>
          </div>
        </div>

        {/* Farliga åtgärder */}
        <div style={{background:WH,borderRadius:10,border:`1.5px solid ${R}30`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:R,textTransform:"uppercase",letterSpacing:.7,marginBottom:12}}>Farliga åtgärder</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontWeight:600,fontSize:13}}>Nollställ lagret</div>
              <div style={{fontSize:11,color:MU,marginTop:2}}>Tar bort alla artiklar — användare och försäljningar påverkas inte</div>
            </div>
            <button onClick={()=>setConfirmClear(true)} style={{background:R,color:WH,border:"none",borderRadius:8,padding:"8px 14px",fontWeight:700,fontSize:13,cursor:"pointer",flexShrink:0,marginLeft:12}}>
              <Icon name="trash"/> Nollställ
            </button>
          </div>
        </div>

      </div>

      {/* Bekräftelsedialog */}
      {confirmClear&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300,padding:20}} onClick={()=>setConfirmClear(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:24,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:8,color:R}}>⚠ Nollställ lagret?</div>
            <div style={{fontSize:13,color:TM,marginBottom:20,lineHeight:1.5}}>
              Detta tar bort <strong>alla {items?.length||0} artiklar</strong> permanent.<br/>
              Användare, försäljningar och inställningar påverkas inte.<br/>
              <strong style={{color:R}}>Kan inte ångras.</strong>
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmClear(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={clearInventory}>Ja, nollställ lagret</Btn>
            </div>
          </div>
        </div>
      )}

    </Page>
  );
}
function BulkEditPage({ items, saveItems, lists, pop, toast$, can, isAdmin }) {
  if (!isAdmin && !can("canBulkEdit")) return <Page><TopBar title="Massredigering" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [mode, setMode] = useState("edit"); // "edit" | "delete"
  const [selected, setSelected] = useState(new Set());
  const [field, setField] = useState("category");
  const [value, setValue] = useState("");
  const [locType, setLocType] = useState(""); // för placering: vald placeringstyp
  const [search, setSearch] = useState("");
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggle = id => setSelected(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  const filtered = items.filter(i => {
    if (!search) return true;
    const q = search.toLowerCase();
    return [i.name,i.sku,i.oem,i.stockNumber,i.category,i.regNumber,i.location,i.make,i.model].some(f=>f?.toLowerCase().includes(q));
  });
  const selAll = () => setSelected(new Set(filtered.map(i=>i.id)));

  const FIELDS = [
    {k:"category", l:"Kategori", opts:lists?.categories||CATEGORIES},
    {k:"condition", l:"Skick", opts:lists?.conditions||CONDITIONS},
    {k:"side", l:"Sida", opts:lists?.sides||SIDES},
    {k:"supplier", l:"Leverantör", opts:null},
    {k:"location", l:"Placering", opts:null},
  ];
  const currentField = FIELDS.find(f=>f.k===field);
  const LOCTYPES = lists?.locationTypes||LOCATION_TYPES;

  const apply = async () => {
    if (!value||selected.size===0) return;
    const updated = items.map(i => {
      if (!selected.has(i.id)) return i;
      if (field==="location") return {...i, location:value, locationType:locType||i.locationType, updatedAt:Date.now()};
      return {...i,[field]:value,updatedAt:Date.now()};
    });
    await saveItems(updated);
    toast$(`${selected.size} artiklar uppdaterade`,"success");
    setSelected(new Set()); setConfirmBulk(false); setValue(""); setLocType("");
  };

  const applyDelete = async () => {
    if (selected.size===0) return;
    const remaining = items.filter(i => !selected.has(i.id));
    await saveItems(remaining);
    toast$(`${selected.size} artiklar borttagna`,"success");
    setSelected(new Set()); setConfirmDelete(false);
  };

  return (
    <Page flush noAnim>
      <TopBar title="Massredigering" onBack={pop} subtitle="Ändra eller ta bort flera artiklar"/>
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"14px 14px 20px"}}>
        {/* Läge: ändra eller ta bort */}
        <div style={{display:"flex",gap:6,background:BG,borderRadius:10,padding:4,marginBottom:14}}>
          <button onClick={()=>{setMode("edit");}} style={{flex:1,padding:"9px",borderRadius:7,border:"none",background:mode==="edit"?WH:"transparent",color:mode==="edit"?B:MU,fontWeight:700,fontSize:13,boxShadow:mode==="edit"?SH:"none",cursor:"pointer"}}><Icon name="pen"/> Ändra fält</button>
          <button onClick={()=>{setMode("delete");}} style={{flex:1,padding:"9px",borderRadius:7,border:"none",background:mode==="delete"?WH:"transparent",color:mode==="delete"?R:MU,fontWeight:700,fontSize:13,boxShadow:mode==="delete"?SH:"none",cursor:"pointer"}}><Icon name="trash"/> Ta bort</button>
        </div>

        {mode==="edit"&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Vad ska ändras?</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {FIELDS.map(f=>(
                <button key={f.k} onClick={()=>{setField(f.k);setValue("");setLocType("");}} style={{padding:"10px 6px",borderRadius:8,border:`2px solid ${field===f.k?B:BD}`,background:field===f.k?B+"08":WH,fontWeight:field===f.k?700:500,fontSize:12,color:field===f.k?B:TX,cursor:"pointer"}}>{f.l}</button>
              ))}
            </div>
            <div style={{marginTop:10}}>
              {field==="location" ? (
                <>
                  <Sel label="Placeringstyp (valfritt)" value={locType} onChange={e=>setLocType(e.target.value)} options={LOCTYPES}/>
                  <div style={{marginTop:8}}>
                    <Inp label="Placering" value={value} onChange={e=>setValue(e.target.value)} placeholder="t.ex. A12, Rum 3..."/>
                  </div>
                  <div style={{fontSize:11,color:MU,marginTop:4}}>Lämnar du placeringstyp tom behålls den befintliga typen på varje del.</div>
                </>
              ) : currentField?.opts
                ? <Sel label={`Nytt värde — ${currentField.l}`} value={value} onChange={e=>setValue(e.target.value)} options={["",  ...currentField.opts]}/>
                : <Inp label={`Nytt värde — ${currentField?.l}`} value={value} onChange={e=>setValue(e.target.value)} placeholder="Skriv nytt värde..."/>
              }
            </div>
          </div>
        )}

        {mode==="delete"&&(
          <div style={{background:R+"08",borderRadius:10,border:`1.5px solid ${R}40`,padding:14,marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:8,color:R,fontWeight:700,fontSize:13,marginBottom:4}}><Icon name="triangle-exclamation"/> Ta bort flera artiklar</div>
            <div style={{fontSize:12,color:TM}}>Markera de artiklar du vill ta bort i listan nedan. Borttagning kan inte ångras — ta gärna en backup först.</div>
          </div>
        )}

        <div style={{display:"flex",gap:8,marginBottom:10,alignItems:"center"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök (namn, lagernr, artikelnr, regnr...)" style={{flex:1,padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13}}/>
          <button onClick={selAll} style={{flexShrink:0,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${BD}`,background:WH,fontSize:12,fontWeight:600,cursor:"pointer",color:B}}>Alla</button>
          <button onClick={()=>setSelected(new Set())} style={{flexShrink:0,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${BD}`,background:WH,fontSize:12,fontWeight:600,cursor:"pointer",color:MU}}>Rensa</button>
        </div>
        <div style={{fontSize:11,color:MU,marginBottom:10}}>Visar {filtered.length} av {items.length} · {selected.size} valda</div>

        {filtered.map(item=>{
          const sel = selected.has(item.id);
          const accent = mode==="delete"?R:B;
          return (
            <div key={item.id} onClick={()=>toggle(item.id)} style={{background:WH,borderRadius:8,border:`2px solid ${sel?accent:BD}`,padding:"10px 12px",marginBottom:6,display:"flex",gap:10,alignItems:"center",cursor:"pointer"}}>
              <div style={{width:20,height:20,borderRadius:5,border:`2px solid ${sel?accent:BD}`,background:sel?accent:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {sel&&<Icon name="check" style={{fontSize:10,color:WH}}/>}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.stockNumber?`#${item.stockNumber} `:""}{item.name}{item.side?` — ${item.side}`:""}</div>
                <div style={{fontSize:11,color:MU}}>{mode==="edit"?(field==="location"?[item.locationType,item.location].filter(Boolean).join(" ")||"—":(item[field]||"—")):(item.oem||item.sku)} · {item.sku}</div>
              </div>
              <div style={{fontWeight:700,color:B,fontSize:13,flexShrink:0}}>{item.price.toLocaleString("sv-SE")} kr</div>
            </div>
          );
        })}
      </div>

      {/* Fast fot */}
      {mode==="edit"&&selected.size>0&&value&&(
        <div style={{flexShrink:0,background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 20px rgba(0,0,0,.08)"}}>
          <div style={{fontSize:12,color:MU,marginBottom:8}}>{selected.size} artiklar valda → ändra {currentField?.l} till <strong>"{field==="location"?`${locType?locType+" ":""}${value}`:value}"</strong></div>
          <Btn full variant="red" onClick={()=>setConfirmBulk(true)}>Tillämpa på {selected.size} artiklar</Btn>
        </div>
      )}
      {mode==="delete"&&selected.size>0&&(
        <div style={{flexShrink:0,background:WH,borderTop:`1px solid ${BD}`,padding:"12px 14px",paddingBottom:"max(12px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 20px rgba(0,0,0,.08)"}}>
          <div style={{fontSize:12,color:MU,marginBottom:8}}>{selected.size} artiklar markerade för borttagning</div>
          <Btn full variant="red" onClick={()=>setConfirmDelete(true)}><Icon name="trash"/> Ta bort {selected.size} artiklar</Btn>
        </div>
      )}

      {confirmBulk&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmBulk(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Bekräfta massändring</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Ändrar {currentField?.l} till <strong>"{field==="location"?`${locType?locType+" ":""}${value}`:value}"</strong> på {selected.size} artiklar. Kan inte ångras.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmBulk(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={apply}>Tillämpa</Btn>
            </div>
          </div>
        </div>
      )}

      {confirmDelete&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDelete(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8,color:R}}>Ta bort {selected.size} artiklar?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>De {selected.size} markerade artiklarna tas bort permanent från lagret. Detta går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDelete(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={applyDelete}>Ta bort permanent</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Suppliers Page ───────────────────────────────────────────────────────────
function SuppliersPage({ suppliers, saveSuppliers, items, pop, toast$, can, isAdmin }) {
  if (!isAdmin && !can("canManageSuppliers")) return <Page><TopBar title="Leverantörer" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [editing, setEditing] = useState(null);
  const [f, setF] = useState({name:"",contact:"",phone:"",email:"",notes:""});
  const [confirmDel, setConfirmDel] = useState(null);
  const U = (k,v) => setF(p=>({...p,[k]:v}));

  const openNew = () => { setF({name:"",contact:"",phone:"",email:"",notes:""}); setEditing("new"); };
  const openEdit = sup => { setF({...sup}); setEditing(sup.id); };

  const save = async () => {
    if (!f.name.trim()) { toast$("Namn krävs","error"); return; }
    if (editing==="new") {
      await saveSuppliers([...suppliers,{...f,id:genId("sup"),createdAt:Date.now()}]);
    } else {
      await saveSuppliers(suppliers.map(s=>s.id===editing?{...s,...f}:s));
    }
    toast$("Sparad","success"); setEditing(null);
  };

  const del = async id => {
    await saveSuppliers(suppliers.filter(s=>s.id!==id));
    toast$("Borttagen","success"); setConfirmDel(null);
  };

  // Hur många artiklar per leverantör
  const itemCount = sup => items.filter(i=>(i.supplier||"").toLowerCase()===sup.name.toLowerCase()).length;

  return (
    <Page>
      <TopBar title="Leverantörer" onBack={pop} subtitle="Kontakter & info" right={<Btn small onClick={openNew}><Icon name="plus"/> Ny</Btn>}/>
      <div style={{padding:"14px 14px 60px"}}>
        {suppliers.length===0&&!editing&&(
          <div style={{textAlign:"center",padding:40,color:MU}}>
            <Icon name="truck" style={{fontSize:36,display:"block",margin:"0 auto 12px"}}/>
            Inga leverantörer ännu. Lägg till din första!
          </div>
        )}

        {suppliers.map(sup=>(
          <div key={sup.id} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:15}}>{sup.name}</div>
                <div style={{fontSize:12,color:MU,marginTop:2}}>{itemCount(sup)} artiklar i lager</div>
                {sup.contact&&<div style={{fontSize:12,color:TM,marginTop:4}}>{sup.contact}</div>}
                {sup.phone&&<div style={{fontSize:12,color:TM}}><Icon name="phone" style={{marginRight:4}}/>{sup.phone}</div>}
                {sup.email&&<div style={{fontSize:12,color:TM}}><Icon name="envelope" style={{marginRight:4}}/>{sup.email}</div>}
                {sup.notes&&<div style={{fontSize:11,color:MU,marginTop:6,fontStyle:"italic"}}>{sup.notes}</div>}
              </div>
              <div style={{display:"flex",gap:6}}>
                <Btn small variant="ghost" onClick={()=>openEdit(sup)}><Icon name="pen"/></Btn>
                <Btn small variant="ghost" onClick={()=>setConfirmDel(sup.id)} style={{color:R}}><Icon name="trash"/></Btn>
              </div>
            </div>
          </div>
        ))}

        {editing&&(
          <div style={{background:WH,borderRadius:10,border:`2px solid ${B}`,padding:16,marginTop:14}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>{editing==="new"?"Ny leverantör":"Redigera leverantör"}</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <Inp label="Namn *" value={f.name} onChange={e=>U("name",e.target.value)} placeholder="Leverantör AB"/>
              <Inp label="Kontaktperson" value={f.contact||""} onChange={e=>U("contact",e.target.value)}/>
              <Inp label="Telefon" value={f.phone||""} onChange={e=>U("phone",e.target.value)}/>
              <Inp label="E-post" value={f.email||""} onChange={e=>U("email",e.target.value)}/>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Anteckningar</label>
                <textarea value={f.notes||""} onChange={e=>U("notes",e.target.value)} rows={2} style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"none",fontFamily:"inherit"}}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <Btn full variant="ghost" onClick={()=>setEditing(null)}>Avbryt</Btn>
              <Btn full onClick={save}>Spara</Btn>
            </div>
          </div>
        )}
      </div>

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort leverantör?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Artiklar kopplade till leverantören påverkas inte.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Backup Page ──────────────────────────────────────────────────────────────
function BackupPage({ items, sales, users, settings, suppliers, roles, lists, activityLog, favorites, saveItems, saveSales, saveUsers, saveSettings, saveSuppliers, saveRoles, saveLists, setItems, setSales, setSettings, setSuppliers, pop, toast$, can, isAdmin }) {
  if (!isAdmin && !can("canBackup")) return <Page><TopBar title="Backup" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [restoring, setRestoring] = useState(false);
  const fileRef = useRef(null);

  const doBackup = async () => {
    // Samla ihop bilderna via snabb endpoint för komplett backup
    const itemsWithImages = [];
    for (const it of items) {
      if (it.hasImages > 0 && (!it.images || it.images.length === 0)) {
        const imgs = await getImages(it.id);
        itemsWithImages.push({ ...it, images: imgs || [] });
      } else {
        itemsWithImages.push(it);
      }
    }
    const data = { version:4, exportedAt:new Date().toISOString(), items: itemsWithImages, sales, users: users.map(u=>({...u,password:undefined})), settings, suppliers, roles, lists, activitylog: activityLog, favorites };
    const json = JSON.stringify(data, null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json],{type:"application/json"}));
    a.download = `lager_backup_${new Date().toLocaleDateString("sv-SE").replace(/\//g,"-")}.json`;
    a.click();
    toast$("Backup skapad!","success");
  };

  const doRestore = async (file) => {
    if (!file) return;
    setRestoring(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.items || !data.users) throw new Error("Ogiltig backup-fil");

      const allItems = data.items;
      const BATCH = 40;  // små batchar så inget anrop avbryts
      let finalItems = [];

      for (let i = 0; i < allItems.length; i += BATCH) {
        const batch = allItems.slice(i, i + BATCH);
        const isFirst = i === 0;
        const res = await fetch(`${API}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: batch,
            first: isFirst,
            // Skicka metadata bara i första batchen
            sales: isFirst ? (data.sales || []) : null,
            users: isFirst ? (data.users || []) : null,
            settings: isFirst ? (data.settings || null) : null,
            suppliers: isFirst ? (data.suppliers || []) : null,
            roles: isFirst ? (data.roles || null) : null,
            lists: isFirst ? (data.lists || null) : null,
            activitylog: isFirst ? (data.activitylog || null) : null,
            favorites: isFirst ? (data.favorites || null) : null,
          }),
        });
        if (!res.ok) {
          let reason = "";
          try { const err = await res.json(); reason = err.error || ""; } catch {}
          throw new Error(`Del ${i+1}: ${reason || `serverfel ${res.status}`}`);
        }
        const result = await res.json();
        finalItems = result.items;
        // Visa framsteg
        setRestoreProgress(Math.min(100, Math.round(((i + BATCH) / allItems.length) * 100)));
      }

      setItems(finalItems);
      if (data.sales) setSales?.(data.sales);
      if (data.settings) setSettings?.(data.settings);
      if (data.suppliers) setSuppliers?.(data.suppliers);
      if (data.roles) saveRoles?.(data.roles);
      if (data.lists) saveLists?.(data.lists);

      toast$(`Klart! ${finalItems.length} delar återställda — laddar om…`,"success");
      // Ladda om så allt (roller, listor, logg, användare) säkert syns
      setTimeout(()=>window.location.reload(), 1200);
    } catch(e) {
      toast$("Fel: "+e.message,"error");
    }
    setRestoring(false);
    setRestoreProgress(0);
  };
  const [restoreProgress, setRestoreProgress] = useState(0);

  const stats = [
    ["Artiklar",items?.length||0],
    ["Försäljningar",sales?.length||0],
    ["Leverantörer",suppliers?.length||0],
  ];

  return (
    <Page>
      <TopBar title="Backup" onBack={pop} subtitle="Säkerhetskopiera data"/>
      <div style={{padding:"14px 14px 60px"}}>

        {/* Backup */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>Skapa backup</div>
          <div style={{fontSize:13,color:TM,marginBottom:12}}>Exporterar all data (artiklar, försäljningar, inställningar, leverantörer) till en JSON-fil. Spara filen på ett säkert ställe.</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
            {stats.map(([l,v])=>(
              <div key={l} style={{background:B+"08",borderRadius:8,padding:"10px",textAlign:"center"}}>
                <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:B}}>{v}</div>
                <div style={{fontSize:11,color:MU}}>{l}</div>
              </div>
            ))}
          </div>
          <Btn full onClick={doBackup}><Icon name="file-export"/> Ladda ner backup</Btn>
        </div>

        {/* Restore */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>Återställ från backup</div>
          <div style={{background:R+"08",border:`1px solid ${R}20`,borderRadius:8,padding:10,marginBottom:12,fontSize:12,color:R,fontWeight:600}}>
            ⚠ Varning: Återställning skriver över befintlig data. Skapa en backup först.
          </div>
          <div onClick={()=>fileRef.current?.click()} style={{border:`2px dashed ${BD}`,borderRadius:10,padding:"30px 20px",textAlign:"center",cursor:"pointer",background:BG}}>
            <Icon name="rotate" style={{fontSize:28,color:MU,display:"block",margin:"0 auto 8px"}}/>
            <div style={{fontSize:13,fontWeight:600,color:MU}}>{restoring?`Återställer... ${restoreProgress}%`:"Klicka för att välja backup-fil (.json)"}</div>
          </div>
          <input ref={fileRef} type="file" accept=".json" style={{display:"none"}} onChange={e=>doRestore(e.target.files[0])}/>
        </div>

      </div>
    </Page>
  );
}


function DashboardPage({ items, sales, users, can, isAdmin, currentUser, push, pop, toast$ }) {
  if (!currentUser || (!isAdmin && !can("canViewDashboard"))) return (
    <Page>
      <TopBar title="Dashboard" onBack={pop} subtitle="Statistik & översikt"/>
      <div style={{padding:40,textAlign:"center"}}>
        <Icon name="chart-line" style={{fontSize:48,color:BD,marginBottom:16}}/>
        <div style={{fontWeight:700,fontSize:16,color:TX,marginBottom:8}}>Inloggning krävs</div>
        <div style={{fontSize:13,color:MU,marginBottom:20}}>Du måste vara inloggad för att se statistik.</div>
        <Btn onClick={()=>push("login")}>Logga in</Btn>
      </div>
    </Page>
  );

  const allSales = sales||[];
  const now = Date.now();
  const salesMonth = allSales.filter(s=>now-s.soldAt<30*864e5);
  const salesWeek  = allSales.filter(s=>now-s.soldAt<7*864e5);
  const totalVal   = items.reduce((s,i)=>s+(i.price||0)*(i.quantity||0),0);
  const totalQty   = items.reduce((s,i)=>s+(i.quantity||0),0);
  const revMonth   = salesMonth.reduce((a,s)=>a+s.total,0);
  const profMonth  = salesMonth.reduce((a,s)=>a+(s.profit||0),0);
  const revWeek    = salesWeek.reduce((a,s)=>a+s.total,0);

  const sellerRev = {};
  salesMonth.forEach(s=>{ sellerRev[s.soldBy]=(sellerRev[s.soldBy]||0)+s.total; });
  const topSellers = Object.entries(sellerRev).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const itemCount = {};
  allSales.forEach(s=>{ itemCount[s.itemName]=(itemCount[s.itemName]||0)+s.qty; });
  const topItems = Object.entries(itemCount).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const fmt = ts => new Date(ts).toLocaleDateString("sv-SE",{day:"numeric",month:"short"})+" "+new Date(ts).toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"});

  const StatCard = ({label,value,color,icon,sub})=>(
    <div style={{background:WH,borderRadius:12,padding:"14px",border:`1px solid ${BD}`,boxShadow:SH}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
        <div style={{width:26,height:26,borderRadius:7,background:color+"18",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <Icon name={icon} style={{fontSize:12,color}}/>
        </div>
        <span style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>{label}</span>
      </div>
      <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:26,fontWeight:800,color,lineHeight:1.1}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:MU,marginTop:3}}>{sub}</div>}
    </div>
  );

  const Section = ({title,action,onAction})=>(
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,marginTop:18}}>
      <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>{title}</div>
      {action&&<button onClick={onAction} style={{background:"none",border:"none",color:B,fontSize:12,fontWeight:600,cursor:"pointer"}}>{action}</button>}
    </div>
  );

  return (
    <Page>
      <TopBar title="Dashboard" onBack={pop} subtitle="Statistik & översikt"/>
      <div style={{padding:"14px 14px 40px"}}>

        {/* Snabbåtgärder */}
        <Section title="Snabbåtgärder"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:6}}>
          {[
            {icon:"qrcode",    label:"Skanna",      route:"scan",        show:isAdmin||can("canScan")},
            {icon:"qrcode",    label:"Etiketter", route:"qrlabels",   show:isAdmin},
            {icon:"location-dot",label:"Platser",    route:"locationview", show:(isAdmin||can("canView"))},
            {icon:"file-export",label:"Importera",  route:"import",      show:isAdmin||can("canAdd")},
            {icon:"chart-line",label:"Rapporter",   route:"reports",     show:isAdmin||can("canViewReports")},
            {icon:"chart-line",label:"Säljlogg",    route:"saleslog",    show:isAdmin||can("canViewLog")},
            {icon:"bookmark",  label:"Reservationer", route:"reservations", show:isAdmin||can("canViewReservations")},
            {icon:"clock-rotate-left",label:"Aktivitetslogg", route:"activitylog", show:isAdmin||can("canViewActivityLog")},
            {icon:"pen",       label:"Massredigera", route:"bulkedit",   show:isAdmin},
            {icon:"truck",     label:"Leverantörer", route:"suppliers",  show:isAdmin},
            {icon:"rotate",    label:"Backup",       route:"backup",     show:isAdmin},
          ].filter(a=>a.show).map(a=>(
            <button key={a.route} onClick={()=>push(a.route)} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"14px 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:6,cursor:"pointer"}}>
              <Icon name={a.icon} style={{fontSize:18,color:B}}/>
              <span style={{fontSize:11,fontWeight:600,color:TX,textAlign:"center"}}>{a.label}</span>
            </button>
          ))}
        </div>

        {/* Lager */}
        <Section title="Lager"/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <StatCard label="Artiklar"       value={items.length}  color={B}  icon="list"/>
          <StatCard label="Tot. kvantitet" value={totalQty}      color={B}  icon="tag"/>
          <StatCard label="Lagervärde"     value={totalVal.toLocaleString("sv-SE")+" kr"} color={GR} icon="file-export"/>
        </div>

        {/* Försäljning */}
        {(isAdmin||can("canViewLog"))&&<>
          <Section title="Försäljning — 30 dagar" action="Visa logg" onAction={()=>push("saleslog")}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <StatCard label="Intäkt"    value={revMonth.toLocaleString("sv-SE")+" kr"} color={B}  icon="chart-line"/>
            <StatCard label="Vinst"     value={profMonth.toLocaleString("sv-SE")+" kr"} color={profMonth>=0?GR:R} icon="tag"/>
            <StatCard label="Affärer"   value={salesMonth.length} color={TM} icon="pen"/>
            <StatCard label="Denna vecka" value={revWeek.toLocaleString("sv-SE")+" kr"} color={B} icon="chart-line"/>
          </div>

          {/* Toppsäljare */}
          {topSellers.length>0&&<>
            <Section title="Toppsäljare (30 dagar)"/>
            <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,overflow:"hidden"}}>
              {topSellers.map(([name,rev],i)=>(
                <div key={name} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderBottom:i<topSellers.length-1?`1px solid ${BD}50`:"none"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:[B,GR,AM,MU,MU][i]+"20",color:[B,GR,AM,MU,MU][i],fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
                  <span style={{flex:1,fontSize:13,fontWeight:600}}>{name}</span>
                  <span style={{fontSize:13,fontWeight:700,color:[B,GR,AM,MU,MU][i]}}>{rev.toLocaleString("sv-SE")} kr</span>
                </div>
              ))}
            </div>
          </>}

          {/* Mest sålda */}
          {topItems.length>0&&<>
            <Section title="Mest sålda artiklar"/>
            <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,overflow:"hidden"}}>
              {topItems.map(([name,qty],i)=>(
                <div key={name} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderBottom:i<topItems.length-1?`1px solid ${BD}50`:"none"}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:B+"15",color:B,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
                  <span style={{flex:1,fontSize:13}}>{name}</span>
                  <span style={{fontSize:12,color:MU,fontWeight:600}}>{qty} st</span>
                </div>
              ))}
            </div>
          </>}

          {/* Senaste försäljningar */}
          {allSales.length>0&&<>
            <Section title="Senaste försäljningar" action="Alla" onAction={()=>push("saleslog")}/>
            <div style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,overflow:"hidden"}}>
              {allSales.slice(0,6).map((s,i)=>(
                <div key={s.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 14px",borderBottom:i<Math.min(allSales.length,6)-1?`1px solid ${BD}50`:"none"}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.itemName}{s.itemSide?` — ${s.itemSide}`:""}</div>
                    <div style={{fontSize:11,color:MU}}>{s.soldBy}{s.buyer!=="Okänd"?` → ${s.buyer}`:""} · {fmt(s.soldAt)}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0,marginLeft:12}}>
                    <div style={{fontWeight:700,color:B,fontSize:14}}>{s.total.toLocaleString("sv-SE")} kr</div>
                    <div style={{fontSize:11,color:s.profit>=0?GR:R}}>{s.profit>=0?"+":""}{(s.profit||0).toLocaleString("sv-SE")} kr</div>
                  </div>
                </div>
              ))}
            </div>
          </>}

          {allSales.length===0&&salesMonth.length===0&&(
            <div style={{textAlign:"center",padding:"30px 20px",color:MU,fontSize:13}}>
              <Icon name="chart-line" style={{fontSize:32,marginBottom:10,display:"block",margin:"0 auto 10px"}}/>
              Inga försäljningar ännu — börja sälja för att se statistik här.
            </div>
          )}
        </>}

      </div>
    </Page>
  );
}

// ─── Status helpers ───────────────────────────────────────────────────────────
const sc = q => q===0?R:GR;
const cc = c => c==="Ny"?GR:c?.includes("Gott")?B:c?.includes("spricka")?AM:MU;

// ─── Login Page ───────────────────────────────────────────────────────────────
function LoginPage({ users, saveUsers, setSession, push, pop, toast$ }) {
  const [u, setU] = useState(""); const [p, setP] = useState("");
  const [loading, setLoading] = useState(false);
  const login = async () => {
    setLoading(true);
    const match = users.find(x=>x.username.toLowerCase()===u.toLowerCase());
    if (!match) { toast$("Fel inloggningsuppgifter","error"); setLoading(false); return; }

    const hashed = await hashPassword(p);
    let ok = match.password === hashed;

    // Migrera gamla klartext-lösenord automatiskt vid lyckad inloggning
    if (!ok && match.password === p) {
      ok = true;
      await saveUsers(users.map(x=>x.id===match.id?{...x,password:hashed}:x));
    }

    if (!ok) { toast$("Fel inloggningsuppgifter","error"); setLoading(false); return; }

    saveSession(match.id);
    setSession(match.id);
    pop();
    toast$(`Välkommen, ${match.username}!`,"success");
    setLoading(false);
  };
  return (
    <Page>
      <TopBar title="Logga in" onBack={pop} />
      <div style={{maxWidth:360,margin:"40px auto",padding:"0 20px"}}>
        <div style={{background:WH,borderRadius:12,padding:28,boxShadow:SH2,border:`1px solid ${BD}`}}>
          <div style={{display:"flex",gap:4,justifyContent:"center",marginBottom:22}}>
            <div style={{width:8,height:40,background:R,borderRadius:4}}/><div style={{width:8,height:40,background:B,borderRadius:4}}/>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <Inp label="Användarnamn" value={u} onChange={e=>setU(e.target.value)} placeholder="username" />
            <Inp label="Lösenord" type="password" value={p} onChange={e=>setP(e.target.value)} placeholder="••••••" />
            <Btn full onClick={login} disabled={loading} style={{marginTop:4,padding:"11px"}}>{loading?"Loggar in...":"Logga in"}</Btn>
          </div>
          <p style={{textAlign:"center",fontSize:12,color:MU,marginTop:14}}>admin / admin123</p>
        </div>
      </div>
    </Page>
  );
}

// ─── Virtuoso grid layout — responsiv kortgrid (definieras utanför komponenten
// så den inte återskapas vid varje render) ────────────────────────────────────
const gridComponents = {
  List: forwardRef(({ style, children, ...props }, ref) => (
    <div ref={ref} {...props} style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:10, ...style }}>
      {children}
    </div>
  )),
  Item: ({ children, ...props }) => (
    <div {...props} style={{ minWidth:0 }}>{children}</div>
  ),
};

// ─── Inventory Page ───────────────────────────────────────────────────────────
function InventoryPage({ items, sales, can, currentUser, isAdmin, session, setSession, push, toast$, saveItems, viewMode, setViewMode, filters, applyFilters, search, setSearch, sortPref, setSortPref, cart, addToCart }) {
  const [showSort, setShowSort] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const setFilters = applyFilters;
  const sortBy = sortPref.by, sortDir = sortPref.dir;
  const setSortBy = (v) => setSortPref(p=>({...p,by:v}));
  const setSortDir = (v) => setSortPref(p=>({...p,dir:v}));

  if (!can("canView")) return <Page><TopBar title="Lager" /><div style={{padding:40,textAlign:"center",color:R,fontWeight:600}}>Åtkomst nekad.</div></Page>;

  // Hjälpare: tolka kommaseparerade nummer ("11, 15, 23") till en lista
  const parseList = (str) => (str||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  const stockNumList = parseList(filters.stockNums);
  const artNumList = parseList(filters.artNums);

  const activeCount = [filters.cats.length,filters.conds.length,filters.sides.length,filters.make,filters.brandGroup,filters.locationType,filters.model,filters.yearMin,filters.yearMax,filters.priceMin,filters.priceMax,filters.low,filters.supplier,filters.stockNums,filters.artNums,filters.reserved,filters.noImage].filter(Boolean).length;

  let filtered = items.filter(i => {
    const q = search.toLowerCase();
    const m = !q || [i.name,i.sku,i.category,i.oem,i.compatible,i.side,i.supplier,i.location,i.make,i.model,i.regNumber,i.stockNumber,getBrandGroup(i.make)].some(f=>f?.toLowerCase().includes(q));
    if (!m) return false;
    // Lagernummer-filter: exakt match mot någon i listan
    if (stockNumList.length && !stockNumList.includes((i.stockNumber||"").toLowerCase())) return false;
    // Artikelnummer-filter: exakt match mot någon i listan
    if (artNumList.length && !artNumList.includes((i.oem||"").toLowerCase())) return false;
    if (filters.reserved && !(i.reservations?.length>0)) return false;
    if (filters.noImage && (i.hasImages>0 || i.images?.length>0 || i.thumb)) return false;
    if (filters.cats.length && !filters.cats.includes(i.category)) return false;
    if (filters.conds.length && !filters.conds.includes(i.condition)) return false;
    if (filters.sides.length && !filters.sides.includes(i.side)) return false;
    if (filters.make && !i.make?.toLowerCase().includes(filters.make.toLowerCase())) return false;
    if (filters.brandGroup && getBrandGroup(i.make) !== filters.brandGroup) return false;
    if (filters.locationType && i.locationType !== filters.locationType) return false;
    if (filters.model && !i.model?.toLowerCase().includes(filters.model.toLowerCase())) return false;
    if (filters.yearMin && Number(i.yearFrom)<Number(filters.yearMin)) return false;
    if (filters.yearMax && Number(i.yearTo||i.yearFrom)>Number(filters.yearMax)) return false;
    if (filters.priceMin && i.price<Number(filters.priceMin)) return false;
    if (filters.priceMax && i.price>Number(filters.priceMax)) return false;
    if (filters.low && i.quantity>3) return false;
    if (filters.supplier && !i.supplier?.toLowerCase().includes(filters.supplier.toLowerCase())) return false;
    return true;
  });
  // Smartare sortering: numeriska fält jämförs som tal, tomma värden hamnar alltid sist,
  // textfält jämförs naturligt (case-insensitive, å/ä/ö-medvetet via localeCompare).
  const NUMERIC_SORT_KEYS = new Set(["price","quantity","updatedAt","costPrice","stockNumber"]);
  filtered = [...filtered].sort((a,b) => {
    let va = sortBy === "brandGroup" ? getBrandGroup(a.make) : a[sortBy];
    let vb = sortBy === "brandGroup" ? getBrandGroup(b.make) : b[sortBy];
    const aEmpty = va===undefined||va===null||va==="";
    const bEmpty = vb===undefined||vb===null||vb==="";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;   // tomma värden alltid sist, oavsett riktning
    if (bEmpty) return -1;

    let cmp;
    if (NUMERIC_SORT_KEYS.has(sortBy)) {
      cmp = Number(va) - Number(vb);
    } else {
      cmp = String(va).localeCompare(String(vb), "sv", { sensitivity:"base", numeric:true });
    }
    return sortDir==="asc" ? cmp : -cmp;
  });

  const totalVal = items.reduce((s,i)=>s+i.quantity*i.price,0);
  const lowCount = items.filter(i=>i.quantity<=3).length;

  const [confirmDel, setConfirmDel] = useState(null); // id to confirm
  const del = async id => { setConfirmDel(id); };
  const confirmDelAction = async () => {
    const updated = await deleteOneItem(confirmDel);
    if (updated) saveItems(updated);
    else await saveItems(items.filter(i=>i.id!==confirmDel));
    toast$("Borttagen","success"); setConfirmDel(null);
  };

  const exportCSV = () => {
    const hdr=["Artikelnummer","Namn","Sida","Kategori","OEM","Märke","Modell","Årsmodell","Reg.nr","Skick","Antal","Pris","Inköpspris","Leverantör","Placering"];
    const rows=filtered.map(i=>[i.sku,i.name,i.side,i.category,i.oem,i.make,i.model,`${i.yearFrom||""}-${i.yearTo||""}`,i.regNumber,i.condition,i.quantity,i.price,i.costPrice,i.supplier,i.location]);
    const csv=[hdr,...rows].map(r=>r.map(c=>`"${c??""}`).join(",")).join("\n");
    const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"})); a.download="lager_export.csv"; a.click();
    toast$("CSV exporterad","success");
  };

  const cartCount = cart.reduce((a,r)=>a+r.qty, 0);

  const [menuOpen, setMenuOpen] = useState(false);

  const right = (
    <>
      {!currentUser && <Btn small onClick={()=>push("login")}>Logga in</Btn>}
      {currentUser && <>
        <button onClick={()=>window.location.reload()} title="Ladda om" style={{background:"none",border:"none",color:MU,fontSize:17,display:"flex",alignItems:"center",padding:"2px 6px",cursor:"pointer"}}>
          <Icon name="rotate-right"/>
        </button>
        {(can("canUseCheckout")||isAdmin) && (
          <button onClick={()=>push("checkout")} style={{position:"relative",background:"none",border:"none",color:B,fontSize:20,display:"flex",alignItems:"center",padding:"2px 6px"}}>
            <Icon name="cart-shopping"/>
            {cartCount>0 && <span style={{position:"absolute",top:-5,right:-2,background:R,color:WH,borderRadius:"50%",width:17,height:17,fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{cartCount}</span>}
          </button>
        )}
        <button onClick={()=>setMenuOpen(true)} className="mobile-only" style={{background:"none",border:"none",color:TX,fontSize:20,display:"flex",alignItems:"center",padding:"2px 4px"}}>
          <Icon name="grip"/>
        </button>
      </>}
    </>
  );

  return (
    <Page>
      <TopBar title="Lager" right={right} />

      {/* Slide-up menu overlay */}
      {menuOpen && (
        <div style={{position:"fixed",inset:0,zIndex:200}} onClick={()=>setMenuOpen(false)}>
          <div style={{position:"absolute",bottom:0,left:0,right:0,background:WH,borderRadius:"20px 20px 0 0",paddingTop:"max(12px,calc(env(safe-area-inset-top) + 12px))",paddingBottom:"max(24px,env(safe-area-inset-bottom))",boxShadow:"0 -4px 30px rgba(0,0,0,.15)",maxHeight:"calc(90vh - env(safe-area-inset-top))",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            {/* Handle */}
            <div style={{width:36,height:4,background:BD,borderRadius:2,margin:"0 auto 16px"}}/>
            {/* User info */}
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"0 20px 16px",borderBottom:`1px solid ${BD}`,marginBottom:8}}>
              <div style={{width:40,height:40,borderRadius:10,background:isAdmin?R:B,display:"flex",alignItems:"center",justifyContent:"center",color:WH,fontWeight:800,fontSize:16}}>
                {currentUser.username[0].toUpperCase()}
              </div>
              <div>
                <div style={{fontWeight:700,fontSize:15}}>{currentUser.username}</div>
                <div style={{fontSize:12,color:MU}}>{isAdmin?"Administratör":"Användare"}</div>
              </div>
            </div>
            {/* Menu items */}
            {[
              {icon:"house",         label:"Lager",          route:"inventory",   show:true},
              {icon:"cart-shopping", label:"Kassa",          route:"checkout",    show:isAdmin||can("canUseCheckout")},
              {icon:"chart-line",    label:"Dashboard",      route:"dashboard",   show:isAdmin||can("canViewDashboard")},
              {icon:"chart-line",    label:"Rapporter",      route:"reports",     show:isAdmin||can("canViewReports")},
              {icon:"list",          label:"Säljlogg",       route:"saleslog",    show:isAdmin||can("canViewLog")},
              {icon:"bookmark",      label:"Reservationer",  route:"reservations",show:isAdmin||can("canViewReservations")},
              {icon:"clock-rotate-left", label:"Aktivitetslogg", route:"activitylog", show:isAdmin||can("canViewActivityLog")},
              {icon:"qrcode",        label:"Skanna",         route:"scan",        show:isAdmin||can("canScan")},
              {icon:"file-import",   label:"Importera",      route:"import",      show:isAdmin||can("canImport")},
              {icon:"layer-group",   label:"Massredigera",   route:"bulkedit",    show:isAdmin||can("canBulkEdit")},
              {icon:"qrcode",        label:"Etiketter",       route:"qrlabels",    show:isAdmin},
              {icon:"location-dot",   label:"Platser",         route:"locationview", show:(isAdmin||can("canView"))},
              {icon:"truck",         label:"Leverantörer",   route:"suppliers",   show:isAdmin||can("canManageSuppliers")},
              {icon:"users",         label:"Användare",      route:"users",       show:isAdmin||can("canManageUsers")},
              {icon:"rotate",        label:"Backup",         route:"backup",      show:isAdmin||can("canBackup")},
              {icon:"sliders",       label:"Inställningar",  route:"settings",    show:isAdmin||can("canManageSettings")},
            ].filter(m=>m.show).map(m=>(
              <button key={m.route} onClick={()=>{setMenuOpen(false); if(m.route!=="inventory") push(m.route);}}
                style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"12px 20px",background:"none",border:"none",cursor:"pointer",textAlign:"left",borderRadius:0}}>
                <div style={{width:36,height:36,borderRadius:9,background:B+"10",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <Icon name={m.icon} style={{fontSize:15,color:B}}/>
                </div>
                <span style={{fontSize:14,fontWeight:500,color:TX}}>{m.label}</span>
              </button>
            ))}
            {/* Logout */}
            <div style={{borderTop:`1px solid ${BD}`,margin:"8px 0 0"}}/>
            <button onClick={()=>{setMenuOpen(false);clearSession();setSession(null);toast$("Utloggad");}} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"12px 20px",background:"none",border:"none",cursor:"pointer",color:R}}>
              <div style={{width:36,height:36,borderRadius:9,background:R+"10",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <Icon name="right-from-bracket" style={{fontSize:15,color:R}}/>
              </div>
              <span style={{fontSize:14,fontWeight:500}}>Logga ut</span>
            </button>
          </div>
        </div>
      )}

      <div style={{padding:"clamp(14px,2vw,28px)",paddingBottom:80}}>
        {!currentUser && (
          <div style={{background:"#FFFBEB",border:`1px solid ${AM}40`,borderRadius:8,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:13,color:AM,fontWeight:600}}>Gästläge — Skrivskyddad</span>
            <button onClick={()=>push("login")} style={{marginLeft:"auto",background:AM,color:WH,border:"none",borderRadius:5,padding:"5px 14px",fontSize:12,fontWeight:700}}>Logga in</button>
          </div>
        )}

        {/* Search + toolbar — sök alltid på rad 1, knappar på rad 2 */}
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
          {/* Rad 1 — sökfält */}
          <div style={{position:"relative"}}>
            <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,color:MU,pointerEvents:"none"}}><Icon name="magnifying-glass"/></span>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök namn, OEM, lagernr…"
              style={{width:"100%",padding:"10px 10px 10px 32px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,color:TX,background:WH,boxShadow:SH,boxSizing:"border-box"}} />
          </div>
          {/* Rad 2 — knappar */}
          <div style={{display:"flex",gap:6}}>
            {(can("canScan")||isAdmin)&&(
              <button onClick={()=>push("scan")} style={{flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",padding:"9px 12px",borderRadius:8,border:`1.5px solid ${BD}`,background:WH,color:TM,boxShadow:SH}}>
                <Icon name="qrcode"/>
              </button>
            )}
            <button onClick={()=>push("filter",{filters,setFilters:applyFilters,items})}
              style={{flexShrink:0,display:"flex",alignItems:"center",gap:5,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${activeCount>0?B:BD}`,background:activeCount>0?B:WH,color:activeCount>0?WH:TM,fontWeight:600,fontSize:13,boxShadow:SH}}>
              <Icon name="sliders"/>
              {activeCount>0&&<span style={{fontSize:11,fontWeight:700,background:"rgba(255,255,255,.25)",borderRadius:10,padding:"1px 6px"}}>{activeCount}</span>}
            </button>
            <button onClick={()=>setShowSort(s=>!s)}
              style={{flexShrink:0,display:"flex",alignItems:"center",gap:5,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${sortBy!=="stockNumber"?B:BD}`,background:sortBy!=="stockNumber"?B+"10":WH,color:sortBy!=="stockNumber"?B:TM,fontWeight:600,fontSize:13,boxShadow:SH}}>
              {sortDir==="asc"?<Icon name="arrow-up-short-wide"/>:<Icon name="arrow-down-wide-short"/>}
            </button>
            <div style={{display:"flex",gap:5}}>
              <button onClick={()=>setViewMode("cards")} style={{padding:"8px 10px",borderRadius:8,border:`1.5px solid ${viewMode==="cards"?B:BD}`,background:viewMode==="cards"?B+"10":WH,color:viewMode==="cards"?B:MU,boxShadow:SH}}>
                <Icon name="table-cells-large"/>
              </button>
              <button onClick={()=>setViewMode("list")} style={{padding:"8px 10px",borderRadius:8,border:`1.5px solid ${viewMode==="list"?B:BD}`,background:viewMode==="list"?B+"10":WH,color:viewMode==="list"?B:MU,boxShadow:SH}}>
                <Icon name="list"/>
              </button>
            </div>
            {can("canAdd") && <button onClick={()=>push("edit",{item:null})} style={{marginLeft:"auto",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",padding:"9px 13px",borderRadius:8,border:"none",background:B,color:WH,fontSize:16,boxShadow:SH}}><Icon name="plus"/></button>}
          </div>
        </div>

        {/* Aktiva filter som taggar med ✕ + Rensa allt */}
        {(activeCount>0 || search) && (
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",marginBottom:10}}>
            {search&&<FilterTag label={`Sök: ${search}`} onRemove={()=>setSearch("")}/>}
            {filters.stockNums&&<FilterTag label={`Lagernr: ${filters.stockNums}`} onRemove={()=>setFilters({...filters,stockNums:""})}/>}
            {filters.artNums&&<FilterTag label={`Artikelnr: ${filters.artNums}`} onRemove={()=>setFilters({...filters,artNums:""})}/>}
            {filters.low&&<FilterTag label="Lågt lager" onRemove={()=>setFilters({...filters,low:false})}/>}
            {filters.reserved&&<FilterTag label="Reserverade" onRemove={()=>setFilters({...filters,reserved:false})}/>}
            {filters.noImage&&<FilterTag label="Utan bild" onRemove={()=>setFilters({...filters,noImage:false})}/>}
            {filters.cats.map(c=><FilterTag key={c} label={c} onRemove={()=>setFilters({...filters,cats:filters.cats.filter(x=>x!==c)})}/>)}
            {filters.conds.map(c=><FilterTag key={c} label={c} onRemove={()=>setFilters({...filters,conds:filters.conds.filter(x=>x!==c)})}/>)}
            {filters.sides.map(s=><FilterTag key={s} label={s} onRemove={()=>setFilters({...filters,sides:filters.sides.filter(x=>x!==s)})}/>)}
            {filters.make&&<FilterTag label={filters.make} onRemove={()=>setFilters({...filters,make:""})}/>}
            {filters.brandGroup&&<FilterTag label={filters.brandGroup} onRemove={()=>setFilters({...filters,brandGroup:""})}/>}
            {filters.locationType&&<FilterTag label={filters.locationType} onRemove={()=>setFilters({...filters,locationType:""})}/>}
            {filters.model&&<FilterTag label={filters.model} onRemove={()=>setFilters({...filters,model:""})}/>}
            {filters.supplier&&<FilterTag label={filters.supplier} onRemove={()=>setFilters({...filters,supplier:""})}/>}
            {(filters.yearMin||filters.yearMax)&&<FilterTag label={`År ${filters.yearMin||"…"}-${filters.yearMax||"…"}`} onRemove={()=>setFilters({...filters,yearMin:"",yearMax:""})}/>}
            {(filters.priceMin||filters.priceMax)&&<FilterTag label={`Pris ${filters.priceMin||"…"}-${filters.priceMax||"…"}`} onRemove={()=>setFilters({...filters,priceMin:"",priceMax:""})}/>}
            <button onClick={()=>{ setSearch(""); setFilters({ cats:[], conds:[], sides:[], make:"", brandGroup:"", locationType:"", model:"", yearMin:"", yearMax:"", priceMin:"", priceMax:"", low:false, supplier:"", stockNums:"", artNums:"", reserved:false, noImage:false }); }}
              style={{display:"flex",alignItems:"center",gap:5,padding:"5px 11px",borderRadius:16,border:`1.5px solid ${R}40`,background:R+"08",color:R,fontSize:12,fontWeight:700,cursor:"pointer"}}>
              <i className="fa-solid fa-xmark"/> Rensa allt
            </button>
          </div>
        )}

        {/* Sort sheet */}
        {showSort && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH2,marginBottom:8,overflow:"hidden"}}>
            {[
              {k:"stockNumber", dir:"asc",  l:"Lagernummer stigande", sub:"", icon:"arrow-up-1-9"},
              {k:"stockNumber", dir:"desc", l:"Lagernummer fallande",  sub:"", icon:"arrow-down-9-1"},
              {k:"price",       dir:"asc",  l:"Pris stigande",         sub:"", icon:"arrow-up-1-9"},
              {k:"price",       dir:"desc", l:"Pris fallande",         sub:"", icon:"arrow-down-9-1"},
            ].map(({k,dir,l,sub,icon})=>{
              const active = sortBy===k && sortDir===dir;
              return (
                <button key={k+dir} onClick={()=>{ setSortBy(k); setSortDir(dir); setShowSort(false); }}
                  style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"13px 14px",background:active?B:WH,border:"none",borderBottom:`1px solid ${BD}`,color:active?WH:TX,cursor:"pointer",textAlign:"left"}}>
                  <Icon name={icon} style={{fontSize:16,flexShrink:0,color:active?WH:B}}/>
                  <div>
                    <div style={{fontWeight:700,fontSize:13}}>{l}</div>
                    <div style={{fontSize:11,color:active?"rgba(255,255,255,.7)":MU}}>{sub}</div>
                  </div>
                  {active&&<Icon name="check" style={{marginLeft:"auto",fontSize:14}}/>}
                </button>
              );
            })}
          </div>
        )}

        <div style={{fontSize:12,color:MU,marginBottom:10,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span>Visar <strong style={{color:TX}}>{filtered.length}</strong> av {items.length} delar</span>
          {can("canExport") && <button onClick={exportCSV} style={{background:"none",border:"none",color:B,fontSize:12,cursor:"pointer",fontWeight:600,display:"flex",alignItems:"center",gap:4,marginLeft:"auto"}}><Icon name="file-export"/> CSV</button>}
          {(isAdmin||can("canImport")) && <button onClick={()=>push("import")} style={{background:"none",border:"none",color:B,fontSize:12,cursor:"pointer",fontWeight:600,display:"flex",alignItems:"center",gap:4,marginLeft:can("canExport")?"0":"auto"}}><Icon name="file-export"/> Importera</button>}
        </div>

        {/* Cards — virtualiserad: bara synliga kort renderas (snabbt även med 1000+ delar) */}
        {viewMode==="cards" && (() => {
          // Group items by SKU — same SKU = variants of same part
          const groups = [];
          const seen = {};
          filtered.forEach(item => {
            const key = item.sku?.trim().toLowerCase() || item.id;
            if (!seen[key]) { seen[key] = []; groups.push(seen[key]); }
            seen[key].push(item);
          });
          if (filtered.length===0) return <div style={{textAlign:"center",padding:48,color:MU}}>Inga delar hittades</div>;
          return (
            <VirtuosoGrid
              data={groups}
              style={{ height: "calc(100vh - 230px)" }}
              components={gridComponents}
              computeItemKey={(_, group) => group.length===1 ? group[0].id : group[0].sku}
              overscan={600}
              itemContent={(_, group) => {
                if (group.length === 1) {
                  const item = group[0];
                  return (
                    <ItemCard item={item} can={can} isAdmin={isAdmin}
                      onDetail={()=>push("detail",{item})}
                      onEdit={()=>push("edit",{item})}
                      onSell={()=>push("sell",{item, maxQty: Math.max(0,(item.quantity||0)-(item.reservations?.length||0))})}
                      onAddToCart={()=>{ addToCart(item); toast$(`${item.name} tillagd i korgen`,"success"); }}
                      onDelete={()=>del(item.id)}
                      onReserve={()=>push("detail",{item, openReserve:true})}
                    />
                  );
                }
                return (
                  <GroupCard group={group} can={can}
                    onOpen={()=>push("variants",{sku:group[0].sku})}
                    onAddToCart={(item)=>{ addToCart(item); toast$(`${item.name} #${item.stockNumber||""} tillagd i korgen`,"success"); }}
                  />
                );
              }}
            />
          );
        })()}

        {/* List */}
        {viewMode==="list" && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH,overflow:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}>
              <thead>
                <tr style={{borderBottom:`2px solid ${BD}`}}>
                  {[["","",44],["name","Namn"],["oem","Art.nr",90],["category","Kat.",90],["condition","Skick",120],["quantity","Ant.",55],["price","Pris",85],["location","Placering",65],["","",100]].map(([col,lab,w],i)=>(
                    <th key={i} onClick={()=>col&&(sortBy===col?setSortDir(d=>d==="asc"?"desc":"asc"):(setSortBy(col),setSortDir("asc")))}
                      style={{textAlign:"left",padding:"8px 10px",fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,cursor:col?"pointer":"default",whiteSpace:"nowrap",width:w||"auto"}}>
                      {lab}{col&&sortBy===col?(sortDir==="asc"?" ^":" ↓"):""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length===0 && <tr><td colSpan={9} style={{padding:40,textAlign:"center",color:MU}}>Inga delar hittades</td></tr>}
                {(() => {
                  const groups2 = [];
                  const seen2 = {};
                  filtered.forEach(item => {
                    const key = item.sku?.trim().toLowerCase() || item.id;
                    if (!seen2[key]) { seen2[key]=[]; groups2.push({key,items:seen2[key]}); }
                    seen2[key].push(item);
                  });
                  return groups2.map(({key,items:g}) => {
                    if(g.length===1) {
                      const item=g[0];
                      return <ListRow key={item.id} item={item} can={can} isAdmin={isAdmin}
                        onDetail={()=>push("detail",{item})}
                        onEdit={()=>push("edit",{item})}
                        onSell={()=>push("sell",{item})}
                        onAddToCart={()=>{ addToCart(item); toast$(`${item.name} tillagd i korgen`,"success"); }}
                        onDelete={()=>del(item.id)}/>;
                    }
                    // Group row
                    const base=g[0];
                    return <tr key={key} onClick={()=>push("variants",{sku:base.sku})} style={{cursor:"pointer",background:B+"04",borderBottom:`1px solid ${BD}`}}>
                      <td style={{padding:"6px 10px"}}><div style={{display:"flex",gap:3}}>{g.slice(0,3).map(i=>(i.thumb||i.images?.[0])?<img key={i.id} src={i.thumb||i.images[0]} style={{width:24,height:24,borderRadius:4,objectFit:"cover"}} alt=""/>:<div key={i.id} style={{width:24,height:24,borderRadius:4,background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center"}}><i className="fa-solid fa-wrench" style={{fontSize:10,color:MU}}/></div>)}</div></td>
                      <td style={{padding:"7px 10px"}}><div style={{fontWeight:600,fontSize:13}}>{base.name}{base.side?` — ${base.side}`:""}</div><div style={{fontSize:10,color:B,fontWeight:700}}><i className="fa-solid fa-layer-group"/> {g.length} exemplar</div></td>
                      <td style={{padding:"7px 10px",fontSize:12,color:MU}}>{base.sku}</td>
                      <td style={{padding:"7px 10px"}}><Badge label={base.category} color={B} small/></td>
                      <td style={{padding:"7px 10px",fontSize:11,color:MU}}>{[...new Set(g.map(i=>i.condition?.split(" - ")[0]))].join(", ")}</td>
                      <td style={{padding:"7px 10px",fontWeight:700,color:GR}}>{g.reduce((a,i)=>a+i.quantity,0)} st</td>
                      <td style={{padding:"7px 10px",fontWeight:700,color:B,fontSize:12,whiteSpace:"nowrap"}}>
                        {(() => { const p=g.map(i=>i.price).filter(Boolean); const mn=Math.min(...p),mx=Math.max(...p); return mn===mx?`${mn.toLocaleString("sv-SE")} kr`:`${mn.toLocaleString("sv-SE")}–${mx.toLocaleString("sv-SE")}`; })()}
                      </td>
                      <td colSpan={2} style={{padding:"7px 10px",fontSize:11,color:B,fontWeight:600}}>Välj exemplar →</td>
                    </tr>;
                  });
                })()}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* Inline delete confirm */}
      {confirmDel && (
        <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50,padding:24}}>
          <div style={{background:WH,borderRadius:12,padding:24,width:"100%",maxWidth:320,boxShadow:SH2}}>
            <div style={{fontWeight:700,fontSize:16,marginBottom:8}}>Ta bort del?</div>
            <div style={{fontSize:13,color:MU,marginBottom:20}}>Detta kan inte ångras.</div>
            <div style={{display:"flex",gap:10}}>
              <Btn variant="ghost" full onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn variant="red" full onClick={confirmDelAction}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Group Card — shown when multiple items share same SKU ────────────────────
const GroupCard = React.memo(function GroupCard({ group, can, onOpen }) {
  const best = [...group].sort((a,b) => {
    const s = i => i.condition==="Ny"?4:i.condition?.includes("Gott")?3:i.condition?.includes("spricka")?2:1;
    return s(b)-s(a);
  })[0];
  const totalQty = group.reduce((a,i)=>a+i.quantity,0);
  const prices = group.map(i=>i.price).filter(Boolean);
  const minP = Math.min(...prices); const maxP = Math.max(...prices);
  const brandGroup = getBrandGroup(best.make);
  const location = [best.locationType, best.location].filter(Boolean).join(" ");

  return (
    <div onClick={onOpen} style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,boxShadow:SH,padding:12,cursor:"pointer",display:"flex",flexDirection:"column",gap:8,height:188,boxSizing:"border-box",overflow:"hidden"}}>

      {/* Topp: bild + (lagernr-badges, namn, artikelnummer) */}
      <div style={{display:"flex",gap:11,alignItems:"flex-start"}}>
        <div style={{flexShrink:0,width:62,height:62,borderRadius:9,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
          {(() => {
            const src = best.thumb || best.images?.[0] || (best.hasImages>0 ? `/api/img/${best.id}?v=${best.updatedAt||0}` : null);
            return src ? <img src={src} alt="" loading="lazy" decoding="async" width={62} height={62} style={{width:"100%",height:"100%",objectFit:"cover"}}/> : <i className="fa-solid fa-wrench" style={{color:MU,fontSize:18}}/>;
          })()}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",gap:4,marginBottom:3,flexWrap:"wrap"}}>
            {group.map(item=>(
              <span key={item.id} style={{background:B,color:WH,borderRadius:5,padding:"2px 7px",fontSize:12,fontWeight:800,letterSpacing:.3}}>#{item.stockNumber||"?"}</span>
            ))}
          </div>
          <div style={{fontWeight:700,fontSize:14,lineHeight:1.25,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{best.name}{best.side?` — ${best.side}`:""}</div>
          {best.oem&&<div style={{fontSize:15,fontWeight:800,color:TX,fontFamily:"monospace",letterSpacing:.3,marginTop:2,wordBreak:"break-all",lineHeight:1.15}}>{best.oem}</div>}
        </div>
      </div>

      {/* Placering — stor och tydlig */}
      {location&&(
        <div style={{display:"flex",alignItems:"center",gap:6,background:B+"0A",borderRadius:7,padding:"6px 10px"}}>
          <i className="fa-solid fa-location-dot" style={{fontSize:14,color:B}}/>
          <span style={{fontSize:15,fontWeight:800,color:B}}>{location}</span>
        </div>
      )}

      {/* Botten: pris + antal + exemplar-länk */}
      <div style={{display:"flex",alignItems:"flex-end",gap:8,marginTop:"auto"}}>
        <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:B,lineHeight:1}}>
          {prices.length===0?"—":minP===maxP?`${minP.toLocaleString("sv-SE")} kr`:`${minP.toLocaleString("sv-SE")}–${maxP.toLocaleString("sv-SE")} kr`}
        </div>
        <div style={{textAlign:"right",lineHeight:1,marginLeft:"auto"}}>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:totalQty===0?R:GR}}>{totalQty}</span>
          <span style={{fontSize:10,color:MU,marginLeft:2}}>st</span>
        </div>
        <div style={{fontSize:11,color:B,fontWeight:700,display:"flex",alignItems:"center",gap:3,whiteSpace:"nowrap"}}>
          {group.length} ex <i className="fa-solid fa-chevron-right" style={{fontSize:10}}/>
        </div>
      </div>
    </div>
  );
});

// ─── Variants Page — choose between physical copies of same part ───────────────
function VariantsPage({ sku, items, sales, can, isAdmin, push, pop, addToCart, toast$, saveItems }) {
  const group = items.filter(i => i.sku?.trim().toLowerCase() === sku?.trim().toLowerCase());
  const [selected, setSelected] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  const del = async (id) => {
    const updated = await deleteOneItem(id);
    if (updated) saveItems(updated);
    else await saveItems(items.filter(i=>i.id!==id));
    toast$("Borttagen","success");
    setConfirmDel(null);
    if(group.length<=1) pop();
  };

  const condColor = c => c?.includes("Gott")?GR:c?.includes("Ny")?B:c?.includes("spricka")?AM:MU;

  if (!group.length) return <Page><TopBar title="Exemplar" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}>Inga delar hittades.</div></Page>;

  const base = group[0];

  return (
    <Page>
      <TopBar
        title={base.name+(base.side?` — ${base.side}`:"")}
        subtitle={`${group.length} exemplar`}
        onBack={pop}
        right={(isAdmin||can("canAdd"))&&<Btn small onClick={()=>push("edit",{item:{...base,id:undefined,stockNumber:"",images:[]}})}><i className="fa-solid fa-plus"/> Nytt exemplar</Btn>}
      />
      <div style={{padding:"14px 14px 60px"}}>

        {/* Shared info banner */}
        <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:"12px 14px",marginBottom:16,display:"flex",gap:12,flexWrap:"wrap"}}>
          {base.make&&<div style={{fontSize:12}}><span style={{color:MU}}>Märke:</span> <strong>{base.make} {base.model}</strong></div>}
          {base.oem&&<div style={{fontSize:12}}><span style={{color:MU}}>Art.nr:</span> <strong style={{fontFamily:"monospace"}}>{base.oem}</strong></div>}
          {base.category&&<div style={{fontSize:12}}><span style={{color:MU}}>Kategori:</span> <strong>{base.category}</strong></div>}
          {(base.yearFrom||base.yearTo)&&<div style={{fontSize:12}}><span style={{color:MU}}>Årsmodell:</span> <strong>{base.yearFrom}–{base.yearTo}</strong></div>}
        </div>

        {/* Exemplar — kompakta rader */}
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {group.map(item=>{
            const isSel = selected?.id===item.id;
            const cc = c => c?.includes("Gott")?GR:c?.includes("Ny")?B:c?.includes("spricka")?AM:MU;
            return (
              <div key={item.id} onClick={()=>setSelected(isSel?null:item)}
                style={{background:WH,borderRadius:10,border:`2px solid ${isSel?B:BD}`,boxShadow:isSel?`0 0 0 3px ${B}15`:SH,cursor:"pointer",overflow:"hidden",transition:"border-color .15s,box-shadow .15s"}}>

                <div style={{display:"flex",gap:12,padding:14,alignItems:"center"}}>
                  {/* Small image or icon */}
                  <div style={{flexShrink:0,width:64,height:64,borderRadius:8,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                    {(item.thumb||item.images?.[0])
                      ? <img src={item.thumb||item.images[0]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                      : <i className="fa-solid fa-image" style={{fontSize:22,color:BD}}/>
                    }
                    {(item.hasImages||item.images?.length)>1&&<div style={{position:"absolute",bottom:2,right:2,background:"rgba(0,0,0,.6)",color:WH,borderRadius:3,padding:"1px 4px",fontSize:8,fontWeight:600}}>{item.hasImages||item.images.length}<i className="fa-solid fa-image" style={{marginLeft:2}}/></div>}
                  </div>

                  {/* Info */}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                      <span style={{background:isSel?B:"rgba(0,0,0,.75)",color:WH,borderRadius:5,padding:"2px 8px",fontSize:12,fontWeight:800,letterSpacing:.5}}>#{item.stockNumber||"?"}</span>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <div style={{width:7,height:7,borderRadius:"50%",background:cc(item.condition)}}/>
                        <span style={{fontSize:11,fontWeight:600,color:cc(item.condition)}}>{item.condition?.split(" - ")[1]||item.condition}</span>
                      </div>
                    </div>
                    <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:B,lineHeight:1,marginBottom:3}}>{item.price.toLocaleString("sv-SE")} kr</div>
                    <div style={{fontSize:11,color:MU,display:"flex",gap:10,flexWrap:"wrap"}}>
                      {item.location&&<span>Placering: <strong style={{color:TX}}>{item.location}</strong></span>}
                      <span>Antal: <strong style={{color:item.quantity===0?R:GR}}>{item.quantity} st</strong></span>
                      {item.regNumber&&<span>Reg: <strong style={{color:B}}>{item.regNumber}</strong></span>}
                    </div>
                    {item.notes&&<div style={{fontSize:11,color:TM,marginTop:4,fontStyle:"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>"{item.notes}"</div>}
                  </div>

                  {/* Selection indicator */}
                  <div style={{flexShrink:0,width:24,height:24,borderRadius:"50%",border:`2px solid ${isSel?B:BD}`,background:isSel?B:WH,display:"flex",alignItems:"center",justifyContent:"center"}}>
                    {isSel&&<i className="fa-solid fa-check" style={{fontSize:10,color:WH}}/>}
                  </div>
                </div>

                {/* Action buttons — shown when selected */}
                {isSel&&(
                  <div style={{display:"flex",gap:8,padding:"0 14px 14px"}} onClick={e=>e.stopPropagation()}>
                    <Btn variant="ghost" onClick={()=>push("detail",{item})}><i className="fa-solid fa-circle-info"/> Detaljer</Btn>
                    {(can("canSell")||isAdmin)&&item.quantity>0&&(
                      <Btn variant="red" onClick={()=>push("sell",{item})}><i className="fa-solid fa-tag"/> Sälj</Btn>
                    )}
                    {(can("canUseCheckout")||isAdmin)&&item.quantity>0&&(
                      <Btn variant="ghost" onClick={()=>{addToCart(item);toast$(`#${item.stockNumber} tillagd i korgen`,"success");setSelected(null);}}><i className="fa-solid fa-cart-shopping"/></Btn>
                    )}
                    {can("canEdit")&&<Btn variant="ghost" onClick={()=>push("edit",{item})}><i className="fa-solid fa-pen"/></Btn>}
                    {(can("canDelete")||isAdmin)&&<Btn variant="ghost" onClick={()=>setConfirmDel(item.id)} style={{color:R}}><i className="fa-solid fa-trash"/></Btn>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort exemplar?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Detta tar bara bort detta specifika exemplar — inte de andra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}


// ─── Item Card ────────────────────────────────────────────────────────────────
const ItemCard = React.memo(function ItemCard({ item, can, isAdmin, onDetail, onEdit, onSell, onAddToCart, onDelete, onReserve }) {
  const location = [item.locationType, item.location].filter(Boolean).join(" ");
  const imgSrc = item.thumb || item.images?.[0] || (item.hasImages>0 ? `/api/img/${item.id}?v=${item.updatedAt||0}` : null);
  const freeQtyCard = Math.max(0, (item.quantity||0) - (item.reservations?.length||0));
  return (
    <div onClick={onDetail} style={{background:WH,borderRadius:12,border:`1px solid ${BD}`,boxShadow:SH,padding:12,cursor:"pointer",display:"flex",flexDirection:"column",gap:8,height:188,boxSizing:"border-box",overflow:"hidden",position:"relative"}}>

      {/* Topp: bild + (lagernr, namn, artikelnummer) */}
      <div style={{display:"flex",gap:11,alignItems:"flex-start"}}>
        <div style={{flexShrink:0,width:62,height:62,borderRadius:9,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
          {imgSrc?<img src={imgSrc} alt="" loading="lazy" decoding="async" width={62} height={62} style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon name="wrench" style={{color:MU,fontSize:18}}/>}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}>
            {item.stockNumber&&<span style={{background:B,color:WH,borderRadius:5,padding:"2px 8px",fontSize:13,fontWeight:800,letterSpacing:.3}}>#{item.stockNumber}</span>}
            {item.reservations?.length>0&&<span style={{background:AM,color:WH,borderRadius:5,padding:"2px 7px",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",gap:3}}><i className="fa-solid fa-bookmark" style={{fontSize:9}}/>{item.reservations.length} res</span>}
          </div>
          <div style={{fontWeight:700,fontSize:14,lineHeight:1.25,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}{item.side?` — ${item.side}`:""}</div>
          {item.oem&&<div style={{fontSize:15,fontWeight:800,color:TX,fontFamily:"monospace",letterSpacing:.3,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",lineHeight:1.15}}>{item.oem}</div>}
        </div>
      </div>

      {/* Placering — stor och tydlig */}
      {location&&(
        <div style={{display:"flex",alignItems:"center",gap:6,background:B+"0A",borderRadius:7,padding:"6px 10px"}}>
          <i className="fa-solid fa-location-dot" style={{fontSize:14,color:B}}/>
          <span style={{fontSize:15,fontWeight:800,color:B}}>{location}</span>
        </div>
      )}

      {/* Notering — om den finns (en rad) */}
      {item.notes&&(
        <div style={{background:"#FFFBEB",border:`1px solid ${AM}35`,borderRadius:7,padding:"5px 9px",fontSize:11.5,color:TM,lineHeight:1.4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          <i className="fa-solid fa-note-sticky" style={{color:AM,marginRight:5}}/>{item.notes}
        </div>
      )}

      {/* Botten: pris + antal + knappar */}
      <div style={{display:"flex",alignItems:"flex-end",gap:8,marginTop:"auto"}} onClick={e=>e.stopPropagation()}>
        <div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:B,lineHeight:1}}>{(item.price||0).toLocaleString("sv-SE")} kr</div>
        </div>
        <div style={{textAlign:"right",lineHeight:1,marginLeft:"auto"}}>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:22,fontWeight:800,color:item.quantity===0?R:GR}}>{item.quantity}</span>
          <span style={{fontSize:10,color:MU,marginLeft:2}}>st</span>
        </div>
        <div style={{display:"flex",gap:4}}>
          {(can("canUseCheckout")||isAdmin)&&freeQtyCard>0&&<Btn variant="blue" small onClick={onAddToCart}><Icon name="cart-shopping"/></Btn>}
          {(can("canSell")||isAdmin)&&freeQtyCard>0&&<Btn variant="ghost" small onClick={onSell}><Icon name="tag"/></Btn>}
          {onReserve&&(can("canAddReservations")||isAdmin)&&freeQtyCard>0&&<Btn variant="ghost" small onClick={onReserve} style={{color:AM}}><Icon name="bookmark"/></Btn>}
          {can("canEdit")&&<Btn variant="ghost" small onClick={onEdit}><Icon name="pen"/></Btn>}
        </div>
      </div>
    </div>
  );
});

// ─── List Row ─────────────────────────────────────────────────────────────────
function ListRow({ item, can, isAdmin, onDetail, onEdit, onSell, onAddToCart, onDelete }) {
  const [bg, setBg] = useState("transparent");
  return (
    <tr style={{borderBottom:`1px solid ${BD}50`,cursor:"pointer",background:bg}} onMouseEnter={()=>setBg(BG)} onMouseLeave={()=>setBg("transparent")} onClick={onDetail}>
      <td style={{padding:"7px 10px"}}><div style={{width:36,height:36,borderRadius:6,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{(item.thumb||item.images?.[0])?<img src={item.thumb||item.images[0]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon name="wrench" style={{color:MU}}/>}</div></td>
      <td style={{padding:"7px 10px"}}><div style={{fontWeight:600,fontSize:13}}>{item.stockNumber&&<span style={{background:B,color:WH,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:800,marginRight:5}}>#{item.stockNumber}</span>}{item.name}{item.side&&<span style={{color:MU,fontWeight:400}}> — {item.side}</span>}</div>{item.oem&&<div style={{fontSize:11,color:MU}}>Art.nr: {item.oem}</div>}</td>
      <td style={{padding:"7px 10px",fontSize:11,color:MU}}>{item.sku}</td>
      <td style={{padding:"7px 10px"}}><Badge label={item.category} color={B} small /></td>
      <td style={{padding:"7px 10px"}}><Badge label={item.condition} color={cc(item.condition)} small /></td>
      <td style={{padding:"7px 10px"}}><span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:sc(item.quantity)}}>{item.quantity}</span></td>
      <td style={{padding:"7px 10px",fontWeight:600,fontSize:13}}>{item.price.toLocaleString("sv-SE")} kr</td>
      <td style={{padding:"7px 10px",fontSize:11,color:MU}}>{item.location}</td>
      <td style={{padding:"7px 10px"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",gap:4}}>
          {(can("canUseCheckout")||isAdmin)&&item.quantity>0&&<Btn variant="blue" small onClick={onAddToCart}><Icon name="cart-shopping"/></Btn>}
          {(can("canSell")||isAdmin)&&item.quantity>0&&<Btn variant="ghost" small onClick={onSell}><Icon name="tag"/></Btn>}
          {can("canEdit")&&<Btn variant="ghost" small onClick={onEdit}><Icon name="pen"/></Btn>}
          {can("canDelete")&&<Btn variant="ghost" small onClick={onDelete} style={{color:R}}><Icon name="trash"/></Btn>}
        </div>
      </td>
    </tr>
  );
}

// ─── Detail Page ──────────────────────────────────────────────────────────────
// ─── Reservations Page — alla reservationer, grupperade per regnummer ─────────
function ReservationsPage({ items, saveItems, can, isAdmin, currentUser, push, pop, toast$ }) {
  if (!isAdmin && !can("canViewReservations")) return <Page><TopBar title="Reservationer" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [confirmUnreserve, setConfirmUnreserve] = useState(null);
  const [search, setSearch] = useState("");

  // Bygg en lista: en post per reservation, med tillhörande artikel
  const allRes = [];
  for (const it of items) {
    for (const r of (it.reservations||[])) {
      allRes.push({ ...r, item: it });
    }
  }
  // Gruppera per regnummer
  const groups = {};
  for (const r of allRes) {
    const key = r.regNumber || "—";
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  // Filtrera på sök (regnummer eller kund)
  let groupKeys = Object.keys(groups).sort();
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    groupKeys = groupKeys.filter(k =>
      k.toLowerCase().includes(q) || groups[k].some(r => (r.customer||"").toLowerCase().includes(q))
    );
  }

  const removeReservation = async (item, resId) => {
    const updated = { ...item, reservations: (item.reservations||[]).filter(r=>r.id!==resId), updatedAt:Date.now() };
    const res = await saveOneItem(updated);
    if (res) saveItems(res); else await saveItems(items.map(i=>i.id===item.id?updated:i));
    setConfirmUnreserve(null);
    toast$("Reservation borttagen","success");
  };

  return (
    <Page>
      <TopBar title="Reservationer" onBack={pop} subtitle={`${allRes.length} reservationer · ${groupKeys.length} bilar`} />
      <div style={{padding:"14px 14px 40px"}}>
        <div style={{marginBottom:14}}>
          <div style={{position:"relative"}}>
            <Icon name="magnifying-glass" style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:MU,fontSize:13}}/>
            <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök regnummer eller kund…"
              style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:8,padding:"10px 12px 10px 34px",fontSize:14}}/>
          </div>
        </div>

        {allRes.length===0?(
          <div style={{textAlign:"center",padding:50,color:MU}}>
            <Icon name="bookmark" style={{fontSize:42,display:"block",margin:"0 auto 14px",color:BD}}/>
            <div style={{fontWeight:700,fontSize:15,marginBottom:6}}>Inga reservationer än</div>
            <div style={{fontSize:13}}>Reservera delar från en dels detaljsida eller direkt på korten.</div>
          </div>
        ):groupKeys.length===0?(
          <div style={{textAlign:"center",padding:40,color:MU}}>Inga träffar på "{search}"</div>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {groupKeys.map(reg=>{
              const list = groups[reg];
              const customer = list.find(r=>r.customer)?.customer;
              return (
                <div key={reg} style={{background:WH,borderRadius:12,border:`1.5px solid ${AM}40`,overflow:"hidden"}}>
                  {/* Bil-header */}
                  <div style={{background:AM+"12",padding:"12px 14px",display:"flex",alignItems:"center",gap:10,borderBottom:`1px solid ${AM}25`}}>
                    <span style={{background:AM,color:WH,borderRadius:6,padding:"4px 12px",fontSize:17,fontWeight:800,letterSpacing:1,fontFamily:"monospace"}}>{reg}</span>
                    {customer&&<span style={{fontSize:14,fontWeight:700,color:TX}}>{customer}</span>}
                    <span style={{marginLeft:"auto",fontSize:12,color:"#7A4E00",fontWeight:700}}>{list.length} {list.length===1?"del":"delar"}</span>
                  </div>
                  {/* Delar reserverade till denna bil */}
                  <div style={{padding:"6px 14px 10px"}}>
                    {list.map(r=>(
                      <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:`1px solid ${BD}40`}}>
                        <div onClick={()=>push("detail",{item:r.item})} style={{flex:1,minWidth:0,cursor:"pointer"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                            {r.item.stockNumber&&<span style={{background:B,color:WH,borderRadius:4,padding:"1px 7px",fontSize:11,fontWeight:800}}>#{r.item.stockNumber}</span>}
                            <span style={{fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.item.name}{r.item.side?` — ${r.item.side}`:""}</span>
                          </div>
                          {r.item.oem&&<div style={{fontSize:13,fontWeight:700,color:TX,fontFamily:"monospace"}}>{r.item.oem}</div>}
                          {r.note&&<div style={{fontSize:12,color:TM,marginTop:2}}>{r.note}</div>}
                          <div style={{fontSize:10,color:MU,marginTop:2}}>Reserverad av {r.by} · {new Date(r.ts).toLocaleDateString("sv-SE")}</div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:18,fontWeight:800,color:B}}>{(r.item.price||0).toLocaleString("sv-SE")} kr</div>
                          <div style={{display:"flex",gap:6,marginTop:4,justifyContent:"flex-end"}}>
                            <Btn small variant="ghost" onClick={()=>push("detail",{item:r.item})}><Icon name="eye"/></Btn>
                            {(can("canEditReservations")||isAdmin)&&<Btn small variant="ghost" onClick={()=>setConfirmUnreserve({item:r.item, res:r})} style={{color:R}}><Icon name="xmark"/></Btn>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {confirmUnreserve&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmUnreserve(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort reservation?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Reservationen av <strong style={{color:TX}}>{confirmUnreserve.item.name}</strong> för <strong style={{color:TX}}>{confirmUnreserve.res.regNumber}</strong> tas bort.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmUnreserve(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>removeReservation(confirmUnreserve.item, confirmUnreserve.res.id)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Detail Page ──────────────────────────────────────────────────────────────
function DetailPage({ item: initialItem, items, sales, saveItems, saveSales, addToCart, can, isAdmin, currentUser, push, pop, toast$, openReserve, logActivity }) {
  // Get fresh item from store in case it was updated
  const item = items.find(i=>i.id===initialItem.id) || initialItem;
  const isMobile = useIsMobile();
  const [idx, setIdx] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const [showReserve, setShowReserve] = useState(!!openReserve);
  const [confirmDel, setConfirmDel] = useState(false);
  const [resForm, setResForm] = useState({ regNumber:"", customer:"", note:"" });
  const [confirmUnreserve, setConfirmUnreserve] = useState(null);
  const [sellToReserved, setSellToReserved] = useState(null);
  const touchRef = useRef(null);
  const bilInfoUrl = item.regNumber ? `https://www.biluppgifter.se/fordon/${item.regNumber.replace(/\s/g,"")}` : null;

  // Reservationer ligger på artikeln. Antal som går att sälja fritt =
  // antal minus antal reservationer (reserverade exemplar är skyddade).
  const reservations = item.reservations || [];
  const freeQty = Math.max(0, (item.quantity||0) - reservations.length);

  // Bygg cachebara bild-URL:er — webbläsaren cachar dem, hämtas aldrig om.
  // En URL per bild: /api/img/<id>/<index>?v=<tid>
  const count = item.images?.length > 0 ? item.images.length : (item.hasImages || 0);
  const imgs = item.images?.length > 0
    ? item.images  // precis sparade, redan i minnet
    : Array.from({length: count}, (_, k) => `/api/img/${item.id}/${k}?v=${item.updatedAt||0}`);

  const handleTouchStart = e => { touchRef.current = e.touches[0].clientX; };
  const handleTouchEnd = e => {
    if (touchRef.current===null) return;
    const dx = e.changedTouches[0].clientX - touchRef.current;
    if (dx<-40) setIdx(i=>Math.min(imgs.length-1,i+1));
    if (dx>40)  setIdx(i=>Math.max(0,i-1));
    touchRef.current = null;
  };

  // ── Reservationer ──────────────────────────────────────────────────────────
  const addReservation = async () => {
    if (!resForm.regNumber.trim()) { toast$("Ange registreringsnummer","error"); return; }
    if (reservations.length >= (item.quantity||0)) { toast$("Alla exemplar är redan reserverade","error"); return; }
    const newRes = {
      id: genId("res"),
      regNumber: resForm.regNumber.trim().toUpperCase(),
      customer: resForm.customer.trim(),
      note: resForm.note.trim(),
      by: currentUser?.username || "Okänd",
      ts: Date.now(),
    };
    const updated = { ...item, reservations:[...reservations, newRes], updatedAt:Date.now() };
    const res = await saveOneItem(updated);
    if (res) saveItems(res); else await saveItems(items.map(i=>i.id===item.id?updated:i));
    setShowReserve(false);
    setResForm({ regNumber:"", customer:"", note:"" });
    logActivity&&logActivity("reserve", `Reserverade ${item.name}${item.stockNumber?` (#${item.stockNumber})`:""} åt ${newRes.regNumber}${newRes.customer?` (${newRes.customer})`:""}`, { user: currentUser?.username });
    toast$("Reservation tillagd","success");
  };

  const removeReservation = async (resId) => {
    const updated = { ...item, reservations: reservations.filter(r=>r.id!==resId), updatedAt:Date.now() };
    const res = await saveOneItem(updated);
    if (res) saveItems(res); else await saveItems(items.map(i=>i.id===item.id?updated:i));
    setConfirmUnreserve(null);
    toast$("Reservation borttagen","success");
  };

  const doDelete = async () => {
    const updated = await deleteOneItem(item.id);
    if (updated) saveItems(updated);
    else await saveItems(items.filter(i=>i.id!==item.id));
    setConfirmDel(false);
    logActivity&&logActivity("delete", `Tog bort ${item.name}${item.stockNumber?` (#${item.stockNumber})`:""}`, { user: currentUser?.username });
    toast$("Del borttagen","success");
    pop();
  };

  const printProduct = () => {
    const imgHtml = item.images?.length>0 ? `<img src="${item.images[0]}" style="width:200px;height:150px;object-fit:cover;border-radius:8px;margin-bottom:12px"/>` : "";
    const loc = [item.locationType, item.location].filter(Boolean).join(" — ");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${item.name}</title>
    <style>body{font-family:sans-serif;margin:0;padding:24px;color:#141820}
    .num{background:#1B3A6B;color:#fff;padding:6px 14px;border-radius:6px;font-size:22px;font-weight:800;letter-spacing:1px;display:inline-block;margin-bottom:12px}
    h1{font-size:18px;margin:0 0 4px}
    .badge{display:inline-block;background:#1B3A6B18;color:#1B3A6B;border:1px solid #1B3A6B28;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;margin:2px}
    .price{font-size:28px;font-weight:800;color:#1B3A6B;margin:12px 0}
    .row{font-size:12px;padding:5px 0;border-bottom:1px solid #f0f0f0}
    .lbl{color:#8A90A0;font-size:10px;text-transform:uppercase}
    .val{font-weight:600;font-size:13px}
    </style></head><body>
    ${imgHtml}
    ${item.stockNumber?`<div class="num">#${item.stockNumber}</div><br/>`:""}
    <h1>${item.name}${item.side?` — ${item.side}`:""}</h1>
    <div style="margin:6px 0">
      <span class="badge">${item.category||""}</span>
      <span class="badge">${item.condition||""}</span>
    </div>
    <div class="price">${(item.price||0).toLocaleString("sv-SE")} kr</div>
    <div class="row"><div class="lbl">Artikelnummer</div><div class="val" style="font-family:monospace">${item.oem||"—"}</div></div>
    ${item.make?`<div class="row"><div class="lbl">Märke</div><div class="val">${item.make} ${item.model||""}</div></div>`:""}
    ${loc?`<div class="row"><div class="lbl">Placering</div><div class="val">${loc}</div></div>`:""}
    ${item.regNumber?`<div class="row"><div class="lbl">Reg.nr</div><div class="val">${item.regNumber}</div></div>`:""}
    ${item.notes?`<div style="margin-top:14px;background:#f5f5f7;border-radius:6px;padding:10px;font-size:12px">${item.notes}</div>`:""}
    <script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});</script>
    </body></html>`;
    // Lägg till auto-print script och använd universell printHtml
    const printableHtml = html.replace("</body>", "<script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body>");
    printHtml(printableHtml);
  };

  const shareLink = async () => {
    const baseUrl = window.location.origin;
    const link = `${baseUrl}/?item=${item.id}`;
    const text = `${item.name} — #${item.stockNumber||""}\nArtikelnr: ${item.oem||"—"}\nPris: ${(item.price||0).toLocaleString("sv-SE")} kr`;

    // Web Share API — mobilens egna dela-meny (AirDrop, WhatsApp, Messages osv)
    if (navigator.share) {
      try {
        await navigator.share({ title: item.name, text, url: link });
        return;
      } catch (e) {
        // Användaren avbröt — gör inget
        if (e.name === "AbortError") return;
      }
    }

    // Desktop utan Web Share — visa egen panel
    setShareData({ link, subject: encodeURIComponent(`${item.name} — #${item.stockNumber||""}`), body: encodeURIComponent(text + "\n\n" + link) });
    setShowShare(true);
  };

  const [showShare, setShowShare] = useState(false);
  const [shareData, setShareData] = useState(null);

  const canCart = (can("canUseCheckout")||isAdmin) && freeQty>0;
  const canSellBtn = (can("canSell")||isAdmin) && freeQty>0;
  const canReserveBtn = (can("canAddReservations")||isAdmin) && reservations.length<(item.quantity||0);
  const canEditBtn = can("canEdit");
  const canDeleteBtn = can("canDelete")||isAdmin;

  const right = (
    <div style={{display:"flex",gap:6,alignItems:"center"}}>
      <Btn small variant="ghost" onClick={shareLink}><Icon name="share-nodes"/></Btn>
      <Btn small variant="ghost" onClick={printProduct}><Icon name="print"/></Btn>
      {canReserveBtn&&<Btn small variant="ghost" onClick={()=>setShowReserve(true)}><Icon name="bookmark"/>{!isMobile&&" Reservera"}</Btn>}
      {canSellBtn&&<Btn small variant="red" onClick={()=>push("sell",{item, maxQty:freeQty})}><Icon name="tag"/>{!isMobile&&" Sälj"}</Btn>}
      {canEditBtn&&<Btn small variant="ghost" onClick={()=>push("edit",{item})}><Icon name="pen"/></Btn>}
      {/* På dator: kassa + ta bort också uppe. På mobil: dessa hamnar längst ner. */}
      {!isMobile&&canCart&&<Btn small variant="blue" onClick={()=>{ addToCart(item); toast$(`${item.name} tillagd i korgen`,"success"); }}><Icon name="cart-shopping"/> Kassa</Btn>}
      {!isMobile&&canDeleteBtn&&<Btn small variant="ghost" onClick={()=>setConfirmDel(true)} style={{color:R}}><Icon name="trash"/></Btn>}
    </div>
  );

  return (
    <Page>
      <TopBar title={item.name+(item.side?` — ${item.side}`:"")} onBack={pop} right={right} />
      <div style={{padding:"14px 14px 40px"}}>

      {/* Dela-panel */}
      {showShare&&shareData&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:300,display:"flex",alignItems:"flex-end"}} onClick={()=>setShowShare(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:"16px 16px 0 0",width:"100%",padding:"20px 16px",paddingBottom:"max(20px,env(safe-area-inset-bottom))"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:16,textAlign:"center"}}>Dela artikel</div>
            {[
              {icon:"envelope",label:"Outlook / E-post",action:()=>{ window.open(`mailto:?subject=${shareData.subject}&body=${shareData.body}`); setShowShare(false); }},
              {icon:"brands fa-microsoft",label:"Teams",action:()=>{ window.open(`https://teams.microsoft.com/l/chat/0/0?message=${shareData.body}`); setShowShare(false); }},
              {icon:"brands fa-discord",label:"Discord",action:()=>{ copyText(shareData.link).then(()=>toast$("Länk kopierad — klistra in i Discord","success")); setShowShare(false); }},
              {icon:"copy",label:"Kopiera länk",action:()=>{ copyText(shareData.link).then(()=>toast$("Länk kopierad!","success")); setShowShare(false); }},
            ].map(({icon,label,action})=>(
              <button key={label} onClick={action} style={{width:"100%",display:"flex",alignItems:"center",gap:14,padding:"13px 12px",background:"none",border:"none",borderBottom:`1px solid ${BD}`,cursor:"pointer",fontSize:14,fontWeight:500,color:TX}}>
                <i className={`fa-${icon.startsWith("brands")?icon:`solid fa-${icon}`}`} style={{fontSize:18,color:B,width:24,textAlign:"center"}}/>
                {label}
              </button>
            ))}
            <button onClick={()=>setShowShare(false)} style={{width:"100%",padding:"13px",marginTop:8,background:BG,border:"none",borderRadius:8,cursor:"pointer",fontSize:14,fontWeight:600,color:MU}}>Avbryt</button>
          </div>
        </div>
      )}

        {/* ÖVERSIKT — bild till vänster (begränsad storlek), viktig info till höger */}
        <div className="detail-hero" style={{display:"flex",gap:18,marginBottom:18,flexWrap:"wrap",alignItems:"flex-start"}}>

          {/* Bild — begränsad maxbredd så den inte tar hela skärmen */}
          {imgs.length>0 && (
            <div style={{flex:"1 1 320px",maxWidth:420,minWidth:260}}>
              <div style={{borderRadius:12,overflow:"hidden",background:BG,aspectRatio:"4/3",position:"relative",userSelect:"none"}}
                onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
                <img src={imgs[idx]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} />
                <div style={{position:"absolute",bottom:10,right:10,background:"rgba(0,0,0,.45)",color:"#fff",borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:600}}>{idx+1}/{imgs.length}</div>
                {imgs.length>1&&<>
                  <button onClick={()=>setIdx(i=>Math.max(0,i-1))} style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,.85)",border:"none",borderRadius:"50%",width:34,height:34,fontSize:18,cursor:"pointer"}}>‹</button>
                  <button onClick={()=>setIdx(i=>Math.min(imgs.length-1,i+1))} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,.85)",border:"none",borderRadius:"50%",width:34,height:34,fontSize:18,cursor:"pointer"}}>›</button>
                </>}
              </div>
              {imgs.length>1&&(
                <div style={{display:"flex",gap:6,marginTop:8,overflowX:"auto",paddingBottom:2}}>
                  {imgs.map((img,i)=><img key={i} src={img} alt="" loading="lazy" onClick={()=>setIdx(i)} style={{width:52,height:52,objectFit:"cover",borderRadius:7,border:`2.5px solid ${idx===i?B:BD}`,cursor:"pointer",flexShrink:0}}/>)}
                </div>
              )}
            </div>
          )}

          {/* Viktig info till höger om bilden */}
          <div style={{flex:"1 1 300px",minWidth:260,display:"flex",flexDirection:"column",gap:12}}>

            {/* Lagernummer — stor */}
            {item.stockNumber&&(
              <div style={{background:B,borderRadius:10,padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,.65)",textTransform:"uppercase",letterSpacing:.7,marginBottom:2}}>Lagernummer</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:40,fontWeight:800,color:WH,letterSpacing:2,lineHeight:1}}>#{item.stockNumber}</div>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  <button onClick={()=>copyText(item.stockNumber).then(()=>toast$("Lagernummer kopierat","success"))}
                    style={{background:"rgba(255,255,255,.15)",border:"none",borderRadius:8,padding:"7px 11px",color:WH,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
                    <i className="fa-solid fa-copy"/> Kopiera
                  </button>
                  <button onClick={()=>push("qrlabels",{preSelected:[item.id]})}
                    style={{background:"rgba(255,255,255,.15)",border:"none",borderRadius:8,padding:"7px 11px",color:WH,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
                    <i className="fa-solid fa-tag"/> Etikett
                  </button>
                </div>
              </div>
            )}

            {/* Artikelnummer — stort och tydligt */}
            {item.oem&&(
              <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:3}}>Artikelnummer (OEM)</div>
                  <div style={{fontFamily:"monospace",fontSize:22,fontWeight:800,color:TX,wordBreak:"break-all",lineHeight:1.1}}>{item.oem}</div>
                </div>
                <button onClick={()=>copyText(item.oem).then(()=>toast$("Artikelnummer kopierat","success"))}
                  style={{background:BG,border:`1px solid ${BD}`,borderRadius:8,padding:"7px 12px",color:B,cursor:"pointer",fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                  <i className="fa-solid fa-copy"/>
                </button>
              </div>
            )}

            {/* Placering — stor och tydlig */}
            {[item.locationType, item.location].filter(Boolean).length>0&&(
              <div style={{background:B+"0A",borderRadius:10,border:`1px solid ${B}22`,padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
                <i className="fa-solid fa-location-dot" style={{fontSize:20,color:B}}/>
                <div>
                  <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:1}}>Placering</div>
                  <div style={{fontSize:20,fontWeight:800,color:B,lineHeight:1.1}}>{[item.locationType, item.location].filter(Boolean).join(" — ")}</div>
                </div>
              </div>
            )}

            {/* Notering — högt upp så den syns direkt */}
            {item.notes&&(
              <div style={{background:"#FFFBEB",border:`1px solid ${AM}40`,borderRadius:10,padding:"10px 14px",fontSize:13,color:TM,lineHeight:1.5}}>
                <div style={{fontSize:10,fontWeight:700,color:"#9A6B00",textTransform:"uppercase",letterSpacing:.7,marginBottom:3}}>Notering</div>
                {item.notes}
              </div>
            )}
          </div>
        </div>

        {/* Flera exemplar — länk till variantsidan */}
        {(() => {
          const siblings = items.filter(i => i.sku?.trim().toLowerCase() === item.sku?.trim().toLowerCase());
          if (siblings.length <= 1) return null;
          return (
            <div onClick={()=>push("variants",{sku:item.sku})} style={{background:AM+"10",border:`1.5px solid ${AM}40`,borderRadius:10,padding:"12px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
              <i className="fa-solid fa-layer-group" style={{fontSize:20,color:AM}}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13,color:"#7A4E00"}}>Det finns {siblings.length} exemplar av denna del</div>
                <div style={{fontSize:11,color:"#7A4E00"}}>Olika skick och pris — tryck för att jämföra och välja</div>
              </div>
              <i className="fa-solid fa-chevron-right" style={{color:AM,fontSize:13}}/>
            </div>
          );
        })()}

        {/* Beskrivning */}
        {item.description&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"12px 14px",marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:5}}>Beskrivning</div>
            <div style={{fontSize:13,color:TX,lineHeight:1.5}}>{item.description}</div>
          </div>
        )}

        {/* Badges */}
        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:14}}>
          <Badge label={item.category} color={B} />
          {item.side&&<Badge label={item.side} color={B} />}
          <Badge label={item.condition} color={cc(item.condition)} />
          
        </div>

        {/* Price + qty */}
        <div style={{display:"flex",gap:10,marginBottom:16}}>
          <div style={{flex:1,background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:2}}>Försäljningspris</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:B}}>{item.price.toLocaleString("sv-SE")} kr</div>
          </div>
          <div style={{flex:1,background:sc(item.quantity)+"10",border:`1px solid ${sc(item.quantity)}30`,borderRadius:10,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:2}}>I lager</div>
            <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:28,fontWeight:800,color:sc(item.quantity)}}>{item.quantity} st</div>
          </div>
        </div>

        {/* ── Reservationer ── */}
        {(can("canViewReservations")||can("canAddReservations")||isAdmin)&&(
          <div style={{background:WH,borderRadius:10,border:`1.5px solid ${reservations.length>0?AM+"60":BD}`,padding:"12px 14px",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:reservations.length>0?10:0}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <i className="fa-solid fa-bookmark" style={{color:reservations.length>0?AM:MU,fontSize:15}}/>
                <span style={{fontWeight:800,fontSize:14,color:TX}}>Reservationer</span>
                {reservations.length>0&&<span style={{background:AM,color:WH,borderRadius:10,padding:"1px 8px",fontSize:11,fontWeight:700}}>{reservations.length} av {item.quantity}</span>}
              </div>
            </div>
            {reservations.length===0&&(
              <div style={{fontSize:12,color:MU}}>Inga reservationer. Använd "Reservera" uppe i headern för att reservera ett exemplar åt en kund.</div>
            )}

            {reservations.length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {reservations.map(r=>(
                  <div key={r.id} style={{background:AM+"0C",border:`1px solid ${AM}30`,borderRadius:8,padding:"10px 12px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:r.customer||r.note?5:0}}>
                      <span style={{background:AM,color:WH,borderRadius:5,padding:"2px 9px",fontSize:14,fontWeight:800,letterSpacing:.5,fontFamily:"monospace"}}>{r.regNumber}</span>
                      {r.customer&&<span style={{fontSize:13,fontWeight:600,color:TX}}>{r.customer}</span>}
                      <div style={{marginLeft:"auto",display:"flex",gap:6}}>
                        {(can("canSell")||isAdmin)&&<Btn small variant="red" onClick={()=>setSellToReserved(r)}><Icon name="tag"/> Sälj</Btn>}
                        {(can("canEditReservations")||isAdmin)&&<Btn small variant="ghost" onClick={()=>setConfirmUnreserve(r)} style={{color:R}}><Icon name="xmark"/></Btn>}
                      </div>
                    </div>
                    {r.note&&<div style={{fontSize:12,color:TM,marginBottom:3}}>{r.note}</div>}
                    <div style={{fontSize:10,color:MU}}>Reserverad av {r.by} · {new Date(r.ts).toLocaleDateString("sv-SE")}</div>
                  </div>
                ))}
                {freeQty>0
                  ? <div style={{fontSize:11,color:MU,marginTop:2}}>{freeQty} av {item.quantity} kan säljas fritt — resten är reserverade.</div>
                  : <div style={{fontSize:11,color:AM,fontWeight:600,marginTop:2}}>Alla exemplar är reserverade — kan bara säljas till reserverad kund.</div>}
              </div>
            )}
          </div>
        )}


        {/* Ursprungsbil */}
        {(item.make||item.model||item.regNumber)&&(
          <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:"12px 14px",marginBottom:14}}>
            <div style={{fontSize:10,fontWeight:700,color:B,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>Ursprungsbil</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:"8px 20px",marginBottom:10}}>
              {item.make&&<div><div style={{fontSize:10,color:MU,fontWeight:700,textTransform:"uppercase",marginBottom:1}}>Märke</div><div style={{fontSize:14,fontWeight:600}}>{item.make}</div></div>}
              {item.model&&<div><div style={{fontSize:10,color:MU,fontWeight:700,textTransform:"uppercase",marginBottom:1}}>Modell</div><div style={{fontSize:14,fontWeight:600}}>{item.model}</div></div>}
              {item.yearFrom&&<div><div style={{fontSize:10,color:MU,fontWeight:700,textTransform:"uppercase",marginBottom:1}}>Årsmodell</div><div style={{fontSize:14,fontWeight:600}}>{item.yearFrom}{item.yearTo?`-${item.yearTo}`:""}</div></div>}
              {item.regNumber&&<div><div style={{fontSize:10,color:MU,fontWeight:700,textTransform:"uppercase",marginBottom:1}}>Reg.nr</div><div style={{fontSize:15,fontWeight:800,letterSpacing:1.5,color:B}}>{item.regNumber}</div></div>}
            </div>
            {bilInfoUrl&&<button onClick={()=>{ try{ window.open(bilInfoUrl,"_blank"); }catch{ window.location.href=bilInfoUrl; } }} style={{display:"inline-flex",alignItems:"center",gap:5,background:B,color:"#fff",borderRadius:6,padding:"7px 14px",fontSize:12,fontWeight:600,border:"none",cursor:"pointer"}}><Icon name="magnifying-glass" style={{marginRight:5}}/> Kolla bilinfo & originalpris</button>}
          </div>
        )}

        {/* QR-kod */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"14px",marginBottom:14,display:"flex",alignItems:"center",gap:14}}>
          <img src={`https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(item.oem||item.stockNumber||item.sku)}`} alt="QR" style={{width:70,height:70,borderRadius:6,border:`1px solid ${BD}`}} onError={e=>{e.target.style.display="none";e.target.nextSibling.style.display="flex";}} /><div style={{width:70,height:70,borderRadius:6,border:`1px solid ${BD}`,background:BG,display:"none",alignItems:"center",justifyContent:"center",fontSize:9,color:MU,textAlign:"center",padding:4,fontFamily:"monospace"}}>{item.oem||item.stockNumber||item.sku}</div>
          <div>
            <div style={{fontSize:10,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:3}}>QR-kod för skanning</div>
            <div style={{fontSize:13,fontWeight:600,fontFamily:"monospace"}}>{item.oem||item.stockNumber||item.sku}</div>
          </div>
        </div>

        {/* Fields — viktigast synligt, resten bakom "Visa mer" */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"14px",marginBottom:14}}>
          <div style={{display:"flex",flexWrap:"wrap",gap:"12px 12px"}}>
            <Field label="Artikelnummer" value={item.oem} half />
            <Field label="Skick" value={item.condition} half />
            <Field label="Sida" value={item.side} half />
            <Field label="Placering" value={[item.locationType, item.location].filter(Boolean).join(" — ")} half />
          </div>
          {showMore&&(
            <div style={{display:"flex",flexWrap:"wrap",gap:"12px 12px",marginTop:12,paddingTop:12,borderTop:`1px solid ${BD}`}}>
              <Field label="Färgkod" value={item.colorCode} half />
              <Field label="Vikt" value={item.weight?item.weight+" kg":""} half />
              <Field label="Leverantör" value={item.supplier} half />
              {(isAdmin||can("canEdit"))&&<Field label="Inköpspris" value={item.costPrice?item.costPrice.toLocaleString("sv-SE")+" kr":""} half />}
              <Field label="Uppdaterad" value={new Date(item.updatedAt).toLocaleDateString("sv-SE")} half />
            </div>
          )}
          <button onClick={()=>setShowMore(v=>!v)} style={{width:"100%",background:"none",border:"none",borderTop:showMore?"none":`1px solid ${BD}`,marginTop:showMore?10:12,paddingTop:10,color:B,fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
            {showMore?"Visa mindre":"Visa fler detaljer"} <i className={`fa-solid fa-chevron-${showMore?"up":"down"}`} style={{fontSize:10}}/>
          </button>
        </div>

        {/* Mobil — kassa & ta bort längst ner (de nya knapparna) */}
        {isMobile&&(canCart||canDeleteBtn)&&(
          <div style={{display:"flex",gap:8,marginTop:16}}>
            {canCart&&<Btn full variant="blue" onClick={()=>{ addToCart(item); toast$(`${item.name} tillagd i korgen`,"success"); }}><Icon name="cart-shopping"/> Lägg i kassa</Btn>}
            {canDeleteBtn&&<Btn full variant="ghost" onClick={()=>setConfirmDel(true)} style={{color:R,borderColor:R+"40"}}><Icon name="trash"/> Ta bort</Btn>}
          </div>
        )}

      </div>

      {/* Bekräfta ta bort del */}
      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort {item.name}?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Delen tas bort permanent från lagret. Detta går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(false)}>Avbryt</Btn>
              <Btn full variant="red" onClick={doDelete}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Modal — lägg till reservation */}
      {showReserve&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setShowReserve(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:380,width:"100%"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:4}}>Reservera del</div>
            <div style={{fontSize:12,color:MU,marginBottom:16}}>Reservera ett exemplar åt en kund. Det skyddas från försäljning tills det säljs till kunden eller av-reserveras.</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <div>
                <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Registreringsnummer *</label>
                <input type="text" value={resForm.regNumber} onChange={e=>setResForm(f=>({...f,regNumber:e.target.value.toUpperCase()}))} placeholder="ABC123" autoFocus
                  style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"10px 12px",fontSize:15,fontWeight:700,letterSpacing:1,marginTop:4,fontFamily:"monospace"}}/>
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Kund (valfritt)</label>
                <input type="text" value={resForm.customer} onChange={e=>setResForm(f=>({...f,customer:e.target.value}))} placeholder="Namn eller företag"
                  style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:14,marginTop:4}}/>
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Notering (valfritt)</label>
                <input type="text" value={resForm.note} onChange={e=>setResForm(f=>({...f,note:e.target.value}))} placeholder="t.ex. hämtas på fredag"
                  style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:14,marginTop:4}}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:18}}>
              <Btn full variant="ghost" onClick={()=>setShowReserve(false)}>Avbryt</Btn>
              <Btn full onClick={addReservation}><Icon name="bookmark"/> Reservera</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Bekräfta av-reservation */}
      {confirmUnreserve&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmUnreserve(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort reservation?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Reservationen för <strong style={{color:TX}}>{confirmUnreserve.regNumber}</strong>{confirmUnreserve.customer?` (${confirmUnreserve.customer})`:""} tas bort. Delen blir säljbar för alla igen.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmUnreserve(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>removeReservation(confirmUnreserve.id)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Sälj till reserverad kund */}
      {sellToReserved&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setSellToReserved(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:360,width:"100%"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:4}}>Sälj till reserverad kund</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>
              Säljer till <strong style={{color:TX}}>{sellToReserved.regNumber}</strong>{sellToReserved.customer?` — ${sellToReserved.customer}`:""}. Reservationen tas bort när försäljningen är klar.
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setSellToReserved(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>{
                const remaining = reservations.filter(r=>r.id!==sellToReserved.id);
                const updated = { ...item, reservations: remaining, updatedAt:Date.now() };
                saveOneItem(updated).then(res=>{ if(res) saveItems(res); else saveItems(items.map(i=>i.id===item.id?updated:i)); });
                push("sell",{ item:updated, maxQty:1, presetBuyer: sellToReserved.customer||sellToReserved.regNumber });
                setSellToReserved(null);
              }}><Icon name="tag"/> Fortsätt till försäljning</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Filter Page ──────────────────────────────────────────────────────────────
function FilterPage({ items, filters, setFilters, lists, pop }) {
  const CATS = lists?.categories||CATEGORIES, CONDS = lists?.conditions||CONDITIONS, SIDS = lists?.sides||SIDES;
  const [f, setF] = useState({...filters});
  const toggle = (key, val) => setF(p=>({...p,[key]:p[key].includes(val)?p[key].filter(x=>x!==val):[...p[key],val]}));
  const set = (key,val) => setF(p=>({...p,[key]:val}));

  const allMakes     = ["", ...new Set(items.map(i=>i.make).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"sv"));
  const allGroups    = ["", ...new Set(items.map(i=>getBrandGroup(i.make)).filter(Boolean))].sort();
  const allSuppliers = ["", ...new Set(items.map(i=>i.supplier).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"sv"));
  const allLocTypes  = ["", ...new Set(items.map(i=>i.locationType).filter(Boolean))].sort();
  const allModels    = ["", ...new Set(items.map(i=>i.model).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"sv"));

  const prices = items.map(i=>i.price||0).filter(p=>p>0);
  const globalMin = prices.length ? Math.floor(Math.min(...prices)/100)*100 : 0;
  const globalMax = prices.length ? Math.ceil(Math.max(...prices)/100)*100 : 100000;

  const pMin = f.priceMin !== "" ? Number(f.priceMin) : globalMin;
  const pMax = f.priceMax !== "" ? Number(f.priceMax) : globalMax;

  const condColors = {"Ny":GR,"Begagnad - Gott skick":B,"Begagnad - Liten spricka":AM,"Begagnad - Kräver lackering":AM,"Reservdelar / Skrotning":R};

  const parseList = (str) => (str||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  const matchCount = items.filter(i => {
    const sn = parseList(f.stockNums), an = parseList(f.artNums);
    if (sn.length && !sn.includes((i.stockNumber||"").toLowerCase())) return false;
    if (an.length && !an.includes((i.oem||"").toLowerCase())) return false;
    if (f.reserved && !(i.reservations?.length>0)) return false;
    if (f.noImage && (i.hasImages>0 || i.images?.length>0 || i.thumb)) return false;
    if (f.cats.length&&!f.cats.includes(i.category)) return false;
    if (f.conds.length&&!f.conds.includes(i.condition)) return false;
    if (f.sides.length&&!f.sides.includes(i.side)) return false;
    if (f.make&&i.make!==f.make) return false;
    if (f.brandGroup&&getBrandGroup(i.make)!==f.brandGroup) return false;
    if (f.locationType&&i.locationType!==f.locationType) return false;
    if (f.model&&i.model!==f.model) return false;
    if (f.priceMin!==""&&i.price<Number(f.priceMin)) return false;
    if (f.priceMax!==""&&i.price>Number(f.priceMax)) return false;
    if (f.low&&i.quantity>3) return false;
    if (f.supplier&&i.supplier!==f.supplier) return false;
    return true;
  }).length;

  const Section = ({label,value})=>(
    <div style={{fontSize:11,fontWeight:700,color:value?B:MU,textTransform:"uppercase",letterSpacing:1,margin:"18px 0 8px",paddingBottom:4,borderBottom:`1px solid ${value?B+"40":BD}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      {label}
      {value&&<span style={{fontSize:10,fontWeight:600,color:B,background:B+"15",borderRadius:10,padding:"1px 8px",textTransform:"none",letterSpacing:0}}>{value}</span>}
    </div>
  );

  const Chip = ({label,active,color=B,onClick})=>(
    <button onClick={onClick} style={{padding:"6px 14px",borderRadius:20,border:`1.5px solid ${active?color:BD}`,background:active?color:WH,color:active?WH:TM,fontSize:12,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>
      {label}
    </button>
  );

  const Dropdown = ({value, onChange, options, placeholder}) => (
    <select value={value} onChange={e=>onChange(e.target.value)}
      style={{width:"100%",padding:"10px 12px",border:`1.5px solid ${value?B:BD}`,borderRadius:8,fontSize:13,color:value?B:MU,background:WH,fontWeight:value?600:400,cursor:"pointer"}}>
      <option value="">{placeholder}</option>
      {options.filter(Boolean).map(o=><option key={o} value={o}>{o}</option>)}
    </select>
  );

  const apply = () => { setFilters(f); pop(); };
  const clear = () => {
    const empty={cats:[],conds:[],sides:[],make:"",brandGroup:"",locationType:"",model:"",yearMin:"",yearMax:"",priceMin:"",priceMax:"",low:false,supplier:"",stockNums:"",artNums:"",reserved:false,noImage:false};
    setF(empty); setFilters(empty);
  };

  const right = <button onClick={clear} style={{background:"none",border:"none",color:R,fontWeight:600,fontSize:13}}>Rensa</button>;

  return (
    <div className="page" style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",background:BG}}>
      <TopBar title="Filter" onBack={pop} right={right} />
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:"0 14px 20px"}}>
        <div style={{fontSize:13,color:MU,padding:"12px 0"}}>Matchar <strong style={{color:TX}}>{matchCount}</strong> av {items.length} delar</div>

        {/* Lagernummer & artikelnummer — flera med komma */}
        <Section label="Lagernummer" value={f.stockNums?"aktivt":""} />
        <input value={f.stockNums||""} onChange={e=>set("stockNums",e.target.value)} placeholder="t.ex. 11, 15, 23"
          style={{width:"100%",padding:"10px 12px",border:`1.5px solid ${f.stockNums?B:BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box",background:f.stockNums?B+"08":WH}}/>
        <div style={{fontSize:11,color:MU,marginTop:4}}>Visa bara delar med dessa lagernummer (flera separeras med komma).</div>

        <Section label="Artikelnummer" value={f.artNums?"aktivt":""} />
        <input value={f.artNums||""} onChange={e=>set("artNums",e.target.value.toUpperCase())} placeholder="t.ex. 8K0945095, 4G8867409"
          style={{width:"100%",padding:"10px 12px",border:`1.5px solid ${f.artNums?B:BD}`,borderRadius:8,fontSize:13,boxSizing:"border-box",background:f.artNums?B+"08":WH,fontFamily:"monospace"}}/>
        <div style={{fontSize:11,color:MU,marginTop:4}}>Visa bara delar med dessa artikelnummer (flera separeras med komma).</div>

        {/* Snabbval */}
        <Section label="Snabbval" value={[f.low,f.reserved,f.noImage].filter(Boolean).length?`${[f.low,f.reserved,f.noImage].filter(Boolean).length} valda`:""} />
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <Chip label="Lågt lager" active={!!f.low} color={R} onClick={()=>set("low",!f.low)}/>
          <Chip label="Reserverade" active={!!f.reserved} color={AM} onClick={()=>set("reserved",!f.reserved)}/>
          <Chip label="Utan bild" active={!!f.noImage} onClick={()=>set("noImage",!f.noImage)}/>
        </div>

        {/* Kategori — chips */}
        <Section label="Kategori" value={f.cats.length?`${f.cats.length} valda`:""} />
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {CATS.map(c=><Chip key={c} label={c} active={f.cats.includes(c)} onClick={()=>toggle("cats",c)}/>)}
        </div>

        {/* Skick — chips med färg */}
        <Section label="Skick" value={f.conds.length?`${f.conds.length} valda`:""} />
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {CONDS.map(c=><Chip key={c} label={c} active={f.conds.includes(c)} color={condColors[c]||MU} onClick={()=>toggle("conds",c)}/>)}
        </div>

        {/* Sida — chips */}
        <Section label="Sida" value={f.sides.length?`${f.sides.length} valda`:""} />
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {SIDS.filter(Boolean).map(s=><Chip key={s} label={s} active={f.sides.includes(s)} onClick={()=>toggle("sides",s)}/>)}
        </div>

        {/* Koncern — dropdown */}
        <Section label="Koncern" value={f.brandGroup||""} />
        <Dropdown value={f.brandGroup} onChange={v=>set("brandGroup",v)} options={allGroups} placeholder="Alla koncerner" />

        {/* Tillverkare — dropdown */}
        <Section label="Tillverkare" value={f.make||""} />
        <Dropdown value={f.make} onChange={v=>set("make",v)} options={allMakes} placeholder="Alla tillverkare" />

        {/* Modell — dropdown */}
        <Section label="Modell" value={f.model||""} />
        <Dropdown value={f.model} onChange={v=>set("model",v)} options={allModels} placeholder="Alla modeller" />

        {/* Placeringstyp — dropdown */}
        <Section label="Placeringstyp" value={f.locationType||""} />
        <Dropdown value={f.locationType} onChange={v=>set("locationType",v)} options={allLocTypes} placeholder="Alla placeringstyper" />

        {/* Leverantör — dropdown */}
        <Section label="Leverantör" value={f.supplier||""} />
        <Dropdown value={f.supplier} onChange={v=>set("supplier",v)} options={allSuppliers} placeholder="Alla leverantörer" />

        {/* Pris — range slider */}
        <Section label="Pris (kr)" value={(f.priceMin!==""||f.priceMax!=="")?`${pMin.toLocaleString("sv-SE")} – ${pMax.toLocaleString("sv-SE")} kr`:""} />
        <div style={{padding:"0 6px"}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:MU,marginBottom:8}}>
            <span style={{fontWeight:600,color:B}}>{pMin.toLocaleString("sv-SE")} kr</span>
            <span style={{fontWeight:600,color:B}}>{pMax.toLocaleString("sv-SE")} kr</span>
          </div>
          {/* Min slider */}
          <div style={{position:"relative",height:36}}>
            <div style={{position:"absolute",top:"50%",left:0,right:0,height:4,background:BD,borderRadius:2,transform:"translateY(-50%)"}}>
              <div style={{position:"absolute",left:`${((pMin-globalMin)/(globalMax-globalMin||1))*100}%`,right:`${100-((pMax-globalMin)/(globalMax-globalMin||1))*100}%`,height:"100%",background:B,borderRadius:2}}/>
            </div>
            <input type="range" min={globalMin} max={globalMax} step={100} value={pMin}
              onChange={e=>{const v=Number(e.target.value); if(v<=pMax) set("priceMin",String(v));}}
              style={{position:"absolute",width:"100%",height:"100%",opacity:0,cursor:"pointer",zIndex:2}}/>
            <input type="range" min={globalMin} max={globalMax} step={100} value={pMax}
              onChange={e=>{const v=Number(e.target.value); if(v>=pMin) set("priceMax",String(v));}}
              style={{position:"absolute",width:"100%",height:"100%",opacity:0,cursor:"pointer",zIndex:3}}/>
          </div>
          {(f.priceMin!==""||f.priceMax!=="")&&(
            <button onClick={()=>{set("priceMin","");set("priceMax","");}} style={{background:"none",border:"none",color:MU,fontSize:11,cursor:"pointer",textDecoration:"underline",display:"block",marginTop:4}}>Rensa pris</button>
          )}
        </div>

        {/* Lagerstatus */}
        <Section label="Lagerstatus" value={f.low?"Låglager":""} />
        <Chip label="Visa bara låglager (≤3 st)" active={f.low} color={R} onClick={()=>set("low",!f.low)} />

      </div>

      <div style={{flexShrink:0,padding:"12px 14px",background:WH,borderTop:`1px solid ${BD}`,boxShadow:"0 -4px 12px rgba(0,0,0,.08)"}}>
        <Btn full onClick={apply} style={{padding:"13px"}}>Visa {matchCount} delar</Btn>
      </div>
    </div>
  );
}

// ─── Edit Page helpers (defined outside to avoid remount on every keystroke) ──
const G2 = ({children}) => <div style={{display:"flex",gap:10,marginBottom:12}}>{children}</div>;
const H = ({children}) => <div style={{flex:1,minWidth:0}}>{children}</div>;

// ─── Edit Page ────────────────────────────────────────────────────────────────
function EditPage({ item, items, saveItems, lists, pop, push, toast$, currentUser, logActivity }) {
  const CATS = lists?.categories||CATEGORIES, CONDS = lists?.conditions||CONDITIONS, SIDS = lists?.sides||SIDES, LOCTYPES = lists?.locationTypes||LOCATION_TYPES;
  const nextStockNumber = () => {
    const used = new Set(items.map(i => parseInt(i.stockNumber||"0")).filter(n=>!isNaN(n)&&n>0));
    let n = 1;
    while (used.has(n)) n++;
    return String(n);
  };
  const [f, setF] = useState(item ? {...item} : {name:"",stockNumber:nextStockNumber(),side:"",category:"Skärmar",quantity:1,price:0,costPrice:0,supplier:"",location:"",weight:"",colorCode:"",oem:"",description:"",condition:"Begagnad - Gott skick",compatible:"",make:"",model:"",yearFrom:"",yearTo:"",regNumber:"",notes:"",images:[]});
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const fRef = useRef(); const cRef = useRef();

  // ── Redigeringslås ──────────────────────────────────────────────────────────
  const [lockState, setLockState] = useState(null); // null=okänt, {ok}|{blocked}
  const [waitingUser, setWaitingUser] = useState(null);
  const me = currentUser?.username || "Okänd";

  useEffect(() => {
    if (!item?.id) { setLockState({ ok: true }); return; } // ny del — inget lås behövs
    let active = true;
    let hbInterval = null;
    (async () => {
      const r = await lockAcquire(item.id, me, "edit");
      if (!active) return;
      if (r.ok) {
        setLockState({ ok: true });
        // Heartbeat var 30:e sek — håller låset vid liv + kollar om någon väntar
        hbInterval = setInterval(async () => {
          const h = await lockHeartbeat(item.id, me);
          if (h.waitingUser) setWaitingUser(h.waitingUser);
        }, 30000);
      } else {
        setLockState({ blocked: true, by: r.lockedBy, action: r.action, remainingMs: r.remainingMs });
      }
    })();
    return () => {
      active = false;
      if (hbInterval) clearInterval(hbInterval);
      if (item?.id) lockRelease(item.id, me); // släpp låset när man går ut
    };
  }, [item?.id]);

  // Ladda befintliga bilder (snabb endpoint)
  useEffect(() => {
    if (item?.id && (!item.images || item.images.length===0) && item.hasImages > 0) {
      (async () => {
        const imgs = await getImages(item.id);
        if (imgs?.length) setF(p => ({...p, images: imgs}));
      })();
    }
  }, [item?.id]);

  // ── Duplicate detection ────────────────────────────────────────────────────
  const otherItems = items.filter(i => i.id !== f.id);
  const dupStockNumber = f.stockNumber?.trim() && otherItems.find(i => i.stockNumber?.trim() === f.stockNumber?.trim());
  const dupOem        = f.oem?.trim()         && otherItems.find(i => i.oem?.trim().toLowerCase() === f.oem?.trim().toLowerCase());

  const DupWarning = ({ dup, label }) => dup ? (
    <div onClick={()=>pop() || push?.("detail",{item:dup})} style={{background:AM+"12",border:`1.5px solid ${AM}`,borderRadius:8,padding:"8px 12px",marginTop:4,cursor:"pointer",display:"flex",alignItems:"center",gap:8}}>
      <Icon name="triangle-exclamation" style={{color:AM,flexShrink:0}}/>
      <div style={{flex:1}}>
        <div style={{fontSize:11,fontWeight:700,color:AM}}>⚠ {label} finns redan på: <strong>{dup.name}{dup.side?` — ${dup.side}`:""}</strong> #{dup.stockNumber||"—"}</div>
        <div style={{fontSize:10,color:AM,marginTop:1}}>Tryck för att se den artikeln</div>
      </div>
    </div>
  ) : null;

  // Komprimera bilden innan den sparas — minskar storleken drastiskt
  const addImg = file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        // Skala ner till max 1000px bredd, behåll proportioner
        const maxW = 1000;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        // JPEG med 70% kvalitet — mycket mindre än original
        const compressed = canvas.toDataURL("image/jpeg", 0.7);
        set("images", [...(f.images || []), compressed]);
      };
      img.onerror = () => set("images", [...(f.images || []), e.target.result]);
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };
  const rmImg = i => set("images",f.images.filter((_,idx)=>idx!==i));

  const missing = [];
  if (!f.name?.trim()) missing.push("Namn");
  if (!f.oem?.trim()) missing.push("Artikelnummer");
  if (!f.location?.trim()) missing.push("Lagerplats");
  if (!f.stockNumber?.trim()) missing.push("Lagernummer");

  const save = async () => {
    if (missing.length>0) { toast$(`Saknas: ${missing.join(", ")}`,"error"); return; }
    if (dupStockNumber) { toast$(`Lagernr ${f.stockNumber} används redan!`,"error"); return; }
    const autoSku = f.oem.trim().toLowerCase().replace(/[^a-z0-9]/g,"");
    const normalizedMake = normalizeMake(f.make);
    const id = f.id || genId("item");

    // Spara bilderna separat via snabb endpoint — håll items-listan liten
    const imgs = f.images || [];
    await setImages(id, imgs);
    // Skapa en liten thumbnail för kortet (några KB, håller listan snabb)
    const thumb = imgs.length > 0 ? await makeThumbnail(imgs[0]) : null;
    const payload = { ...f, id, oem: (f.oem||'').toUpperCase().trim(), sku: autoSku, make: normalizedMake, updatedAt: Date.now(), images: [], hasImages: imgs.length, thumb };

    const updated = await saveOneItem(payload);
    if (updated) { saveItems(updated); toast$(f.id?"Uppdaterad":"Tillagd","success"); }
    else {
      if (f.id) await saveItems(items.map(i=>i.id===f.id?payload:i));
      else await saveItems([...items,payload]);
      toast$(f.id?"Uppdaterad":"Tillagd","success");
    }
    logActivity&&logActivity(f.id?"edit":"add", `${f.id?"Redigerade":"La till"} ${payload.name}${payload.stockNumber?` (#${payload.stockNumber})`:""}`, { user: currentUser?.username, itemName:payload.name, stockNumber:payload.stockNumber });
    pop();
  };

  const saveAndNew = async () => {
    if (missing.length>0) { toast$(`Saknas: ${missing.join(", ")}`,"error"); return; }
    if (dupStockNumber) { toast$(`Lagernr ${f.stockNumber} används redan!`,"error"); return; }
    const autoSku = f.oem.trim().toLowerCase().replace(/[^a-z0-9]/g,"");
    const normalizedMake = normalizeMake(f.make);
    const id = f.id || genId("item");

    const imgs = f.images || [];
    await setImages(id, imgs);
    const thumb = imgs.length > 0 ? await makeThumbnail(imgs[0]) : null;
    const payload = { ...f, id, oem: (f.oem||'').toUpperCase().trim(), sku: autoSku, make: normalizedMake, updatedAt: Date.now(), images: [], hasImages: imgs.length, thumb };

    const updated = await saveOneItem(payload);
    const newList = updated || (f.id ? items.map(i=>i.id===f.id?payload:i) : [...items,payload]);
    saveItems(newList);
    toast$("Sparad — fyll i nästa exemplar","success");

    const used = new Set(newList.map(i => parseInt(i.stockNumber||"0")).filter(n=>!isNaN(n)&&n>0));
    let n = 1; while (used.has(n)) n++;

    setF({ ...f, id: undefined, stockNumber: String(n), quantity: 1, images: [], regNumber: "" });
    window.scrollTo(0, 0);
  };

  const R2 = <Btn small onClick={save} style={{padding:"5px 14px"}}>Spara</Btn>;

  // Blockerad — någon annan redigerar/säljer delen
  if (lockState?.blocked) {
    const actionText = lockState.action === "cart" ? "har den i sin kassa" : "redigerar den här delen";
    return (
      <Page noAnim>
        <TopBar title="Delen är upptagen" onBack={pop} />
        <div style={{padding:"40px 24px",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:16}}>
          <div style={{width:72,height:72,borderRadius:"50%",background:AM+"18",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon name="lock" style={{fontSize:30,color:AM}}/>
          </div>
          <div>
            <div style={{fontWeight:800,fontSize:18,color:TX,marginBottom:6}}>{lockState.by} {actionText}</div>
            <div style={{fontSize:14,color:MU,lineHeight:1.5,maxWidth:320}}>
              Du kan inte ändra den här delen just nu. Den blir tillgänglig automatiskt om <strong style={{color:AM}}>{fmtLockTime(lockState.remainingMs)}</strong> om {lockState.by} inte blir klar innan dess.
            </div>
          </div>
          <Btn variant="ghost" onClick={pop}><Icon name="arrow-left"/> Tillbaka</Btn>
        </div>
      </Page>
    );
  }

  return (
    <Page noAnim>
      <TopBar title={item?"Redigera del":"Ny karossedel"} onBack={pop} right={R2} />
      <div style={{padding:"14px 14px 60px"}}>

        {/* Banner — någon väntar på delen */}
        {waitingUser&&(
          <div style={{background:AM+"15",border:`1.5px solid ${AM}`,borderRadius:10,padding:"10px 14px",marginBottom:12,display:"flex",alignItems:"center",gap:10}}>
            <Icon name="clock" style={{color:AM,fontSize:18}}/>
            <div style={{fontSize:13,color:TX,fontWeight:600}}><strong>{waitingUser}</strong> väntar på den här delen — spara och gå ut när du är klar.</div>
          </div>
        )}

        {/* De 4 obligatoriska fälten — samlade högst upp för smidigast möjliga flöde */}
        <div style={{background:B,borderRadius:10,padding:14,marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,.65)",textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Obligatoriskt</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <div>
              <input type="text" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="Namn på delen *"
                style={{width:"100%",border:`1.5px solid ${!f.name?.trim()?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 12px",fontSize:14,fontWeight:600,color:WH,background:"rgba(255,255,255,.12)"}}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <input type="text" value={f.oem} onChange={e=>set("oem",e.target.value.toUpperCase())} placeholder="Artikelnummer *"
                style={{flex:1,border:`1.5px solid ${(!f.oem?.trim()||dupOem)?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 12px",fontSize:13,fontWeight:600,color:WH,background:"rgba(255,255,255,.12)"}}/>
              <input type="text" value={f.stockNumber||""} onChange={e=>set("stockNumber",e.target.value)} placeholder="Lagernr *"
                style={{width:100,border:`1.5px solid ${(!f.stockNumber?.trim()||dupStockNumber)?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 12px",fontSize:13,fontWeight:800,color:WH,background:"rgba(255,255,255,.12)",textAlign:"center"}}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <select value={f.locationType||""} onChange={e=>set("locationType",e.target.value)}
                style={{width:130,border:`1.5px solid rgba(255,255,255,.3)`,borderRadius:7,padding:"9px 10px",fontSize:13,fontWeight:600,color:WH,background:"rgba(255,255,255,.15)"}}>
                {LOCTYPES.map(t=><option key={t} value={t} style={{background:"#1B3A6B",color:WH}}>{t||"Typ av plats"}</option>)}
              </select>
              <input type="text" value={f.location} onChange={e=>set("location",e.target.value)} placeholder="Placering *"
                style={{flex:1,border:`1.5px solid ${!f.location?.trim()?"#FF6B6B":"rgba(255,255,255,.3)"}`,borderRadius:7,padding:"9px 12px",fontSize:13,fontWeight:600,color:WH,background:"rgba(255,255,255,.12)"}}/>
            </div>
          </div>
          {dupOem&&<div style={{background:"rgba(255,107,107,.2)",borderRadius:6,padding:"6px 10px",marginTop:8,fontSize:11,fontWeight:700,color:"#FFE0E0"}}><i className="fa-solid fa-triangle-exclamation"/> Artikelnummer finns redan på: {dupOem.name} #{dupOem.stockNumber}</div>}
          {dupStockNumber&&<div style={{background:"rgba(255,107,107,.2)",borderRadius:6,padding:"6px 10px",marginTop:8,fontSize:11,fontWeight:700,color:"#FFE0E0"}}><i className="fa-solid fa-triangle-exclamation"/> Lagernr {f.stockNumber} används redan av: {dupStockNumber.name}</div>}
        </div>

        {/* Images */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Bilder</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {(f.images||[]).map((img,i)=>(
              <div key={i} style={{position:"relative"}}>
                <img src={img} alt="" style={{width:70,height:70,objectFit:"cover",borderRadius:8,border:`1px solid ${BD}`}}/>
                <button onClick={()=>rmImg(i)} style={{position:"absolute",top:-6,right:-6,background:R,color:WH,border:"none",borderRadius:"50%",width:20,height:20,fontSize:11,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
              </div>
            ))}
            <button onClick={()=>fRef.current.click()} style={{width:70,height:70,borderRadius:8,border:`1.5px dashed ${BD}`,background:BG,color:MU,fontSize:20,display:"flex",alignItems:"center",justifyContent:"center"}}><Icon name="plus"/></button>
            <button onClick={()=>cRef.current.click()} style={{width:70,height:70,borderRadius:8,border:`1.5px dashed ${BD}`,background:BG,color:MU,fontSize:20,display:"flex",alignItems:"center",justifyContent:"center"}}><Icon name="camera"/></button>
          </div>
          <input ref={fRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>addImg(e.target.files[0])}/>
          <input ref={cRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>addImg(e.target.files[0])}/>
        </div>

        {/* Beskrivning + kategori/sida/skick */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{marginBottom:10}}>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Kort beskrivning</label>
            <textarea value={f.description||""} onChange={e=>set("description",e.target.value)} rows={2} maxLength={200} placeholder="T.ex. fungerar perfekt, mindre repa på vänster sida..." style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"none",fontFamily:"inherit"}}/>
            <div style={{fontSize:10,color:MU,textAlign:"right",marginTop:2}}>{(f.description||"").length}/200</div>
          </div>
          <G2><H><Sel label="Kategori" value={f.category} onChange={e=>set("category",e.target.value)} options={CATS}/></H><H><Sel label="Sida" value={f.side} onChange={e=>set("side",e.target.value)} options={SIDS}/></H></G2>
          <Sel label="Skick" value={f.condition} onChange={e=>set("condition",e.target.value)} options={CONDS}/>
        </div>

        {/* Car info */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Ursprungsbil</div>
          <G2><H><Inp label="Bilmärke" value={f.make} onChange={e=>set("make",e.target.value)} placeholder="ex. BMW"/></H><H><Inp label="Modell" value={f.model} onChange={e=>set("model",e.target.value)} placeholder="ex. 5-serie F10"/></H></G2>
          <G2><H><Inp label="Kompatibel med" value={f.compatible} onChange={e=>set("compatible",e.target.value)} placeholder="ex. BMW 5-serie F10"/></H><H><Inp label="Reg.nr" value={f.regNumber} onChange={e=>set("regNumber",e.target.value)} placeholder="ex. ABC123"/></H></G2>
          <G2><H><Inp label="Från år" value={f.yearFrom} onChange={e=>set("yearFrom",e.target.value)} placeholder="2010"/></H><H><Inp label="Till år" value={f.yearTo} onChange={e=>set("yearTo",e.target.value)} placeholder="2016"/></H></G2>
        </div>

        {/* Pricing + stock */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Pris &amp; lager</div>
          <G2><H><Inp label="Pris (kr)" type="number" min="0" value={f.price} onChange={e=>set("price",Number(e.target.value))}/></H><H><Inp label="Inköpspris (kr)" type="number" min="0" value={f.costPrice} onChange={e=>set("costPrice",Number(e.target.value))}/></H></G2>
          <G2><H><Inp label="Antal" type="number" min="0" value={f.quantity} onChange={e=>set("quantity",Number(e.target.value))}/></H><H><Inp label="Enhet" value={f.unit||"st"} onChange={e=>set("unit",e.target.value)}/></H></G2>
        </div>

        {/* Details */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:10}}>Övrig info</div>
          <G2><H><Inp label="Leverantör" value={f.supplier} onChange={e=>set("supplier",e.target.value)}/></H></G2>
          <G2><H><Inp label="Vikt (kg)" value={f.weight} onChange={e=>set("weight",e.target.value)}/></H><H><Inp label="Färgkod" value={f.colorCode} onChange={e=>set("colorCode",e.target.value)} placeholder="ex. 300 Alpinweiss"/></H></G2>
          <div style={{marginTop:4}}>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Notering</label>
            <textarea value={f.notes} onChange={e=>set("notes",e.target.value)} rows={3} style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"vertical",fontFamily:"inherit",color:TX}}/>
          </div>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <Btn full onClick={save} style={{padding:"13px"}}>{item?"Spara ändringar":"Lägg till del"}</Btn>
          <Btn full variant="ghost" onClick={saveAndNew} style={{padding:"13px"}}>
            <i className="fa-solid fa-plus"/> Spara &amp; lägg till nytt exemplar
          </Btn>
        </div>
      </div>
    </Page>
  );
}

// ─── Sell Page ────────────────────────────────────────────────────────────────
function SellPage({ item, items, sales, saveItems, saveSales, currentUser, push, pop, toast$, maxQty, presetBuyer, logActivity }) {
  const cap = maxQty != null ? maxQty : (item.quantity || 0);
  const [qty, setQty] = useState(1);
  const [buyer, setBuyer] = useState(presetBuyer || "");
  const VAT_RATE = 0.25; // 25% moms
  // unitPrice hålls som pris INKL moms (källan). De två rutorna skriver båda hit.
  const [unitPrice, setUnitPrice] = useState(item.price);
  // Vilken ruta som visas "rå" medan man skriver (så avrundning inte stör skrivandet)
  const [editing, setEditing] = useState(null); // "incl" | "excl" | null
  const [draftIncl, setDraftIncl] = useState(String(item.price));
  const [draftExcl, setDraftExcl] = useState(String(Math.round(item.price/(1+VAT_RATE))));
  const [discountMode, setDiscountMode] = useState("pct"); // "pct" | "kr"
  const [discountPct, setDiscountPct] = useState(0);
  const [discountKr, setDiscountKr] = useState(0);
  const [note, setNote] = useState("");

  // När man skriver i INKL-rutan → uppdatera priset + räkna ut EXKL automatiskt
  const onInclChange = (v) => {
    setDraftIncl(v);
    const n = Math.max(0, Number(v)||0);
    setUnitPrice(n);
    setDraftExcl(String(Math.round(n/(1+VAT_RATE))));
  };
  // När man skriver i EXKL-rutan → räkna upp till inkl + uppdatera priset
  const onExclChange = (v) => {
    setDraftExcl(v);
    const n = Math.max(0, Number(v)||0);
    const incl = Math.round(n*(1+VAT_RATE));
    setUnitPrice(incl);
    setDraftIncl(String(incl));
  };

  // ── Redigeringslås — hindra samtidig försäljning/redigering av samma del ──
  const [lockState, setLockState] = useState(null);
  const me = currentUser?.username || "Okänd";
  useEffect(() => {
    if (!item?.id) { setLockState({ ok: true }); return; }
    let active = true, hb = null;
    (async () => {
      const r = await lockAcquire(item.id, me, "edit");
      if (!active) return;
      if (r.ok) { setLockState({ ok: true }); hb = setInterval(()=>lockHeartbeat(item.id, me), 30000); }
      else setLockState({ blocked: true, by: r.lockedBy, action: r.action, remainingMs: r.remainingMs });
    })();
    return () => { active=false; if(hb)clearInterval(hb); if(item?.id) lockRelease(item.id, me); };
  }, [item?.id]);

  // Pris efter rabatt (rabatt räknas på inkl-priset)
  const finalPrice = discountMode === "pct"
    ? Math.round(unitPrice * (1 - discountPct/100))
    : Math.max(0, unitPrice - discountKr);
  const effectiveDiscountPct = unitPrice>0 ? Math.round((1 - finalPrice/unitPrice)*100) : 0;

  // finalPrice är INKL moms (kunden betalar detta). Exkl räknas ut.
  const priceInclVat = finalPrice;
  const priceExclVat = Math.round(finalPrice / (1 + VAT_RATE));
  const vatPerUnit = priceInclVat - priceExclVat;

  const total = qty * priceInclVat;
  const totalExclVat = qty * priceExclVat;
  const totalVat = qty * vatPerUnit;
  const profit = qty * (priceExclVat - (item.costPrice||0)); // vinst räknas exkl moms
  const priceChanged = unitPrice !== item.price;

  const resetPrice = () => {
    setUnitPrice(item.price);
    setDraftIncl(String(item.price));
    setDraftExcl(String(Math.round(item.price/(1+VAT_RATE))));
    setDiscountPct(0); setDiscountKr(0);
  };

  // Håll utkastvärdena i synk när man INTE aktivt redigerar (t.ex. efter återställning)
  useEffect(() => {
    if (editing !== "incl") setDraftIncl(String(unitPrice));
    if (editing !== "excl") setDraftExcl(String(Math.round(unitPrice/(1+VAT_RATE))));
  }, [unitPrice]);

  const sell = async () => {
    const it = items.find(i=>i.id===item.id);
    if (!it || qty > cap || it.quantity-qty<0) { toast$("Otillräckligt i lager!","error"); return; }
    const saleEntry = {
      id: genId("sale"),
      itemId: item.id,
      itemName: item.name,
      itemSku: item.sku,
      itemStockNumber: item.stockNumber||"",
      itemSide: item.side||"",
      qty,
      unitPrice: priceInclVat,
      priceInclVat,
      priceExclVat,
      vatPerUnit,
      vatRate: VAT_RATE,
      totalExclVat,
      totalVat,
      originalPrice: item.price,
      manualPrice: priceChanged ? unitPrice : null,
      discount: effectiveDiscountPct,
      discountKr: unitPrice - finalPrice,
      total,
      costPrice: item.costPrice||0,
      profit,
      buyer: buyer.trim()||"Okänd",
      note: note.trim(),
      soldBy: currentUser?.username||"Okänd",
      soldAt: Date.now(),
      // Snapshot — gör att man kan se alla detaljer i säljloggen även efter delen tagits bort
      itemSnapshot: {
        name:item.name, oem:item.oem, sku:item.sku, side:item.side,
        stockNumber:item.stockNumber, category:item.category, condition:item.condition,
        make:item.make, model:item.model, location:item.location, locationType:item.locationType,
        regNumber:item.regNumber, price:item.price, costPrice:item.costPrice,
        notes:item.notes, supplier:item.supplier,
      },
    };
    const newQty = item.quantity - qty;
    if (newQty <= 0) {
      // Antal noll → ta bort från lager (men säljloggen finns kvar)
      const updated = await deleteOneItem(item.id);
      if (updated) saveItems(updated);
      else await saveItems(items.filter(i=>i.id!==item.id));
    } else {
      const updatedItem = {...item, quantity:newQty, updatedAt:Date.now()};
      const updated = await saveOneItem(updatedItem);
      if (updated) saveItems(updated);
      else await saveItems(items.map(i=>i.id===item.id?updatedItem:i));
    }
    await saveSales([saleEntry,...(sales||[])]);
    logActivity&&logActivity("sale", `Sålde ${qty} × ${item.name}${item.stockNumber?` (#${item.stockNumber})`:""} för ${total.toLocaleString("sv-SE")} kr`, { user: currentUser?.username, itemName:item.name, stockNumber:item.stockNumber });
    toast$(`Sålde ${qty} × ${item.name} — ${total.toLocaleString("sv-SE")} kr`,"success");
    push("receipt",{sale:saleEntry});
  };

  if (lockState?.blocked) {
    const actionText = lockState.action === "cart" ? "har den i sin kassa" : "redigerar den här delen";
    return (
      <Page>
        <TopBar title="Delen är upptagen" onBack={pop} />
        <div style={{padding:"40px 24px",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",gap:16}}>
          <div style={{width:72,height:72,borderRadius:"50%",background:AM+"18",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <Icon name="lock" style={{fontSize:30,color:AM}}/>
          </div>
          <div>
            <div style={{fontWeight:800,fontSize:18,color:TX,marginBottom:6}}>{lockState.by} {actionText}</div>
            <div style={{fontSize:14,color:MU,lineHeight:1.5,maxWidth:320}}>
              Du kan inte sälja den här delen just nu. Den blir tillgänglig automatiskt om <strong style={{color:AM}}>{fmtLockTime(lockState.remainingMs)}</strong> om {lockState.by} inte blir klar innan dess.
            </div>
          </div>
          <Btn variant="ghost" onClick={pop}><Icon name="arrow-left"/> Tillbaka</Btn>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <TopBar title="Sälj del" onBack={pop} />
      <div style={{padding:"20px 14px"}}>
        {/* Item summary */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,marginBottom:12,display:"flex",gap:12,alignItems:"center"}}>
          <div style={{width:56,height:56,borderRadius:8,overflow:"hidden",background:BG,border:`1px solid ${BD}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>
            {(item.thumb||item.images?.[0])?<img src={item.thumb||item.images[0]} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Icon name="wrench" style={{color:MU}}/>}
          </div>
          <div style={{flex:1}}>
            {item.stockNumber&&<div style={{display:"inline-flex",alignItems:"center",gap:4,background:B,color:WH,borderRadius:5,padding:"2px 8px",fontSize:12,fontWeight:800,marginBottom:4}}>#{item.stockNumber}</div>}
            <div style={{fontWeight:700,fontSize:15}}>{item.name}{item.side?` — ${item.side}`:""}</div>
            <div style={{fontSize:12,color:MU,marginTop:1}}></div>
            <div style={{fontSize:13,color:MU,marginTop:2}}>I lager: <strong style={{color:sc(item.quantity)}}>{item.quantity} st</strong> &nbsp;·&nbsp; <span style={{color:B,fontWeight:600}}>Ordinarie: {item.price.toLocaleString("sv-SE")} kr/st</span></div>
          </div>
        </div>

        {/* Pris & rabatt */}
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,marginBottom:12,display:"flex",flexDirection:"column",gap:12}}>
          <div>
            <Inp label="Antal" type="number" min="1" max={cap} value={qty} onChange={e=>setQty(Math.max(1,Math.min(cap,Number(e.target.value))))}/>
            {maxQty != null && maxQty < (item.quantity||0) && <div style={{fontSize:11,color:AM,fontWeight:600,marginTop:3}}>Max {cap} st kan säljas — resten är reserverade.</div>}
          </div>

          {/* Två prisrutor — inkl och exkl moms, räknar ut varandra automatiskt */}
          <div>
            <label style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",fontSize:11,fontWeight:700,color:priceChanged?B:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:6}}>
              <span>Pris per styck (moms 25%)</span>
              {priceChanged&&<button onClick={resetPrice} style={{background:"none",border:"none",color:B,fontSize:10,fontWeight:700,cursor:"pointer",textDecoration:"underline"}}>Återställ</button>}
            </label>
            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1}}>
                <div style={{fontSize:10,fontWeight:700,color:MU,marginBottom:3}}>EXKL. MOMS</div>
                <input type="number" min="0" inputMode="decimal"
                  value={draftExcl}
                  onFocus={()=>setEditing("excl")} onBlur={()=>setEditing(null)}
                  onChange={e=>onExclChange(e.target.value)}
                  style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${priceChanged?B:BD}`,borderRadius:6,fontSize:14,fontWeight:600,color:TX,background:priceChanged?B+"06":WH}}/>
              </div>
              <div style={{display:"flex",alignItems:"flex-end",paddingBottom:9,color:MU,fontSize:16,fontWeight:700}}>→</div>
              <div style={{flex:1}}>
                <div style={{fontSize:10,fontWeight:700,color:B,marginBottom:3}}>INKL. MOMS</div>
                <input type="number" min="0" inputMode="decimal"
                  value={draftIncl}
                  onFocus={()=>setEditing("incl")} onBlur={()=>setEditing(null)}
                  onChange={e=>onInclChange(e.target.value)}
                  style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${priceChanged?B:BD}`,borderRadius:6,fontSize:14,fontWeight:700,color:B,background:priceChanged?B+"08":WH}}/>
              </div>
            </div>
            <div style={{fontSize:11,color:MU,marginTop:6}}>Skriv i valfri ruta — den andra fylls i automatiskt.</div>
          </div>

          {/* Rabatt toggle: % eller kr */}
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
              <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Ytterligare rabatt</label>
              <div style={{display:"flex",gap:4,background:BG,borderRadius:6,padding:2}}>
                <button onClick={()=>{setDiscountMode("pct");setDiscountKr(0);}} style={{padding:"3px 10px",borderRadius:5,border:"none",background:discountMode==="pct"?WH:"transparent",color:discountMode==="pct"?B:MU,fontSize:11,fontWeight:700,boxShadow:discountMode==="pct"?SH:"none"}}>%</button>
                <button onClick={()=>{setDiscountMode("kr");setDiscountPct(0);}} style={{padding:"3px 10px",borderRadius:5,border:"none",background:discountMode==="kr"?WH:"transparent",color:discountMode==="kr"?B:MU,fontSize:11,fontWeight:700,boxShadow:discountMode==="kr"?SH:"none"}}>kr</button>
              </div>
            </div>
            {discountMode==="pct"?(
              <input type="number" min="0" max="100" value={discountPct} onChange={e=>setDiscountPct(Math.min(100,Math.max(0,Number(e.target.value))))}
                placeholder="0" style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:14}}/>
            ):(
              <input type="number" min="0" value={discountKr} onChange={e=>setDiscountKr(Math.max(0,Number(e.target.value)))}
                placeholder="0" style={{width:"100%",padding:"9px 12px",border:`1.5px solid ${BD}`,borderRadius:6,fontSize:14}}/>
            )}
          </div>

          <Inp label="Kund / köpare" value={buyer} onChange={e=>setBuyer(e.target.value)} placeholder="Namn eller företag"/>
          <div>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>Notering</label>
            <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} placeholder="Valfri kommentar..." style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 12px",fontSize:13,resize:"none",fontFamily:"inherit",color:TX}}/>
          </div>
        </div>

        {/* Summary */}
        {qty>0&&qty<=cap&&(
          <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:14,marginBottom:14}}>
            {priceChanged&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:MU,marginBottom:3}}>
                <span>Ordinarie pris</span>
                <span style={{textDecoration:"line-through"}}>{item.price.toLocaleString("sv-SE")} kr</span>
              </div>
            )}
            {(discountPct>0||discountKr>0)&&(
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:AM,marginBottom:3}}>
                <span>Rabatt</span>
                <span>-{discountMode==="pct"?`${discountPct}%`:`${discountKr.toLocaleString("sv-SE")} kr`}</span>
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:TM,marginBottom:3}}>
              <span>{qty} st × {priceExclVat.toLocaleString("sv-SE")} kr (exkl. moms)</span>
              <span>{totalExclVat.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:TM,marginBottom:6,paddingBottom:6,borderBottom:`1px solid ${B}20`}}>
              <span>Moms (25%)</span>
              <span>{totalVat.toLocaleString("sv-SE")} kr</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
              <span style={{fontSize:13,fontWeight:700,color:TX}}>Totalt (inkl. moms)</span>
              <span style={{fontSize:22,fontWeight:800,color:B}}>{total.toLocaleString("sv-SE")} kr</span>
            </div>
            {item.costPrice>0&&<div style={{marginTop:6,fontSize:12,color:profit>=0?GR:R,fontWeight:600}}>Vinst (exkl. moms): {profit.toLocaleString("sv-SE")} kr</div>}
          </div>
        )}

        <Btn full variant="red" onClick={sell} disabled={qty<1||qty>item.quantity} style={{padding:"13px"}}>
          <Icon name="tag"/> Bekräfta försäljning
        </Btn>
      </div>
    </Page>
  );
}


// ─── Sales Log Page ───────────────────────────────────────────────────────────
function SalesLogPage({ sales, saveSales, items, saveItems, users, can, isAdmin, currentUser, push, pop, toast$, logActivity }) {
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("all");
  const [confirmReverse, setConfirmReverse] = useState(null);
  const all = sales||[];

  const [saleDetail, setSaleDetail] = useState(null);

  const reverseSale = async (s) => {
    const existing = items.find(i => i.id===s.itemId);
    if (existing) {
      // Delen finns kvar — lägg bara tillbaka antalet
      const updatedItem = {...existing, quantity:existing.quantity+s.qty, updatedAt:Date.now()};
      const updated = await saveOneItem(updatedItem);
      if (updated) saveItems(updated);
      else await saveItems(items.map(i=>i.id===s.itemId?updatedItem:i));
    } else {
      // Delen är borttagen — återskapa den helt från snapshot eller säljdata
      const snap = s.itemSnapshot || {};
      const restored = {
        id: s.itemId || genId("item"),
        name: snap.name || s.itemName || "Återställd del",
        oem: snap.oem || "",
        sku: snap.sku || s.itemSku || "",
        side: snap.side || s.itemSide || "",
        stockNumber: snap.stockNumber || s.itemStockNumber || "",
        category: snap.category || "Övrigt",
        condition: snap.condition || "Begagnad - Gott skick",
        make: snap.make || "",
        model: snap.model || "",
        location: snap.location || "",
        locationType: snap.locationType || "",
        regNumber: snap.regNumber || "",
        price: snap.price != null ? snap.price : (s.originalPrice || 0),
        costPrice: snap.costPrice || s.costPrice || 0,
        notes: snap.notes || "",
        supplier: snap.supplier || "",
        quantity: s.qty || 1,
        images: [],
        hasImages: 0,
        updatedAt: Date.now(),
      };
      const updated = await saveOneItem(restored);
      if (updated) saveItems(updated);
      else await saveItems([...items, restored]);
    }
    await saveSales((sales||[]).filter(x=>x.id!==s.id));
    logActivity&&logActivity("reverse", `Ångrade försäljning av ${s.itemName}${s.itemStockNumber?` (#${s.itemStockNumber})`:""}`, { user: currentUser?.username });
    toast$("Försäljning ångrad — delen är tillbaka i lagret","success");
    setConfirmReverse(null);
  };

  const now = Date.now();
  const filtered = all.filter(s => {
    if (period==="today")  { const d=new Date(s.soldAt); const t=new Date(); return d.toDateString()===t.toDateString(); }
    if (period==="week")   return now-s.soldAt < 7*864e5;
    if (period==="month")  return now-s.soldAt < 30*864e5;
    return true;
  }).filter(s => !search || s.itemName.toLowerCase().includes(search.toLowerCase()) || s.buyer.toLowerCase().includes(search.toLowerCase()) || s.soldBy.toLowerCase().includes(search.toLowerCase()) || (s.receiptId||s.id||"").toLowerCase().includes(search.toLowerCase()));

  const totalRev = filtered.reduce((a,s)=>a+s.total,0);
  const totalProfit = filtered.reduce((a,s)=>a+(s.profit||0),0);
  const totalQty = filtered.reduce((a,s)=>a+s.qty,0);
  const totalDiscount = filtered.reduce((a,s)=>a+(s.discountKr||0)*s.qty,0);

  // Group by receiptId for dagskassa view
  const byReceipt = {};
  filtered.forEach(s => {
    const key = s.receiptId || s.id;
    if (!byReceipt[key]) byReceipt[key] = { id:key, rows:[], soldAt:s.soldAt, soldBy:s.soldBy, buyer:s.buyer, payMethod:s.payMethod||"kontant" };
    byReceipt[key].rows.push(s);
  });
  const receipts = Object.values(byReceipt).sort((a,b)=>b.soldAt-a.soldAt);

  // Dagskassa: group by date
  const byDate = {};
  filtered.forEach(s => {
    const d = new Date(s.soldAt).toLocaleDateString("sv-SE",{weekday:"short",day:"numeric",month:"short"});
    if (!byDate[d]) byDate[d] = { date:d, rev:0, profit:0, qty:0, txCount:0, byPayment:{} };
    byDate[d].rev += s.total;
    byDate[d].profit += (s.profit||0);
    byDate[d].qty += s.qty;
    byDate[d].txCount++;
    const pay = s.payMethod||"kontant";
    byDate[d].byPayment[pay] = (byDate[d].byPayment[pay]||0) + s.total;
  });
  const dagskassa = Object.values(byDate);

  // Top sellers
  const byUser = {};
  filtered.forEach(s=>{ byUser[s.soldBy]=(byUser[s.soldBy]||0)+s.total; });
  const topSellers = Object.entries(byUser).sort((a,b)=>b[1]-a[1]).slice(0,3);

  const fmt = ts => {
    const d = new Date(ts);
    return d.toLocaleDateString("sv-SE",{day:"numeric",month:"short"}) + " " + d.toLocaleTimeString("sv-SE",{hour:"2-digit",minute:"2-digit"});
  };
  const fmtPay = p => p==="swish"?"Swish":p==="kort"?"Kort":"Kontant";

  return (
    <Page>
      <TopBar title="Säljlogg" onBack={pop} subtitle="Alla försäljningar" />
      <div style={{padding:"clamp(14px,2vw,28px)",paddingBottom:80}}>

        {/* Period filter */}
        <div style={{display:"flex",gap:6,marginBottom:12,overflowX:"auto",paddingBottom:2}}>
          {[["all","Alla"],["today","Idag"],["week","7 dagar"],["month","30 dagar"],["dagskassa","Dagskassa"]].map(([v,l])=>(
            <button key={v} onClick={()=>setPeriod(v)} style={{flexShrink:0,padding:"6px 14px",borderRadius:20,border:`1.5px solid ${period===v?B:BD}`,background:period===v?B:WH,color:period===v?WH:TM,fontWeight:600,fontSize:12}}>{l}</button>
          ))}
        </div>

        {/* Search */}
        <div style={{position:"relative",marginBottom:12}}>
          <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}}><Icon name="magnifying-glass" style={{color:MU,fontSize:13}}/></span>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Sök artikel, kund, säljare..." style={{width:"100%",padding:"9px 10px 9px 32px",border:`1.5px solid ${BD}`,borderRadius:8,fontSize:13,color:TX,background:WH}}/>
        </div>

        {/* Stats */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:12}}>
          {[[totalRev.toLocaleString("sv-SE")+" kr","Intäkt",B],[totalProfit.toLocaleString("sv-SE")+" kr","Vinst",totalProfit>=0?GR:R],[totalQty+" st","Sålda",TM],[totalDiscount>0?"-"+totalDiscount.toLocaleString("sv-SE")+" kr":"0 kr","Rabatt",AM]].map(([val,lbl,col])=>(
            <div key={lbl} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:"10px 8px",textAlign:"center"}}>
              <div style={{fontSize:13,fontWeight:800,color:col}}>{val}</div>
              <div style={{fontSize:9,color:MU,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,marginTop:2}}>{lbl}</div>
            </div>
          ))}
        </div>

        {/* Dagskassa view */}
        {period==="dagskassa" && (
          <div>
            {dagskassa.length===0?(
              <div style={{textAlign:"center",padding:40,color:MU,fontSize:13}}>Inga försäljningar att visa</div>
            ):dagskassa.map(d=>(
              <div key={d.date} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
                  <div style={{fontWeight:700,fontSize:14,textTransform:"capitalize"}}>{d.date}</div>
                  <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:20,fontWeight:800,color:B}}>{d.rev.toLocaleString("sv-SE")} kr</div>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                  <Badge label={`${d.txCount} transaktioner`} color={TM} small/>
                  <Badge label={`${d.qty} delar`} color={TM} small/>
                  <Badge label={`Vinst: ${d.profit.toLocaleString("sv-SE")} kr`} color={d.profit>=0?GR:R} small/>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {Object.entries(d.byPayment).map(([pay,rev])=>(
                    <div key={pay} style={{flex:1,minWidth:80,background:BG,borderRadius:6,padding:"6px 10px",textAlign:"center"}}>
                      <div style={{fontSize:12,fontWeight:700,color:TX}}>{rev.toLocaleString("sv-SE")} kr</div>
                      <div style={{fontSize:10,color:MU,fontWeight:600}}>{fmtPay(pay)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Receipt-grouped view (non-dagskassa) */}
        {period!=="dagskassa" && <>

        {/* Top sellers */}
        {topSellers.length>0&&(
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:12,marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>Toppsäljare</div>
            {topSellers.map(([name,rev],i)=>(
              <div key={name} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{width:20,height:20,borderRadius:"50%",background:[B,GR,AM][i]+"20",color:[B,GR,AM][i],fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{i+1}</div>
                <span style={{flex:1,fontSize:13,fontWeight:600}}>{name}</span>
                <span style={{fontSize:13,fontWeight:700,color:B}}>{rev.toLocaleString("sv-SE")} kr</span>
              </div>
            ))}
          </div>
        )}

        {/* Sales list — virtualiserad */}
        {filtered.length===0?(
          <div style={{textAlign:"center",padding:40,color:MU,fontSize:14}}>Inga försäljningar hittades</div>
        ):(
          <Virtuoso
            style={{ height: "calc(100vh - 240px)" }}
            data={filtered}
            computeItemKey={(_, s) => s.id}
            itemContent={(_, s) => (
            <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                    {s.itemStockNumber&&<span style={{background:B,color:WH,borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:800}}>#{s.itemStockNumber}</span>}
                    <div style={{fontWeight:700,fontSize:14}}>{s.itemName}{s.itemSide?` — ${s.itemSide}`:""}</div>
                  </div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:800,fontSize:16,color:B}}>{s.total.toLocaleString("sv-SE")} kr</div>
                  {s.profit!=null&&<div style={{fontSize:11,color:s.profit>=0?GR:R,fontWeight:600}}>Vinst: {s.profit.toLocaleString("sv-SE")} kr</div>}
                </div>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:6}}>
                <Badge label={`${s.qty} st × ${s.unitPrice.toLocaleString("sv-SE")} kr`} color={B} small/>
                {s.manualPrice!=null&&<Badge label={`Ändrat pris (ord. ${s.originalPrice.toLocaleString("sv-SE")} kr)`} color={B} small/>}
                {s.discount>0&&<Badge label={`-${s.discount}%`} color={AM} small/>}
                <Badge label={`Kund: ${s.buyer}`} color={TM} small/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:MU}}>Säljare: <strong style={{color:TX}}>{s.soldBy}</strong></span>
                <span style={{fontSize:11,color:MU}}>{fmt(s.soldAt)}</span>
              </div>
              {s.note&&<div style={{marginTop:6,fontSize:12,color:TM,background:BG,borderRadius:5,padding:"5px 8px"}}>{s.note}</div>}
              <div style={{display:"flex",gap:8,marginTop:8,paddingTop:8,borderTop:`1px solid ${BD}50`}}>
                <Btn variant="ghost" small onClick={()=>setSaleDetail(s)}><Icon name="circle-info"/> Detaljer</Btn>
                <Btn variant="ghost" small onClick={()=>push("receipt",{sale:s})}><Icon name="receipt"/> Kvitto</Btn>
                {(isAdmin||s.soldBy===currentUser?.username)&&(
                  <Btn variant="ghost" small onClick={()=>setConfirmReverse(s)} style={{color:R}}><Icon name="rotate-left"/> Ångra</Btn>
                )}
              </div>
            </div>
            )}
          />
        )}
        </>}
      </div>

      {/* Säljdetaljer */}
      {saleDetail&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setSaleDetail(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:0,maxWidth:380,width:"100%",maxHeight:"85vh",overflowY:"auto"}}>
            <div style={{background:B,color:WH,padding:"16px 18px",borderRadius:"14px 14px 0 0"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  {saleDetail.itemStockNumber&&<span style={{background:"rgba(255,255,255,.2)",borderRadius:4,padding:"1px 7px",fontSize:11,fontWeight:800}}>#{saleDetail.itemStockNumber}</span>}
                  <div style={{fontWeight:800,fontSize:17,marginTop:4}}>{saleDetail.itemName}{saleDetail.itemSide?` — ${saleDetail.itemSide}`:""}</div>
                </div>
                <button onClick={()=>setSaleDetail(null)} style={{background:"none",border:"none",color:WH,fontSize:20,cursor:"pointer"}}>✕</button>
              </div>
            </div>
            <div style={{padding:18}}>
              {(() => {
                const snap = saleDetail.itemSnapshot || {};
                const rows = [
                  ["Artikelnummer", snap.oem],
                  ["Märke", snap.make ? `${snap.make}${snap.model?` ${snap.model}`:""}` : null],
                  ["Skick", snap.condition],
                  ["Kategori", snap.category],
                  ["Placering", [snap.locationType,snap.location].filter(Boolean).join(" — ")],
                  ["Reg.nr", snap.regNumber],
                ].filter(([,v])=>v);
                return rows.map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${BD}`,fontSize:13}}>
                    <span style={{color:MU}}>{k}</span>
                    <span style={{fontWeight:600,fontFamily:k==="Artikelnummer"?"monospace":"inherit"}}>{v}</span>
                  </div>
                ));
              })()}
              <div style={{marginTop:14,background:BG,borderRadius:8,padding:12}}>
                <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",marginBottom:8}}>Försäljning</div>
                {[
                  ["Antal", `${saleDetail.qty} st`],
                  ["Pris/st", `${saleDetail.unitPrice.toLocaleString("sv-SE")} kr`],
                  saleDetail.discount>0?["Rabatt", `-${saleDetail.discount}%`]:null,
                  ["Totalt", `${saleDetail.total.toLocaleString("sv-SE")} kr`],
                  saleDetail.profit!=null?["Vinst", `${saleDetail.profit.toLocaleString("sv-SE")} kr`]:null,
                  ["Kund", saleDetail.buyer],
                  ["Säljare", saleDetail.soldBy],
                  ["Datum", fmt(saleDetail.soldAt)],
                  saleDetail.payMethod?["Betalning", fmtPay(saleDetail.payMethod)]:null,
                ].filter(Boolean).map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",fontSize:13}}>
                    <span style={{color:MU}}>{k}</span>
                    <span style={{fontWeight:k==="Totalt"?800:600,color:k==="Totalt"?B:TX}}>{v}</span>
                  </div>
                ))}
              </div>
              {saleDetail.note&&<div style={{marginTop:12,fontSize:13,color:TM,background:AM+"10",borderRadius:8,padding:10}}>{saleDetail.note}</div>}
              <Btn full variant="ghost" onClick={()=>{setSaleDetail(null);push("receipt",{sale:saleDetail});}} style={{marginTop:14}}><Icon name="receipt"/> Visa kvitto</Btn>
            </div>
          </div>
        </div>
      )}

      {confirmReverse&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmReverse(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ångra försäljning?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>
              {confirmReverse.qty} × {confirmReverse.itemName} återförs till lagret ({confirmReverse.total.toLocaleString("sv-SE")} kr).
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmReverse(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>reverseSale(confirmReverse)}>Ångra</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
// ─── Users Page ───────────────────────────────────────────────────────────────
function UsersPage({ users, saveUsers, roles, currentUser, push, pop, toast$, can, isAdmin }) {
  if (!isAdmin && !can("canManageUsers")) return <Page><TopBar title="Användare" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [confirmDel, setConfirmDel] = useState(null);
  const del = async (id) => {
    await saveUsers(users.filter(u=>u.id!==id)); toast$("Borttagen","success"); setConfirmDel(null);
  };
  const roleOf = u => (roles||[]).find(r => r.id === u.roleId);
  const right = (
    <div style={{display:"flex",gap:6}}>
      <Btn small variant="ghost" onClick={()=>push("roles")}><Icon name="user-shield"/> Roller</Btn>
      <Btn small onClick={()=>push("edituser",{user:null})}><Icon name="plus"/> Ny</Btn>
    </div>
  );
  return (
    <Page>
      <TopBar title="Användare" onBack={pop} subtitle="Hantera team" right={right} />
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:8}}>
        {users.map(u=>{
          const role = roleOf(u);
          return (
          <div key={u.id} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH,padding:"12px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <div style={{width:38,height:38,borderRadius:8,background:u.role==="admin"?R:(role?.color||B),display:"flex",alignItems:"center",justifyContent:"center",color:WH,fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:16,flexShrink:0}}>
                {u.username[0].toUpperCase()}
              </div>
              <div>
                <div style={{fontWeight:700}}>{u.username} {u.id===currentUser.id&&<Badge label="Du" color={B} small />}</div>
                {u.role==="admin"
                  ? <Badge label="Admin" color={R} small />
                  : role
                    ? <Badge label={role.name} color={role.color||B} small />
                    : <Badge label="Egna behörigheter" color={MU} small />}
              </div>
              <div style={{marginLeft:"auto",display:"flex",gap:6}}>
                {u.role!=="admin"&&<Btn variant="blue" small onClick={()=>push("perms",{user:u})}><Icon name="key"/></Btn>}
                <Btn variant="ghost" small onClick={()=>push("edituser",{user:u})}><Icon name="pen"/></Btn>
                {u.id!==currentUser.id&&<Btn variant="ghost" small onClick={()=>setConfirmDel(u)} style={{color:R}}><Icon name="trash"/></Btn>}
              </div>
            </div>
            {u.role!=="admin"&&(
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {(() => {
                  // Visa effektiva behörigheter (roll + egna)
                  const effective = { ...(role?.permissions||{}), ...(u.permissions||{}) };
                  const active = ALL_PERMISSIONS.filter(p=>effective[p.key]);
                  return active.length>0
                    ? active.map(p=><Badge key={p.key} label={<><Icon name={p.icon.replace("fa-","")} style={{marginRight:4}}/>{p.label}</>} color={B} small />)
                    : <span style={{fontSize:11,color:MU}}>Inga behörigheter</span>;
                })()}
              </div>
            )}
          </div>
          );
        })}
      </div>

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:320,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort {confirmDel.username}?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>Detta går inte att ångra.</div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel.id)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Hantera listor — redigera kategorier, skick, sidor, placeringstyper ──────
function ManageListsPage({ lists, saveLists, pop, toast$, isAdmin, can }) {
  if (!isAdmin && !can("canManageSettings")) return <Page><TopBar title="Hantera listor" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [local, setLocal] = useState({
    categories: [...(lists?.categories||DEFAULT_CATEGORIES)],
    conditions: [...(lists?.conditions||DEFAULT_CONDITIONS)],
    sides: [...(lists?.sides||DEFAULT_SIDES)].filter(Boolean),
    locationTypes: [...(lists?.locationTypes||DEFAULT_LOCATION_TYPES)].filter(Boolean),
  });
  const [newVal, setNewVal] = useState({ categories:"", conditions:"", sides:"", locationTypes:"" });

  const addItem = (key) => {
    const v = newVal[key].trim();
    if (!v) return;
    if (local[key].some(x => x.toLowerCase() === v.toLowerCase())) { toast$("Finns redan","error"); return; }
    setLocal(p => ({ ...p, [key]: [...p[key], v] }));
    setNewVal(p => ({ ...p, [key]: "" }));
  };
  const removeItem = (key, val) => setLocal(p => ({ ...p, [key]: p[key].filter(x => x !== val) }));
  const moveItem = (key, idx, dir) => setLocal(p => {
    const arr = [...p[key]]; const j = idx + dir;
    if (j < 0 || j >= arr.length) return p;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    return { ...p, [key]: arr };
  });

  const save = async () => {
    // Sidor och placeringstyper behåller en ledande tom sträng (= "ingen/valfri")
    await saveLists({
      categories: local.categories,
      conditions: local.conditions,
      sides: ["", ...local.sides],
      locationTypes: ["", ...local.locationTypes],
    });
    toast$("Listor sparade","success");
    pop();
  };

  const sections = [
    { key:"categories", title:"Kategorier", icon:"fa-tags", hint:"T.ex. Skärmar, Dörrar, Stötfångare" },
    { key:"conditions", title:"Skick", icon:"fa-star-half-stroke", hint:"T.ex. Ny, Begagnad – Gott skick" },
    { key:"sides", title:"Sidor", icon:"fa-arrows-left-right", hint:"T.ex. Vänster, Höger, Fram, Bak" },
    { key:"locationTypes", title:"Placeringstyper", icon:"fa-warehouse", hint:"T.ex. Hylla, Låda, Rum" },
  ];

  return (
    <Page>
      <TopBar title="Hantera listor" onBack={pop} right={<Btn small onClick={save}><Icon name="check"/> Spara</Btn>} />
      <div style={{padding:"14px 14px 60px"}}>
        <div style={{fontSize:12,color:MU,marginBottom:12,lineHeight:1.5}}>
          Lägg till, ta bort eller ändra ordning. Tar du bort ett värde försvinner det bara från nya val — delar som redan har det behåller sitt värde.
        </div>
        {sections.map(sec=>(
          <div key={sec.key} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <i className={`fa-solid ${sec.icon}`} style={{color:B,fontSize:15}}/>
              <div style={{fontWeight:800,fontSize:15,color:TX}}>{sec.title}</div>
            </div>
            <div style={{fontSize:11,color:MU,marginBottom:10}}>{sec.hint}</div>

            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
              {local[sec.key].length===0&&<div style={{fontSize:12,color:MU,fontStyle:"italic"}}>Inga värden än</div>}
              {local[sec.key].map((val,idx)=>(
                <div key={val} style={{display:"flex",alignItems:"center",gap:8,background:BG,borderRadius:7,padding:"7px 10px"}}>
                  <div style={{display:"flex",flexDirection:"column",gap:1}}>
                    <button onClick={()=>moveItem(sec.key,idx,-1)} disabled={idx===0} style={{background:"none",border:"none",cursor:idx===0?"default":"pointer",color:idx===0?BD:MU,fontSize:10,padding:0,lineHeight:1}}><i className="fa-solid fa-chevron-up"/></button>
                    <button onClick={()=>moveItem(sec.key,idx,1)} disabled={idx===local[sec.key].length-1} style={{background:"none",border:"none",cursor:idx===local[sec.key].length-1?"default":"pointer",color:idx===local[sec.key].length-1?BD:MU,fontSize:10,padding:0,lineHeight:1}}><i className="fa-solid fa-chevron-down"/></button>
                  </div>
                  <span style={{flex:1,fontSize:13,fontWeight:600,color:TX}}>{val}</span>
                  <button onClick={()=>removeItem(sec.key,val)} style={{background:"none",border:"none",cursor:"pointer",color:R,fontSize:14,padding:"2px 4px"}}><i className="fa-solid fa-trash"/></button>
                </div>
              ))}
            </div>

            <div style={{display:"flex",gap:6}}>
              <input type="text" value={newVal[sec.key]} onChange={e=>setNewVal(p=>({...p,[sec.key]:e.target.value}))}
                onKeyDown={e=>{ if(e.key==="Enter") addItem(sec.key); }}
                placeholder="Lägg till nytt värde…"
                style={{flex:1,border:`1.5px solid ${BD}`,borderRadius:7,padding:"8px 11px",fontSize:13}}/>
              <Btn small variant="blue" onClick={()=>addItem(sec.key)}><Icon name="plus"/></Btn>
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}

// ─── Roles Page — hantera roller ──────────────────────────────────────────────
function RolesPage({ roles, saveRoles, users, push, pop, toast$, isAdmin, can }) {
  if (!isAdmin && !can("canManageUsers")) return <Page><TopBar title="Roller" onBack={pop}/><div style={{padding:40,textAlign:"center",color:MU}}><i className="fa-solid fa-lock" style={{fontSize:32,marginBottom:12,display:"block"}}/>Du saknar behörighet.</div></Page>;
  const [confirmDel, setConfirmDel] = useState(null);
  const usersWithRole = id => users.filter(u => u.roleId === id).length;
  const del = async (role) => {
    await saveRoles((roles||[]).filter(r=>r.id!==role.id));
    toast$("Roll borttagen","success");
    setConfirmDel(null);
  };
  const right = <Btn small onClick={()=>push("editrole",{role:null})}><Icon name="plus"/> Ny roll</Btn>;
  return (
    <Page>
      <TopBar title="Roller" onBack={pop} subtitle="Behörighetsmallar" right={right} />
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:8}}>
        <div style={{fontSize:12,color:MU,marginBottom:4}}>Roller är färdiga behörighetspaket du kan tilldela användare. Ändra en roll så uppdateras alla som har den.</div>
        {(roles||[]).map(role=>{
          const count = ALL_PERMISSIONS.filter(p=>role.permissions?.[p.key]).length;
          const used = usersWithRole(role.id);
          return (
            <div key={role.id} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,boxShadow:SH,padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:14,height:14,borderRadius:4,background:role.color||B,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:15}}>{role.name}</div>
                  <div style={{fontSize:12,color:MU}}>{count} behörigheter · {used} användare</div>
                </div>
                <Btn variant="ghost" small onClick={()=>push("editrole",{role})}><Icon name="pen"/></Btn>
                <Btn variant="ghost" small onClick={()=>setConfirmDel(role)} style={{color:R}}><Icon name="trash"/></Btn>
              </div>
            </div>
          );
        })}
        {(roles||[]).length===0&&<div style={{textAlign:"center",padding:30,color:MU}}>Inga roller än. Skapa en med "Ny roll".</div>}
      </div>

      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}} onClick={()=>setConfirmDel(null)}>
          <div onClick={e=>e.stopPropagation()} style={{background:WH,borderRadius:14,padding:20,maxWidth:340,width:"100%"}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Ta bort rollen "{confirmDel.name}"?</div>
            <div style={{fontSize:13,color:MU,marginBottom:16}}>
              {usersWithRole(confirmDel.id)>0
                ? `${usersWithRole(confirmDel.id)} användare har den här rollen. De blir utan roll (behåller bara ev. egna behörigheter).`
                : "Detta går inte att ångra."}
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn full variant="ghost" onClick={()=>setConfirmDel(null)}>Avbryt</Btn>
              <Btn full variant="red" onClick={()=>del(confirmDel)}>Ta bort</Btn>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ─── Edit Role Page ───────────────────────────────────────────────────────────
function EditRolePage({ role, roles, saveRoles, pop, toast$ }) {
  const [f, setF] = useState(role ? {...role, permissions:{...role.permissions}} : { name:"", color:"#1B3A6B", permissions:{} });
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const togglePerm = k => setF(p=>({...p,permissions:{...p.permissions,[k]:!p.permissions?.[k]}}));
  const COLORS = ["#1B3A6B","#CC1B2B","#2E7D32","#E65100","#6A1B9A","#00838F","#757575"];

  const save = async () => {
    if (!f.name.trim()) { toast$("Ge rollen ett namn","error"); return; }
    if (f.id) {
      await saveRoles((roles||[]).map(r=>r.id===f.id?f:r));
      toast$("Roll uppdaterad","success");
    } else {
      await saveRoles([...(roles||[]), {...f, id:genId("role")}]);
      toast$("Roll skapad","success");
    }
    pop();
  };

  // Gruppera behörigheter för tydlighet
  const groups = [
    { title:"Lager", keys:["canView","canAdd","canEdit","canDelete","canBulkEdit","canScan","canImport","canExport"] },
    { title:"Försäljning", keys:["canSell","canUseCheckout","canPrintReceipt"] },
    { title:"Reservationer", keys:["canViewReservations","canAddReservations","canEditReservations"] },
    { title:"Logg & rapporter", keys:["canViewLog","canViewActivityLog","canViewDashboard","canViewReports"] },
    { title:"Administration", keys:["canManageSuppliers","canBackup","canManageUsers","canManageSettings"] },
  ];

  return (
    <Page>
      <TopBar title={role?"Redigera roll":"Ny roll"} onBack={pop} right={<Btn small onClick={save}><Icon name="check"/> Spara</Btn>} />
      <div style={{padding:"14px 14px 60px"}}>
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:12}}>
          <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Rollnamn</label>
          <input type="text" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="t.ex. Säljare"
            style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:7,padding:"9px 12px",fontSize:14,fontWeight:600,marginTop:4,marginBottom:12}}/>
          <label style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7}}>Färg</label>
          <div style={{display:"flex",gap:8,marginTop:6}}>
            {COLORS.map(c=>(
              <button key={c} onClick={()=>set("color",c)} style={{width:30,height:30,borderRadius:7,background:c,border:f.color===c?`3px solid ${TX}`:`2px solid ${BD}`,cursor:"pointer"}}/>
            ))}
          </div>
        </div>

        {groups.map(g=>(
          <div key={g.title} style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:14,marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:800,color:B,textTransform:"uppercase",letterSpacing:.5,marginBottom:10}}>{g.title}</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {g.keys.map(key=>{
                const perm = ALL_PERMISSIONS.find(p=>p.key===key);
                if (!perm) return null;
                const on = !!f.permissions?.[key];
                return (
                  <button key={key} onClick={()=>togglePerm(key)} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",borderRadius:8,border:`1.5px solid ${on?B:BD}`,background:on?B+"0C":WH,cursor:"pointer",textAlign:"left"}}>
                    <div style={{width:34,height:20,borderRadius:10,background:on?B:BD,position:"relative",flexShrink:0,transition:"background .15s"}}>
                      <div style={{position:"absolute",top:2,left:on?16:2,width:16,height:16,borderRadius:"50%",background:WH,transition:"left .15s"}}/>
                    </div>
                    <i className={`fa-solid ${perm.icon}`} style={{color:on?B:MU,width:16,textAlign:"center"}}/>
                    <span style={{fontSize:13,fontWeight:600,color:on?TX:TM}}>{perm.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}

// ─── Edit User Page ───────────────────────────────────────────────────────────
function EditUserPage({ user, users, roles, saveUsers, pop, toast$ }) {
  // Lösenordsfältet är alltid tomt vid redigering — den lagrade hashen kan
  // inte (och ska inte) visas upp som klartext. Lämnas fältet tomt vid
  // sparning behålls det befintliga lösenordet oförändrat.
  const [f, setF] = useState(user ? {...user, password:""} : {username:"",password:"",role:"user",permissions:{}});
  const [showPw, setShowPw] = useState(false);
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const togglePerm = k => setF(p=>({...p,permissions:{...p.permissions,[k]:!p.permissions?.[k]}}));
  const save = async () => {
    if (!f.username.trim()) { toast$("Fyll i användarnamn","error"); return; }
    if (!user && !f.password.trim()) { toast$("Lösenord krävs för ny användare","error"); return; }

    if (f.id) {
      const updated = { ...f };
      if (f.password.trim()) {
        updated.password = await hashPassword(f.password.trim());
      } else {
        // Inget nytt lösenord angivet — behåll det gamla
        const existing = users.find(u=>u.id===f.id);
        updated.password = existing?.password;
      }
      await saveUsers(users.map(u=>u.id===f.id?updated:u));
      toast$("Uppdaterad","success");
    } else {
      if (users.find(u=>u.username.toLowerCase()===f.username.toLowerCase())) { toast$("Användarnamnet är taget","error"); return; }
      const hashed = await hashPassword(f.password.trim());
      await saveUsers([...users,{...f,password:hashed,id:genId("user"),createdAt:Date.now()}]);
      toast$("Skapad","success");
    }
    pop();
  };
  return (
    <Page>
      <TopBar title={user?"Redigera användare":"Ny användare"} onBack={pop} right={<Btn small onClick={save}>Spara</Btn>} />
      <div style={{padding:"14px 14px 40px",display:"flex",flexDirection:"column",gap:12}}>
        <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16,display:"flex",flexDirection:"column",gap:14}}>
          <Inp label="Användarnamn *" value={f.username} onChange={e=>set("username",e.target.value)}/>
          <div>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:4}}>{user?"Nytt lösenord (lämna tomt för att behålla)":"Lösenord *"}</label>
            <div style={{position:"relative"}}>
              <input type={showPw?"text":"password"} value={f.password} onChange={e=>set("password",e.target.value)} placeholder={user?"••••••••":""}
                style={{width:"100%",border:`1.5px solid ${BD}`,borderRadius:6,padding:"9px 40px 9px 12px",fontSize:14}}/>
              <button onClick={()=>setShowPw(v=>!v)} type="button" style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:MU,cursor:"pointer",padding:6}}>
                <i className={`fa-solid fa-${showPw?"eye-slash":"eye"}`}/>
              </button>
            </div>
            {user&&<div style={{fontSize:11,color:MU,marginTop:4}}>Av säkerhetsskäl lagras lösenord krypterat och kan inte visas i efterhand. Skriv ett nytt här för att hjälpa en användare som glömt sitt — toggla ögat för att se vad du skrivit innan du sparar.</div>}
          </div>
          <div>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.7,marginBottom:8}}>Roll</label>
            <div style={{display:"flex",gap:8}}>
              {[{v:"user",l:"Användare"},{v:"admin",l:"Admin"}].map(({v,l})=>(
                <button key={v} onClick={()=>set("role",v)} style={{flex:1,padding:"9px",borderRadius:8,border:`2px solid ${f.role===v?B:BD}`,background:f.role===v?B+"10":WH,color:f.role===v?B:MU,fontWeight:600,fontSize:13}}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {f.role==="user" && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:10}}>Roll (färdigt behörighetspaket)</div>
            <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
              <button onClick={()=>set("roleId",null)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,border:`1.5px solid ${!f.roleId?B:BD}`,background:!f.roleId?B+"0C":WH,cursor:"pointer",textAlign:"left"}}>
                <div style={{width:12,height:12,borderRadius:3,background:MU,flexShrink:0}}/>
                <span style={{fontSize:13,fontWeight:600,color:!f.roleId?TX:TM}}>Ingen roll — bara egna behörigheter nedan</span>
              </button>
              {(roles||[]).map(role=>(
                <button key={role.id} onClick={()=>set("roleId",role.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,border:`1.5px solid ${f.roleId===role.id?B:BD}`,background:f.roleId===role.id?B+"0C":WH,cursor:"pointer",textAlign:"left"}}>
                  <div style={{width:12,height:12,borderRadius:3,background:role.color||B,flexShrink:0}}/>
                  <span style={{fontSize:13,fontWeight:600,color:f.roleId===role.id?TX:TM,flex:1}}>{role.name}</span>
                  <span style={{fontSize:11,color:MU}}>{ALL_PERMISSIONS.filter(p=>role.permissions?.[p.key]).length} behörigheter</span>
                </button>
              ))}
            </div>
            <div style={{fontSize:11,color:MU,marginBottom:4}}>Rollen ger en grunduppsättning behörigheter. Du kan ge extra behörigheter utöver rollen här under:</div>
          </div>
        )}

        {f.role==="user" && (
          <div style={{background:WH,borderRadius:10,border:`1px solid ${BD}`,padding:16}}>
            <div style={{fontSize:11,fontWeight:700,color:MU,textTransform:"uppercase",letterSpacing:.8,marginBottom:12}}>{f.roleId?"Extra behörigheter (utöver rollen)":"Behörigheter"}</div>
            {ALL_PERMISSIONS.map(({key,label,icon})=>{
              const fromRole = f.roleId && (roles||[]).find(r=>r.id===f.roleId)?.permissions?.[key];
              const on = f.permissions?.[key] || fromRole;
              return (
              <div key={key} onClick={()=>!fromRole&&togglePerm(key)}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 8px",borderRadius:8,cursor:fromRole?"default":"pointer",background:on?B+"08":"transparent",marginBottom:4,opacity:fromRole?0.7:1}}>
                <div style={{width:32,height:32,borderRadius:8,background:on?B+"18":BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={icon.replace("fa-","")} style={{fontSize:14,color:on?B:MU}}/></div>
                <span style={{flex:1,fontSize:14,fontWeight:500,color:on?TX:MU}}>{label}{fromRole&&<span style={{fontSize:10,color:B,marginLeft:6,fontWeight:700}}>(från roll)</span>}</span>
                <div style={{width:42,height:24,borderRadius:12,background:on?B:"#ddd",position:"relative",transition:"background .2s",flexShrink:0}}>
                  <div style={{position:"absolute",top:3,left:on?20:3,width:18,height:18,borderRadius:"50%",background:WH,boxShadow:"0 1px 3px rgba(0,0,0,.2)",transition:"left .2s"}}/>
                </div>
              </div>
              );
            })}
          </div>
        )}
        {f.role==="admin" && (
          <div style={{background:B+"08",border:`1px solid ${B}20`,borderRadius:10,padding:"12px 16px",fontSize:13,color:B,fontWeight:500}}>
            OK Admin har automatiskt alla behörigheter
          </div>
        )}
      </div>
    </Page>
  );
}

// ─── Permissions Page ─────────────────────────────────────────────────────────
function PermsPage({ user, users, saveUsers, pop, toast$ }) {
  const [p, setP] = useState({...user.permissions});
  const toggle = k => setP(prev=>({...prev,[k]:!prev[k]}));
  const save = async () => {
    await saveUsers(users.map(u=>u.id===user.id?{...u,permissions:p}:u));
    toast$("Behörigheter sparade","success"); pop();
  };
  return (
    <Page>
      <TopBar title={`Behörigheter — ${user.username}`} onBack={pop} right={<Btn small onClick={save}>Spara</Btn>} />
      <div style={{padding:"14px 14px 40px"}}>
        {ALL_PERMISSIONS.map(({key,label,icon})=>(
          <div key={key} onClick={()=>toggle(key)} style={{display:"flex",alignItems:"center",gap:12,padding:"14px",borderRadius:10,cursor:"pointer",background:p[key]?B+"08":WH,border:`1px solid ${p[key]?B+"25":BD}`,marginBottom:8,transition:"background .1s"}}>
            <div style={{width:34,height:34,borderRadius:8,background:p[key]?B+"18":BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={icon.replace("fa-","")} style={{fontSize:15,color:p[key]?B:MU}}/></div>
            <span style={{flex:1,fontSize:14,fontWeight:500,color:p[key]?TX:MU}}>{label}</span>
            <div style={{width:44,height:24,borderRadius:12,background:p[key]?B:"#ddd",position:"relative",transition:"background .2s",flexShrink:0}}>
              <div style={{position:"absolute",top:3,left:p[key]?22:3,width:18,height:18,borderRadius:"50%",background:WH,boxShadow:"0 1px 3px rgba(0,0,0,.2)",transition:"left .2s"}}/>
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}
