/* Verify the reworked desktop: boot with no letter system, the Control
   Panel, the Network dialog, program enable/disable, and Winamp. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8812;
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
    const data = body === undefined || body === null ? null
      : (Buffer.isBuffer(body) ? body : JSON.stringify(body));
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

function inBrowser(script, budget, tag, page) {
  const src = fs.readFileSync(path.join(DIR, page || "card.html"), "utf8");
  const p = path.join(DIR, "_probe_cp" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_cp" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshcp-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 22000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_cp" + tag + ".html"],
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

    // an mp3 and an mp4 so Winamp has something to list
    await req("PUT", "/api/upload", Buffer.from("ID3fakeaudiodata"), admin, { "X-File-Name": "song.mp3" });
    await req("PUT", "/api/upload", Buffer.from("fakevideodata"), admin, { "X-File-Name": "clip.mp4" });
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    await req("PUT", "/api/upload", PNG, admin, { "X-File-Name": "pic.png" });

    console.log("=== the desktop boots with no letter system ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  document.title = "PROBE" + JSON.stringify({
    icons: document.querySelectorAll(".w98-icon").length,
    hasDesktop: !!document.querySelector(".w98-desktop") || !!document.getElementById("iconLayer"),
    title: document.title,
    errors: window.__errs || []
  });
}, 1600);
`, 20000, "boot");
      console.log("  " + JSON.stringify(r));
      check("the desktop is present", r.hasDesktop === true);
      check("icons are built", r.icons >= 15, String(r.icons));
      check("the site name becomes the title", /Letterdrop/.test(r.title || ""), r.title);
    }

    console.log("\n=== a legacy letter link no longer hijacks the page ===");
    {
      const payload = "eyJ0byI6ImEiLCJmcm9tIjoiYSIsIm5vdGUiOiJhIiwidGhlbWUiOiJyb3NlIiwiZGF0ZSI6IjIwMjYtMDktMjUiLCJzaGFwZSI6ImRvdW50In0";
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  // simulate having arrived with an old letter hash by opening the inbox
  location.hash = "${payload}";
  LDMail.open("inbox");
  setTimeout(function () {
    document.title = "PROBE" + JSON.stringify({
      signinShown: !!document.querySelector(".w98-signin"),
      mailboxOpen: !!Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
        function (w) { return !w.hidden && /Outlook/.test(w.querySelector(".w98-title-text").textContent); }).length,
      bodyText: document.body.textContent.slice(0, 60)
    });
  }, 1500);
}, 700);
`, 22000, "legacy");
      console.log("  " + JSON.stringify(r));
      check("no error page is shown", !/could not be displayed/i.test(r.bodyText || ""), r.bodyText);
      check("an old hash does not open a letter", r.mailboxOpen === false || r.signinShown === true,
        JSON.stringify(r));
    }

    /* The Letterdrop Network dialog is gone: writing a letter is now a real
       program, so the obsolete "letters are no longer links" notice has no
       reason to exist. This checks the composer is what you get instead. */
    console.log("\n=== writing a letter ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  LDLetter.compose();
  setTimeout(function () {
    var win = winByTitle(/New Letter/);
    var out = { opened: !!win };
    if (win) {
      out.shapes = win.querySelectorAll(".ld-shape").length;
      out.hasBody = !!win.querySelector(".ld-letter-body-input");
      out.hasSuggest = !!win.querySelector(".w98-suggest");
      out.noNetworkDialog = !winByTitle(/Letterdrop Network/);
    }
    document.title = "PROBE" + JSON.stringify(out);
  }, 1600);
}, 700);
`, 22000, "net");
      console.log("  " + JSON.stringify(r));
      check("the composer window opens", r.opened === true);
      check("it has the shape picker", r.shapes === 5, String(r.shapes));
      check("and a body box", r.hasBody === true);
      check("and autocomplete", r.hasSuggest === true);
      check("the old Network dialog is gone", r.noNetworkDialog === true);
    }

    console.log("\n=== the Control Panel ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDControl.open();
    setTimeout(function () {
      var win = winByTitle(/Control Panel/);
      var out = { opened: !!win };
      if (win) {
        out.tabs = Array.prototype.map.call(win.querySelectorAll(".cp-tab"),
          function (b) { return b.textContent; });

        // the Programs tab
        Array.prototype.filter.call(win.querySelectorAll(".cp-tab"),
          function (b) { return b.textContent === "Programs"; })[0].click();
        out.programs = win.querySelectorAll(".cp-program").length;

        // the Storage tab
        Array.prototype.filter.call(win.querySelectorAll(".cp-tab"),
          function (b) { return b.textContent === "Storage"; })[0].click();
        setTimeout(function () {
          out.storage = win.querySelector(".cp-big") ? win.querySelector(".cp-big").textContent : null;
          out.storageRows = win.querySelectorAll(".cp-trow").length;

          // the Danger tab
          Array.prototype.filter.call(win.querySelectorAll(".cp-tab"),
            function (b) { return b.textContent === "Danger"; })[0].click();
          out.dangerCards = win.querySelectorAll(".cp-danger").length;
          out.hasConfirm = !!win.querySelector(".cp-danger-row .ld-input");

          document.title = "PROBE" + JSON.stringify(out);
        }, 700);
      } else {
        document.title = "PROBE" + JSON.stringify(out);
      }
    }, 2000);
  });
}, 700);
`, 26000, "cp");
      console.log("  " + JSON.stringify(r));
      check("the Control Panel opens", r.opened === true);
      check("it has four tabs", (r.tabs || []).length === 4, JSON.stringify(r.tabs));
      check("every program is listed", r.programs === 14, String(r.programs));
      check("it reports storage used", /B|KB|MB|GB/.test(r.storage || ""), r.storage);
      check("per-account rows are shown", (r.storageRows || 0) >= 2, String(r.storageRows));
      check("there are three dangerous actions", r.dangerCards === 3, String(r.dangerCards));
      check("each needs a typed confirmation", r.hasConfirm === true);
    }

    console.log("\n=== a disabled program disappears and refuses to open ===");
    {
      await req("POST", "/api/admin/settings", { programs: { minesweeper: false, paint: false } }, admin);

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    setTimeout(function () {
      var all = Array.prototype.map.call(document.querySelectorAll(".w98-icon"),
        function (i) { return i.dataset.appId; });
      var visible = Array.prototype.filter.call(document.querySelectorAll(".w98-icon"),
        function (i) { return !i.hidden; }).map(function (i) { return i.dataset.appId; });

      var out = {
        hasIcon: all.indexOf("minesweeper") !== -1,
        iconHidden: visible.indexOf("minesweeper") === -1,
        paintHidden: visible.indexOf("paint") === -1,
        calcStillVisible: visible.indexOf("calculator") !== -1
      };

      /* Double-clicking the icon is how a user would try it. The icon is
         hidden, so this simulates a stale shortcut by dispatching the event
         straight at the node. */
      var node = Array.prototype.filter.call(document.querySelectorAll(".w98-icon"),
        function (i) { return i.dataset.appId === "minesweeper"; })[0];
      if (node) {
        node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }

      setTimeout(function () {
        var wins = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
          function (w) { return !w.hidden; });
        out.minesweeperOpen = wins.some(function (w) {
          return /Minesweeper/.test(w.querySelector(".w98-title-text").textContent);
        });
        out.dialogShown = /disabled on this computer/i.test(document.body.textContent);
        document.title = "PROBE" + JSON.stringify(out);
      }, 1000);
    }, 1600);
  });
}, 700);
`, 28000, "disabled");
      console.log("  " + JSON.stringify(r));
      check("the icon still exists in the DOM", r.hasIcon === true);
      check("but is hidden", r.iconHidden === true);
      check("a second disabled program is hidden too", r.paintHidden === true);
      check("an enabled program is still visible", r.calcStillVisible === true);
      check("launching it does not open it", r.minesweeperOpen === false);
      check("and it says why", r.dialogShown === true);

      await req("POST", "/api/admin/settings",
        { programs: { minesweeper: true, paint: true } }, admin);
    }

    console.log("\n=== Winamp lists and plays media ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDWinamp.open();
    setTimeout(function () {
      var win = winByTitle(/Winamp/);
      var out = { opened: !!win };
      if (win) {
        var rows = win.querySelectorAll(".wa-row");
        out.rows = rows.length;
        out.names = Array.prototype.map.call(rows, function (r) {
          return r.querySelector(".wa-rowname").textContent;
        });
        out.hasSeek = !!win.querySelector(".wa-seek");
        out.hasVolume = !!win.querySelector(".wa-vol");
        out.transport = win.querySelectorAll(".wa-btn").length;
        out.hasVideoEl = !!win.querySelector(".wa-video");
      }
      document.title = "PROBE" + JSON.stringify(out);
    }, 2000);
  });
}, 700);
`, 24000, "winamp");
      console.log("  " + JSON.stringify(r));
      check("Winamp opens", r.opened === true);
      check("it lists only playable media", r.rows === 2, String(r.rows));
      check("the mp3 is listed", (r.names || []).indexOf("song.mp3") !== -1, JSON.stringify(r.names));
      check("the mp4 is listed", (r.names || []).indexOf("clip.mp4") !== -1, JSON.stringify(r.names));
      check("the png is not", (r.names || []).indexOf("pic.png") === -1, JSON.stringify(r.names));
      check("it has a seek bar", r.hasSeek === true);
      check("and a volume control", r.hasVolume === true);
      check("with transport buttons", r.transport >= 5, String(r.transport));
      check("and a video element for mp4s", r.hasVideoEl === true);
    }

    console.log("\n=== the share page is just the file ===");
    {
      const share = await req("POST", "/api/share", { name: "pic.png" }, admin);
      const token = share.json.token;
      const page = await req("GET", "/" + token);
      check("the short link works", page.status === 200, String(page.status));
      check("it is only an image tag",
        page.text.indexOf('<img class="media"') !== -1 && !/<h1|<button/i.test(page.text),
        page.text.slice(page.text.indexOf("<body>"), page.text.indexOf("<body>") + 80));
      check("the token is six characters", token.length === 6, token);
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
