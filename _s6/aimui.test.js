/* Stage 3 UI verification: two real browsers chatting through AIM. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8785;
const BASE = "http://127.0.0.1:" + PORT;
const TMP = process.env.TEMP;

/* Remove a throwaway browser profile, so the temp directory does not
   fill up across runs. */
function dropProfile(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
}


let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } }

const DATA = path.join(DIR, "data");
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: DIR,
  env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_USER: "root", ADMIN_PASS: "rootpassword1" }),
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOut = "";
server.stdout.on("data", d => serverOut += d.toString());
server.stderr.on("data", d => serverOut += d.toString());

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
      r.on("error", function () { n > 100 ? reject(new Error("no start:\n" + serverOut)) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

/* Run one page, optionally with a startup script, and read back a value. */
function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_aim_" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_aim_" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshaim-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 26000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_aim_" + tag + ".html"],
      { stdio: ["ignore", fd, "ignore"] });
} finally {
  dropProfile(__profile);
}
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
}

const helpers = `
function ready() {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
}
function signInAs(u, p) {
  return new Promise(function (resolve) {
    LDApps.openSignIn(function (user) { resolve(user || null); });
    setTimeout(function () {
      var inputs = document.querySelectorAll(".w98-signin input");
      inputs[0].value = u;
      inputs[1].value = p;
      document.querySelector(".w98-signin-actions .w98-btn").click();
      setTimeout(function () { resolve(null); }, 2400);
    }, 300);
  });
}
function visibleWins() {
  return Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
    function (w) { return !w.hidden; });
}
function winTitles() {
  return visibleWins().map(function (w) { return w.querySelector(".w98-title-text").textContent; });
}
`;

(async function run() {
  try {
    await waitForServer();

    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;
    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    await req("POST", "/api/admin/users", { username: "bob", password: "bobpassword1", role: "user" }, admin);

    console.log("=== AIM opens and connects ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword").then(function () {
    LDAim.open();
    setTimeout(function () {
      var buddies = document.querySelectorAll(".aim-buddy");
      document.title = "PROBE" + JSON.stringify({
        titles: winTitles(),
        connected: LDAim.isConnected(),
        status: document.querySelector(".aim-status") ? document.querySelector(".aim-status").textContent : null,
        me: document.querySelector(".aim-me") ? document.querySelector(".aim-me").textContent : null,
        buddies: buddies.length,
        names: Array.prototype.map.call(buddies, function (b) {
          return b.querySelector(".aim-name").textContent;
        })
      });
    }, 2600);
  });
}, 700);
`, 30000, "open");
      console.log("  " + JSON.stringify(r));
      check("the buddy list window opens", (r.titles || []).some(t => /AIM/.test(t)), JSON.stringify(r.titles));
      check("the socket connects", r.connected === true);
      check("it shows your own screen name", r.me === "alice", r.me);
      check("status reads Online", r.status === "Online", r.status);
      check("buddies are listed", r.buddies === 2, String(r.buddies));
      check("both accounts appear", (r.names || []).indexOf("bob") !== -1, JSON.stringify(r.names));
    }

    console.log("\n=== an offline buddy is shown as offline ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword").then(function () {
    LDAim.open();
    setTimeout(function () {
      var rows = document.querySelectorAll(".aim-buddy");
      var bob = Array.prototype.filter.call(rows, function (x) {
        return x.querySelector(".aim-name").textContent === "bob";
      })[0];
      document.title = "PROBE" + JSON.stringify({
        bobOnline: bob ? bob.className.indexOf("is-on") !== -1 : null
      });
    }, 2400);
  });
}, 700);
`, 28000, "offline");
      console.log("  " + JSON.stringify(r));
      check("bob shows as offline with no socket", r.bobOnline === false, String(r.bobOnline));
    }

    console.log("\n=== history renders in a conversation ===");
    {
      const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;
      const bobId = (await req("GET", "/api/im/buddies", undefined, alice)).json.buddies
        .filter(b => b.username === "bob")[0].id;
      await req("POST", "/api/im/send", { to: bobId, text: "a stored message" }, alice);
      await req("POST", "/api/im/send", { to: bobId, text: "another one" }, alice);

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("bob", "bobpassword1").then(function () {
    LD.imBuddies().then(function (res) {
      var alice = res.buddies.filter(function (b) { return b.username === "alice"; })[0];
      LDAim.open();
      setTimeout(function () {
        var rows = document.querySelectorAll(".aim-buddy");
        var target = Array.prototype.filter.call(rows, function (x) {
          return x.querySelector(".aim-name").textContent === "alice";
        })[0];
        target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        setTimeout(function () {
          var msgs = document.querySelectorAll(".aim-msg");
          document.title = "PROBE" + JSON.stringify({
            titles: winTitles(),
            messages: msgs.length,
            first: msgs.length ? msgs[0].querySelector(".aim-text").textContent : null,
            hasInput: !!document.querySelector(".aim-input"),
            firstIsTheirs: msgs.length ? msgs[0].className.indexOf("is-mine") === -1 : null
          });
        }, 1600);
      }, 1800);
    });
  });
}, 700);
`, 34000, "history");
      console.log("  " + JSON.stringify(r));
      check("a conversation window opens", (r.titles || []).some(t => /Instant Message/.test(t)),
        JSON.stringify(r.titles));
      check("the stored messages render", r.messages === 2, String(r.messages));
      check("with the right text", r.first === "a stored message", r.first);
      check("they are shown as the other person's", r.firstIsTheirs === true, String(r.firstIsTheirs));
      check("there is a box to type in", r.hasInput === true);
    }

    console.log("\n=== unread badge on a buddy ===");
    {
      const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;
      const bobId = (await req("GET", "/api/im/buddies", undefined, alice)).json.buddies
        .filter(b => b.username === "bob")[0].id;
      await req("POST", "/api/im/send", { to: bobId, text: "unread for bob" }, alice);

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("bob", "bobpassword1").then(function () {
    LDAim.open();
    setTimeout(function () {
      var badge = document.querySelector(".aim-badge");
      document.title = "PROBE" + JSON.stringify({
        hasBadge: !!badge,
        count: badge ? badge.textContent : null
      });
    }, 2600);
  });
}, 700);
`, 30000, "badge");
      console.log("  " + JSON.stringify(r));
      check("an unread badge appears", r.hasBadge === true, JSON.stringify(r));
      check("with the count", r.count === "1", r.count);
    }

  } catch (err) {
    console.log("\n  TEST ERROR: " + err.message);
    fail++;
  } finally {
    try { server.kill(); } catch (e) {}
    setTimeout(function () {
      if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
      console.log("\n----------------------------------------");
      console.log("PASS " + pass + "   FAIL " + fail);
      process.exit(fail ? 1 : 0);
    }, 400);
  }
})();
