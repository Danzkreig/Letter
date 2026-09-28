/* Verify window resizing in a real browser. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8811;
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

function waitForServer() {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function go() {
      n++;
      const r = http.request(BASE + "/api/me", function (res) { res.resume(); resolve(); });
      r.on("error", function () { n > 100 ? reject(new Error("no start")) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_rz" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_rz" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshrz-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 20000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_rz" + tag + ".html"],
      { stdio: ["ignore", fd, "ignore"] });
} finally {
  dropProfile(__profile);
}
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
}

(async function run() {
  try {
    await waitForServer();

    const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
  LDPrograms.openCalculator();
  setTimeout(function () {
    var win = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
      function (w) { return !w.hidden; })[0];
    var out = {};

    out.grips = win.querySelectorAll(".w98-grip").length;
    out.dirs = Array.prototype.map.call(win.querySelectorAll(".w98-grip"),
      function (g) { return g.dataset.dir; });

    var startW = win.offsetWidth, startH = win.offsetHeight;
    var startL = win.offsetLeft, startT = win.offsetTop;
    out.start = [startW, startH];

    function drag(dir, dx, dy) {
      var grip = win.querySelector('.w98-grip[data-dir="' + dir + '"]');
      var r = grip.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      grip.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
      window.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, clientX: x + dx, clientY: y + dy
      }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x + dx, clientY: y + dy }));
    }

    // grow from the south-east corner
    drag("se", 120, 80);
    out.afterSE = [win.offsetWidth, win.offsetHeight];
    out.grewW = win.offsetWidth > startW;
    out.grewH = win.offsetHeight > startH;
    out.originHeld = win.offsetLeft === startL && win.offsetTop === startT;

    // shrink back from the south-east
    drag("se", -60, -40);
    out.afterShrink = [win.offsetWidth, win.offsetHeight];

    // the east edge only changes width
    var w1 = win.offsetWidth, h1 = win.offsetHeight;
    drag("e", 40, 0);
    out.eastOnlyW = win.offsetWidth > w1;
    out.eastKeptH = win.offsetHeight === h1;

    // dragging the north edge moves the top while the bottom stays put
    var bottomBefore = win.offsetTop + win.offsetHeight;
    drag("n", 0, 30);
    out.northMovedTop = win.offsetTop > startT;
    out.northHeldBottom = Math.abs((win.offsetTop + win.offsetHeight) - bottomBefore) <= 2;

    // it refuses to go below a usable size
    drag("se", -4000, -4000);
    out.minW = win.offsetWidth;
    out.minH = win.offsetHeight;
    out.respectsMin = win.offsetWidth >= 200 && win.offsetHeight >= 140;

    // and cannot be dragged off the top-left
    drag("nw", 5000, 5000);
    out.afterNW = [win.offsetLeft, win.offsetTop, win.offsetWidth, win.offsetHeight];
    out.notOffscreen = win.offsetLeft >= 0 && win.offsetTop >= 0;

    // the buttons still work after all that resizing
    var screen = win.querySelector(".calc-screen");
    win.querySelector('.calc-btn[data-key="7"]').click();
    win.querySelector('.calc-btn[data-key="+"]').click();
    win.querySelector('.calc-btn[data-key="3"]').click();
    win.querySelector('.calc-btn[data-key="="]').click();
    out.stillWorks = screen.textContent === "10";

    document.title = "PROBE" + JSON.stringify(out);
  }, 1200);
}, 700);
`, 26000, "win");

    console.log("  " + JSON.stringify(r));
    check("eight resize grips", r.grips === 8, String(r.grips));
    check("all four sides and corners are present",
      ["n", "s", "e", "w", "ne", "nw", "se", "sw"].every(d => (r.dirs || []).indexOf(d) !== -1),
      JSON.stringify(r.dirs));
    check("dragging the SE corner widens the window", r.grewW === true);
    check("and makes it taller", r.grewH === true);
    check("without moving the top-left", r.originHeld === true);
    check("dragging back shrinks it", r.afterShrink[0] < r.afterSE[0], JSON.stringify(r.afterShrink));
    check("the east edge changes width only", r.eastOnlyW === true && r.eastKeptH === true,
      JSON.stringify([r.eastOnlyW, r.eastKeptH]));
    check("the north edge moves the top", r.northMovedTop === true);
    check("and leaves the bottom edge in place", r.northHeldBottom === true);
    check("there is a sensible minimum size", r.respectsMin === true,
      JSON.stringify([r.minW, r.minH]));
    check("it cannot be dragged off the top-left", r.notOffscreen === true,
      JSON.stringify(r.afterNW));
    check("the program inside still works after resizing", r.stillWorks === true);

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
