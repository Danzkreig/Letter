/* Why does the composer probe fail to set a title? */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8752;
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
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
  LDApps.openSignIn(function () {});
  setTimeout(function () {
    var inputs = document.querySelectorAll(".w98-signin input");
    inputs[0].value = "root";
    inputs[1].value = "rootpassword1";
    document.querySelector(".w98-signin-actions .w98-btn").click();
    setTimeout(function () {
      LDComposer.open();
      setTimeout(function () {
        var out = {
          errs: window.__errs,
          rows: document.querySelectorAll("#trackEditor .track-row").length,
          rowClasses: Array.prototype.map.call(
            document.querySelectorAll("#trackEditor .track-row"),
            function (r) { return r.className; }),
          linkInput: !!document.querySelector("#trackEditor .tr-link"),
          fieldsCount: document.querySelectorAll("#trackEditor .tr-fields input").length,
          shapeOpts: document.querySelectorAll("#shapePicker .shape-opt").length,
          themeSwatches: document.querySelectorAll("#themePicker .swatch").length
        };
        document.title = "PROBE" + JSON.stringify(out);
      }, 2200);
    }, 2200);
  }, 500);
}, 800);
`;
  const p = path.join(DIR, "_probe_c3.html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + probe + "</script></body>"), "utf8");

  const dumpFile = path.join(DIR, "_probe_c3_dump.txt");
  const fd = fs.openSync(dumpFile, "w");
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0",
    "--window-size=1280,900", "--virtual-time-budget=30000", "--dump-dom",
    "--user-data-dir=" + process.env.TEMP + "\\dshc3", BASE + "/_probe_c3.html"],
    { stdio: ["ignore", fd, "pipe"] });
  fs.closeSync(fd);

  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  console.log("probe:", m ? m[1].replace(/&quot;/g, '"') : "NO TITLE");

  const errs = (dump.match(/CONSOLE:\d+\] "[^"]{0,220}/g) || [])
    .filter(e => !/ProtocolLaunch|task_manager|external_registry/.test(e));
  console.log("\nbrowser console:");
  errs.slice(0, 14).forEach(e => console.log("  " + e));

  try { server.kill(); } catch (e) {}
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})();
