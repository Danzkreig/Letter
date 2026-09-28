/* Verify all four shapes render, animate, and stay cheap enough to run
   on a timer. */

"use strict";

const A = require("../ascii.js");

let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } }

console.log("=== the registry ===");
{
  check("four shapes are offered", A.NAMES.length === 4, JSON.stringify(A.NAMES));
  ["heart2d", "donut2d", "heart", "donut"].forEach(function (n) {
    check(n + " is registered", typeof A.shapes[n] === "function");
    check(n + " has a step", Array.isArray(A.STEP[n]), JSON.stringify(A.STEP[n]));
    check(n + " has a label", typeof A.LABELS[n] === "string", A.LABELS[n]);
    check(n + " has a caption", typeof A.CAPTIONS[n] === "string", A.CAPTIONS[n]);
  });
  check("isValid accepts a real shape", A.isValid("donut") === true);
  check("isValid rejects a made-up one", A.isValid("banana") === false);
  check("isValid rejects undefined", A.isValid(undefined) === false);
  check("make returns null for an unknown shape", A.make("banana") === null);
}

console.log("\n=== every shape draws something ===");
const frames = {};
A.NAMES.forEach(function (n) {
  const s = A.make(n);
  /* The 2D shapes reveal and then loop, so sample them once the picture
     is complete (16 lines) rather than at an arbitrary point in the cycle. */
  const steps = n.endsWith("2d") ? 18 : 40;
  for (let i = 0; i < steps; i++) s.step.apply(null, A.STEP[n]);
  const out = s.render();
  frames[n] = out;

  const ink = (out.match(/[^ \n]/g) || []).length;
  const lines = out.split("\n").filter(function (l) { return l.trim(); }).length;
  console.log("  " + n.padEnd(8) + " ink=" + String(ink).padStart(5) + "  lines=" + String(lines).padStart(3));

  check(n + " draws ink", ink > 150, String(ink));
  check(n + " fills several lines", lines >= 14, String(lines));
  check(n + " is rectangular", out.split("\n").slice(0, -1).every(function (l) {
    return l.length === out.split("\n")[0].length;
  }));
});

console.log("\n=== the 3D ones actually move ===");
["heart", "donut"].forEach(function (n) {
  const s = A.make(n);
  const first = s.render();
  for (let i = 0; i < 12; i++) s.step.apply(null, A.STEP[n]);
  const later = s.render();
  check(n + " changes as it turns", first !== later);
});

console.log("\n=== the 2D ones reveal line by line ===");
["heart2d", "donut2d"].forEach(function (n) {
  const s = A.make(n);
  const empty = s.render().trim();
  check(n + " starts blank", empty === "", JSON.stringify(empty.slice(0, 20)));

  s.step.apply(null, A.STEP[n]);
  const oneLine = s.render().split("\n").filter(function (l) { return l.trim(); }).length;
  check(n + " reveals one line at a time", oneLine === 1, String(oneLine));

  /* Step until the picture is complete, then keep stepping to the end of
     the cycle. The two grids are different heights, so the cycle length
     has to come from the shape rather than being hardcoded. */
  const cycle = s.cycle;
  const rows = cycle - 14;               // the reveal is the hold-less part
  for (let i = 1; i < rows; i++) s.step.apply(null, A.STEP[n]);
  check(n + " completes the picture", s.render().split("\n").filter(function (l) {
    return l.trim();
  }).length === rows, "expected " + rows);

  // and the rest of the cycle returns it to a blank grid
  for (let i = rows; i < cycle; i++) s.step.apply(null, A.STEP[n]);
  check(n + " loops back to the beginning", s.render().trim() === "",
    JSON.stringify(s.render().trim().slice(0, 30)));
});

console.log("\n=== the heart has a notch and a point ===");
{
  const s = A.make("heart");
  for (let i = 0; i < 22; i++) s.step(0.042, 0);
  const lines = s.render().split("\n").filter(function (l) { return l.trim(); });

  const width = function (l) { return l.replace(/\s+$/, "").length - l.search(/\S/); };

  const top = lines[0] || "";
  // the notch means the first rows are narrower than the widest row below
  const widest = Math.max.apply(null, lines.map(width));
  check("the top row is narrower than the widest (a notch, not a flat slab)",
    width(top) < widest - 6, width(top) + " vs " + widest);

  // the bottom should taper to a point
  const bottom = lines[lines.length - 1] || "";
  check("the bottom tapers to a point", width(bottom) <= 8, String(width(bottom)));
}

console.log("\n=== it is cheap enough for a timer ===");
{
  const budget = 40;   // ms for one frame at the default size
  A.NAMES.forEach(function (n) {
    const s = A.make(n);
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) { s.step.apply(null, A.STEP[n]); s.render(); }
    const per = (Date.now() - t0) / 6;
    console.log("  " + n.padEnd(8) + " " + per.toFixed(1) + " ms/frame");
    check(n + " renders within budget", per < budget, per.toFixed(1) + "ms");
  });
}

console.log("\n----------------------------------------");
console.log("PASS " + pass + "   FAIL " + fail);
process.exit(fail ? 1 : 0);
