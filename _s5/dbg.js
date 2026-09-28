/* Why does mail open when signed out, and what is the real unread count? */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8773;
const BASE = "http://127.0.0.1:" + PORT;

const DATA = path.join(DIR, "data");
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: DIR,
  env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_USER: "root", ADMIN_PASS: "rootpassword1" }),
  stdio: ["ignore", "pipe", "pipe"]
});

function req(method, urlPath, body, cookie) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(BASE + urlPath, {
      method: method,
      headers: Object.assign({ "Content-Type": "application/json" },
        cookie ? { Cookie: cookie } : {},
        data ? { "Content-Length": Buffer.byteLength(data) } : {})
    }, function (res) {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", function () {
        let json = null;
        try { json = JSON.parse(out); } catch (e) {}
        resolve({ status: res.statusCode, json, text: out,
          cookie: res.headers["set-cookie"] ? res.headers["set-cookie"][0].split(";")[0] : null });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

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

function inBrowser(probe, budget) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_dbg5.html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + probe + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_dbg5.txt");
  const fd = fs.openSync(dumpFile, "w");
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0",
    "--window-size=1280,900", "--virtual-time-budget=" + (budget || 26000), "--dump-dom",
    "--user-data-dir=" + process.env.TEMP + "\\dshdbg5", BASE + "/_probe_dbg5.html"],
    { stdio: ["ignore", fd, "pipe"] });
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  const errs = (dump.match(/CONSOLE:\d+\] "[^"]{0,160}/g) || [])
    .filter(e => !/ProtocolLaunch|task_manager/.test(e));
  return { state: m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null, errs };
}

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;
    await req("POST", "/api/admin/users", { username: "bob", password: "bobpassword1", role: "user" }, admin);
    const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" }).catch(() => ({})));
    await req("POST", "/api/admin/users", { username: "carol", password: "carolpassword1", role: "user" }, admin);
    const carol = (await req("POST", "/api/login", { username: "carol", password: "carolpassword1" })).cookie;
    // carol sends bob two unread messages
    await req("POST", "/api/mail", { to: "bob", subject: "one", body: "first" }, carol);
    await req("POST", "/api/mail", { to: "bob", subject: "two", body: "second" }, carol);

    console.log("=== server-side unread for bob (should be 2) ===");
    {
      const bob = (await req("POST", "/api/login", { username: "bob", password: "bobpassword1" })).cookie;
      const c = await req("GET", "/api/mail/count", undefined, bob);
      console.log("  /api/mail/count -> " + JSON.stringify(c.json));
    }

    console.log("\n=== signed-out: what does LDMail.open do? ===");
    {
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
  var before = document.querySelectorAll(".w98-win").length;
  var ret = LDMail.open("inbox");
  setTimeout(function () {
    document.title = "PROBE" + JSON.stringify({
      windowsBefore: before,
      windowsAfter: document.querySelectorAll(".w98-win").length,
      returned: ret === null ? "null" : "a window",
      titles: Array.prototype.map.call(document.querySelectorAll(".w98-win"),
        function (w) { return w.querySelector(".w98-title-text").textContent; }),
      signin: !!document.querySelector(".w98-signin")
    });
  }, 1200);
}, 700);
`, 16000);
      console.log("  " + JSON.stringify(r.state));
      if (r.errs.length) { console.log("  console:"); r.errs.slice(0, 4).forEach(e => console.log("    " + e)); }
    }

    console.log("\n=== signed in: badge after opening the mailbox unread ===");
    {
      const r = inBrowser(`
function ready() {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
}
setTimeout(function () {
  ready();
  LDApps.openSignIn(function () {});
  setTimeout(function () {
    var inputs = document.querySelectorAll(".w98-signin input");
    inputs[0].value = "bob";
    inputs[1].value = "bobpassword1";
    document.querySelector(".w98-signin-actions .w98-btn").click();
    setTimeout(function () {
      var badge = document.getElementById("trayMail");
      document.title = "PROBE" + JSON.stringify({
        hidden: badge.hidden,
        text: badge.textContent,
        title: badge.title
      });
    }, 2600);
  }, 400);
}, 700);
`, 22000);
      console.log("  " + JSON.stringify(r.state));
      if (r.errs.length) { console.log("  console:"); r.errs.slice(0, 4).forEach(e => console.log("    " + e)); }
    }

  } catch (e) {
    console.log("ERROR: " + e.message);
  } finally {
    try { server.kill(); } catch (e) {}
    setTimeout(function () {
      if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
      process.exit(0);
    }, 400);
  }
})();
