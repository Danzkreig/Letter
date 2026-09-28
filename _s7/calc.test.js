/* Verify the calculator's arithmetic by driving the real window in a browser. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8791;
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
  const p = path.join(DIR, "_probe_p" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_p" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshp-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 20000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_p" + tag + ".html"],
      { stdio: ["ignore", fd, "ignore"] });
} finally {
  dropProfile(__profile);
}
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
}

/* Drive the calculator the way a person would: click the buttons. */
const calcProbe = (steps) => `
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
  LDPrograms.openCalculator();
  setTimeout(function () {
    var win = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
      function (w) { return !w.hidden; })[0];
    var out = {};
    var seq = ${JSON.stringify(steps)};
    function press(k) {
      var b = win.querySelector('.calc-btn[data-key="' + k + '"]');
      if (!b) throw new Error("no button " + k);
      b.click();
    }
    function screenText() {
      var s = win.querySelector(".calc-screen");
      return s ? s.textContent : null;
    }
    out.results = [];
    seq.forEach(function (group) {
      group.forEach(function (k) { press(k); });
      out.results.push(screenText());
    });
    out.buttons = win.querySelectorAll(".calc-btn").length;
    out.title = win.querySelector(".w98-title-text").textContent;
    document.title = "PROBE" + JSON.stringify(out);
  }, 1200);
}, 700);
`;

(async function run() {
  try {
    await waitForServer();

    console.log("=== calculator ===");
    {
      const r = inBrowser(calcProbe([
        ["1", "2", "+", "3", "="],          // 15
        ["C", "9", "-", "4", "="],          // 5
        ["C", "6", "*", "7", "="],          // 42
        ["C", "8", "/", "2", "="],          // 4
        ["C", "5", ".", "5", "+", "1", "="],// 6.5
        ["C", "2", "+", "3", "*", "4", "="],// 20 (left to right, like a simple calculator)
        ["C", "7", "sqrt"],                 // ~2.645...
        ["C", "9", "/", "0", "="],          // divide by zero
        ["C", "5", "+/-"],                  // -5
        ["C", "1", "2", "3", "Back"],       // 12
        ["C", "4", "MS", "C", "MR"]         // memory recall
      ]), 26000, "calc");
      console.log("  title: " + r.title + ", buttons: " + r.buttons);
      console.log("  sequence results: " + JSON.stringify(r.results));

      const g = r.results;
      check("the window is a Calculator", r.title === "Calculator", r.title);
      check("it has the full keypad", r.buttons === 24, String(r.buttons));
      check("12 + 3 = 15", g[0] === "15", g[0]);
      check("9 - 4 = 5", g[1] === "5", g[1]);
      check("6 * 7 = 42", g[2] === "42", g[2]);
      check("8 / 2 = 4", g[3] === "4", g[3]);
      check("5.5 + 1 = 6.5", g[4] === "6.5", g[4]);
      check("2 + 3 * 4 = 20 (sequential, as a basic calculator does)", g[5] === "20", g[5]);
      check("sqrt(7) shows a rounded value, not an exponent", /^2\.64575/.test(g[6]), g[6]);
      check("and it is not in exponential notation", g[6].indexOf("e") === -1, g[6]);
      check("dividing by zero is refused", /Cannot divide by zero/.test(g[7]), g[7]);
      check("+/- negates", g[8] === "-5", g[8]);
      check("Backspace trims a digit", g[9] === "12", g[9]);
      check("memory recall works", g[10] === "4", g[10]);
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
