// install-service.js — Registrerar Lager som Windows-tjänst via node-windows
// Kör som administratör: node install-service.js
//
// Avinstallera tjänsten: node install-service.js --uninstall

var Service = require("node-windows").Service;
var path = require("path");

var svc = new Service({
  name: "Lager Server",
  description: "Lager — lagerhantering för karossdelar",
  script: path.join(__dirname, "server.cjs"),
  nodeOptions: [],
  wait: 2,
  grow: 0.5,
});

var uninstall = process.argv.includes("--uninstall");

if (uninstall) {
  svc.on("uninstall", function () {
    console.log("Tjänsten avinstallerad.");
  });
  svc.uninstall();
} else {
  svc.on("install", function () {
    svc.start();
    console.log("✓ Tjänsten installerad och startad!");
    console.log("  Lager körs nu automatiskt vid Windows-start.");
    console.log("  Öppna: http://localhost:3000");
  });
  svc.on("alreadyinstalled", function () {
    console.log("Tjänsten finns redan. Kör med --uninstall för att ta bort den.");
  });
  svc.install();
}
