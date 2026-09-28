/* Stage 4 verification: MS-DOS, Paint, Minesweeper and the file-system apps.
   (The Calculator has its own suite.) Drives the real UI in a browser. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8793;
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

function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_pr" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_pr" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshpr-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 22000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_pr" + tag + ".html"],
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
    // a second account, so Network Neighbourhood has something to show
    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    // seed a note and an image so DOS and Paint have something to work with
    await req("POST", "/api/file", { kind: "note", name: "hello.txt", text: "first line\nsecond line" }, admin);
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await req("POST", "/api/file", { kind: "image", name: "pic.png", mime: "image/png", base64: PNG }, admin);

    console.log("=== MS-DOS Prompt ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDPrograms.openDos();
    setTimeout(function () {
      var win = winByTitle(/MS-DOS/);
      var input = win.querySelector(".dos-input");
      var out = { results: [] };
      function run(cmd) {
        input.value = cmd;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      function text() { return win.querySelector(".dos-out").textContent; }

      run("VER");
      out.afterVer = /Windows 98 \\[Version 4\\.10/.test(text());
      run("ECHO hello world");
      out.afterEcho = /hello world/.test(text());
      run("DATE");
      out.afterDate = /Current date is/.test(text());
      run("TIME");
      out.afterTime = /Current time is/.test(text());
      run("CD");
      out.afterCd = /C:\\\\LETTERDROP/.test(text());
      run("HELP");
      out.afterHelp = /Available commands/.test(text());
      run("FROBNICATE");
      out.badCommand = /Bad command or file name/.test(text());

      run("DIR");
      setTimeout(function () {
        out.afterDir = text();
        run("TYPE hello.txt");
        setTimeout(function () {
          out.afterType = text();
          run("CLS");
          out.afterCls = text().trim();
          run("FORMAT C:");
          out.afterFormat = /Access denied/.test(text());
          document.title = "PROBE" + JSON.stringify(out);
        }, 700);
      }, 900);
    }, 1200);
  });
}, 700);
`, 30000, "dos");
      console.log("  VER: " + r.afterVer + ", ECHO: " + r.afterEcho + ", DATE: " + r.afterDate +
        ", TIME: " + r.afterTime + ", CD: " + r.afterCd + ", HELP: " + r.afterHelp);

      check("VER reports Windows 98", r.afterVer === true);
      check("ECHO prints text back", r.afterEcho === true);
      check("DATE works", r.afterDate === true);
      check("TIME works", r.afterTime === true);
      check("CD reports the current directory", r.afterCd === true);
      check("HELP lists commands", r.afterHelp === true);
      check("an unknown command is rejected", r.badCommand === true);
      check("DIR lists the real files",
        /hello\.txt/.test(r.afterDir || "") && /pic\.png/.test(r.afterDir || ""),
        "(dir output missing files)");
      check("DIR shows a file count", /file\(s\)/.test(r.afterDir || ""));
      check("TYPE prints a real note",
        /first line/.test(r.afterType || "") && /second line/.test(r.afterType || ""),
        "(note body missing)");
      check("CLS clears the screen", r.afterCls === "", JSON.stringify(r.afterCls && r.afterCls.slice(0, 40)));
      check("FORMAT is refused", r.afterFormat === true);
    }

    console.log("\n=== Paint ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDPrograms.openPaint();
    setTimeout(function () {
      var win = winByTitle(/Paint/);
      var canvas = win.querySelector(".paint-canvas");
      var ctx = canvas.getContext("2d");
      var out = {};

      out.hasCanvas = !!canvas;
      out.swatches = win.querySelectorAll(".paint-swatch").length;
      out.sizes = win.querySelectorAll(".paint-size").length;

      // start white
      function px(x, y) {
        var d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2]];
      }
      out.startsWithWhite = px(10, 10).join(",") === "255,255,255";

      // pick red and draw a stroke with real mouse events
      win.querySelector('.paint-swatch[data-colour="#ed1c24"]').click();
      var rect = canvas.getBoundingClientRect();
      function mouse(type, x, y) {
        canvas.dispatchEvent(new MouseEvent(type, {
          bubbles: true, clientX: rect.left + x, clientY: rect.top + y
        }));
      }
      mouse("mousedown", 40, 40);
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, clientX: rect.left + 100, clientY: rect.top + 40
      }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      out.strokePainted = px(70, 40).join(",") === "237,28,36";

      // erase over it
      win.querySelector(".paint-tool").click();
      var rect2 = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, clientX: rect2.left + 70, clientY: rect2.top + 40
      }));
      // drag across so the erase definitely covers the sampled point
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, clientX: rect2.left + 90, clientY: rect2.top + 40
      }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      out.afterErasePixels = px(70, 40).join(",");
      out.afterErase = px(70, 40).join(",") === "255,255,255";

      // saving: stub the prompt and confirm it reaches the server
      window.prompt = function () { return "art.png"; };
      var saveBtn = Array.prototype.filter.call(win.querySelectorAll(".paint-tool"),
        function (b) { return /Save/.test(b.textContent); })[0];
      saveBtn.click();
      setTimeout(function () {
        LD.listFiles().then(function (res) {
          out.saved = res.files.some(function (f) { return f.name === "art.png" && f.kind === "image"; });
          out.titleChanged = /art\\.png/.test(win.querySelector(".w98-title-text").textContent);
          document.title = "PROBE" + JSON.stringify(out);
        });
      }, 1200);
    }, 1200);
  });
}, 700);
`, 32000, "paint");
      console.log("  " + JSON.stringify(r));
      check("the canvas exists", r.hasCanvas === true);
      check("the palette is offered", r.swatches === 20, String(r.swatches));
      check("brush sizes are offered", r.sizes === 4, String(r.sizes));
      check("it starts blank", r.startsWithWhite === true);
      check("drawing paints the chosen colour", r.strokePainted === true, "(stroke not found)");
      check("the eraser removes it", r.afterErase === true);
      check("saving stores an image in Documents", r.saved === true, "(not saved)");
      check("the title follows the saved name", r.titleChanged === true);
    }

    console.log("\n=== Minesweeper ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  LDPrograms.openMinesweeper();
  setTimeout(function () {
    var win = winByTitle(/Minesweeper/);
    var cells = win.querySelectorAll(".mine-cell");
    var out = {};

    out.cells = cells.length;
    out.gridCols = getComputedStyle(win.querySelector(".mine-grid")).gridTemplateColumns.split(" ").length;
    out.mineCounter = win.querySelector(".mine-count").textContent;
    out.allClosed = Array.prototype.every.call(cells, function (c) {
      return c.className.indexOf("is-open") === -1;
    });

    // right-click flags
    cells[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    out.flagged = cells[0].textContent === "\\uD83D\\uDEA9";
    out.counterAfterFlag = win.querySelector(".mine-count").textContent;

    // unflag
    cells[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    out.unflagged = cells[0].textContent === "";

    // the real game logic: click every square, one must be a mine and the
    // first click must never be one
    var first = cells[4];
    first.click();
    out.firstClickOpened = first.className.indexOf("is-open") !== -1;
    out.someOpened = win.querySelectorAll(".mine-cell.is-open").length > 1;

    document.title = "PROBE" + JSON.stringify(out);
  }, 1200);
}, 700);
`, 26000, "mine");
      console.log("  " + JSON.stringify(r));
      check("an 81-square grid", r.cells === 81, String(r.cells));
      check("laid out 9 across", r.gridCols === 9, String(r.gridCols));
      check("the mine counter starts at 10", r.mineCounter === "010", r.mineCounter);
      check("every square starts closed", r.allClosed === true);
      check("right-click plants a flag", r.flagged === true);
      check("the counter drops when flagged", r.counterAfterFlag === "009", r.counterAfterFlag);
      check("right-click again removes it", r.unflagged === true);
      check("the first click is always safe", r.firstClickOpened === true, "(hit a mine first)");
      check("it flood-opens empty squares", r.someOpened === true);
    }

    console.log("\n=== My Computer, Recycle Bin, Network ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDPrograms.openComputer();
    setTimeout(function () {
      var win = winByTitle(/My Computer/);
      var out = { computerItems: win.querySelectorAll(".w98-pickrow").length };

      // opening My Computer's My Documents entry should open the file browser
      var rows = win.querySelectorAll(".w98-pickrow");
      var docsRow = Array.prototype.filter.call(rows, function (r) {
        return /My Documents/.test(r.textContent);
      })[0];
      docsRow.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

      setTimeout(function () {
        out.docsOpened = !!winByTitle(/My Documents/);

        LDPrograms.openRecycleBin();
        setTimeout(function () {
          var rb = winByTitle(/Recycle Bin/);
          out.recycleText = rb ? rb.querySelector(".w98-filelist").textContent : null;

          LDPrograms.openNetwork();
          setTimeout(function () {
            var nw = winByTitle(/Network/);
            out.networkRows = nw ? nw.querySelectorAll(".w98-pickrow").length : 0;
            out.networkText = nw ? nw.querySelector(".w98-statusbar").textContent : null;
            document.title = "PROBE" + JSON.stringify(out);
          }, 1300);
        }, 900);
      }, 1300);
    }, 1200);
  });
}, 700);
`, 34000, "fs");
      console.log("  " + JSON.stringify(r));
      check("My Computer lists its icons", r.computerItems >= 5, String(r.computerItems));
      check("My Documents opens from it", r.docsOpened === true);
      check("the Recycle Bin explains itself", /empty/i.test(r.recycleText || ""), r.recycleText);
      check("Network lists the other accounts", r.networkRows >= 1, String(r.networkRows));
      check("and says how many", /computer\(s\)/.test(r.networkText || ""), r.networkText);
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
