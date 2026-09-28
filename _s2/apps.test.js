/* Stage 2 verification: Notepad and My Documents against the live server.
   Drives the real UI in a headless browser. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8741;
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

/* fresh data dir */
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

function waitForServer() {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function go() {
      n++;
      const r = http.request(BASE + "/api/me", function (res) { res.resume(); resolve(); });
      r.on("error", function () { n > 80 ? reject(new Error("no start:\n" + serverOut)) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

/* Run a page in the browser and return a value the page puts in the title. */
function inBrowser(probe, budget) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_s2.html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + probe + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_s2_dump.txt");
  const fd = fs.openSync(dumpFile, "w");
  const profile = TMP + "\\dshs2";
  try {
    execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,860", "--virtual-time-budget=" + (budget || 40000), "--dump-dom",
      "--user-data-dir=" + profile, BASE + "/_probe_s2.html"],
      { stdio: ["ignore", fd, "ignore"] });
  } finally {
    dropProfile(profile);
  }
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
}

/* Sign in inside the page, skipping the boot sequence. This goes through the
   real sign-in window, so it exercises the same path a person would. */
const signIn = `
function ready() {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
}
function signInAs(u, p) {
  // the real form: open it, fill it, submit it
  return new Promise(function (resolve, reject) {
    LDApps.openSignIn(function (user) { resolve(user || null); });
    setTimeout(function () {
      var inputs = document.querySelectorAll(".w98-signin input");
      if (inputs.length < 2) { reject(new Error("no sign-in form")); return; }
      inputs[0].value = u;
      inputs[1].value = p;
      var ok = document.querySelector(".w98-signin-actions .w98-btn");
      ok.click();
      setTimeout(function () { resolve(null); }, 2500);
    }, 300);
  });
}
`;

(async function run() {
  try {
    await waitForServer();

    console.log("=== the apps are loaded ===");
    {
      const r = inBrowser(`
${signIn}
setTimeout(function () {
  ready();
  document.title = "PROBE" + JSON.stringify({
    api: typeof window.LD,
    apps: typeof window.LDApps,
    icons: document.querySelectorAll(".w98-icon").length,
    hasNotepadIcon: !!document.querySelector('.w98-icon[data-app-id="notepad"]'),
    hasDocsIcon: !!document.querySelector('.w98-icon[data-app-id="documents"]'),
    adminIconHidden: document.querySelector('.w98-icon[data-app-id="accounts"]').hidden
  });
}, 700);
`, 12000);
      console.log("  " + JSON.stringify(r));
      check("the API client is present", r && r.api === "object", r && r.api);
      check("the apps module is present", r && r.apps === "object", r && r.apps);
      check("Notepad has a desktop icon", r && r.hasNotepadIcon === true);
      check("My Documents has a desktop icon", r && r.hasDocsIcon === true);
      check("admin-only icon is hidden when signed out", r && r.adminIconHidden === true, JSON.stringify(r));
    }

    console.log("\n=== Notepad: write, save, reload ===");
    {
      const r = inBrowser(`
${signIn}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openNotepad(null, "");
    setTimeout(function () {
      var w = Array.prototype.filter.call(
        document.querySelectorAll(".w98-win"),
        function (x) { return !x.hidden; }
      )[0];
      var area = document.querySelector(".w98-notepad");
      area.value = "Dear Mira,\\n\\nThis note was typed in Notepad.\\n\\n- Sam";
      var saveBtn = Array.prototype.filter.call(
        document.querySelectorAll(".w98-notepad-actions .w98-btn"),
        function (b) { return b.textContent === "Save"; })[0];
      saveBtn.click();

      /* Save opens a real Save As dialog with a folder browser now, rather
         than a window.prompt, so the name is typed in there. */
      setTimeout(function () {
        var dlg = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
          function (x) { return !x.hidden && /Save As/.test(
            x.querySelector(".w98-title-text").textContent); })[0];
        if (!dlg) {
          document.title = "PROBE" + JSON.stringify({ noDialog: true });
          return;
        }
        dlg.querySelector(".saveas-row input").value = "letter.txt";
        Array.prototype.filter.call(dlg.querySelectorAll(".w98-btn"),
          function (b) { return b.textContent === "Save"; })[0].click();

        setTimeout(function () {
          document.title = "PROBE" + JSON.stringify({
            titleAfterSave: w.querySelector(".w98-title-text").textContent,
            status: document.querySelector(".w98-statusbar span").textContent,
            areaValue: area.value
          });
        }, 1400);
      }, 1200);
    }, 400);
  });
}, 600);
`, 24000);
      console.log("  " + JSON.stringify(r));
      check("the Save As dialog appears", r.noDialog !== true);
      check("the window retitles to the saved name", /letter\.txt/.test(r.titleAfterSave || ""), r.titleAfterSave);
      check("the status line confirms the save", /Saved letter\.txt/.test(r.status || ""), r.status);
      check("the text is still in the editor", /Notepad/.test(r.areaValue || ""), r.areaValue);
    }

    console.log("\n=== My Documents: list, open, delete ===");
    {
      const r = inBrowser(`
${signIn}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openDocuments();
    setTimeout(function () {
      var rows = document.querySelectorAll(".w98-filerow");
      var names = Array.prototype.map.call(rows, function (x) {
        return x.querySelector(".w98-filename").textContent;
      });
      var status = document.querySelector(".w98-statusbar span").textContent;
      // open it into Notepad
      rows[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      setTimeout(function () {
        var notepads = document.querySelectorAll(".w98-notepad");
        document.title = "PROBE" + JSON.stringify({
          fileCount: rows.length,
          names: names,
          status: status,
          notepadOpened: notepads.length,
          notepadText: notepads.length ? notepads[0].value : null
        });
      }, 1000);
    }, 900);
  });
}, 600);
`, 22000);
      console.log("  " + JSON.stringify(r, null, 1).replace(/\n/g, "\n  "));
      check("the saved note is listed", r.fileCount === 1, String(r.fileCount));
      check("it has the right name", r.names[0] === "letter.txt", JSON.stringify(r.names));
      /* The status bar now separates folders from files, so it reads
         "1 file" rather than "1 object". */
      check("the status bar counts files", /1 file/.test(r.status || ""), r.status);
      check("double-click opens it in Notepad", r.notepadOpened === 1, String(r.notepadOpened));
      check("the note's text is loaded back", /typed in Notepad/.test(r.notepadText || ""), r.notepadText);
    }

    console.log("\n=== image upload ===");
    {
      const r = inBrowser(`
${signIn}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    // a real 1x1 PNG, uploaded the same way the file picker would
    var b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    LD.saveImage("tiny.png", "image/png", b64).then(function () {
      LDApps.openDocuments();
      setTimeout(function () {
        var rows = document.querySelectorAll(".w98-filerow");
        var kinds = Array.prototype.map.call(rows, function (x) {
          return x.querySelector(".w98-filekind").textContent;
        });
        // open the image
        var imgRow = Array.prototype.filter.call(rows, function (x) {
          return x.querySelector(".w98-filename").textContent === "tiny.png";
        })[0];
        imgRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        setTimeout(function () {
          var viewer = document.querySelector(".w98-viewer img");
          document.title = "PROBE" + JSON.stringify({
            rows: rows.length,
            kinds: kinds,
            viewerShown: !!viewer,
            srcIsData: viewer ? viewer.src.indexOf("data:image/png") === 0 : false
          });
        }, 1100);
      }, 900);
    });
  });
}, 600);
`, 24000);
      console.log("  " + JSON.stringify(r));
      check("the image is listed", r.rows === 2, String(r.rows));
      check("it is typed as an Image",
        r.kinds.indexOf("Image") !== -1, JSON.stringify(r.kinds));
      check("the note is still typed as Text",
        r.kinds.indexOf("Text") !== -1, JSON.stringify(r.kinds));
      check("double-click opens the viewer", r.viewerShown === true);
      check("the viewer shows the real image data", r.srcIsData === true);
    }

    console.log("\n=== a second user is isolated ===");
    {
      const r = inBrowser(`
${signIn}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    return LD.createUser("alice", "alicepassword", "user");
  }).then(function () {
    return LD.logout();
  }).then(function () {
    return signInAs("alice", "alicepassword");
  }).then(function () {
    LDApps.openDocuments();
    setTimeout(function () {
      var rows = document.querySelectorAll(".w98-filerow");
      var empty = document.querySelector(".w98-hint");
      document.title = "PROBE" + JSON.stringify({
        files: rows.length,
        emptyShown: !!empty,
        status: document.querySelector(".w98-statusbar span").textContent,
        adminIconHidden: document.querySelector('.w98-icon[data-app-id="accounts"]').hidden
      });
    }, 1100);
  });
}, 600);
`, 26000);
      console.log("  " + JSON.stringify(r));
      check("a new user sees an empty folder", r.files === 0, String(r.files));
      check("it says the folder is empty", r.emptyShown === true);
      check("zero files in the status bar", /0 files/.test(r.status || ""), r.status);
      check("a non-admin cannot see User Accounts", r.adminIconHidden === true, JSON.stringify(r));
    }

    console.log("\n=== admin can browse another user's folder ===");
    {
      const r = inBrowser(`
${signIn}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    return LD.listUsers();
  }).then(function (res) {
    var alice = res.users.filter(function (u) { return u.username === "alice"; })[0];
    // put a file in alice's folder as the admin
    return LD.saveNote("fromadmin.txt", "placed by the admin", alice.id).then(function () {
      return alice;
    });
  }).then(function (alice) {
    LDApps.openDocuments({ userId: alice.id, title: alice.username + "'s Documents" });
    setTimeout(function () {
      var rows = document.querySelectorAll(".w98-filerow");
      document.title = "PROBE" + JSON.stringify({
        rows: rows.length,
        first: rows.length ? rows[0].querySelector(".w98-filename").textContent : null,
        winTitle: Array.prototype.filter.call(
          document.querySelectorAll(".w98-win"),
          function (x) { return !x.hidden; }
        ).map(function (x) {
          return x.querySelector(".w98-title-text").textContent;
        })
      });
    }, 1100);
  });
}, 600);
`, 26000);
      console.log("  " + JSON.stringify(r));
      check("the admin sees the other user's file", r.rows === 1, String(r.rows));
      check("it is the file the admin placed", r.first === "fromadmin.txt", r.first);
      check("the window is titled for that user",
        Array.isArray(r.winTitle) && r.winTitle.some(function (t) { return /alice/.test(t); }),
        JSON.stringify(r.winTitle));
    }

    console.log("\n=== a non-admin is refused by the API directly ===");
    {
      const r = inBrowser(`
${signIn}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword").then(function () {
    return LD.listUsers().then(function () {
      document.title = "PROBE" + JSON.stringify({ allowed: true });
    }).catch(function (e) {
      document.title = "PROBE" + JSON.stringify({ allowed: false, message: e.message, status: e.status });
    });
  });
}, 600);
`, 16000);
      console.log("  " + JSON.stringify(r));
      check("a user is blocked from the admin API", r.allowed === false, JSON.stringify(r));
      check("with a 403", r.status === 403, String(r.status));
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
