/* Is the desktop really signed out when the guard runs? */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8774;
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
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
  var out = {
    whoami: typeof LDMail.setUser,
    userBefore: LDApps && typeof LDApps.openSignIn
  };
  // ask the bridge directly, the same way mail.js does
  try {
    var b = window.__bridgeProbe;
  } catch (e) {}
  setTimeout(function () {
    var ret = LDMail.open("inbox");
    var wins = Array.prototype.map.call(document.querySelectorAll(".w98-win"),
      function (w) { return w.querySelector(".w98-title-text").textContent; });
    document.title = "PROBE" + JSON.stringify({
      returnedNull: ret === null,
      windows: wins,
      signinShown: !!document.querySelector(".w98-signin"),
      sessionVisible: typeof window.LD !== "undefined"
    });
  }, 1500);
}, 700);
`;
  const p = path.join(DIR, "_probe_g.html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + probe + "</script></body>"), "utf8");

  const dumpFile = path.join(DIR, "_probe_g.txt");
  const fd = fs.openSync(dumpFile, "w");
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--window-size=1280,900",
    "--virtual-time-budget=16000", "--dump-dom", "--user-data-dir=" + process.env.TEMP + "\\dshg2",
    BASE + "/_probe_g.html"], { stdio: ["ignore", fd, "ignore"] });
  fs.closeSync(fd);

  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  console.log("probe:", m ? m[1].replace(/&quot;/g, '"') : "NO TITLE");

  // is the guard even present in the served mail.js?
  const mailJs = fs.readFileSync(path.join(DIR, "mail.js"), "utf8");
  console.log("");
  console.log("mail.js has the guard:", /if \(!whoami\(\)\)/.test(mailJs));
  console.log("mail.js defines whoami:", /function whoami\(\)/.test(mailJs));

  try { server.kill(); } catch (e) {}
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})();
