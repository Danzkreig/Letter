/* Verify the five changes:
   1. one "signed in" prompt
   2. one "Write a Letter" per menu
   3. shutdown signs out and tries to close
   4. the Start menu rail is real text
   5. icons can be dragged and the layout is remembered. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8962;
const BASE = "http://127.0.0.1:" + PORT;
const TMP = process.env.TEMP;

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

function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_ui" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_ui" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const profile = path.join(TMP, "dshui-" + tag + "-" + Date.now());
  try {
    execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 30000), "--dump-dom",
      "--user-data-dir=" + profile, BASE + "/_probe_ui" + tag + ".html"],
      { stdio: ["ignore", fd, "ignore"] });
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
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
/* Sign in through the desktop's own menu path, so the session is really
   set rather than just the server cookie. */
function signInAs(u, p) {
  return new Promise(function (resolve) {
    document.getElementById("startBtn").click();
    setTimeout(function () {
      var signIn = Array.prototype.filter.call(
        document.querySelectorAll("#startItems .w98-startitem"),
        function (i) { return /Sign In/.test(i.textContent); })[0];
      if (signIn) signIn.click();

      setTimeout(function () {
        var inputs = document.querySelectorAll(".w98-signin input");
        if (!inputs.length) { resolve(null); return; }
        inputs[0].value = u;
        inputs[1].value = p;
        document.querySelector(".w98-signin-actions .w98-btn").click();
        setTimeout(function () { resolve(LDUI.currentUser()); }, 2600);
      }, 700);
    }, 400);
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
          function (b) { return /OK|Close/i.test(b.textContent); })[0];
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
    void admin;

    console.log("=== 1. signing in prompts once ===");
    {
      /* Counted from the DOM rather than by wrapping infoBox: the desktop
         holds its own reference to the bridge, so patching LDUI.infoBox
         would not intercept its calls. */
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();

  var seen = [];
  var observer = new MutationObserver(function () {
    Array.prototype.forEach.call(document.querySelectorAll(".w98-dialog"), function (d) {
      var text = d.textContent || "";
      if (/Signed in as/.test(text) && seen.indexOf(d) === -1) seen.push(d);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  signInAs("root", "rootpassword1").then(function (user) {
    setTimeout(function () {
      document.title = "PROBE" + JSON.stringify({
        sessionUser: user ? user.username : null,
        signedInDialogs: seen.length
      });
    }, 400);
  });
}, 700);
`, 34000, "once");
      console.log("  " + JSON.stringify(r));
      check("the session is set", r.sessionUser === "root", String(r.sessionUser));
      check("exactly one signed-in dialog", r.signedInDialogs === 1,
        String(r.signedInDialogs));
    }

    console.log("\n=== 2. one 'Write a Letter' in each menu ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  var desktopLetters = Array.prototype.filter.call(
    document.querySelectorAll("#iconLayer .w98-icon"), function (i) {
      return /Write a Letter/.test(i.textContent);
    }).length;

  document.getElementById("startBtn").click();
  setTimeout(function () {
    var startLetters = Array.prototype.filter.call(
      document.querySelectorAll("#startItems .w98-startitem"), function (i) {
        return /Write a Letter/.test(i.textContent);
      }).length;
    var allLabels = Array.prototype.map.call(
      document.querySelectorAll("#startItems .w98-startitem"),
      function (i) { return i.textContent.trim(); });
    document.title = "PROBE" + JSON.stringify({
      desktopLetters: desktopLetters,
      startLetters: startLetters,
      totalStartItems: allLabels.length,
      duplicates: allLabels.filter(function (l, i) { return allLabels.indexOf(l) !== i; })
    });
  }, 500);
}, 700);
`, 26000, "letters");
      console.log("  " + JSON.stringify(r));
      check("one on the desktop", r.desktopLetters === 1, String(r.desktopLetters));
      check("one in the Start menu", r.startLetters === 1, String(r.startLetters));
      check("no duplicated Start entries", (r.duplicates || []).length === 0,
        JSON.stringify(r.duplicates));
    }

    console.log("\n=== 3. shutdown signs out ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function (user) {
    return dismissDialogs().then(function () {
      var out = { sessionBefore: user ? user.username : null };
      document.getElementById("startBtn").click();

      return new Promise(function (done) { setTimeout(done, 600); }).then(function () {
        var shut = Array.prototype.filter.call(
          document.querySelectorAll("#startItems .w98-startitem"),
          function (i) { return /Shut Down/.test(i.textContent); })[0];
        out.foundShutdown = !!shut;
        if (!shut) { document.title = "PROBE" + JSON.stringify(out); return; }
        shut.click();
        return new Promise(function (done) { setTimeout(done, 700); });
      }).then(function () {
        var dlg = Array.prototype.filter.call(document.querySelectorAll(".w98-dialog"),
          function (d) { return !d.hidden && /Shut Down Windows/.test(d.textContent); })[0];
        out.confirmShown = !!dlg;
        if (dlg) {
          out.confirmText = dlg.textContent.slice(0, 140);
          out.buttons = Array.prototype.map.call(dlg.querySelectorAll(".w98-btn"),
            function (b) { return b.textContent; });
          var go = Array.prototype.filter.call(dlg.querySelectorAll(".w98-btn"),
            function (b) { return /Shut down/i.test(b.textContent); })[0];
          if (go) go.click();
        }
        return new Promise(function (done) { setTimeout(done, 2800); });
      }).then(function () {
        out.screenShown = !!document.querySelector(".w98-shutdown");
        out.screenText = document.querySelector(".w98-shutdown-big") ?
          document.querySelector(".w98-shutdown-big").textContent : null;
        out.hasTurnBackOn = !!Array.prototype.filter.call(
          document.querySelectorAll(".w98-shutdown .w98-btn"),
          function (b) { return /Turn back on/.test(b.textContent); })[0];
        out.sessionAfter = LDUI.currentUser() ? LDUI.currentUser().username : null;

        return LD.me().then(function (res) {
          out.serverSession = !!(res && res.user);
          document.title = "PROBE" + JSON.stringify(out);
        });
      });
    });
  });
}, 700);
`, 46000, "shutdown");
      console.log("  " + JSON.stringify(r));
      check("the session was set first", r.sessionBefore === "root", String(r.sessionBefore));
      check("the Start menu has Shut Down", r.foundShutdown === true);
      check("it asks first", r.confirmShown === true);
      check("mentioning signing out", /sign out/i.test(r.confirmText || ""), r.confirmText);
      check("offering Cancel", (r.buttons || []).indexOf("Cancel") !== -1,
        JSON.stringify(r.buttons));
      check("the shut-down screen appears", r.screenShown === true);
      check("with the classic line", /safe to turn off/i.test(r.screenText || ""), r.screenText);
      check("and a way back on", r.hasTurnBackOn === true);
      check("the desktop session is cleared", r.sessionAfter === null, String(r.sessionAfter));
      check("and the server session is gone", r.serverSession === false,
        String(r.serverSession));
    }

    console.log("\n=== 4. the Start menu rail is real text ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();

  /* The menu is hidden on load, and a transform on a hidden element reads
     as "none", so it is opened before anything is measured. */
  document.getElementById("startBtn").click();

  setTimeout(function () {
    var rail = document.querySelector(".w98-startmenu-side");
    var text = rail ? rail.querySelector(".w98-startmenu-side-text") : null;
    var out = { exists: !!text, menuOpen: !document.getElementById("startMenu").hidden };
    if (text) {
      out.content = text.textContent;
      var cs = getComputedStyle(text);
      out.transform = cs.transform;
      out.fontFamily = cs.fontFamily;
      out.color = cs.color;
      out.railBg = getComputedStyle(rail).backgroundImage;
      out.isElement = text.tagName.toLowerCase() === "span";
      out.railHasImg = !!rail.querySelector("img");

      /* The real question: is it taller than it is wide, i.e. running up
         the rail rather than across it? */
      var box = text.getBoundingClientRect();
      out.boxW = Math.round(box.width);
      out.boxH = Math.round(box.height);
      out.vertical = box.height > box.width;

      /* and does it sit inside the rail? */
      var railBox = rail.getBoundingClientRect();
      out.insideRail = box.left >= railBox.left - 1 && box.right <= railBox.right + 1 &&
        box.top >= railBox.top - 1 && box.bottom <= railBox.bottom + 1;

      /* how many times does the text appear? once, not tiled */
      out.occurrences = document.querySelectorAll(".w98-startmenu-side-text").length;
    }
    document.title = "PROBE" + JSON.stringify(out);
  }, 700);
}, 700);
`, 26000, "rail");
      console.log("  " + JSON.stringify(r));
      check("the menu opens", r.menuOpen === true);
      check("the rail has text", r.exists === true);
      check("reading Windows 98", /^Windows\s*98$/.test((r.content || "").replace(/\s+/g, " ").trim()),
        JSON.stringify(r.content));
      check("it is a real element, not an image", r.isElement === true && r.railHasImg === false);
      check("it appears once, not tiled", r.occurrences === 1, String(r.occurrences));
      check("it runs up the rail, not across it", r.vertical === true,
        r.boxW + "x" + r.boxH);
      check("and sits inside the rail", r.insideRail === true);
      check("the old tiled artwork is gone", !/start-menu-side/.test(r.railBg || ""), r.railBg);
    }

    console.log("\n=== 5. icons can be moved ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  var icons = document.querySelectorAll("#iconLayer .w98-icon");
  var out = { count: icons.length };
  if (icons.length < 2) { document.title = "PROBE" + JSON.stringify(out); return; }

  var icon = icons[0];
  var layer = document.getElementById("iconLayer");
  var before = icon.getBoundingClientRect();

  out.startLeft = Math.round(before.left);
  out.startTop = Math.round(before.top);

  /* Drag it with pointer events, the way a mouse would. */
  function pointer(type, x, y) {
    icon.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1
    }));
  }

  pointer("pointerdown", before.left + 20, before.top + 20);
  pointer("pointermove", before.left + 60, before.top + 20);
  pointer("pointermove", before.left + 160, before.top + 130);
  pointer("pointerup", before.left + 160, before.top + 130);

  setTimeout(function () {
    var after = icon.getBoundingClientRect();
    out.endLeft = Math.round(after.left);
    out.endTop = Math.round(after.top);
    out.movedX = out.endLeft - out.startLeft;
    out.movedY = out.endTop - out.startTop;

    // did it remember?
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem("letterdrop.icons") || "null"); } catch (e) {}
    out.saved = saved;
    out.savedForThis = saved ? saved[icon.dataset.appId] : null;

    // is it inside the desktop?
    var box = layer.getBoundingClientRect();
    out.insideX = after.left >= box.left - 1 && after.right <= box.right + 1;
    out.insideY = after.top >= box.top - 1 && after.bottom <= box.bottom + 1;

    document.title = "PROBE" + JSON.stringify(out);
  }, 400);
}, 900);
`, 26000, "drag");
      console.log("  " + JSON.stringify(r).slice(0, 300));
      check("there are icons", r.count >= 10, String(r.count));
      check("dragging moves it right", r.movedX > 100, String(r.movedX));
      check("and down", r.movedY > 80, String(r.movedY));
      check("the position is stored", r.savedForThis !== null && r.savedForThis !== undefined,
        JSON.stringify(r.savedForThis));
      check("stored close to where it landed",
        r.savedForThis && Math.abs(r.savedForThis.x - (r.endLeft - 8)) < 30,
        JSON.stringify(r.savedForThis) + " vs " + r.endLeft);
      check("it stays on the desktop", r.insideX === true && r.insideY === true);
    }

    console.log("\n=== a moved icon keeps its place on reload ===");
    {
      /* Move an icon, then load a fresh page and check it is still there.
         localStorage is per-profile, so this reuses one profile dir. */
      const profile = path.join(TMP, "dshuikeep-" + Date.now());
      const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");

      /* These two run in the same browser profile, one after the other, so
         the second load sees what the first stored. They are written out
         as plain strings rather than using the shared helper, because each
         runs as its own page. */
      const READY = `
function ready() {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
}
`;

      const moveProbe = READY + `
setTimeout(function () {
  ready();
  var icon = document.querySelectorAll("#iconLayer .w98-icon")[0];
  var id = icon.dataset.appId;
  /* Set a known position directly, which is what a drag would leave. */
  localStorage.setItem("letterdrop.icons", JSON.stringify(
    (function () { var o = {}; o[id] = { x: 300, y: 200 }; return o; })()));
  document.title = "PROBE" + JSON.stringify({ id: id });
}, 700);
`;
      const checkProbe = READY + `
setTimeout(function () {
  ready();
  var icons = document.querySelectorAll("#iconLayer .w98-icon");
  var found = null;
  Array.prototype.forEach.call(icons, function (i) {
    var r = i.getBoundingClientRect();
    var box = document.getElementById("iconLayer").getBoundingClientRect();
    if (Math.abs((r.left - box.left) - 300) < 4 && Math.abs((r.top - box.top) - 200) < 4) {
      found = i.dataset.appId;
    }
  });
  document.title = "PROBE" + JSON.stringify({ atSavedSpot: found, iconCount: icons.length });
}, 900);
`;
      fs.writeFileSync(path.join(DIR, "_probe_uikeep1.html"),
        src.replace("</body>", "<script>" + moveProbe + "</script></body>"), "utf8");
      fs.writeFileSync(path.join(DIR, "_probe_uikeep2.html"),
        src.replace("</body>", "<script>" + checkProbe + "</script></body>"), "utf8");

      function runPage(which) {
        const dumpFile = path.join(DIR, "_probe_uikeep" + which + ".txt");
        const fd = fs.openSync(dumpFile, "w");
        try {
          execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
            "--window-size=1280,900", "--virtual-time-budget=20000", "--dump-dom",
            "--user-data-dir=" + profile,
            BASE + "/_probe_uikeep" + which + ".html"],
            { stdio: ["ignore", fd, "ignore"] });
        } finally {
          fs.closeSync(fd);
        }
        const dump = fs.readFileSync(dumpFile, "utf8");
        const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
        return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
      }

      let r1 = null, r2 = null;
      try {
        r1 = runPage(1);
        r2 = runPage(2);
      } finally {
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
      }
      console.log("  " + JSON.stringify(r1) + " then " + JSON.stringify(r2));
      check("an icon can be placed", r1 && r1.id, JSON.stringify(r1));
      check("and is still there on a fresh load", r2 && r2.atSavedSpot === r1.id,
        JSON.stringify(r2));
    }

    console.log("\n=== the desktop context menu has Tidy up ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  var layer = document.getElementById("iconLayer");
  layer.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 500, clientY: 400
  }));

  setTimeout(function () {
    var menu = document.querySelector(".w98-iconmenu");
    var out = { menuShown: !!menu };
    if (menu) {
      out.items = Array.prototype.map.call(menu.querySelectorAll(".w98-iconmenu-item"),
        function (b) { return b.textContent; });
    }
    document.title = "PROBE" + JSON.stringify(out);
  }, 400);
}, 900);
`, 24000, "menu");
      console.log("  " + JSON.stringify(r));
      check("right-clicking the desktop opens a menu", r.menuShown === true);
      check("offering Tidy up icons", (r.items || []).indexOf("Tidy up icons") !== -1,
        JSON.stringify(r.items));
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
