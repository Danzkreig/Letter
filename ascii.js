/* ============================================================
   Letterdrop — ASCII toys

   Two flat shapes, revealed a line at a time, and two real 3D renders
   in the style of Andy Sloane's donut.c: a parametric surface sampled,
   projected orthographically, z-buffered so nearer points occlude
   farther ones, and shaded onto a luminance ramp.

   No dependencies; everything here is arithmetic on typed arrays.
   ============================================================ */

(function (global) {
  "use strict";

  const CHARS = ".,-~:;=!*#$@";

  /* ============================================================
     3D: a torus (the classic donut)
     ============================================================ */

  function donut(W, H) {
    W = W || 78;
    H = H || 34;

    // torus radii; theta sweeps the tube, phi sweeps around the ring
    const R1 = 1, R2 = 2, K2 = 5;
    const K1 = W * K2 * 3 / (8 * (R1 + R2));

    let A = 0, B = 0;
    const zbuf = new Float32Array(W * H);
    const out = new Array(W * H);

    function render() {
      const cosA = Math.cos(A), sinA = Math.sin(A);
      const cosB = Math.cos(B), sinB = Math.sin(B);
      const cosT = Math.cos(A), sinT = Math.sin(A);

      for (let i = 0; i < W * H; i++) { zbuf[i] = 0; out[i] = " "; }

      for (let theta = 0; theta < 6.28318; theta += 0.07) {
        const ct = Math.cos(theta), st = Math.sin(theta);
        for (let phi = 0; phi < 6.28318; phi += 0.02) {
          const cp = Math.cos(phi), sp = Math.sin(phi);
          const circlex = R2 + R1 * ct;
          const circley = R1 * st;

          const x = circlex * (cosB * cp + sinA * sinB * sp) - circley * cosA * sinB;
          const y = circlex * (sinB * cp - sinA * cosB * sp) + circley * cosA * cosB;
          const z = K2 + cosA * circlex * sp + circley * sinA;
          const ooz = 1 / z;

          const xp = Math.floor(W / 2 + K1 * ooz * x);
          const yp = Math.floor(H / 2 - K1 * ooz * y * 0.5);

          // lighting from the surface normal
          const L = cp * ct * sinB - cosA * ct * sp - sinA * st +
            cosB * (cosA * st - ct * sinA * sp);
          if (L <= 0) continue;

          const idx = xp + W * yp;
          if (xp < 0 || xp >= W || yp < 0 || yp >= H) continue;
          if (ooz > zbuf[idx]) {
            zbuf[idx] = ooz;
            out[idx] = CHARS[Math.min(CHARS.length - 1, Math.floor(L * 8))];
          }
        }
      }
      // silence the unused-variable lint the maths above leaves behind
      void cosT; void sinT;

      let s = "";
      for (let j = 0; j < H; j++) {
        s += out.slice(j * W, (j + 1) * W).join("") + "\n";
      }
      return s;
    }

    return {
      render: render,
      step: function (dA, dB) { A += dA; B += dB; }
    };
  }

  /* ============================================================
     3D: a heart

     A heart is not a surface of revolution -- revolving a profile
     destroys the two lobes and the notch between them. Instead the
     implicit curve (x² + y² − 1)³ − x²y³ = 0 is used as the *outline*,
     and the solid is built by giving it thickness in z: for each point
     inside the outline, the front and back surfaces sit at
     z = ±k·cuberoot(−curve), which is 0 on the boundary and deepest in
     the middle. That keeps the real silhouette and still reads as solid.

     It yaws rather than spinning: a full rotation would present the
     heart edge-on, where it is a featureless slab. A gentle swing keeps
     the lobes facing the viewer the whole time.
     ============================================================ */

  function heart(W, H) {
    W = W || 78;
    H = H || 34;

    let t = 0;
    const SWING = 0.5;   // radians either side of centre

    /* Signed value of the heart curve: negative inside, positive out. */
    function inside(x, y) {
      const a = x * x + y * y - 1;
      return a * a * a - x * x * y * y * y;
    }

    /* How far inside the outline a point is: 1 deep within, 0 on the edge,
       negative outside.

       This uses the curve value itself rather than measuring to the edge
       along x. That matters at the notch between the lobes, where the
       middle of the shape is still close to the boundary -- measuring
       along x would report full depth there and fill the notch in. */
    function depth(x, y) {
      const v = inside(x, y);
      if (v >= 0) return -1;
      const d = Math.pow(-v, 1 / 3);
      return d > 1 ? 1 : d;
    }

    const zbuf = new Float32Array(W * H);
    const out = new Array(W * H);

    /* The heart spans about ±1.15 in x and −1 to +1.2 in y, and the maths
       has +y upward while a text grid runs downward, so y is negated in
       the projection. */
    const SPAN = 2.7;
    const K2 = 4;

    function render() {
      const a = Math.sin(t) * SWING;
      const cosA = Math.cos(a), sinA = Math.sin(a);

      for (let i = 0; i < W * H; i++) { zbuf[i] = 0; out[i] = " "; }

      /* March over the outline in world space, finely enough that no
         column is skipped, and give each point front and back faces. */
      const STEP = 0.01;
      for (let wx = -1.35; wx <= 1.35; wx += STEP) {
        for (let wy = -1.35; wy <= 1.35; wy += STEP) {
          const d = depth(wx, wy);
          if (d < 0) continue;

          // the surface bulges out of the page by the cube root of depth
          const zHalf = 0.55 * d;

          for (let side = -1; side <= 1; side += 2) {
            const wz = zHalf * side;

            // yaw about the vertical axis
            const x = wx * cosA - wz * sinA;
            const z = wx * sinA + wz * cosA;

            const zz = K2 + z;
            if (zz <= 0.1) continue;
            const ooz = K2 / zz;      // 1 at the centre, smaller further away

            const xp = Math.floor(W / 2 + ooz * (x / SPAN) * W);
            // negate y: the maths has it up, a text grid has it down
            const yp = Math.floor(H / 2 - ooz * (wy / SPAN) * H);
            if (xp < 0 || xp >= W || yp < 0 || yp >= H) continue;

            /* Light from the upper left, plus a depth term so the middle
               of a head-on solid does not go dark. */
            const facing = side < 0 ? 1 : 0.5;
            const lum = Math.max(0.15, Math.min(1, 0.3 + d * 0.45 + facing * 0.3));

            const idx = xp + W * yp;
            if (ooz > zbuf[idx]) {
              zbuf[idx] = ooz;
              out[idx] = CHARS[Math.min(CHARS.length - 1, Math.floor(lum * 8))];
            }
          }
        }
      }

      let s = "";
      for (let j = 0; j < H; j++) {
        s += out.slice(j * W, (j + 1) * W).join("") + "\n";
      }
      return s;
    }

    return {
      render: render,
      step: function (dA) { t += (dA || 0.045); }
    };
  }

  /* ============================================================
     2D shapes

     Plain character grids, revealed one line at a time and then held.
     They are meant to look like something someone typed by hand.
     ============================================================ */

  const HEART_2D = [
    "   *****       *****   ",
    "  *******     *******  ",
    " *********   ********* ",
    "***********************",
    "***********************",
    " ********************* ",
    "  *******************  ",
    "   *****************   ",
    "    ***************    ",
    "     *************     ",
    "      ***********      ",
    "       *********       ",
    "        *******        ",
    "         *****         ",
    "          ***          ",
    "           *           "
  ];

  const DONUT_2D = [
    "      ***********      ",
    "    ***************    ",
    "  *******************  ",
    " ********************* ",
    "***********************",
    "******         ********",
    "*****           *******",
    "*****           *******",
    "*****           *******",
    "******         ********",
    "***********************",
    " ********************* ",
    "  *******************  ",
    "    ***************    ",
    "      ***********      "
  ];

  /* Reveal a grid one line at a time, hold it, then start over. The cycle
     is exactly grid.length + HOLD steps, so a caller can predict it. */
  const REVEAL_HOLD = 14;

  function makeReveal(grid) {
    let at = 0;
    const cycle = grid.length + REVEAL_HOLD;

    function render() {
      const shown = Math.min(at, grid.length);
      const lines = [];
      for (let i = 0; i < grid.length; i++) {
        lines.push(i < shown ? grid[i] : "");
      }
      return lines.join("\n");
    }

    return {
      render: render,
      step: function () { at = (at + 1) % cycle; },
      // how far through the reveal we are, which the tests rely on
      progress: function () { return Math.min(at, grid.length); },
      cycle: cycle
    };
  }

  /* ============================================================
     Registry
     ============================================================ */

  const SHAPES = {
    heart2d: function () { return makeReveal(HEART_2D); },
    donut2d: function () { return makeReveal(DONUT_2D); },
    heart: function () { return heart(); },
    donut: function () { return donut(); }
  };

  /* How fast each shape turns or reveals, per frame. */
  const STEP = {
    donut: [0.055, 0.028],
    heart: [0.042, 0],
    heart2d: [0, 0],
    donut2d: [0, 0]
  };

  const LABELS = {
    heart2d: "Heart (text)",
    donut2d: "Donut (text)",
    heart: "Heart (3D)",
    donut: "Donut (3D)"
  };

  const CAPTIONS = {
    heart2d: "LOVE.TXT",
    donut2d: "DONUT.TXT",
    heart: "HEART.EXE",
    donut: "DONUT.EXE"
  };

  const NAMES = ["heart2d", "donut2d", "heart", "donut"];

  function isValid(name) {
    return NAMES.indexOf(name) !== -1;
  }

  global.LETTERDROP_ASCII = {
    shapes: SHAPES,
    STEP: STEP,
    LABELS: LABELS,
    CAPTIONS: CAPTIONS,
    NAMES: NAMES,
    isValid: isValid,
    make: function (name) {
      const f = SHAPES[name];
      return f ? f() : null;
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.LETTERDROP_ASCII;
  }
})(typeof window !== "undefined" ? window : globalThis);
