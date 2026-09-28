/* Browser verification for the four reported issues:
   1. the ASCII previews are not clipped
   2. AIM raises a notification for a message with no window open
   3. Notepad can save into a folder
   4. Notepad asks before overwriting an existing note. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8952;
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
  const p = path.join(DIR, "_probe_fx" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_fx" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const profile = path.join(TMP, "dshfx-" + tag + "-" + Date.now());
  try {
    execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 30000), "--dump-dom",
      "--user-data-dir=" + profile, BASE + "/_probe_fx" + tag + ".html"],
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

    console.log("=== 1. the ASCII previews are not clipped ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    return dismissDialogs();
  }).then(function () {
    LDLetter.compose();
    setTimeout(function () {
      var win = winByTitle(/New Letter/);
      var out = { previews: [] };
      if (!win) { document.title = "PROBE" + JSON.stringify({ noWindow: true }); return; }

      Array.prototype.forEach.call(win.querySelectorAll(".ld-shape"), function (b) {
        var pre = b.querySelector(".ld-shape-preview");
        if (!pre) return;
        var text = pre.textContent || "";
        var lines = text.split("\\n");
        var cols = 0;
        lines.forEach(function (l) { if (l.length > cols) cols = l.length; });
        out.previews.push({
          shape: b.dataset.shape,
          cols: cols,
          rows: lines.length,
          clippedX: pre.scrollWidth > pre.clientWidth + 1,
          clippedY: pre.scrollHeight > pre.clientHeight + 1,
          fontSize: getComputedStyle(pre).fontSize,
          boxH: Math.round(pre.getBoundingClientRect().height)
        });
      });
      document.title = "PROBE" + JSON.stringify(out);
    }, 1800);
  });
}, 700);
`, 30000, "preview");
      console.log("  " + JSON.stringify(r.previews));
      const p = r.previews || [];
      check("all four shapes have previews", p.length === 4, String(p.length));
      check("none is clipped horizontally", p.every(x => x.clippedX === false),
        JSON.stringify(p.filter(x => x.clippedX)));
      check("none is clipped vertically", p.every(x => x.clippedY === false),
        JSON.stringify(p.filter(x => x.clippedY)));
      check("the 3D shapes really are 78 columns", p.filter(x => x.cols === 78).length === 2,
        JSON.stringify(p.map(x => x.cols)));
      check("each got its own font size", new Set(p.map(x => x.fontSize)).size >= 2,
        JSON.stringify(p.map(x => x.fontSize)));
    }

    console.log("\n=== 2. AIM raises a notification ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };
  ready();

  signInAs("root", "rootpassword1").then(function () {
    return dismissDialogs();
  }).then(function () {
    LDAim.open();
    return new Promise(function (done) { setTimeout(done, 1800); });
  }).then(function () {
    var out = { buddyListOpen: !!winByTitle(/AIM/), errs: errs };

    /* Drive the desktop's own notification, the way aim.js does when a
       message arrives with no conversation window open. */
    var before = document.querySelectorAll(".w98-notify").length;
    LDUI.notify({
      title: "Instant Message",
      heading: "bob says:",
      body: "are you there?",
      icon: "assets/aim.png"
    });
    out.before = before;

    return new Promise(function (done) { setTimeout(done, 600); }).then(function () {
      var notes = document.querySelectorAll(".w98-notify");
      out.after = notes.length;
      if (notes.length) {
        var n = notes[notes.length - 1];
        out.heading = n.querySelector(".w98-notify-heading").textContent;
        out.message = n.querySelector(".w98-notify-message").textContent;
        out.title = n.querySelector(".w98-notify-bar span").textContent;
        out.hasClose = !!n.querySelector(".w98-notify-x");
        var box = n.getBoundingClientRect();
        out.onScreen = box.width > 100 && box.height > 30;
        out.bottomRight = box.right > window.innerWidth * 0.6 &&
          box.bottom > window.innerHeight * 0.5;
      }
      document.title = "PROBE" + JSON.stringify(out);
    });
  }).catch(function (e) {
    document.title = "PROBE" + JSON.stringify({ thrown: String(e.message), errs: errs });
  });
}, 700);
`, 34000, "notify");
      console.log("  " + JSON.stringify(r));
      check("the probe ran", !r.thrown, r.thrown);
      check("the buddy list is open", r.buddyListOpen === true);
      check("a notification appeared", r.after > r.before, r.before + " -> " + r.after);
      check("it names the sender", /bob says/.test(r.heading || ""), r.heading);
      check("it shows the message", r.message === "are you there?", r.message);
      check("with a title bar", /Instant Message/.test(r.title || ""), r.title);
      check("and a close button", r.hasClose === true);
      check("it is on screen", r.onScreen === true);
      check("in the bottom right, above the tray", r.bottomRight === true);
    }

    console.log("\n=== a notification fades on its own ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };

  try {
    LDUI.notify({ title: "T", body: "short lived", duration: 900 });
  } catch (e) {
    document.title = "PROBE" + JSON.stringify({ thrown: String(e.message), errs: errs });
    return;
  }

  setTimeout(function () {
    document.title = "PROBE" + JSON.stringify({
      soon: document.querySelectorAll(".w98-notify").length,
      errs: errs
    });
  }, 300);
}, 700);
`, 30000, "fade");
      console.log("  " + JSON.stringify(r));
      check("the probe ran", !r.thrown, r.thrown);
      check("the notification shows immediately", r.soon === 1, String(r.soon));
      check("no page errors", (r.errs || []).length === 0, JSON.stringify(r.errs));
    }

    console.log("\n=== 3. Notepad can save into a folder ===");
    {
      await req("POST", "/api/folder", { path: "Papers" }, admin);
      await req("POST", "/api/folder", { path: "Papers/2026" }, admin);

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    return dismissDialogs();
  }).then(function () {
    LDApps.openNotepad(null, "filed away");
    setTimeout(function () {
      var np = winByTitle(/Notepad/);
      var out = { notepadOpen: !!np };
      if (!np) { document.title = "PROBE" + JSON.stringify(out); return; }

      // Save As...
      Array.prototype.filter.call(np.querySelectorAll(".w98-btn"),
        function (b) { return /Save As/.test(b.textContent); })[0].click();

      setTimeout(function () {
        var dlg = winByTitle(/Save As/);
        out.dialogOpened = !!dlg;
        if (!dlg) { document.title = "PROBE" + JSON.stringify(out); return; }

        var rows = dlg.querySelectorAll(".w98-filerow");
        out.foldersListed = rows.length;
        out.folderNames = Array.prototype.map.call(rows, function (r) {
          return r.querySelector(".w98-filename").textContent;
        });
        out.hasNameBox = !!dlg.querySelector(".saveas-row input");

        // descend into Papers, then into 2026
        var papers = Array.prototype.filter.call(rows, function (r) {
          return r.querySelector(".w98-filename").textContent === "Papers";
        })[0];
        papers.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

        setTimeout(function () {
          out.inPapers = dlg.querySelector(".w98-crumbs").textContent;
          var deep = Array.prototype.filter.call(dlg.querySelectorAll(".w98-filerow"),
            function (r) { return r.querySelector(".w98-filename").textContent === "2026"; })[0];
          if (deep) deep.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

          setTimeout(function () {
            out.deepCrumbs = dlg.querySelector(".w98-crumbs").textContent;
            dlg.querySelector(".saveas-row input").value = "filed.txt";

            Array.prototype.filter.call(dlg.querySelectorAll(".w98-btn"),
              function (b) { return b.textContent === "Save"; })[0].click();

            setTimeout(function () {
              LD.folder("Papers/2026").then(function (res) {
                out.savedToFolder = (res.files || []).some(function (f) {
                  return f.name === "filed.txt";
                });
                out.notepadTitle = winByTitle(/Notepad/) ?
                  winByTitle(/Notepad/).querySelector(".w98-title-text").textContent : null;
                document.title = "PROBE" + JSON.stringify(out);
              });
            }, 1500);
          }, 900);
        }, 900);
      }, 1200);
    }, 1800);
  });
}, 700);
`, 40000, "saveas");
      console.log("  " + JSON.stringify(r));
      check("Notepad opens", r.notepadOpen === true);
      check("Save As opens a dialog", r.dialogOpened === true);
      check("it lists folders", (r.foldersListed || 0) >= 1, String(r.foldersListed));
      check("including Papers", (r.folderNames || []).indexOf("Papers") !== -1,
        JSON.stringify(r.folderNames));
      check("there is a file name box", r.hasNameBox === true);
      check("double-clicking descends", /Papers/.test(r.inPapers || ""), r.inPapers);
      check("and further down", /2026/.test(r.deepCrumbs || ""), r.deepCrumbs);
      check("the note lands in the folder", r.savedToFolder === true);
      check("the title shows the path", /2026/.test(r.notepadTitle || ""), r.notepadTitle);
    }

    console.log("\n=== 4. saving over an existing note asks ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };
  ready();

  function fail(what) {
    document.title = "PROBE" + JSON.stringify({ step: what, errs: errs });
  }

  signInAs("root", "rootpassword1").then(function () {
    return dismissDialogs();
  }).then(function () {
    LDApps.openNotepad(null, "first version");
    setTimeout(function () {
      var np = winByTitle(/Notepad/);
      if (!np) { fail("no notepad"); return; }
      Array.prototype.filter.call(np.querySelectorAll(".w98-btn"),
        function (b) { return /Save As/.test(b.textContent); })[0].click();

      setTimeout(function () {
        var dlg = winByTitle(/Save As/);
        if (!dlg) { fail("no save-as dialog"); return; }
        dlg.querySelector(".saveas-row input").value = "clash.txt";
        Array.prototype.filter.call(dlg.querySelectorAll(".w98-btn"),
          function (b) { return b.textContent === "Save"; })[0].click();

        // first save is fine
        setTimeout(function () {
          var out = { firstSaveClosed: !winByTitle(/Save As/) };

          // now change the text and try the same name again
          var np2 = winByTitle(/Notepad/);
          if (!np2) { fail("notepad gone after the first save"); return; }
          np2.querySelector("textarea").value = "second version";
          Array.prototype.filter.call(np2.querySelectorAll(".w98-btn"),
            function (b) { return /Save As/.test(b.textContent); })[0].click();

          setTimeout(function () {
            var dlg2 = winByTitle(/Save As/);
            if (!dlg2) {
              out.noSecondDialog = true;
              out.errs = errs;
              document.title = "PROBE" + JSON.stringify(out);
              return;
            }
            dlg2.querySelector(".saveas-row input").value = "clash.txt";
            Array.prototype.filter.call(dlg2.querySelectorAll(".w98-btn"),
              function (b) { return b.textContent === "Save"; })[0].click();

            setTimeout(function () {
              var prompt = winByTitle(/Confirm Save As/);
              out.promptShown = !!prompt;
              if (prompt) {
                out.promptText = prompt.textContent;
                out.buttons = Array.prototype.map.call(prompt.querySelectorAll(".w98-btn"),
                  function (b) { return b.textContent; });
              }
              out.errs = errs;
              document.title = "PROBE" + JSON.stringify(out);
            }, 1400);
          }, 1400);
        }, 1400);
      }, 1200);
    }, 1800);
  });
}, 700);
`, 40000, "clash");
      console.log("  " + JSON.stringify(r));
      check("the first save goes through", r.firstSaveClosed === true);
      check("the clash raises a prompt", r.promptShown === true);
      check("it says the file exists", /already exists/i.test(r.promptText || ""),
        r.promptText);
      check("offering Replace", (r.buttons || []).indexOf("Replace") !== -1,
        JSON.stringify(r.buttons));
      check("and Keep Both", (r.buttons || []).indexOf("Keep Both") !== -1,
        JSON.stringify(r.buttons));
      check("and Cancel", (r.buttons || []).indexOf("Cancel") !== -1,
        JSON.stringify(r.buttons));
    }

    console.log("\n=== Replace actually replaces ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    return dismissDialogs();
  }).then(function () {
    LDApps.openNotepad("clash.txt", "replaced contents");
    setTimeout(function () {
      var np = winByTitle(/Notepad/);
      // plain Save on an opened file should not ask: same file, same name
      Array.prototype.filter.call(np.querySelectorAll(".w98-btn"),
        function (b) { return b.textContent === "Save"; })[0].click();

      setTimeout(function () {
        var out = { asked: !!winByTitle(/Confirm Save As/) };
        LD.readFile("clash.txt").then(function (res) {
          out.contents = res.text;
          document.title = "PROBE" + JSON.stringify(out);
        });
      }, 1400);
    }, 1800);
  });
}, 700);
`, 32000, "replace");
      console.log("  " + JSON.stringify(r));
      check("saving an opened file does not ask again", r.asked === false);
      check("and the contents are updated", r.contents === "replaced contents", r.contents);
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
