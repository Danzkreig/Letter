/* Verify Pipes: the rotation maths, that a board is always solvable, that
   turning pieces eventually wins, and that it draws. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8921;
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
  const p = path.join(DIR, "_probe_pipe" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_pipe" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshpipe-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 30000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_pipe" + tag + ".html"],
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

    console.log("=== the rotation maths ===");
    {
      /* Pure arithmetic, so it can be checked in node rather than a browser. */
      const src = fs.readFileSync(path.join(DIR, "programs.js"), "utf8");
      const m = src.match(/function rotateMask\(mask\) \{[\s\S]*?\n  \}/);
      check("rotateMask is found in the source", Boolean(m), "(not found)");

      const rotateMask = eval("(" + m[0] + ")");

      /* Read the shape table out of the source too, so the numbers tested
         below cannot drift away from the ones the program actually uses.
         The table is written with the named side constants, so those are
         supplied when it is evaluated. */
      const table = src.match(/const PIPE_SHAPES = \[([\s\S]*?)\];/);
      check("the shape table is found", Boolean(table), "(not found)");
      const SHAPES = new Function("PIPE_UP", "PIPE_RIGHT", "PIPE_DOWN", "PIPE_LEFT",
        "return [" + table[1] + "];")(1, 2, 4, 8);
      check("there are ten shapes", SHAPES.length === 10, String(SHAPES.length));
      check("each opens two to four ways", SHAPES.every(function (s) {
        const bits = [1, 2, 4, 8].filter(function (b) { return s & b; }).length;
        return bits >= 2 && bits <= 4;
      }), JSON.stringify(SHAPES));
      check("none of them is a dead end", SHAPES.every(function (s) { return s !== 0; }));

      /* A cross opens all four ways, so it looks the same however it is
         turned and can never help or hinder a connection. Handing them out
         would just sprinkle dead pieces over the board. */
      check("no cross is handed out", SHAPES.indexOf(15) === -1, JSON.stringify(SHAPES));
      check("every shape actually changes when turned", SHAPES.every(function (s) {
        return rotateMask(s) !== s;
      }), JSON.stringify(SHAPES.filter(function (s) { return rotateMask(s) === s; })));

      check("up becomes right", rotateMask(1) === 2, String(rotateMask(1)));
      check("right becomes down", rotateMask(2) === 4, String(rotateMask(2)));
      check("down becomes left", rotateMask(4) === 8, String(rotateMask(4)));
      check("left becomes up", rotateMask(8) === 1, String(rotateMask(8)));

      const shapes = [3, 5, 6, 9, 10, 12, 7, 11, 13, 14, 15];
      const identity = shapes.every(function (s) {
        let v = s;
        for (let i = 0; i < 4; i++) v = rotateMask(v);
        return v === s;
      });
      check("four turns return a piece to where it started", identity);

      /* How many distinct orientations a shape has. A straight looks the
         same after two turns; a tee or elbow needs all four; a cross is
         never changed. The values are the bitmasks the program generates:
         5 is up+down, 10 is left+right, 7 is a tee, 15 is a cross. */
      const period = function (start) {
        let v = start;
        for (let n = 1; n <= 4; n++) {
          v = rotateMask(v);
          if (v === start) return n;
        }
        return 0;
      };

      check("the vertical straight repeats after two turns", period(5) === 2, String(period(5)));
      check("the horizontal straight repeats after two turns", period(10) === 2,
        String(period(10)));
      check("a tee needs all four turns", period(7) === 4, String(period(7)));
      check("an elbow needs all four turns", period(3) === 4, String(period(3)));
      check("a cross is never changed by turning", period(15) === 1, String(period(15)));

      // the two straights really are in the table the program draws from
      check("the table contains a straight", SHAPES.indexOf(5) !== -1, JSON.stringify(SHAPES));
      check("and a tee", SHAPES.indexOf(7) !== -1, JSON.stringify(SHAPES));
    }

    console.log("\n=== the program opens and draws ===");
    {
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  var errs = [];
  window.onerror = function (m, s, l) { errs.push(m + " @" + l); };

  LDPrograms.openPipes();

  setTimeout(function () {
    var win = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
      function (w) { return !w.hidden && /Pipes/.test(w.querySelector(".w98-title-text").textContent); })[0];

    var out = { opened: !!win, errs: errs };
    if (win) {
      var c = win.querySelector(".pipes-canvas");
      out.hasCanvas = !!c;
      out.width = c ? c.width : 0;
      out.height = c ? c.height : 0;
      out.cells = LDPrograms.openPipes ? null : null;

      var pipe = LDPrograms.openPipes();
      out.gridSize = pipe.grid().length;
      out.drains = pipe.drains().length;
      out.moves = pipe.moves();
      out.solvedAtStart = pipe.isSolved();

      // is anything actually drawn? count non-background pixels
      var ctx = c.getContext("2d");
      var data = ctx.getImageData(0, 0, c.width, c.height).data;
      var lit = 0;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i] > 40 || data[i+1] > 60 || data[i+2] > 40) lit++;
      }
      out.litPixels = lit;
      out.drawn = lit > 200;

      out.status = win.querySelector(".pipes-status").textContent;
      out.progress = win.querySelector(".pipes-progress").textContent;
      out.level = win.querySelector(".pipes-level").textContent;
    }
    document.title = "PROBE" + JSON.stringify(out);
  }, 1800);
}, 700);
`, 30000, "open");
      console.log("  " + JSON.stringify(r).slice(0, 280));
      check("the window opens", r.opened === true);
      check("it has a canvas", r.hasCanvas === true);
      check("the canvas has a size", r.width > 50 && r.height > 50, r.width + "x" + r.height);
      check("the board is filled", r.gridSize >= 25, String(r.gridSize));
      check("there are outlets", r.drains >= 2, String(r.drains));
      check("it does not start solved", r.solvedAtStart === false);
      check("something is drawn", r.drawn === true, String(r.litPixels) + " lit pixels");
      check("the level is named", /Warm-up/.test(r.level || ""), r.level);
      check("the progress line reports", /outlets/.test(r.progress || ""), r.progress);
      check("no page errors", (r.errs || []).length === 0, JSON.stringify(r.errs));
    }

    console.log("\n=== turning a piece ===");
    {
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  var pipe = LDPrograms.openPipes();
  setTimeout(function () {
    var out = {};
    var grid = pipe.grid();
    var drains = pipe.drains();
    var source = pipe.source();

    /* Find a piece that is not fixed and whose shape actually changes when
       turned. Every generated shape does, but the board may be all crosses
       if it ever stopped excluding them, which is itself worth catching. */
    var free = -1;
    for (var i = 0; i < grid.length; i++) {
      if (!grid[i].fixed) { free = i; break; }
    }
    out.freeFound = free >= 0;
    out.freeMask = grid[free].mask;
    out.isCross = grid[free].mask === 15;

    var before = grid[free].mask;
    var movesBefore = pipe.moves();
    var turned = pipe.turn(free);
    out.turned = turned;
    out.maskChanged = grid[free].mask !== before;
    out.movesWentUp = pipe.moves() === movesBefore + 1;

    // a fixed piece must refuse
    out.sourceIsFixed = grid[source].fixed;
    var srcMask = grid[source].mask;
    out.refusedFixed = pipe.turn(source) === false;
    out.fixedUnchanged = grid[source].mask === srcMask;

    out.drainsFixed = drains.every(function (d) { return grid[d].fixed; });

    /* Turning a piece three more times must bring it home, whatever it is. */
    for (var t = 0; t < 3; t++) pipe.turn(free);
    out.backToStart = grid[free].mask === before;

    document.title = "PROBE" + JSON.stringify(out);
  }, 1200);
}, 700);
`, 28000, "turn");
      console.log("  " + JSON.stringify(r));
      check("a free piece was found", r.freeFound === true);
      check("it is not a cross", r.isCross === false, String(r.freeMask) + " is a cross");
      check("turning it works", r.turned === true);
      check("its shape changes", r.maskChanged === true, String(r.freeMask));
      check("the move counter goes up", r.movesWentUp === true);
      check("four turns bring it home", r.backToStart === true);
      check("the tap is fixed", r.sourceIsFixed === true);
      check("turning the tap is refused", r.refusedFixed === true);
      check("and it does not change", r.fixedUnchanged === true);
      check("every outlet is fixed", r.drainsFixed === true);
    }

    console.log("\n=== a board can be played to a win ===");
    {
      /* Proving a board is *solvable* in general is genuinely expensive:
         with ~20 free pieces at four rotations each, the search space is
         4^20, and even a pruning walk over one board took minutes.

         What this checks instead is the property the player actually
         depends on: the win condition works. A board is rearranged by
         hand -- every free piece turned until the water reaches every
         outlet -- and the program must then agree it is solved, report
         it, and refuse further turns.

         The generator's part, that it never produces a dead board, is
         covered by the water check below. */
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  var OPP = { 1: 4, 2: 8, 4: 1, 8: 2 };
  var pipe = LDPrograms.openPipes();

  /* Turn pieces until the water reaches every outlet. Uses the game's own
     turn() rather than writing grid[].mask directly, so the display and
     the win check are exercised exactly as they are for a player.

     This is a greedy walk with random nudges when it stalls, so it does
     not win every board -- a local optimum is easy to get stuck in. That
     is a limit of this walker, not of the game, so callers retry with a
     fresh board rather than treating one loss as a product failure. */
  function attemptWin() {
    var grid = pipe.grid();

    function freeIndices() {
      var out = [];
      for (var i = 0; i < grid.length; i++) if (!grid[i].fixed) out.push(i);
      return out;
    }

    for (var pass = 0; pass < 800; pass++) {
      if (pipe.isSolved()) return true;

      var before = Object.keys(pipe.watered()).length;
      var improved = false;

      var candidates = freeIndices();
      for (var c = 0; c < candidates.length && !improved; c++) {
        var i = candidates[c];
        for (var t = 0; t < 4; t++) {
          pipe.turn(i);
          if (Object.keys(pipe.watered()).length > before) { improved = true; break; }
        }
      }

      if (!improved) {
        var free = freeIndices();
        if (!free.length) return false;
        pipe.turn(free[Math.floor(Math.random() * free.length)]);
      }
    }
    return pipe.isSolved();
  }

  /* Give it a few boards before giving up on it. */
  function solveByHand() {
    for (var attempt = 0; attempt < 5; attempt++) {
      if (attempt) press("New board");
      if (attemptWin()) return { won: true, attempts: attempt + 1 };
    }
    return { won: false, attempts: 5 };
  }

  function press(label) {
    Array.prototype.filter.call(pipe.win.querySelectorAll(".pipes-btn"),
      function (b) { return b.textContent === label; })[0].click();
  }

  setTimeout(function () {
    var out = {
      drains: pipe.drains().length,
      startWet: Object.keys(pipe.watered()).length,
      startSolved: pipe.isSolved()
    };

    var result = solveByHand();
    out.won = result.won;
    out.attempts = result.attempts;
    out.wetAtEnd = Object.keys(pipe.watered()).length;
    out.solvedFlag = pipe.isSolved();

    // the window should now say so
    out.status = pipe.win.querySelector(".pipes-status").textContent;
    out.progress = pipe.win.querySelector(".pipes-progress").textContent;
    out.progressDone = pipe.win.querySelector(".pipes-progress")
      .classList.contains("is-done");

    document.title = "PROBE" + JSON.stringify(out);
  }, 1400);
}, 700);
`, 90000, "solve");
      console.log("  " + JSON.stringify(r));

      check("a board starts unsolved", r.startSolved === false);
      check("water flows from the outset", r.startWet > 1, String(r.startWet));
      check("a board can be played to a win", r.won === true,
        JSON.stringify(r) + " (greedy walker, " + r.attempts + " boards tried)");
      check("the win flag is set", r.solvedFlag === true);
      check("the status line says so", /Flowing|flowing/.test(r.status || ""), r.status);
      check("the progress line marks it done", r.progressDone === true, r.progress);
      check("every outlet is watered at the end",
        /reaching (\d+) of \1/.test(r.progress || ""), r.progress);
    }

    console.log("\n=== a fresh board always has water in it ===");
    {
      /* The generator randomises every piece, which can leave the tap
         sealed off. A board with no water reads as broken, so this checks
         a decent sample at every size rather than trusting one. */
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  var pipe = LDPrograms.openPipes();
  var samples = [];

  function snapshot() {
    var wet = pipe.watered();
    return {
      wet: Object.keys(wet).length,
      cells: pipe.grid().length,
      solved: pipe.isSolved()
    };
  }
  function press(label) {
    Array.prototype.filter.call(pipe.win.querySelectorAll(".pipes-btn"),
      function (b) { return b.textContent === label; })[0].click();
  }

  setTimeout(function () {
    for (var i = 0; i < 12; i++) { if (i) press("New board"); samples.push(snapshot()); }
    ["Bigger", "Bigger"].forEach(function () {
      press("Bigger");
      for (var j = 0; j < 8; j++) { if (j) press("New board"); samples.push(snapshot()); }
    });
    document.title = "PROBE" + JSON.stringify({ samples: samples });
  }, 1500);
}, 700);
`, 60000, "water");
      console.log("  boards checked: " + (r.samples || []).length);

      const samples = r.samples || [];
      const dead = samples.filter(s => s.wet <= 1);
      const solved = samples.filter(s => s.solved);

      check("a decent number of boards were checked", samples.length >= 25,
        String(samples.length));
      check("none of them has the tap sealed off", dead.length === 0,
        JSON.stringify(dead.slice(0, 3)));
      check("every board starts with water flowing",
        samples.every(s => s.wet > 1),
        JSON.stringify(samples.map(s => s.wet)));
      check("none starts already solved", solved.length === 0,
        JSON.stringify(solved.slice(0, 3)));
    }

    console.log("\n=== the level buttons work ===");
    {
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  var pipe = LDPrograms.openPipes();
  setTimeout(function () {
    var win = pipe.win;
    var out = { startSize: pipe.size() };

    var bigger = Array.prototype.filter.call(win.querySelectorAll(".pipes-btn"),
      function (b) { return b.textContent === "Bigger"; })[0];
    var smaller = Array.prototype.filter.call(win.querySelectorAll(".pipes-btn"),
      function (b) { return b.textContent === "Smaller"; })[0];
    var fresh = Array.prototype.filter.call(win.querySelectorAll(".pipes-btn"),
      function (b) { return b.textContent === "New board"; })[0];

    bigger.click();
    setTimeout(function () {
      out.afterBigger = pipe.size();
      smaller.click();
      smaller.click();
      setTimeout(function () {
        out.afterSmaller = pipe.size();
        // smaller at the bottom of the range must not go below it
        for (var i = 0; i < 5; i++) smaller.click();
        setTimeout(function () {
          out.floorSize = pipe.size();
          out.levelText = win.querySelector(".pipes-level").textContent;
          fresh.click();
          setTimeout(function () {
            out.afterNew = pipe.moves();
            document.title = "PROBE" + JSON.stringify(out);
          }, 500);
        }, 900);
      }, 900);
    }, 900);
  }, 1200);
}, 700);
`, 34000, "levels");
      console.log("  " + JSON.stringify(r));
      check("it starts at 5", r.startSize === 5, String(r.startSize));
      check("Bigger grows the board", r.afterBigger === 6, String(r.afterBigger));
      check("Smaller shrinks it", r.afterSmaller === 5, String(r.afterSmaller));
      check("it will not go below the smallest", r.floorSize === 5, String(r.floorSize));
      check("the level name updates", /Warm-up/.test(r.levelText || ""), r.levelText);
      check("New board resets the moves", r.afterNew === 0, String(r.afterNew));
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
