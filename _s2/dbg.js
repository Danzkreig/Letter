/* Why does the probe return nothing? Capture console errors and the real DOM. */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8742;
const BASE = "http://127.0.0.1:" + PORT;

const DATA = path.join(DIR, "data");
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: DIR,
  env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_USER: "root", ADMIN_PASS: "rootpassword1" }),
  stdio: ["ignore", "pipe", "pipe"]
});

function waitForServer() {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function go() {
      n++;
      const r = http.request(BASE + "/api/me", function (res) { res.resume(); resolve(); });
      r.on("error", function () { n > 80 ? reject(new Error("no start")) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

(async function () {
  await waitForServer();

  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const probe = `
window.__errs = [];
window.onerror = function (m, s, l, c) { window.__errs.push(m + " @" + l + ":" + c); };
setTimeout(function () {
  var out = {
    errs: window.__errs,
    api: typeof window.LD,
    apps: typeof window.LDApps,
    ascii: typeof window.LETTERDROP_ASCII,
    icons: document.querySelectorAll(".w98-icon").length,
    scripts: Array.prototype.map.call(document.querySelectorAll("script"), function (s) { return s.src.split("/").pop() || "(inline)"; })
  };
  document.title = "PROBE" + JSON.stringify(out);
}, 1500);
`;
  const p = path.join(DIR, "_probe_dbg.html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + probe + "</script></body>"), "utf8");

  const dumpFile = path.join(DIR, "_probe_dbg_dump.txt");
  const fd = fs.openSync(dumpFile, "w");
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0",
    "--virtual-time-budget=12000", "--dump-dom", "--user-data-dir=" + process.env.TEMP + "\\dshdbg2",
    BASE + "/_probe_dbg.html"], { stdio: ["ignore", fd, "pipe"] });
  fs.closeSync(fd);

  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  console.log("probe result:", m ? m[1].replace(/&quot;/g, '"') : "NO TITLE");
  console.log("");
  console.log("--- console errors from the browser ---");
  const errs = dump.match(/CONSOLE:\d+\] "[^"]{0,200}/g) || [];
  errs.filter(e => !/ProtocolLaunch|task_manager|external_registry/.test(e)).slice(0, 12).forEach(e => console.log("  " + e));

  // also check the raw page source the server returns
  console.log("");
  console.log("--- what does the server return for api.js / apps.js? ---");
  ["/api.js", "/apps.js", "/desktop.js"].forEach(function (u) {
    const req = http.request(BASE + u, { method: "GET" }, function (res) {
      let len = 0;
      res.on("data", c => len += c.length);
      res.on("end", () => console.log("  " + u + " -> " + res.statusCode + " (" + len + " bytes)"));
    });
    req.end();
  });

  setTimeout(function () {
    try { server.kill(); } catch (e) {}
    if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
    process.exit(0);
  }, 1500);
})();
