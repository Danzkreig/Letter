/* ============================================================
   Letterdrop — Calculator, MS-DOS Prompt and Paint

   Three working programs for the Windows 98 desktop.
   Everything else on the machine is a decoy; these are not.
   ============================================================ */

(function (global) {
  "use strict";

  let UI = null;

  function init(ui) { UI = ui; }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ============================================================
     Calculator

     A standard four-function calculator. The display is a real
     number, not a string being appended to, so the arithmetic is
     correct rather than cosmetic.
     ============================================================ */

  let calcWindow = null;

  function openCalculator() {
    if (calcWindow && !calcWindow.win.hidden) {
      UI.focusWindow(calcWindow.win);
      return calcWindow;
    }

    const built = UI.makeWindow({
      title: "Calculator",
      icon: "assets/calculator-32x32.png",
      width: 260, height: 260, x: 420, y: 200
    });

    const state = {
      display: "0",     // what the screen shows
      acc: null,        // the running total
      op: null,         // pending operator
      fresh: true,      // next digit starts a new number
      memory: 0
    };

    const screen = el("div", "calc-screen", "0");
    screen.setAttribute("role", "status");
    screen.setAttribute("aria-live", "polite");

    const grid = el("div", "calc-grid");

    function render() {
      /* Trim a result that would overflow the screen. Only switch to
         exponential when the number really is too long, and never for a
         value short enough to show in full -- sqrt(7) is 2.6457513110645907,
         which wants rounding, not an exponent. */
      let s = state.display;
      if (s.length > 16 && !isNaN(Number(s)) && s.indexOf("e") === -1) {
        const n = Number(s);
        const plain = String(n);
        if (plain.length <= 16) {
          s = plain;
        } else if (Math.abs(n) !== 0 && (Math.abs(n) >= 1e16 || Math.abs(n) < 1e-9)) {
          s = n.toExponential(9);
        } else {
          // round to the digits that fit rather than dropping into e-notation
          const decimals = Math.max(0, 15 - String(Math.trunc(n)).length);
          s = n.toFixed(Math.min(decimals, 12)).replace(/\.?0+$/, "");
        }
      }
      screen.textContent = s;
    }

    function inputDigit(d) {
      if (state.fresh) {
        state.display = d;
        state.fresh = false;
      } else {
        state.display = state.display === "0" ? d : state.display + d;
      }
      render();
    }

    function inputDot() {
      if (state.fresh) {
        state.display = "0.";
        state.fresh = false;
      } else if (state.display.indexOf(".") === -1) {
        state.display += ".";
      }
      render();
    }

    function current() {
      const n = Number(state.display);
      return isNaN(n) ? 0 : n;
    }

    function apply(a, b, op) {
      switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/":
          if (b === 0) return null;   // signalled as an error
          return a / b;
        default: return b;
      }
    }

    function setOp(op) {
      const value = current();
      if (state.op !== null && !state.fresh) {
        const out = apply(state.acc, value, state.op);
        if (out === null) { fail(); return; }
        state.acc = out;
        state.display = String(out);
      } else {
        state.acc = value;
      }
      state.op = op;
      state.fresh = true;
      render();
    }

    function equals() {
      if (state.op === null) return;
      const out = apply(state.acc, current(), state.op);
      if (out === null) { fail(); return; }
      state.display = String(out);
      state.acc = null;
      state.op = null;
      state.fresh = true;
      render();
    }

    function fail() {
      state.display = "Cannot divide by zero";
      state.acc = null;
      state.op = null;
      state.fresh = true;
      render();
    }

    function clearAll() {
      state.display = "0";
      state.acc = null;
      state.op = null;
      state.fresh = true;
      render();
    }

    function backspace() {
      if (state.fresh) return;
      state.display = state.display.length > 1 ? state.display.slice(0, -1) : "0";
      if (state.display === "0") state.fresh = true;
      render();
    }

    const LAYOUT = [
      ["MC", "MR", "MS", "C"],
      ["7", "8", "9", "/"],
      ["4", "5", "6", "*"],
      ["1", "2", "3", "-"],
      ["0", "+/-", ".", "+"],
      ["Back", "=", "CE", "sqrt"]
    ];

    LAYOUT.forEach(function (row) {
      row.forEach(function (label) {
        const b = el("button", "calc-btn", label);
        b.type = "button";
        b.dataset.key = label;
        b.addEventListener("click", function () { press(label); });
        grid.appendChild(b);
      });
    });

    function press(label) {
      if (/^[0-9]$/.test(label)) { inputDigit(label); return; }
      switch (label) {
        case ".": inputDot(); break;
        case "+": case "-": case "*": case "/": setOp(label); break;
        case "=": equals(); break;
        case "C": clearAll(); break;
        case "CE": state.display = "0"; state.fresh = true; render(); break;
        case "Back": backspace(); break;
        case "+/-":
          state.display = state.display.charAt(0) === "-"
            ? state.display.slice(1)
            : (state.display === "0" ? "0" : "-" + state.display);
          render();
          break;
        case "sqrt": {
          const v = current();
          if (v < 0) { fail(); return; }
          state.display = String(Math.sqrt(v));
          state.fresh = true;
          render();
          break;
        }
        case "MS": state.memory = current(); state.fresh = true; break;
        case "MR": state.display = String(state.memory); state.fresh = true; render(); break;
        case "MC": state.memory = 0; break;
      }
    }

    /* keyboard, so it behaves like a real calculator */
    built.win.addEventListener("keydown", function (e) {
      const k = e.key;
      if (/^[0-9]$/.test(k)) { press(k); e.preventDefault(); return; }
      if (k === "." || k === "+" || k === "-" || k === "*" || k === "/") { press(k); e.preventDefault(); return; }
      if (k === "Enter" || k === "=") { press("="); e.preventDefault(); return; }
      if (k === "Escape") { press("C"); e.preventDefault(); return; }
      if (k === "Backspace") { press("Back"); e.preventDefault(); return; }
    });
    built.win.tabIndex = -1;

    built.body.appendChild(screen);
    built.body.appendChild(grid);

    calcWindow = { win: built.win, press: press, screen: screen };
    render();
    return calcWindow;
  }

  /* ============================================================
     MS-DOS Prompt

     A small shell over the real per-user file store, so `dir` lists
     your actual Documents and `type` prints a real note. Commands
     that would need a real machine (format, deltree) politely refuse.
     ============================================================ */

  let dosWindow = null;

  const DOS_HELP = [
    "Available commands:",
    "  DIR              list the files in your folder",
    "  TYPE <file>      print a note",
    "  DEL <file>       delete a file",
    "  CD               show the current directory",
    "  VER              show the DOS version",
    "  DATE             show today's date",
    "  TIME             show the current time",
    "  ECHO <text>      print text back",
    "  CLS              clear the screen",
    "  EXIT             close this window"
  ];

  function openDos() {
    if (dosWindow && !dosWindow.win.hidden) {
      UI.focusWindow(dosWindow.win);
      return dosWindow;
    }

    const built = UI.makeWindow({
      title: "MS-DOS Prompt",
      icon: "assets/msdos-32x32.png",
      width: 560, height: 380, x: 150, y: 180
    });

    const out = el("div", "dos-out");
    out.setAttribute("role", "log");

    const line = el("div", "dos-line");
    const prompt = el("span", "dos-prompt", "C:\\LETTERDROP>");
    const input = el("input", "dos-input");
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Command");
    line.appendChild(prompt);
    line.appendChild(input);

    built.body.appendChild(out);
    built.body.appendChild(line);

    function say(text, cls) {
      const d = el("div", "dos-text" + (cls ? " " + cls : ""), text);
      out.appendChild(d);
      out.scrollTop = out.scrollHeight;
    }

    function run(raw) {
      const cmd = raw.trim();
      say("C:\\LETTERDROP>" + cmd);
      if (!cmd) return;

      const parts = cmd.split(/\s+/);
      const verb = parts[0].toUpperCase();
      const rest = cmd.slice(parts[0].length).trim();

      switch (verb) {
        case "DIR":
          say("");
          say(" Volume in drive C is LETTERDROP");
          say(" Directory of C:\\LETTERDROP");
          say("");
          LD.listFiles().then(function (res) {
            const files = res.files || [];
            if (!files.length) {
              say("File Not Found");
            } else {
              files.forEach(function (f) {
                const size = String(f.size).padStart(10, " ");
                const tag = f.kind === "image" ? "<DIR> IMG " : "      TXT ";
                say(f.name.padEnd(24, " ") + tag + size);
              });
              say("");
              say("        " + files.length + " file(s)");
            }
            say("");
          }).catch(function (e) { say(e.message, "is-error"); });
          break;

        case "TYPE": {
          if (!rest) { say("Required parameter missing"); break; }
          LD.readFile(rest).then(function (res) {
            if (res.kind === "image") {
              say("(that is an image -- open it from My Documents)");
            } else {
              res.text.split("\n").forEach(function (l) { say(l); });
            }
            say("");
          }).catch(function (e) { say("File not found - " + rest, "is-error"); });
          break;
        }

        case "DEL": {
          if (!rest) { say("Required parameter missing"); break; }
          LD.deleteFile(rest).then(function () {
            say("Deleted " + rest);
            UI.broadcast("files-changed");
          }).catch(function (e) { say("File not found - " + rest, "is-error"); });
          break;
        }

        case "CD":
          say("C:\\LETTERDROP");
          break;

        case "VER":
          say("");
          say("Windows 98 [Version 4.10.1998]");
          say("");
          break;

        case "DATE":
          say("Current date is " + new Date().toDateString());
          break;

        case "TIME":
          say("Current time is " + new Date().toLocaleTimeString());
          break;

        case "ECHO":
          say(rest || "ECHO is on.");
          break;

        case "CLS":
          out.textContent = "";
          break;

        case "HELP":
          DOS_HELP.forEach(function (l) { say(l); });
          break;

        case "EXIT":
          built.win.hidden = true;
          UI.broadcast("windows-changed");
          break;

        case "FORMAT":
        case "DELTREE":
        case "FDISK":
          say("");
          say("Access denied. Nice try.", "is-error");
          say("");
          break;

        default:
          say("Bad command or file name", "is-error");
      }
    }

    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = input.value;
      input.value = "";
      run(v);
    });

    // clicking anywhere in the window puts the cursor back in the prompt
    built.win.addEventListener("mousedown", function (e) {
      if (e.target === built.win || e.target === out) {
        setTimeout(function () { input.focus(); }, 0);
      }
    });

    say("Letterdrop DOS Prompt");
    say("Type HELP for a list of commands.");
    say("");

    dosWindow = { win: built.win, run: run, output: out, input: input };
    setTimeout(function () { input.focus(); }, 80);
    return dosWindow;
  }

  /* ============================================================
     Paint

     A real canvas: brush, eraser, colours, sizes, and saving into
     your own Documents as a PNG.
     ============================================================ */

  let paintWindow = null;

  const PALETTE = [
    "#000000", "#7f7f7f", "#880015", "#ed1c24", "#ff7f27", "#fff200",
    "#22b14c", "#00a2e8", "#3f48cc", "#a349a4", "#ffffff", "#c3c3c3",
    "#b97a57", "#ffaec9", "#ffc90e", "#efe4b0", "#b5e61d", "#99d9ea",
    "#7092be", "#c8bfe7"
  ];

  function openPaint() {
    if (paintWindow && !paintWindow.win.hidden) {
      UI.focusWindow(paintWindow.win);
      return paintWindow;
    }

    const built = UI.makeWindow({
      title: "untitled - Paint",
      icon: "assets/paint-32x32.png",
      width: 620, height: 500, x: 120, y: 80
    });

    /* ---------- the canvas ---------- */
    const wrap = el("div", "paint-canvas-wrap");
    const canvas = document.createElement("canvas");
    canvas.className = "paint-canvas";
    canvas.width = 560;
    canvas.height = 320;
    canvas.setAttribute("aria-label", "Drawing area");
    wrap.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    function blank() {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    blank();

    /* ---------- the tools ---------- */
    const bar = el("div", "paint-tools");

    const colors = el("div", "paint-colors");
    let currentColour = "#000000";
    PALETTE.forEach(function (hex, i) {
      const sw = el("button", "paint-swatch");
      sw.type = "button";
      sw.style.background = hex;
      sw.dataset.colour = hex;
      sw.setAttribute("aria-label", "Colour " + hex);
      if (i === 0) sw.classList.add("is-active");
      sw.addEventListener("click", function () {
        currentColour = hex;
        tool = "brush";
        Array.prototype.forEach.call(colors.querySelectorAll(".paint-swatch"),
          function (s) { s.classList.remove("is-active"); });
        sw.classList.add("is-active");
        paintTool.classList.remove("is-active");
      });
      colors.appendChild(sw);
    });

    const sizes = el("div", "paint-sizes");
    let brushSize = 4;
    [2, 4, 8, 16].forEach(function (n, i) {
      const b = el("button", "paint-size", String(n));
      b.type = "button";
      b.dataset.size = String(n);
      if (i === 1) b.classList.add("is-active");
      b.addEventListener("click", function () {
        brushSize = n;
        Array.prototype.forEach.call(sizes.querySelectorAll(".paint-size"),
          function (s) { s.classList.remove("is-active"); });
        b.classList.add("is-active");
      });
      sizes.appendChild(b);
    });

    const paintTool = el("button", "paint-tool", "Erase");
    paintTool.type = "button";
    let tool = "brush";
    paintTool.addEventListener("click", function () {
      tool = tool === "eraser" ? "brush" : "eraser";
      paintTool.classList.toggle("is-active", tool === "eraser");
    });

    const clearBtn = el("button", "paint-tool", "Clear");
    clearBtn.type = "button";
    clearBtn.addEventListener("click", function () {
      UI.confirmBox("Paint", "Clear the canvas?", function () { blank(); });
    });

    const saveBtn = el("button", "paint-tool", "Save to Documents");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", function () {
      const name = window.prompt("Save as (a .png in your Documents):", "drawing.png");
      if (!name) return;
      const b64 = canvas.toDataURL("image/png").split(",")[1];
      LD.saveImage(name, "image/png", b64)
        .then(function (res) {
          built.win.dataset.title = res.name + " - Paint";
          UI.setWindowTitle(built.win, res.name + " - Paint");
          UI.broadcast("files-changed");
          UI.infoBox("Paint", "Saved " + res.name + " to your Documents.");
        })
        .catch(function (e) { UI.errorBox("Paint", e.message); });
    });

    const openBtn = el("button", "paint-tool", "Open");
    openBtn.type = "button";
    openBtn.addEventListener("click", function () {
      LD.listFiles().then(function (res) {
        const images = (res.files || []).filter(function (f) { return f.kind === "image"; });
        if (!images.length) { UI.infoBox("Paint", "No images in your Documents yet."); return; }
        const name = window.prompt("Which image?\n\n" +
          images.map(function (f) { return f.name; }).join("\n"), images[0].name);
        if (!name) return;
        LD.readFile(name).then(function (file) {
          if (file.kind !== "image") { UI.errorBox("Paint", "That is not an image."); return; }
          const img = new Image();
          img.onload = function () {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // fit it inside the canvas without distorting it
            const scale = Math.min(canvas.width / img.width, canvas.height / img.height, 1);
            ctx.drawImage(img, 0, 0, img.width * scale, img.height * scale);
            UI.setWindowTitle(built.win, file.name + " - Paint");
          };
          img.onerror = function () { UI.errorBox("Paint", "That image could not be read."); };
          img.src = "data:" + file.mime + ";base64," + file.base64;
        }).catch(function (e) { UI.errorBox("Paint", e.message); });
      }).catch(function (e) { UI.errorBox("Paint", e.message); });
    });

    bar.appendChild(colors);
    const toolRow = el("div", "paint-toolrow");
    toolRow.appendChild(sizes);
    toolRow.appendChild(paintTool);
    toolRow.appendChild(clearBtn);
    toolRow.appendChild(openBtn);
    toolRow.appendChild(saveBtn);
    bar.appendChild(toolRow);

    /* ---------- drawing ---------- */
    let drawing = false;
    let lastX = 0, lastY = 0;

    function pointFrom(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height)
      };
    }

    function strokeTo(p) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = tool === "eraser" ? brushSize * 3 : brushSize;
      ctx.strokeStyle = tool === "eraser" ? "#ffffff" : currentColour;
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastX = p.x; lastY = p.y;
    }

    canvas.addEventListener("mousedown", function (e) {
      drawing = true;
      const p = pointFrom(e);
      lastX = p.x; lastY = p.y;
      strokeTo(p);          // a single click leaves a dot
      e.preventDefault();
    });

    window.addEventListener("mousemove", function (e) {
      if (!drawing) return;
      strokeTo(pointFrom(e));
    });

    window.addEventListener("mouseup", function () {
      drawing = false;
    });

    built.body.appendChild(bar);
    built.body.appendChild(wrap);

    paintWindow = {
      win: built.win, canvas: canvas, ctx: ctx,
      setColour: function (c) { currentColour = c; tool = "brush"; },
      clear: blank
    };
    return paintWindow;
  }

  /* ============================================================
     Minesweeper

     The real game: 9x9 with 10 mines, flood reveal on empty
     squares, right-click to flag, and a first click that is always
     safe (mine placement is deferred until after it).
     ============================================================ */

  let mineWindow = null;

  function openMinesweeper() {
    if (mineWindow && !mineWindow.win.hidden) {
      UI.focusWindow(mineWindow.win);
      return mineWindow;
    }

    const COLS = 9, ROWS = 9, MINES = 10;

    const built = UI.makeWindow({
      title: "Minesweeper",
      icon: "assets/minesweeper-32x32.png",
      width: 320, height: 380, x: 200, y: 140
    });

    const head = el("div", "mine-head");
    const mineCount = el("div", "mine-count", String(MINES).padStart(3, "0"));
    const face = el("button", "mine-face", "\uD83D\uDE42");
    face.type = "button";
    const clock = el("div", "mine-count", "000");
    head.appendChild(mineCount);
    head.appendChild(face);
    head.appendChild(clock);

    const grid = el("div", "mine-grid");
    grid.style.gridTemplateColumns = "repeat(" + COLS + ", 26px)";

    built.body.appendChild(head);
    built.body.appendChild(grid);

    let cells = [];       // { mine, revealed, flagged, n }
    let started = false;
    let over = false;
    let flags = 0;
    let seconds = 0;
    let timer = null;

    function reset() {
      clearInterval(timer);
      timer = null;
      seconds = 0;
      flags = 0;
      started = false;
      over = false;
      clock.textContent = "000";
      mineCount.textContent = String(MINES).padStart(3, "0");
      face.textContent = "\uD83D\uDE42";
      grid.textContent = "";
      cells = [];

      for (let i = 0; i < ROWS * COLS; i++) {
        cells.push({ mine: false, revealed: false, flagged: false, n: 0 });
      }

      cells.forEach(function (c, i) {
        const b = el("button", "mine-cell");
        b.type = "button";
        b.dataset.i = String(i);
        b.setAttribute("aria-label", "Square " + (i + 1));

        b.addEventListener("click", function () { reveal(i); });
        b.addEventListener("contextmenu", function (e) {
          e.preventDefault();
          flag(i);
        });
        grid.appendChild(b);
      });
    }

    function neighbours(i) {
      const x = i % COLS, y = Math.floor(i / COLS);
      const out = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
          out.push(ny * COLS + nx);
        }
      }
      return out;
    }

    /* Mines are placed after the first click, and never under it or its
       neighbours, so the first move always opens something. */
    function placeMines(safeIndex) {
      const forbidden = {};
      forbidden[safeIndex] = true;
      neighbours(safeIndex).forEach(function (n) { forbidden[n] = true; });

      const pool = [];
      for (let i = 0; i < cells.length; i++) if (!forbidden[i]) pool.push(i);

      // shuffle and take the first MINES
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
      pool.slice(0, MINES).forEach(function (i) { cells[i].mine = true; });

      cells.forEach(function (c, i) {
        if (c.mine) return;
        c.n = neighbours(i).filter(function (n) { return cells[n].mine; }).length;
      });
    }

    function paint(i) {
      const c = cells[i];
      const b = grid.children[i];
      if (!b) return;
      b.className = "mine-cell";
      b.textContent = "";
      if (c.revealed) {
        b.classList.add("is-open");
        if (c.mine) { b.classList.add("is-mine"); b.textContent = "\uD83D\uDCA3"; }
        else if (c.n) { b.textContent = String(c.n); b.classList.add("n" + c.n); }
      } else if (c.flagged) {
        b.textContent = "\uD83D\uDEA9";
      }
    }

    function reveal(i) {
      if (over) return;
      const c = cells[i];
      if (!c || c.revealed || c.flagged) return;

      if (!started) {
        started = true;
        placeMines(i);
        timer = setInterval(function () {
          seconds = Math.min(999, seconds + 1);
          clock.textContent = String(seconds).padStart(3, "0");
        }, 1000);
      }

      if (c.mine) {
        over = true;
        clearInterval(timer);
        cells.forEach(function (x, j) { if (x.mine) { x.revealed = true; paint(j); } });
        face.textContent = "\uD83D\uDE35";
        UI.infoBox("Minesweeper", "Boom. Press the face to try again.");
        return;
      }

      // flood fill through empty squares
      const stack = [i];
      while (stack.length) {
        const at = stack.pop();
        const cell = cells[at];
        if (cell.revealed || cell.flagged) continue;
        cell.revealed = true;
        paint(at);
        if (cell.n === 0) {
          neighbours(at).forEach(function (n) {
            if (!cells[n].revealed) stack.push(n);
          });
        }
      }

      checkWin();
    }

    function flag(i) {
      if (over) return;
      const c = cells[i];
      if (!c || c.revealed) return;
      c.flagged = !c.flagged;
      flags += c.flagged ? 1 : -1;
      mineCount.textContent = String(Math.max(0, MINES - flags)).padStart(3, "0");
      paint(i);
    }

    function checkWin() {
      const safeLeft = cells.filter(function (c) { return !c.mine && !c.revealed; }).length;
      if (safeLeft !== 0) return;
      over = true;
      clearInterval(timer);
      face.textContent = "\uD83D\uDE0E";
      UI.infoBox("Minesweeper", "You cleared the field in " + seconds + " seconds.");
    }

    face.addEventListener("click", function () { reset(); });

    reset();
    mineWindow = { win: built.win, reset: reset, reveal: reveal, flag: flag, cells: function () { return cells; } };
    return mineWindow;
  }

  /* ============================================================
     My Computer, the Recycle Bin and Network Neighbourhood

     These are browsers over the same file store, wearing different
     hats -- which is roughly what the originals were.
     ============================================================ */

  let computerWindow = null;

  function openComputer() {
    if (computerWindow && !computerWindow.win.hidden) {
      UI.focusWindow(computerWindow.win);
      return computerWindow;
    }

    const built = UI.makeWindow({
      title: "My Computer",
      icon: "assets/my-computer-32x32.png",
      width: 480, height: 320, x: 220, y: 160
    });

    const bar = el("div", "w98-toolbar");
    ["File", "Edit", "View", "Help"].forEach(function (label) {
      const b = el("button", "w98-tool", label);
      b.type = "button";
      b.addEventListener("click", function () { UI.illegal(label + " menu"); });
      bar.appendChild(b);
    });

    const list = el("div", "w98-filelist");

    const DRIVES = [
      { name: "3\u00BD Floppy (A:)", icon: "assets/folder-32x32.png", msg: "A:\\ is not accessible. The device is not ready." },
      { name: "Local Disk (C:)", icon: "assets/my-computer-32x32.png", files: true },
      { name: "My Documents", icon: "assets/my-documents-folder-32x32.png", docs: true },
      { name: "Control Panel", icon: "assets/task-scheduler-16x16.png", msg: "Control Panel" },
      { name: "Printers", icon: "assets/task-scheduler-16x16.png", msg: "Printers" },
      { name: "Dial-Up Networking", icon: "assets/network-32x32.png", msg: "Dial-Up Networking" }
    ];

    DRIVES.forEach(function (d) {
      const row = el("div", "w98-filerow w98-pickrow");
      row.tabIndex = 0;
      const icon = el("img");
      icon.src = d.icon;
      icon.alt = "";
      row.appendChild(icon);
      row.appendChild(el("span", "w98-filename", d.name));
      row.appendChild(el("span", "w98-filekind", d.files ? "Local Disk" : d.docs ? "Folder" : "System"));

      const go = function () {
        if (d.docs) { LDApps.openDocuments(); return; }
        if (d.files) { openCdrive(); return; }
        UI.errorBox(d.name, d.msg || (d.name + " is not available."));
      };
      row.addEventListener("dblclick", go);
      row.addEventListener("click", go);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); go(); }
      });
      list.appendChild(row);
    });

    const status = el("div", "w98-statusbar");
    status.appendChild(el("span", null, DRIVES.length + " object(s)"));
    built.body.appendChild(bar);
    built.body.appendChild(list);
    built.body.appendChild(status);

    computerWindow = { win: built.win };
    return computerWindow;
  }

  /* C: shows your own files, which is the only disk this machine has. */
  let cdriveWindow = null;

  function openCdrive() {
    if (cdriveWindow && !cdriveWindow.win.hidden) {
      UI.focusWindow(cdriveWindow.win);
      return cdriveWindow;
    }

    const built = UI.makeWindow({
      title: "Local Disk (C:)",
      icon: "assets/my-computer-32x32.png",
      width: 500, height: 340, x: 260, y: 200
    });

    const list = el("div", "w98-filelist");
    const status = el("div", "w98-statusbar");
    const st = el("span", null, "Reading...");
    status.appendChild(st);

    function load() {
      list.textContent = "";
      LD.listFiles().then(function (res) {
        const files = res.files || [];
        if (!files.length) {
          list.appendChild(el("div", "w98-hint", "This disk is empty. Use Notepad or Paint."));
        } else {
          files.forEach(function (f) {
            const row = el("div", "w98-filerow w98-pickrow");
            const icon = el("img");
            icon.src = f.kind === "image" ? "assets/paint-32x32.png" : "assets/notepad-file-32x32.png";
            icon.alt = "";
            row.appendChild(icon);
            row.appendChild(el("span", "w98-filename", f.name));
            row.appendChild(el("span", "w98-filekind", f.kind === "image" ? "Image" : "Text"));
            row.appendChild(el("span", "w98-filesize", f.size + " B"));
            list.appendChild(row);
          });
        }
        const total = files.reduce(function (a, f) { return a + f.size; }, 0);
        st.textContent = files.length + " file(s)   " + total + " bytes";
      }).catch(function (e) { st.textContent = e.message; });
    }

    load();
    UI.on("files-changed", load);

    built.body.appendChild(list);
    built.body.appendChild(status);
    cdriveWindow = { win: built.win, refresh: load };
    return cdriveWindow;
  }

  /* The Recycle Bin is honest about what it holds: files you deleted are
     gone, so it shows an empty bin and says so. */
  function openRecycleBin() {
    const built = UI.makeWindow({
      title: "Recycle Bin",
      icon: "assets/recycle-bin-32x32.png",
      width: 420, height: 260, x: 300, y: 220
    });

    const list = el("div", "w98-filelist");
    list.appendChild(el("div", "w98-hint",
      "The Recycle Bin is empty. Files you delete from My Documents are removed " +
      "straight away, so there is nothing here to restore."));

    const status = el("div", "w98-statusbar");
    status.appendChild(el("span", null, "0 object(s)"));

    const bar = el("div", "w98-toolbar");
    const emptyBtn = el("button", "w98-tool", "Empty Recycle Bin");
    emptyBtn.type = "button";
    emptyBtn.addEventListener("click", function () {
      UI.infoBox("Recycle Bin", "It is already empty.");
    });
    bar.appendChild(emptyBtn);

    built.body.appendChild(bar);
    built.body.appendChild(list);
    built.body.appendChild(status);
    return built;
  }

  /* Network Neighbourhood shows the other accounts on this machine. */
  function openNetwork() {
    const built = UI.makeWindow({
      title: "Network Neighbourhood",
      icon: "assets/network-32x32.png",
      width: 480, height: 320, x: 280, y: 180
    });

    const list = el("div", "w98-filelist");
    const status = el("div", "w98-statusbar");
    const st = el("span", null, "Browsing...");
    status.appendChild(st);

    LD.mailRecipients().then(function (res) {
      const users = res.users || [];
      if (!users.length) {
        list.appendChild(el("div", "w98-hint", "No other computers on the network."));
      }
      users.forEach(function (u) {
        const row = el("div", "w98-filerow w98-pickrow");
        row.tabIndex = 0;
        const icon = el("img");
        icon.src = "assets/my-computer-32x32.png";
        icon.alt = "";
        row.appendChild(icon);
        row.appendChild(el("span", "w98-filename", "\\\\LETTERDROP\\" + u.username));
        row.appendChild(el("span", "w98-filekind", "Computer"));

        const go = function () { LDApps.openDocuments({ userId: u.id, title: u.username + "'s Documents" }); };
        row.addEventListener("dblclick", go);
        row.addEventListener("click", go);
        row.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); go(); }
        });
        list.appendChild(row);
      });
      st.textContent = users.length + " computer(s) on the network";
    }).catch(function (e) { st.textContent = e.message; });

    built.body.appendChild(list);
    built.body.appendChild(status);
    return built;
  }

  /* ============================================================
     Pipes

     A grid of pipe pieces that can be turned. Water starts at the tap and
     spreads through anything joined to it; the aim is to reach every
     outlet.

     A piece is a bitmask of which of its four sides are open, so turning
     it a quarter clockwise is a bit rotation. That is what keeps the
     whole game small: a shape is a number and a turn is arithmetic.
     ============================================================ */

  const PIPE_UP = 1, PIPE_RIGHT = 2, PIPE_DOWN = 4, PIPE_LEFT = 8;

  /* Every shape the generator may hand out.

     A cross (all four sides open) is deliberately absent: it is identical
     in every orientation, so turning it does nothing and it can never help
     or hinder a connection. Including it would just sprinkle dead pieces
     across the board. */
  const PIPE_SHAPES = [
    PIPE_UP | PIPE_DOWN,
    PIPE_LEFT | PIPE_RIGHT,
    PIPE_UP | PIPE_RIGHT,
    PIPE_RIGHT | PIPE_DOWN,
    PIPE_DOWN | PIPE_LEFT,
    PIPE_LEFT | PIPE_UP,
    PIPE_UP | PIPE_RIGHT | PIPE_DOWN,
    PIPE_UP | PIPE_RIGHT | PIPE_LEFT,
    PIPE_UP | PIPE_DOWN | PIPE_LEFT,
    PIPE_RIGHT | PIPE_DOWN | PIPE_LEFT
  ];

  const PIPE_LEVELS = [
    { name: "Warm-up", size: 5 },
    { name: "Trickle", size: 6 },
    { name: "Flow", size: 7 }
  ];

  /* Turn a piece a quarter clockwise: each side moves one place round the
     compass, and the one falling off the top comes back at the bottom. */
  function rotateMask(mask) {
    return ((mask << 1) | (mask >> 3)) & 0xF;
  }

  const OPPOSITE = { 1: 4, 2: 8, 4: 1, 8: 2 };

  let pipesWindow = null;

  function openPipes() {
    if (pipesWindow && !pipesWindow.win.hidden) {
      UI.focusWindow(pipesWindow.win);
      return pipesWindow;
    }

    const built = UI.makeWindow({
      title: "Pipes",
      icon: "assets/pipes-32x32.png",
      width: 560, height: 580, x: 220, y: 50
    });

    const bar = el("div", "pipes-bar");
    const levelLabel = el("span", "pipes-level", "");
    const movesLabel = el("span", "pipes-moves", "");
    bar.appendChild(levelLabel);
    bar.appendChild(movesLabel);

    const newBtn = el("button", "pipes-btn", "New board");
    newBtn.type = "button";
    bar.appendChild(newBtn);

    const smaller = el("button", "pipes-btn", "Smaller");
    smaller.type = "button";
    bar.appendChild(smaller);

    const bigger = el("button", "pipes-btn", "Bigger");
    bigger.type = "button";
    bar.appendChild(bigger);

    const wrap = el("div", "pipes-wrap");
    const canvas = document.createElement("canvas");
    canvas.className = "pipes-canvas";
    canvas.setAttribute("aria-label", "Pipe board. Click a piece to turn it.");
    wrap.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    const progress = el("div", "pipes-progress", "");
    const status = el("div", "pipes-status", "Click a piece to turn it.");

    built.body.appendChild(bar);
    built.body.appendChild(wrap);
    built.body.appendChild(progress);
    built.body.appendChild(status);

    let level = 0;
    let size = PIPE_LEVELS[0].size;
    let grid = [];       // { mask, fixed }
    let source = 0;
    let drains = [];
    let moves = 0;
    let solved = false;
    let cell = 60;

    function at(x, y) { return y * size + x; }

    function neighbours(i) {
      const x = i % size, y = Math.floor(i / size);
      const out = [];
      if (y > 0) out.push({ at: at(x, y - 1), side: PIPE_UP });
      if (x < size - 1) out.push({ at: at(x + 1, y), side: PIPE_RIGHT });
      if (y < size - 1) out.push({ at: at(x, y + 1), side: PIPE_DOWN });
      if (x > 0) out.push({ at: at(x - 1, y), side: PIPE_LEFT });
      return out;
    }

    function newBoard(nextSize) {
      if (nextSize) size = nextSize;
      moves = 0;
      solved = false;

      grid = [];
      for (let i = 0; i < size * size; i++) {
        grid.push({
          mask: PIPE_SHAPES[Math.floor(Math.random() * PIPE_SHAPES.length)],
          fixed: false
        });
      }

      // the tap sits on the top edge and never turns
      source = at(Math.floor(Math.random() * size), 0);
      grid[source].fixed = true;

      // outlets go on the edges, never on the tap
      drains = [];
      const wanted = Math.max(2, Math.round(size / 2));
      const taken = {};
      taken[source] = true;

      let guard = 0;
      while (drains.length < wanted && guard++ < 500) {
        const edge = Math.floor(Math.random() * 4);
        let x, y;
        if (edge === 0) { x = Math.floor(Math.random() * size); y = 0; }
        else if (edge === 1) { x = size - 1; y = Math.floor(Math.random() * size); }
        else if (edge === 2) { x = Math.floor(Math.random() * size); y = size - 1; }
        else { x = 0; y = Math.floor(Math.random() * size); }

        const i = at(x, y);
        if (taken[i]) continue;
        taken[i] = true;
        drains.push(i);
        grid[i].fixed = true;
      }

      /* Bend the tap's own piece so it opens onto the board, and make at
         least one neighbour reach back. Without this the tap can end up
         sealed off, and the player opens to a board with no water in it
         at all, which just looks broken. */
      openTheTap();

      /* Turn things until the board is not already solved, so there is
         always something to do. */
      for (let attempt = 0; attempt < 80; attempt++) {
        grid.forEach(function (c) { if (!c.fixed) c.mask = rotateMask(c.mask); });
        if (!isSolved()) break;
      }

      /* Shuffling can seal the tap again, so this is re-checked and, if
         necessary, a piece next to the tap is bent back towards it. */
      ensureWaterFlows();

      paintAll();
      report();
    }

    /* Point the tap into the board and give it somewhere to go.

       The tap opens along one edge, plus every other edge direction that
       is actually on the board. Making it a straight through to the
       outside would open it into a wall, which is how a board ended up
       with no water in it. */
    function openTheTap() {
      const x = source % size, y = Math.floor(source / size);

      // every direction that leads to a real neighbour
      const inward = [];
      if (y > 0) inward.push(PIPE_UP);
      if (x < size - 1) inward.push(PIPE_RIGHT);
      if (y < size - 1) inward.push(PIPE_DOWN);
      if (x > 0) inward.push(PIPE_LEFT);

      /* An edge tap opens inward; a tap with two usable directions (a
         corner) opens both ways, which gives the water a better start. */
      const onEdge = (y === 0) || (y === size - 1) || (x === 0) || (x === size - 1);
      let mask = 0;

      if (onEdge) {
        // the inward direction is whichever axis points away from the edge
        const primary = [];
        if (y === 0) primary.push(PIPE_DOWN);
        if (y === size - 1) primary.push(PIPE_UP);
        if (x === 0) primary.push(PIPE_RIGHT);
        if (x === size - 1) primary.push(PIPE_LEFT);
        mask |= primary[Math.floor(Math.random() * primary.length)];

        // in a corner, add the other usable direction so it is not a stub
        if (primary.length === 2) mask |= primary[0] | primary[1];
      } else {
        mask |= inward[Math.floor(Math.random() * inward.length)];
      }

      // never open towards nothing
      mask &= inward.reduce(function (a, d) { return a | d; }, 0);
      if (!mask) mask = inward[0];

      grid[source].mask = mask;
    }

    /* Guarantee the water has at least one neighbour to reach.

       Both ends have to agree: the tap must open towards the neighbour,
       and the neighbour must open back. The tap only opens along the
       direction `openTheTap` chose, so the candidate is picked from that
       side rather than from all four. */
    function ensureWaterFlows() {
      if (Object.keys(watered()).length > 1) return;

      const tapMask = grid[source].mask;
      // the sides the tap actually opens onto
      const openSides = neighbours(source).filter(function (n) {
        return (tapMask & n.side) && !grid[n.at].fixed;
      });
      if (!openSides.length) return;

      const pick = openSides[Math.floor(Math.random() * openSides.length)];
      // rotate the neighbour until it opens back towards the tap
      for (let i = 0; i < 4; i++) {
        if (grid[pick.at].mask & OPPOSITE[pick.side]) return;
        grid[pick.at].mask = rotateMask(grid[pick.at].mask);
      }
    }

    /* Which cells the water reaches. Two pieces join only if each opens
       towards the other, which is what stops water crossing a gap. */
    function watered() {
      const seen = {};
      const stack = [source];
      seen[source] = true;

      while (stack.length) {
        const i = stack.pop();
        const mask = grid[i].mask;
        neighbours(i).forEach(function (n) {
          if (seen[n.at]) return;
          if (!(mask & n.side)) return;
          if (!(grid[n.at].mask & OPPOSITE[n.side])) return;
          seen[n.at] = true;
          stack.push(n.at);
        });
      }
      return seen;
    }

    function isSolved() {
      const wet = watered();
      return drains.every(function (d) { return wet[d]; });
    }

    function report() {
      const wet = watered();
      const reached = drains.filter(function (d) { return wet[d]; }).length;
      const info = PIPE_LEVELS[level] || PIPE_LEVELS[0];

      levelLabel.textContent = info.name + " \u00B7 " + size + "\u00D7" + size;
      movesLabel.textContent = moves + (moves === 1 ? " turn" : " turns");

      progress.textContent = "Water reaching " + reached + " of " + drains.length +
        " outlets";
      progress.className = "pipes-progress" +
        (reached === drains.length ? " is-done" : "");

      if (reached === drains.length) {
        if (!solved) {
          solved = true;
          status.textContent = "Flowing. Finished in " + moves +
            (moves === 1 ? " turn." : " turns.");
          if (window.LDSound) LDSound.play("ok");
        }
      } else {
        solved = false;
        status.textContent = "Click a piece to turn it. Right-click turns the other way.";
      }
    }

    /* ---------- drawing ---------- */

    function paintAll() {
      const box = wrap.getBoundingClientRect();
      // fit the board into whatever space the window is giving it
      const avail = Math.max(150, Math.min(box.width - 6, box.height - 6));
      cell = Math.max(18, Math.floor(avail / size));

      canvas.width = cell * size;
      canvas.height = cell * size;
      canvas.style.width = canvas.width + "px";
      canvas.style.height = canvas.height + "px";

      const wet = watered();

      ctx.fillStyle = "#0d1a12";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < grid.length; i++) {
        drawCell((i % size) * cell, Math.floor(i / size) * cell,
          grid[i], Boolean(wet[i]), i === source, drains.indexOf(i) !== -1);
      }

      // faint grid lines, so the pieces are countable
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let n = 1; n < size; n++) {
        ctx.beginPath();
        ctx.moveTo(n * cell, 0); ctx.lineTo(n * cell, canvas.height);
        ctx.moveTo(0, n * cell); ctx.lineTo(canvas.width, n * cell);
        ctx.stroke();
      }
    }

    function drawCell(x, y, c, isWet, isSource, isDrain) {
      const mid = cell / 2;
      const width = Math.max(3, Math.round(cell * 0.2));
      const colour = isWet ? "#4fd1ff" : "#2f7a55";

      const arms = [
        [PIPE_UP, mid, 0],
        [PIPE_RIGHT, cell, mid],
        [PIPE_DOWN, mid, cell],
        [PIPE_LEFT, 0, mid]
      ];

      // the body: one arm per open side, drawn at full width so joins meet
      ctx.strokeStyle = colour;
      ctx.lineCap = "round";
      ctx.lineWidth = width;
      arms.forEach(function (a) {
        if (!(c.mask & a[0])) return;
        ctx.beginPath();
        ctx.moveTo(x + mid, y + mid);
        ctx.lineTo(x + a[1], y + a[2]);
        ctx.stroke();
      });

      ctx.beginPath();
      ctx.arc(x + mid, y + mid, width * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();

      // a lit pipe glows, which is what makes the water legible
      if (isWet) {
        ctx.save();
        ctx.shadowColor = "#4fd1ff";
        ctx.shadowBlur = 7;
        ctx.strokeStyle = "rgba(150, 232, 255, 0.55)";
        ctx.lineWidth = Math.max(1, width * 0.3);
        arms.forEach(function (a) {
          if (!(c.mask & a[0])) return;
          ctx.beginPath();
          ctx.moveTo(x + mid, y + mid);
          ctx.lineTo(x + a[1], y + a[2]);
          ctx.stroke();
        });
        ctx.restore();
      }

      if (isSource) {
        ctx.fillStyle = "#ffd36e";
        ctx.beginPath();
        ctx.arc(x + mid, y + mid, Math.max(3, cell * 0.13), 0, Math.PI * 2);
        ctx.fill();
      }

      if (isDrain) {
        ctx.strokeStyle = isWet ? "#8ef0a8" : "#6f6033";
        ctx.lineWidth = Math.max(2, cell * 0.07);
        ctx.beginPath();
        ctx.arc(x + mid, y + mid, Math.max(4, cell * 0.25), 0, Math.PI * 2);
        ctx.stroke();
        if (isWet) {
          ctx.fillStyle = "rgba(142, 240, 168, 0.3)";
          ctx.fill();
        }
      }

      // fixed pieces get a corner pip, so it is clear they will not turn
      if (c.fixed) {
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.fillRect(x + 3, y + 3, 3, 3);
      }
    }

    /* ---------- playing ---------- */

    function cellAt(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      // CSS may have scaled the canvas, so map back into board space
      const col = Math.floor(((clientX - r.left) / r.width) * size);
      const row = Math.floor(((clientY - r.top) / r.height) * size);
      if (col < 0 || row < 0 || col >= size || row >= size) return -1;
      return at(col, row);
    }

    function turn(i) {
      if (solved || i < 0 || !grid[i]) return false;
      if (grid[i].fixed) {
        status.textContent = "That piece is fixed \u2014 the tap and the outlets do not turn.";
        return false;
      }

      /* A cross is the same in all four orientations, so turning one would
         silently cost a move and look broken. Say so instead. */
      if (grid[i].mask === (PIPE_UP | PIPE_RIGHT | PIPE_DOWN | PIPE_LEFT)) {
        status.textContent = "That piece is a cross \u2014 turning it makes no difference.";
        return false;
      }

      grid[i].mask = rotateMask(grid[i].mask);
      moves++;
      if (window.LDSound) LDSound.play("click");
      paintAll();
      report();
      return true;
    }

    canvas.addEventListener("click", function (e) {
      turn(cellAt(e.clientX, e.clientY));
    });

    canvas.addEventListener("contextmenu", function (e) {
      // right-click turns anticlockwise, which saves three clicks on a tee
      e.preventDefault();
      const i = cellAt(e.clientX, e.clientY);
      if (solved || i < 0 || !grid[i] || grid[i].fixed) return;
      grid[i].mask = rotateMask(rotateMask(rotateMask(grid[i].mask)));
      moves++;
      paintAll();
      report();
    });

    newBtn.addEventListener("click", function () { newBoard(); });
    smaller.addEventListener("click", function () {
      level = Math.max(0, level - 1);
      newBoard(PIPE_LEVELS[level].size);
    });
    bigger.addEventListener("click", function () {
      level = Math.min(PIPE_LEVELS.length - 1, level + 1);
      newBoard(PIPE_LEVELS[level].size);
    });

    // resizing the window has to re-fit the board
    UI.on("window-resized", function (e) {
      if (e && e.win === built.win) paintAll();
    });

    newBoard(PIPE_LEVELS[0].size);
    // the canvas needs a layout pass before its size is known
    setTimeout(paintAll, 60);

    pipesWindow = {
      win: built.win,
      grid: function () { return grid; },
      watered: watered,
      isSolved: isSolved,
      moves: function () { return moves; },
      size: function () { return size; },
      source: function () { return source; },
      drains: function () { return drains; },
      turn: turn,
      repaint: paintAll
    };
    return pipesWindow;
  }

  global.LDPrograms = {
    init: init,
    openCalculator: openCalculator,
    openDos: openDos,
    openPaint: openPaint,
    openMinesweeper: openMinesweeper,
    openComputer: openComputer,
    openRecycleBin: openRecycleBin,
    openNetwork: openNetwork,
    openPipes: openPipes,
    rotateMask: rotateMask,
    PIPE_SHAPES: PIPE_SHAPES
  };
})(window);
