/* Verify the security UI: the forced password change window and the
   session manager inside My Profile. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8863;
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
  env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_USER: "root", ADMIN_PASS: "" }),
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
  const p = path.join(DIR, "_probe_sec" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_sec" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshsec-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 24000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_sec" + tag + ".html"],
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
      setTimeout(function () { resolve(null); }, 2600);
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
    const seedPassword = (serverOut.match(/password:\s*(\S+)/) || [])[1];
    if (!seedPassword) throw new Error("could not read the generated password:\n" + serverOut);
    console.log("generated password: " + seedPassword);

    console.log("=== the forced change window appears on first sign-in ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "${seedPassword}").then(function () {
    setTimeout(function () {
      var win = winByTitle(/Change Your Password/);
      var out = { shown: !!win };
      if (win) {
        out.fields = win.querySelectorAll('input[type="password"]').length;
        out.hasExplanation = /set for you/i.test(win.textContent);
        out.hasSignOut = Array.prototype.map.call(win.querySelectorAll(".w98-btn"),
          function (b) { return b.textContent; });
        // the window must not be dismissable
        var closeBtn = win.querySelector(".w98-tbtn-close");
        out.closeHidden = closeBtn ? closeBtn.hidden : true;
      }
      document.title = "PROBE" + JSON.stringify(out);
    }, 2200);
  });
}, 700);
`, 30000, "force");
      console.log("  " + JSON.stringify(r));
      check("the window opens on first sign-in", r.shown === true);
      check("it has three password boxes", r.fields === 3, String(r.fields));
      check("it explains why", r.hasExplanation === true);
      check("it offers Change password", (r.hasSignOut || []).some(b => /Change password/.test(b)),
        JSON.stringify(r.hasSignOut));
      check("and a way out via Sign out", (r.hasSignOut || []).some(b => /Sign out/.test(b)));
      check("the close button is hidden", r.closeHidden === true);
    }

    console.log("\n=== the change actually unlocks the desktop ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "${seedPassword}").then(function () {
    setTimeout(function () {
      var win = winByTitle(/Change Your Password/);
      var out = { shown: !!win };
      if (!win) { document.title = "PROBE" + JSON.stringify(out); return; }
      var f = win.querySelectorAll('input[type="password"]');

      // a mismatch is caught before sending
      f[0].value = "${seedPassword}"; f[1].value = "newpassword12"; f[2].value = "different123";
      Array.prototype.filter.call(win.querySelectorAll(".w98-btn"),
        function (b) { return /Change password/.test(b.textContent); })[0].click();
      setTimeout(function () {
        out.mismatchWarning = /do not match/i.test(win.querySelector(".w98-signin-msg").textContent);

        // too short
        f[0].value = "${seedPassword}"; f[1].value = "short"; f[2].value = "short";
        Array.prototype.filter.call(win.querySelectorAll(".w98-btn"),
          function (b) { return /Change password/.test(b.textContent); })[0].click();
        setTimeout(function () {
          out.shortWarning = /at least 8/i.test(win.querySelector(".w98-signin-msg").textContent);

          // the real thing
          f[0].value = "${seedPassword}"; f[1].value = "newpassword12"; f[2].value = "newpassword12";
          Array.prototype.filter.call(win.querySelectorAll(".w98-btn"),
            function (b) { return /Change password/.test(b.textContent); })[0].click();
          setTimeout(function () {
            out.stillOpen = !!winByTitle(/Change Your Password/);
            // the desktop should be usable now
            LD.listFiles().then(function () {
              out.filesWork = true;
              document.title = "PROBE" + JSON.stringify(out);
            }).catch(function (e) {
              out.filesWork = false;
              out.afterError = e.message;
              document.title = "PROBE" + JSON.stringify(out);
            });
          }, 2000);
        }, 600);
      }, 600);
    }, 2200);
  });
}, 700);
`, 36000, "change");
      console.log("  " + JSON.stringify(r));
      check("the window opens", r.shown === true);
      check("a mismatched confirmation is caught", r.mismatchWarning === true);
      check("a too-short password is caught", r.shortWarning === true);
      check("the window closes after success", r.stillOpen === false);
      check("and files are reachable afterwards", r.filesWork === true, r.afterError);
    }

    console.log("\n=== the session manager ===");
    {
      // root's password is now newpassword12
      const a = await req("POST", "/api/login", { username: "root", password: "newpassword12" });
      check("the new password works", a.status === 200, String(a.status));

      // make a second session so there is something to end
      await req("POST", "/api/login", { username: "root", password: "newpassword12" }, null,
        { "User-Agent": "OtherDevice/1.0" });

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "newpassword12").then(function () {
    LDApps.openProfile();
    setTimeout(function () {
      var win = winByTitle(/Profile/);
      var out = { opened: !!win };
      if (win) {
        var rows = win.querySelectorAll(".w98-session");
        out.rows = rows.length;
        out.currentRows = win.querySelectorAll(".w98-session.is-current").length;
        out.text = win.querySelector(".w98-sessions").textContent;
        out.hasKillOthers = Array.prototype.map.call(win.querySelectorAll(".w98-btn"),
          function (b) { return b.textContent; }).some(function (t) { return /other devices/i.test(t); });
        out.signOutButtons = win.querySelectorAll(".w98-session .w98-mini").length;
      }
      document.title = "PROBE" + JSON.stringify(out);
    }, 2400);
  });
}, 700);
`, 32000, "sessions");
      console.log("  " + JSON.stringify(r));
      check("the profile window opens", r.opened === true);
      check("sessions are listed", r.rows >= 2, String(r.rows));
      check("exactly one is marked current", r.currentRows === 1, String(r.currentRows));
      check("the device is described readably", /Browser|Command line|Edge|Chrome/.test(r.text || ""),
        r.text);
      check("a sign-out button per other session", r.signOutButtons === r.rows - 1,
        r.signOutButtons + " buttons for " + r.rows + " rows");
      check("there is a sign out others button", r.hasKillOthers === true);
    }

    console.log("\n=== ending a session from the UI ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "newpassword12").then(function () {
    LDApps.openProfile();
    setTimeout(function () {
      var win = winByTitle(/Profile/);
      var before = win.querySelectorAll(".w98-session").length;
      var btn = win.querySelector(".w98-session .w98-mini");
      var out = { before: before };
      if (btn) btn.click();
      setTimeout(function () {
        out.after = win.querySelectorAll(".w98-session").length;
        out.ended = out.after < out.before;
        document.title = "PROBE" + JSON.stringify(out);
      }, 1600);
    }, 2400);
  });
}, 700);
`, 32000, "revoke");
      console.log("  " + JSON.stringify(r));
      check("there were sessions to end", r.before >= 2, String(r.before));
      check("clicking Sign out removes one", r.ended === true, r.before + " -> " + r.after);
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
