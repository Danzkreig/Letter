/* Verify: the Write a Letter button opens the composer, the obsolete
   Letterdrop entry is gone, and the invitation window no longer claims
   the link is unused. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8851;
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

function req(method, urlPath, body, cookie, headers) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const h = Object.assign({ "Content-Type": "application/json" },
      cookie ? { Cookie: cookie } : {}, headers || {});
    if (data) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", function () {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: raw.toString("utf8"),
          headers: res.headers,
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

function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_wl" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_wl" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshwl-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 24000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_wl" + tag + ".html"],
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
function winByTitle(re) {
  return Array.prototype.filter.call(document.querySelectorAll(".w98-win"), function (w) {
    return !w.hidden && re.test(w.querySelector(".w98-title-text").textContent);
  })[0];
}
`;

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    console.log("=== no obsolete Letterdrop button ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    setTimeout(function () {
      var labels = Array.prototype.map.call(document.querySelectorAll(".w98-icon"),
        function (i) { return i.querySelector(".w98-icon-label") ?
          i.querySelector(".w98-icon-label").textContent :
          i.textContent.trim(); });
      // and the Start menu
      document.getElementById("startBtn").click();
      setTimeout(function () {
        var startLabels = Array.prototype.map.call(
          document.querySelectorAll(".w98-startitem"),
          function (b) { return b.textContent.trim(); });
        document.title = "PROBE" + JSON.stringify({
          desktopLabels: labels,
          startLabels: startLabels
        });
      }, 500);
    }, 1800);
  });
}, 700);
`, 26000, "labels");
      console.log("  desktop: " + JSON.stringify(r.desktopLabels));
      console.log("  start:   " + JSON.stringify(r.startLabels));

      check("a Write a Letter icon exists",
        (r.desktopLabels || []).some(l => /Write a Letter/.test(l)), JSON.stringify(r.desktopLabels));
      check("no bare Letterdrop icon remains",
        !(r.desktopLabels || []).some(l => l.trim() === "Letterdrop"), JSON.stringify(r.desktopLabels));
      check("Write a Letter is in the Start menu",
        (r.startLabels || []).some(l => /Write a Letter/.test(l)), JSON.stringify(r.startLabels));
      check("no bare Letterdrop Start entry remains",
        !(r.startLabels || []).some(l => l.trim() === "Letterdrop"), JSON.stringify(r.startLabels));
    }

    console.log("\n=== the button opens the letter composer ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    // click the desktop icon, the way a user would
    var icon = Array.prototype.filter.call(document.querySelectorAll(".w98-icon"),
      function (i) { return /Write a Letter/.test(i.textContent); })[0];
    icon.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    setTimeout(function () {
      var win = winByTitle(/New Letter/);
      document.title = "PROBE" + JSON.stringify({
        opened: !!win,
        titles: Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
          function (w) { return !w.hidden; }).map(function (w) {
            return w.querySelector(".w98-title-text").textContent; }),
        hasShapes: win ? win.querySelectorAll(".ld-shape").length : 0,
        hasBody: win ? !!win.querySelector(".ld-letter-body-input") : false,
        // the Network dialog must not appear
        networkDialog: !!winByTitle(/Letterdrop Network/),
        /* Look for a real dialog, not the words: this probe's own source is
           part of the dumped DOM, so a textContent search matches itself. */
        illegal: Array.prototype.some.call(document.querySelectorAll(".w98-dialog"),
          function (d) { return !d.closest(".w98-win") && /illegal operation/i.test(d.textContent); })
      });
    }, 2000);
  });
}, 700);
`, 28000, "open");
      console.log("  " + JSON.stringify(r));
      check("the letter composer opens", r.opened === true, JSON.stringify(r.titles));
      check("with the shape picker", r.hasShapes === 5, String(r.hasShapes));
      check("and the letter body", r.hasBody === true);
      check("the Letterdrop Network dialog does not appear", r.networkDialog === false);
      check("no illegal-operation error", r.illegal === false);
    }

    console.log("\n=== the invite window no longer claims it is unused ===");
    {
      const made = await req("POST", "/api/letter", { kind: "invitation", body: "join me" }, admin);
      const inviteId = made.json.mail.id;

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDLetter.open(${JSON.stringify(inviteId)});
    setTimeout(function () {
      var win = winByTitle(/Letter/);
      var out = { opened: !!win };
      if (win) {
        var linkBtn = Array.prototype.filter.call(win.querySelectorAll(".w98-btn"),
          function (b) { return /Show invite link/.test(b.textContent); })[0];
        out.hasLinkButton = !!linkBtn;
        if (linkBtn) linkBtn.click();
      }
      setTimeout(function () {
        var linkWin = winByTitle(/Invitation link/);
        out.linkWindowOpened = !!linkWin;
        if (linkWin) {
          var hint = linkWin.querySelector(".w98-share-hint");
          out.hint = hint ? hint.textContent : null;
          out.hasUrl = !!linkWin.querySelector(".w98-share-url");
        }
        document.title = "PROBE" + JSON.stringify(out);
      }, 1400);
    }, 1600);
  });
}, 700);
`, 30000, "invite");
      console.log("  " + JSON.stringify(r));
      check("the letter window opens", r.opened === true);
      check("it offers the invite link button", r.hasLinkButton === true);
      check("the link window opens", r.linkWindowOpened === true);
      check("there is no 'still unused' claim", !/still unused/i.test(r.hint || ""), r.hint);
      check("it still says when it expires", /Expires/.test(r.hint || ""), r.hint);
      check("the link itself is shown", r.hasUrl === true);
    }

  } catch (err) {
    console.log("\n  TEST ERROR: " + err.message);
    console.log(err.stack.split("\n").slice(0, 4).join("\n"));
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
