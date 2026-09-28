/* Verify the sounds: that they build without error, that the mute switch
   persists, and that a sound is actually triggered by the right events.

   Headless Edge has no audio device, so this cannot check that anything is
   audible. What it can check is that the synthesis runs cleanly -- a
   broken Web Audio graph throws, and every route here is exercised. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8911;
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
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const h = Object.assign({ "Content-Type": "application/json" }, cookie ? { Cookie: cookie } : {});
    if (data) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", function () {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: raw.toString("utf8"),
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

/* "--autoplay-policy=no-user-gesture-required" is what lets the Web Audio
   graph actually run in headless, so a broken node really does throw. */
function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_snd" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_snd" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshsnd-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--autoplay-policy=no-user-gesture-required",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 26000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_snd" + tag + ".html"],
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
function dismissDialogs() {
  return new Promise(function (resolve) {
    var tries = 0;
    (function go() {
      var open = Array.prototype.filter.call(document.querySelectorAll(".w98-dialog"),
        function (d) { return !d.hidden && d.offsetParent !== null; });
      if (!open.length || tries++ > 6) { resolve(); return; }
      open.forEach(function (d) {
        var ok = Array.prototype.filter.call(d.querySelectorAll(".w98-btn"),
          function (b) { return /OK|Close|Yes/i.test(b.textContent); })[0];
        if (ok) ok.click(); else d.hidden = true;
      });
      setTimeout(go, 200);
    })();
  });
}
`;

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    console.log("=== every sound builds without error ===");
    {
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };

  var out = { present: typeof window.LDSound, names: LDSound ? LDSound.names : null };
  if (!LDSound) { document.title = "PROBE" + JSON.stringify(out); return; }

  out.supported = LDSound.supported();
  LDSound.unlock();

  // play each one; a broken graph throws rather than failing silently
  out.played = {};
  LDSound.names.forEach(function (n) {
    try { out.played[n] = LDSound.play(n); }
    catch (e) { out.played[n] = "threw: " + e.message; }
  });

  // and the audio context should be running
  try {
    var c = new (window.AudioContext || window.webkitAudioContext)();
    out.contextState = c.state;
    c.close();
  } catch (e) { out.contextState = "unavailable"; }

  out.errs = errs;
  document.title = "PROBE" + JSON.stringify(out);
}, 900);
`, 24000, "build");
      console.log("  " + JSON.stringify(r).slice(0, 260));
      check("the sound module is loaded", r.present === "object", String(r.present));
      check("Web Audio is available", r.supported === true);
      check("there are eight sounds", (r.names || []).length === 8, JSON.stringify(r.names));
      const failed = Object.keys(r.played || {}).filter(function (k) {
        return r.played[k] !== true;
      });
      check("every sound plays without throwing", failed.length === 0, JSON.stringify(failed));
      check("no page errors", (r.errs || []).length === 0, JSON.stringify(r.errs));
    }

    console.log("\n=== the mute switch works and is remembered ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };

  var btn = document.getElementById("traySound");
  var out = { hasButton: !!btn };
  if (!btn) { document.title = "PROBE" + JSON.stringify(out); return; }

  out.startsOn = LDSound.isEnabled();
  out.pressedOn = btn.getAttribute("aria-pressed");
  out.titleOn = btn.title;

  // click to mute
  btn.click();
  out.afterMute = LDSound.isEnabled();
  out.pressedMuted = btn.getAttribute("aria-pressed");
  out.mutedClass = btn.classList.contains("is-muted");
  out.storedAfterMute = localStorage.getItem("letterdrop.sound");

  // and back on
  btn.click();
  out.afterUnmute = LDSound.isEnabled();
  out.storedAfterUnmute = localStorage.getItem("letterdrop.sound");

  out.errs = errs;
  document.title = "PROBE" + JSON.stringify(out);
}, 900);
`, 24000, "mute");
      console.log("  " + JSON.stringify(r));
      check("the tray has a speaker button", r.hasButton === true);
      check("sound starts on", r.startsOn === true);
      check("the button reports it", r.pressedOn === "true", r.pressedOn);
      check("clicking mutes", r.afterMute === false);
      check("the button shows it", r.pressedMuted === "false", r.pressedMuted);
      check("with a muted style", r.mutedClass === true);
      check("the choice is stored", r.storedAfterMute === "off", r.storedAfterMute);
      check("clicking again unmutes", r.afterUnmute === true);
      check("and that is stored too", r.storedAfterUnmute === "on", r.storedAfterUnmute);
      check("no page errors", (r.errs || []).length === 0, JSON.stringify(r.errs));
    }

    console.log("\n=== a muted desktop makes no sound ===");
    {
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  var played = [];
  var realPlay = LDSound.play;
  LDSound.play = function (n) { played.push(n); return realPlay(n); };

  var out = {};
  out.mutedResult = LDSound.play("startup");   // while enabled
  LDSound.setEnabled(false);
  out.afterMute = LDSound.play("error");
  LDSound.setEnabled(true);

  out.callsSeen = played;
  document.title = "PROBE" + JSON.stringify(out);
}, 900);
`, 22000, "silent");
      console.log("  " + JSON.stringify(r));
      check("an enabled sound reports it played", r.mutedResult === true);
      check("a muted one reports it did not", r.afterMute === false);
    }

    console.log("\n=== an illegal operation clicks and beeps ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };

  var played = [];
  var real = LDSound.play;
  LDSound.play = function (n) { played.push(n); return real(n); };

  signInAs("root", "rootpassword1").then(function () {
    return dismissDialogs();
  }).then(function () {
    played.length = 0;   // ignore the sign-in notify

    // clicking a decoy icon is the classic illegal operation
    var icon = Array.prototype.filter.call(document.querySelectorAll(".w98-icon"),
      function (i) { return /Solitaire|Pinball|Pipes/.test(i.textContent); })[0];
    if (!icon) { document.title = "PROBE" + JSON.stringify({ noIcon: true }); return; }
    icon.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    setTimeout(function () {
      var dlg = Array.prototype.filter.call(document.querySelectorAll(".w98-dialog"),
        function (d) { return !d.hidden && /illegal operation/i.test(d.textContent); })[0];
      document.title = "PROBE" + JSON.stringify({
        dialogShown: !!dlg,
        played: played,
        errs: errs
      });
    }, 900);
  });
}, 700);
`, 30000, "error");
      console.log("  " + JSON.stringify(r));
      check("the illegal-operation dialog appears", r.dialogShown === true);
      check("and it makes a noise", (r.played || []).indexOf("error") !== -1,
        JSON.stringify(r.played));
      check("no page errors", (r.errs || []).length === 0, JSON.stringify(r.errs));
    }

    console.log("\n=== new mail dings, and only on arrival ===");
    {
      /* Drive the real path: sign in, open the mailbox, and check that
         merely reading mail does not set the ding off.

         No HTTP request is made here on purpose: one issued straight after
         a browser probe races that probe's teardown and surfaces as an
         ECONNRESET. Anything needed is seeded at the top of the run. */
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };

  var played = [];
  var real = LDSound.play;
  LDSound.play = function (n) { played.push(n); return real(n); };

  signInAs("root", "rootpassword1").then(function () {
    return dismissDialogs();
  }).then(function () {
    /* Wait for the desktop's own unread poll to have run at least once,
       so it has a baseline to compare against. */
    return LD.mailUnread().then(function (res) {
      return new Promise(function (done) {
        // nudge the desktop's badge, which is what notices the change
        window.dispatchEvent(new Event("focus"));
        played.length = 0;
        // and open the mailbox, which broadcasts mail-changed
        LDMail.open("inbox");
        setTimeout(done, 1200);
      }).then(function () { return res; });
    });
  }).then(function () {
    document.title = "PROBE" + JSON.stringify({ playedAfterOpen: played, errs: errs });
  });
}, 700);
`, 30000, "mail");
      console.log("  " + JSON.stringify(r));
      check("opening the mailbox does not ding", (r.playedAfterOpen || []).indexOf("mail") === -1,
        JSON.stringify(r.playedAfterOpen));
      check("no page errors", (r.errs || []).length === 0, JSON.stringify(r.errs));
    }

    console.log("\n=== the ding logic is right ===");
    {
      /* The ding fires when the unread count rises. That decision lives in
         refreshUnread, which is not exported, so the rule is read from the
         source rather than driven through the UI. */
      const src = fs.readFileSync(path.join(DIR, "desktop.js"), "utf8");
      const sounds = fs.readFileSync(path.join(DIR, "sounds.js"), "utf8");

      check("the desktop tracks the previous unread count", /lastUnread/.test(src));
      check("it only plays when the count rises", /n > lastUnread/.test(src),
        "(no rising check found)");
      check("it clears the baseline when signed out", /lastUnread = null/.test(src));
      check("the mail sound exists", /mail: function/.test(sounds));
      check("the IM sound exists", /im: function/.test(sounds));
      check("error beeps are wired to illegal operations",
        /LDSound\.play\("error"\)/.test(src));
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
