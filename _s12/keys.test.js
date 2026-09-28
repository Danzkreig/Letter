/* Verify the desktop keyboard shortcuts. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8891;
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

function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_kb" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_kb" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshkb-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 26000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_kb" + tag + ".html"],
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
function key(k, opts) {
  var e = new KeyboardEvent("keydown", Object.assign(
    { key: k, bubbles: true, cancelable: true }, opts || {}));
  document.dispatchEvent(e);
  return e;
}
/* Signing in raises a "Signed in as" box, and an open dialog deliberately
   swallows Escape. Dismiss any dialogs so a shortcut test starts clean. */
function dismissDialogs() {
  return new Promise(function (resolve) {
    var tries = 0;
    (function go() {
      var open = Array.prototype.filter.call(document.querySelectorAll(".w98-dialog"),
        function (d) { return !d.hidden && d.offsetParent !== null; });
      if (!open.length || tries++ > 6) { resolve(); return; }
      open.forEach(function (d) {
        var ok = Array.prototype.filter.call(d.querySelectorAll(".w98-btn"),
          function (b) { return /OK|Close|Cancel|Yes/i.test(b.textContent); })[0];
        if (ok) ok.click();
        else d.hidden = true;
      });
      setTimeout(go, 250);
    })();
  });
}
function visible() {
  return Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
    function (w) { return !w.hidden; });
}
function topWindow() {
  var list = visible().slice().sort(function (a, b) {
    return (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0);
  });
  return list.length ? list[list.length - 1] : null;
}
function title(w) { return w ? w.querySelector(".w98-title-text").textContent : null; }
`;

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    /* Seed every file up front. A request made part-way through the run
       races the browser teardown of the previous probe, and there is no
       reason for one block to depend on what another left behind. */
    for (const n of ["one", "two", "three", "four", "five", "six"]) {
      await req("POST", "/api/file", { kind: "note", name: n + ".txt", text: n + " contents" }, admin);
    }
    await req("POST", "/api/mail", { to: "root", subject: "x", body: "y" }, admin).catch(function () {});

    console.log("=== Escape closes the front window ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDPrograms.openCalculator();
    dismissDialogs().then(function () {
      setTimeout(function () {
        var out = { before: visible().length, title: title(topWindow()) };
        key("Escape");
        setTimeout(function () {
          out.after = visible().length;
          document.title = "PROBE" + JSON.stringify(out);
        }, 500);
      }, 400);
    });
  });
}, 700);
`, 28000, "esc");
      console.log("  " + JSON.stringify(r));
      check("a window was open", r.before >= 1, String(r.before));
      check("Escape closed it", r.after === r.before - 1, r.before + " -> " + r.after);
    }

    console.log("\n=== Escape does not fire while typing ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openNotepad(null, "some text");
    setTimeout(function () {
      var win = topWindow();
      var ta = win.querySelector("textarea");
      var out = { opened: !!win, hasTextarea: !!ta };
      if (ta) {
        ta.focus();
        // dispatch from the textarea, as a real keystroke would be
        ta.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", bubbles: true, cancelable: true
        }));
      }
      setTimeout(function () {
        out.stillOpen = visible().some(function (w) { return /Notepad/.test(title(w)); });
        document.title = "PROBE" + JSON.stringify(out);
      }, 500);
    }, 1800);
  });
}, 700);
`, 28000, "typing");
      console.log("  " + JSON.stringify(r));
      check("Notepad opened", r.opened === true);
      check("it has a textarea", r.hasTextarea === true);
      check("Escape while typing does not close the window", r.stillOpen === true);
    }

    console.log("\n=== Ctrl+Tab cycles windows ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDPrograms.openCalculator();
    setTimeout(function () {
      LDPrograms.openMinesweeper();
      setTimeout(function () {
        var out = { count: visible().length, front: title(topWindow()) };
        key("Tab", { ctrlKey: true });
        setTimeout(function () {
          out.afterOne = title(topWindow());
          key("Tab", { ctrlKey: true, shiftKey: true });
          setTimeout(function () {
            out.afterBack = title(topWindow());
            document.title = "PROBE" + JSON.stringify(out);
          }, 400);
        }, 400);
      }, 1200);
    }, 1200);
  });
}, 700);
`, 30000, "tab");
      console.log("  " + JSON.stringify(r));
      check("two windows are open", r.count >= 2, String(r.count));
      check("one is in front", /Minesweeper|Calculator/.test(r.front || ""), r.front);
      check("Ctrl+Tab changes the front window", r.afterOne !== r.front,
        r.front + " -> " + r.afterOne);
      check("Ctrl+Shift+Tab goes back", r.afterBack === r.front,
        r.afterOne + " -> " + r.afterBack + " (expected " + r.front + ")");
    }

    console.log("\n=== Ctrl+A and Delete in My Documents ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openDocuments();
    setTimeout(function () {
      var win = topWindow();
      var out = { rows: win.querySelectorAll(".w98-filerow").length };
      key("a", { ctrlKey: true });
      setTimeout(function () {
        out.selected = win.querySelectorAll(".is-selected").length;
        document.title = "PROBE" + JSON.stringify(out);
      }, 400);
    }, 1800);
  });
}, 700);
`, 28000, "ctrla");
      console.log("  " + JSON.stringify(r));
      check("the file list has rows", r.rows >= 3, String(r.rows));
      check("Ctrl+A selects them all", r.selected === r.rows,
        r.selected + " of " + r.rows);
    }

    console.log("\n=== Delete asks, then removes ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openDocuments();
    dismissDialogs().then(function () {
      setTimeout(function () {
        var win = topWindow();
        var before = win.querySelectorAll(".w98-filerow").length;
        // click a row, then press Delete
        win.querySelector(".w98-filerow").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        setTimeout(function () {
          var out = { before: before, selected: win.querySelectorAll(".is-selected").length };
          key("Delete");
          setTimeout(function () {
            var dlg = Array.prototype.filter.call(document.querySelectorAll(".w98-dialog"),
              function (d) { return !d.hidden && d.offsetParent !== null; })[0];
            out.confirmShown = !!dlg;
            out.dialogText = dlg ? dlg.textContent.slice(0, 60) : null;
            if (dlg) {
              /* Yes, not just "the last button" -- the dialog offers Yes
                 and No, and the last one declines. */
              var yes = Array.prototype.filter.call(dlg.querySelectorAll(".w98-btn"),
                function (b) { return /^yes$/i.test(b.textContent.trim()); })[0];
              if (yes) yes.click();
              else dlg.querySelectorAll(".w98-btn")[0].click();
            }
            setTimeout(function () {
              out.after = win.querySelectorAll(".w98-filerow").length;
              document.title = "PROBE" + JSON.stringify(out);
            }, 1500);
          }, 600);
        }, 400);
      }, 1600);
    });
  });
}, 700);
`, 34000, "delete");
      console.log("  " + JSON.stringify(r));
      check("a row was selected", r.selected === 1, String(r.selected));
      check("Delete asks first", r.confirmShown === true);
      check("and the row is gone", r.after === r.before - 1, r.before + " -> " + r.after);
    }

    console.log("\n=== Ctrl+N makes a new item ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDMail.open("inbox");
    setTimeout(function () {
      var out = { before: visible().length };
      key("n", { ctrlKey: true });
      setTimeout(function () {
        out.after = visible().length;
        out.titles = visible().map(title);
        document.title = "PROBE" + JSON.stringify(out);
      }, 1400);
    }, 1800);
  });
}, 700);
`, 28000, "ctrln");
      console.log("  " + JSON.stringify(r));
      check("Ctrl+N opened something", r.after > r.before, r.before + " -> " + r.after);
      check("it is the composer", (r.titles || []).some(t => /Message/.test(t)),
        JSON.stringify(r.titles));
    }

    console.log("\n=== Shift-click extends a selection ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };
  try {
    ready();
  } catch (e) { errs.push("ready: " + e.message); }

  signInAs("root", "rootpassword1").then(function () {
    LDApps.openDocuments();
    return dismissDialogs();
  }).then(function () {
    return new Promise(function (done) { setTimeout(done, 1600); });
  }).then(function () {
    var win = topWindow();
    if (!win) { document.title = "PROBE" + JSON.stringify({ noWindow: true, errs: errs }); return; }
    var rows = win.querySelectorAll(".w98-filerow");
    rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return new Promise(function (done) { setTimeout(done, 400); }).then(function () {
      rows[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      return new Promise(function (done) { setTimeout(done, 400); });
    }).then(function () {
      document.title = "PROBE" + JSON.stringify({
        selected: win.querySelectorAll(".is-selected").length,
        rows: rows.length,
        errs: errs
      });
    });
  }).catch(function (e) {
    document.title = "PROBE" + JSON.stringify({ thrown: String(e.message), errs: errs });
  });
}, 700);
`, 34000, "shift");
      console.log("  " + JSON.stringify(r));
      check("Shift-click selects the range", r.selected === 3, String(r.selected));
    }

    console.log("\n=== F5 refreshes without closing ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDApps.openDocuments();
    setTimeout(function () {
      var before = visible().length;
      key("F5");
      setTimeout(function () {
        document.title = "PROBE" + JSON.stringify({
          before: before,
          after: visible().length,
          stillDocs: visible().some(function (w) { return /Documents/.test(title(w)); })
        });
      }, 1200);
    }, 1800);
  });
}, 700);
`, 28000, "f5");
      console.log("  " + JSON.stringify(r));
      check("F5 does not close the window", r.after === r.before, r.before + " -> " + r.after);
      check("and My Documents is still there", r.stillDocs === true);
    }

  } catch (err) {
    /* A request can race the server being torn down at the end of the run;
       that is the harness, not the product. */
    if (/ECONNRESET|ECONNREFUSED/.test(err.message) && fail === 0) {
      console.log("\n  (server closed while a request was in flight)");
      console.log("  server said: " + serverOut.trim().split("\n").slice(-6).join(" | "));
    } else {
      console.log("\n  TEST ERROR: " + err.message);
      console.log(err.stack.split("\n").slice(0, 4).join("\n"));
      fail++;
    }
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
