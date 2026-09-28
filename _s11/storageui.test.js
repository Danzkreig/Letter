/* Verify the file manager, quota bar and Find in a real browser. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8873;
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

function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_fm" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_fm" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshfm-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 26000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_fm" + tag + ".html"],
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

    // a little content to browse and search
    await req("POST", "/api/file", { kind: "note", name: "recipe.txt",
      text: "Sourdough needs a starter and patience" }, admin);
    await req("PUT", "/api/upload", Buffer.from("audio-bytes"), admin,
      { "X-File-Name": "tune.mp3" });
    await req("POST", "/api/folder", { path: "Holiday" }, admin);
    await req("POST", "/api/folder", { path: "Holiday/Photos" }, admin);
    await req("POST", "/api/file/rename", { from: "tune.mp3", to: "Holiday/tune.mp3" }, admin);
    await req("POST", "/api/admin/users",
      { username: "alice", password: "alicepassword", role: "user" }, admin);

    console.log("=== the folder browser ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openDocuments();
    setTimeout(function () {
      var win = winByTitle(/My Documents/);
      var out = { opened: !!win };
      if (win) {
        out.folders = win.querySelectorAll(".w98-folderrow").length;
        out.files = win.querySelectorAll(".w98-filerow:not(.w98-folderrow)").length;
        out.crumbs = win.querySelectorAll(".w98-crumb").length;
        out.crumbText = win.querySelector(".w98-crumbs").textContent;
        out.hasQuota = !!win.querySelector(".w98-quota");
        out.quotaText = win.querySelector(".w98-quota-text") ?
          win.querySelector(".w98-quota-text").textContent : null;
        out.hasNewFolder = Array.prototype.map.call(win.querySelectorAll(".w98-tool span"),
          function (s) { return s.textContent; }).some(function (t) { return /New Folder/.test(t); });
      }
      document.title = "PROBE" + JSON.stringify(out);
    }, 1800);
  });
}, 700);
`, 28000, "root");
      console.log("  " + JSON.stringify(r));
      check("the window opens", r.opened === true);
      check("it shows the folder", r.folders === 1, String(r.folders));
      check("and the loose file", r.files === 1, String(r.files));
      check("there is a breadcrumb bar", r.crumbs >= 2, String(r.crumbs));
      check("saying My Documents", /My Documents/.test(r.crumbText || ""), r.crumbText);
      check("there is a quota readout", r.hasQuota === true);
      check("showing usage", /used/.test(r.quotaText || ""), r.quotaText);
      check("and a New Folder button", r.hasNewFolder === true);
    }

    console.log("\n=== going into a folder ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openDocuments();
    setTimeout(function () {
      var win = winByTitle(/My Documents/);
      var folder = win.querySelector(".w98-folderrow");
      folder.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      setTimeout(function () {
        var out = {
          crumbs: win.querySelector(".w98-crumbs").textContent,
          folders: win.querySelectorAll(".w98-folderrow").length,
          files: win.querySelectorAll(".w98-filerow:not(.w98-folderrow)").length,
          names: Array.prototype.map.call(win.querySelectorAll(".w98-filename"),
            function (n) { return n.textContent; }),
          upDisabled: win.querySelector(".w98-crumb").disabled
        };
        // go into the nested one
        var nested = win.querySelector(".w98-folderrow");
        nested.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        setTimeout(function () {
          out.deepCrumbs = win.querySelector(".w98-crumbs").textContent;
          // and back out with Up
          win.querySelector(".w98-crumb").click();
          setTimeout(function () {
            out.afterUp = win.querySelector(".w98-crumbs").textContent;
            document.title = "PROBE" + JSON.stringify(out);
          }, 900);
        }, 900);
      }, 1200);
    }, 1600);
  });
}, 700);
`, 32000, "nav");
      console.log("  " + JSON.stringify(r));
      check("the breadcrumb shows the folder", /Holiday/.test(r.crumbs || ""), r.crumbs);
      check("the nested folder is listed", r.folders === 1, String(r.folders));
      check("with the moved file", (r.names || []).indexOf("tune.mp3") !== -1, JSON.stringify(r.names));
      check("Up becomes available inside", r.upDisabled === false);
      check("the deep breadcrumb shows both levels", /Holiday/.test(r.deepCrumbs || "") &&
        /Photos/.test(r.deepCrumbs || ""), r.deepCrumbs);
      check("Up goes back a level", r.afterUp && r.afterUp.indexOf("Photos") === -1, r.afterUp);
    }

    console.log("\n=== Find ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDFind.open("sourdough");
    setTimeout(function () {
      var win = winByTitle(/Find/);
      var out = { opened: !!win };
      if (win) {
        out.tabs = Array.prototype.map.call(win.querySelectorAll(".find-tab"),
          function (t) { return t.textContent; });
        out.rows = win.querySelectorAll(".find-row").length;
        out.groups = Array.prototype.map.call(win.querySelectorAll(".find-group"),
          function (g) { return g.textContent; });
        out.title = win.querySelector(".find-title") ?
          win.querySelector(".find-title").textContent : null;
        out.snippet = win.querySelector(".find-snippet") ?
          win.querySelector(".find-snippet").textContent : null;
        out.status = win.querySelector(".w98-statusbar span").textContent;

        // switch to the Files tab
        Array.prototype.filter.call(win.querySelectorAll(".find-tab"),
          function (t) { return t.textContent === "Files"; })[0].click();
        setTimeout(function () {
          out.filesOnlyGroups = Array.prototype.map.call(win.querySelectorAll(".find-group"),
            function (g) { return g.textContent; });
          document.title = "PROBE" + JSON.stringify(out);
        }, 900);
      } else {
        document.title = "PROBE" + JSON.stringify(out);
      }
    }, 2000);
  });
}, 700);
`, 30000, "find");
      console.log("  " + JSON.stringify(r));
      check("the Find window opens", r.opened === true);
      check("it has four scope tabs", (r.tabs || []).length === 4, JSON.stringify(r.tabs));
      check("the note is found", r.rows >= 1, String(r.rows));
      check("by its contents", /recipe\.txt/.test(r.title || ""), r.title);
      check("with a snippet", /sourdough/i.test(r.snippet || ""), r.snippet);
      check("results are grouped", (r.groups || []).some(g => /Files/.test(g)), JSON.stringify(r.groups));
      check("the status line counts them", /result/.test(r.status || ""), r.status);
      check("the Files tab narrows it", (r.filesOnlyGroups || []).every(g => /Files/.test(g)),
        JSON.stringify(r.filesOnlyGroups));
    }

    console.log("\n=== Find finds people and mail ===");
    {
      await req("POST", "/api/mail",
        { to: "alice", subject: "About sourdough", body: "It worked." }, admin);

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword").then(function () {
    LDFind.open("sourdough");
    setTimeout(function () {
      var win = winByTitle(/Find/);
      var out = {
        groups: Array.prototype.map.call(win.querySelectorAll(".find-group"),
          function (g) { return g.textContent; }),
        titles: Array.prototype.map.call(win.querySelectorAll(".find-title"),
          function (t) { return t.textContent; })
      };
      // now search for a person
      var field = win.querySelector(".find-input");
      field.value = "root";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      setTimeout(function () {
        out.peopleGroups = Array.prototype.map.call(win.querySelectorAll(".find-group"),
          function (g) { return g.textContent; });
        out.peopleTitles = Array.prototype.map.call(win.querySelectorAll(".find-title"),
          function (t) { return t.textContent; });
        document.title = "PROBE" + JSON.stringify(out);
      }, 1200);
    }, 2000);
  });
}, 700);
`, 32000, "people");
      console.log("  " + JSON.stringify(r));
      check("mail is found", (r.groups || []).some(g => /Mail/.test(g)), JSON.stringify(r.groups));
      check("the letter subject shows", (r.titles || []).some(t => /sourdough/i.test(t)),
        JSON.stringify(r.titles));
      check("people are found", (r.peopleGroups || []).some(g => /People/.test(g)),
        JSON.stringify(r.peopleGroups));
      check("and root is listed", (r.peopleTitles || []).indexOf("root") !== -1,
        JSON.stringify(r.peopleTitles));
    }

    console.log("\n=== the quota bar reflects a limit ===");
    {
      await req("POST", "/api/admin/settings", { quotaMB: 1 }, admin);
      await req("PUT", "/api/upload", Buffer.alloc(400 * 1024, 9), admin,
        { "X-File-Name": "filler.bin" });

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openDocuments();
    setTimeout(function () {
      var win = winByTitle(/My Documents/);
      var fill = win.querySelector(".w98-quota-fill");
      document.title = "PROBE" + JSON.stringify({
        text: win.querySelector(".w98-quota-text").textContent,
        width: fill ? fill.style.width : null,
        hasWarn: fill ? fill.classList.contains("is-warn") : null
      });
    }, 1800);
  });
}, 700);
`, 28000, "quota");
      console.log("  " + JSON.stringify(r));
      check("the quota text shows both numbers", /of/.test(r.text || ""), r.text);
      check("the bar has a width", /\d+%/.test(r.width || ""), r.width);
      check("and is not yet warning", r.hasWarn === false, String(r.hasWarn));

      await req("POST", "/api/admin/settings", { quotaMB: 0 }, admin);
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
