/* ============================================================
   Letterdrop — 2000s desktop shell
   Boots into a Windows-98-style desktop, dials up to AOL, and
   opens the letter as an email. Almost everything is a decoy:
   clicking it raises an "illegal action" dialog, which is the
   joke. The two things that actually work are Start and the
   email.
   ============================================================ */

(function () {
  "use strict";

  /* ---------- Elements ---------- */
  const $ = (id) => document.getElementById(id);

  const desktop   = $("desktop");
  const iconLayer = $("iconLayer");
  const taskList  = $("taskList");
  const startBtn  = $("startBtn");
  const startMenu = $("startMenu");
  const startItems= $("startItems");
  const trayClock = $("trayClock");

  const bios      = $("bios");
  const biosLines = $("biosLines");
  const biosPrompt= $("biosPrompt");
  const boot      = $("boot");
  const aol       = $("aol");
  const aolArt    = $("aolArt");
  const aolStatus = $("aolStatus");
  const aolBar    = $("aolBar");
  const aolHeading= $("aolHeading");
  const aolSub    = $("aolSub");
  const aolSkip   = $("aolSkip");

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ============================================================
     Entry

     There is one way in: the desktop boots, and you sign in. The old
     encoded-link "letter" is gone -- mail between accounts replaced it,
     so nothing is read out of the URL any more.
     ============================================================ */

  /* ============================================================
     Window manager
     ============================================================ */

  let zTop = 100;
  let offset = 0;

  function focusWindow(win) {
    Array.prototype.forEach.call(
      document.querySelectorAll(".w98-win"),
      function (w) { w.classList.add("is-blurred"); }
    );
    win.classList.remove("is-blurred");
    win.style.zIndex = String(++zTop);
    syncTaskbar();
  }

  function syncTaskbar() {
    const wins = document.querySelectorAll(".w98-win");
    taskList.textContent = "";
    Array.prototype.forEach.call(wins, function (w) {
      if (w.hidden) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "w98-task" +
        (w.classList.contains("is-blurred") ? "" : " is-active");
      const img = document.createElement("img");
      img.src = w.dataset.icon || "assets/notepad-32x32.png";
      img.alt = "";
      const span = document.createElement("span");
      span.textContent = w.dataset.title || "Window";
      b.appendChild(img);
      b.appendChild(span);
      b.addEventListener("click", function () {
        if (w.classList.contains("is-blurred")) {
          focusWindow(w);
        } else {
          w.hidden = true;
          syncTaskbar();
        }
      });
      taskList.appendChild(b);
    });
  }

  /* Build a Win98 window. `size` is optional; windows are clamped to the
     viewport so nothing can be dragged off-screen. */
  function makeWindow(opts) {
    const win = document.createElement("div");
    win.className = "w98-win w98-raised";
    win.dataset.title = opts.title;
    win.dataset.icon = opts.icon || "assets/notepad-32x32.png";

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(opts.width || 480, vw - 16);
    const h = Math.min(opts.height || 360, vh - 60);

    // cascade successive windows so they don't stack exactly
    const x = Math.max(4, Math.min((opts.x != null ? opts.x : 60 + offset * 26), vw - w - 4));
    const y = Math.max(4, Math.min((opts.y != null ? opts.y : 40 + offset * 22), vh - h - 40));
    offset++;

    win.style.left = x + "px";
    win.style.top = y + "px";
    win.style.width = w + "px";
    win.style.height = h + "px";

    /* title bar */
    const bar = document.createElement("div");
    bar.className = "w98-title";

    const ico = document.createElement("img");
    ico.src = win.dataset.icon;
    ico.alt = "";

    const text = document.createElement("span");
    text.className = "w98-title-text";
    text.textContent = opts.title;

    const btns = document.createElement("div");
    btns.className = "w98-title-btns";

    const min = document.createElement("button");
    min.type = "button";
    min.className = "w98-tbtn min";
    min.setAttribute("aria-label", "Minimise");
    min.addEventListener("click", function (e) {
      e.stopPropagation();
      win.hidden = true;
      syncTaskbar();
    });

    const max = document.createElement("button");
    max.type = "button";
    max.className = "w98-tbtn max";
    max.setAttribute("aria-label", "Maximise");
    max.addEventListener("click", function (e) {
      e.stopPropagation();
      maximise(win);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "w98-tbtn close";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", function (e) {
      e.stopPropagation();
      win.hidden = true;
      syncTaskbar();
    });

    btns.appendChild(min);
    btns.appendChild(max);
    btns.appendChild(close);

    bar.appendChild(ico);
    bar.appendChild(text);
    bar.appendChild(btns);

    /* body */
    const body = document.createElement("div");
    body.className = "w98-body";

    win.appendChild(bar);
    win.appendChild(body);

    win.addEventListener("mousedown", function () { focusWindow(win); });
    makeDraggable(win, bar);
    makeResizable(win);

    desktop.appendChild(win);
    focusWindow(win);
    return { win: win, body: body };
  }

  function maximise(win) {
    if (win.dataset.maxed === "1") {
      win.style.left = win.dataset.restoreL;
      win.style.top = win.dataset.restoreT;
      win.style.width = win.dataset.restoreW;
      win.style.height = win.dataset.restoreH;
      win.dataset.maxed = "0";
      return;
    }
    win.dataset.restoreL = win.style.left;
    win.dataset.restoreT = win.style.top;
    win.dataset.restoreW = win.style.width;
    win.dataset.restoreH = win.style.height;
    win.dataset.maxed = "1";
    win.style.left = "0px";
    win.style.top = "0px";
    win.style.width = "100%";
    win.style.height = "calc(100% - 28px)";
  }

  /* ---------- resizing ----------
     Eight handles around the frame: four edges and four corners. A window
     remembers its own smallest sensible size, and none of them can be
     dragged smaller than that or off the top-left of the screen. */

  const RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  function makeResizable(win) {
    // growable past its opening size, but never below something usable
    const minW = Math.min(200, win.offsetWidth || 200);
    const minH = Math.min(140, win.offsetHeight || 140);
    win.dataset.minW = String(minW);
    win.dataset.minH = String(minH);

    RESIZE_DIRS.forEach(function (dir) {
      const grip = document.createElement("div");
      grip.className = "w98-grip w98-grip-" + dir;
      grip.dataset.dir = dir;
      grip.setAttribute("aria-hidden", "true");
      win.appendChild(grip);

      grip.addEventListener("mousedown", function (e) {
        if (win.dataset.maxed === "1") return;
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX, startY = e.clientY;
        const startW = win.offsetWidth, startH = win.offsetHeight;
        const startL = win.offsetLeft, startT = win.offsetTop;
        const vw = window.innerWidth;

        const move = function (ev) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;

          let w = startW, h = startH, l = startL, t = startT;

          if (dir.indexOf("e") !== -1) w = startW + dx;
          if (dir.indexOf("s") !== -1) h = startH + dy;
          if (dir.indexOf("w") !== -1) { w = startW - dx; l = startL + dx; }
          if (dir.indexOf("n") !== -1) { h = startH - dy; t = startT + dy; }

          // never smaller than the minimum; move the origin back so the
          // opposite edge stays put when we hit the floor
          if (w < minW) { if (dir.indexOf("w") !== -1) l -= (minW - w); w = minW; }
          if (h < minH) { if (dir.indexOf("n") !== -1) t -= (minH - h); h = minH; }

          // do not let the frame run off the left or top
          if (l < 0) { if (dir.indexOf("w") !== -1) w += l; l = 0; }
          if (t < 0) { if (dir.indexOf("n") !== -1) h += t; t = 0; }
          if (w < minW) w = minW;
          if (h < minH) h = minH;

          // and keep it from growing wider than the desktop
          const maxW = vw - l;
          if (w > maxW) w = maxW;

          win.style.width = Math.round(w) + "px";
          win.style.height = Math.round(h) + "px";
          win.style.left = Math.round(l) + "px";
          win.style.top = Math.round(t) + "px";
        };

        const up = function () {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
          win.classList.remove("is-resizing");
          // let anything inside re-measure (a canvas, the Paint board)
          broadcast("window-resized", { win: win, width: win.offsetWidth, height: win.offsetHeight });
        };

        const cursors = {
          n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
          ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize"
        };
        document.body.style.cursor = cursors[dir] || "nwse-resize";
        win.classList.add("is-resizing");
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    });
  }

  /* Drag by the title bar. Position is clamped so the bar stays reachable. */
  function makeDraggable(win, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

    handle.addEventListener("mousedown", function (e) {
      if (e.target.closest(".w98-tbtn")) return;
      if (win.dataset.maxed === "1") return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = win.offsetLeft; oy = win.offsetTop;
      document.body.style.cursor = "move";
      e.preventDefault();
    });

    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      const vw = window.innerWidth, vh = window.innerHeight;
      let nx = ox + (e.clientX - sx);
      let ny = oy + (e.clientY - sy);
      nx = Math.max(-win.offsetWidth + 60, Math.min(nx, vw - 60));
      ny = Math.max(0, Math.min(ny, vh - 50));
      win.style.left = nx + "px";
      win.style.top = ny + "px";
    });

    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
    });
  }

  /* ============================================================
     Dialogs — the "illegal operation" gag
     ============================================================ */

  let dialogOffset = 0;

  const ILLEGAL_MESSAGES = [
    "This program has performed an illegal operation\nand will be shut down.\n\nIf the problem persists, contact the program vendor.",
    "This program has performed an illegal operation\nand will be shut down.\n\nLETTERDROP caused an invalid page fault\nin module KRNL386.EXE at 0002:00001f4c.",
    "This program has performed an illegal operation\nand will be shut down.\n\nAn exception 0E has occurred at 0028:C0011E36.",
    "This program has performed an illegal operation\nand will be shut down.\n\nStack overflow — too many windows are open.",
    "This program has performed an illegal operation\nand will be shut down.\n\nThe system is not responding.\nPress any key to continue. (Pressing a key will do nothing.)"
  ];

  let illegalIndex = 0;

  const DIALOG_ICONS = [
    "assets/recycle-bin-32x32.png",
    "assets/my-computer-32x32.png",
    "assets/network-32x32.png",
    "assets/task-scheduler-16x16.png"
  ];

  function showDialog(titleText, message, opts) {
    const o = opts || {};
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(o.width || 380, vw - 24);

    const dlg = document.createElement("div");
    dlg.className = "w98-dialog w98-raised";
    dlg.setAttribute("role", "alertdialog");
    dlg.style.width = w + "px";
    dlg.style.left = Math.max(8, (vw - w) / 2 + (dialogOffset % 5) * 18 - 36) + "px";
    dlg.style.top = Math.max(8, Math.min(vh * 0.3 + (dialogOffset % 5) * 22, vh - 200)) + "px";
    dialogOffset++;

    const bar = document.createElement("div");
    bar.className = "w98-title";
    const txt = document.createElement("span");
    txt.className = "w98-title-text";
    txt.textContent = titleText;
    bar.appendChild(txt);

    const bts = document.createElement("div");
    bts.className = "w98-title-btns";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "w98-tbtn close";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", function () { dlg.remove(); });
    bts.appendChild(x);
    bar.appendChild(bts);

    const body = document.createElement("div");
    body.className = "w98-dialog-body";

    const ico = document.createElement("img");
    ico.className = "w98-dialog-icon";
    ico.src = o.icon || DIALOG_ICONS[illegalIndex % DIALOG_ICONS.length];
    ico.alt = "";

    const msg = document.createElement("div");
    msg.className = "w98-dialog-msg";
    // textContent, never innerHTML: the message is ours but this keeps the rule
    msg.textContent = message;

    body.appendChild(ico);
    body.appendChild(msg);

    const acts = document.createElement("div");
    acts.className = "w98-dialog-actions";

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "w98-btn";
    ok.textContent = o.okText || "OK";
    ok.addEventListener("click", function () {
      dlg.remove();
      if (o.onOk) o.onOk();
    });
    acts.appendChild(ok);

    if (o.second) {
      const b2 = document.createElement("button");
      b2.type = "button";
      b2.className = "w98-btn";
      b2.textContent = o.second;
      b2.addEventListener("click", function () {
        dlg.remove();
        if (o.onSecond) o.onSecond();
      });
      acts.appendChild(b2);
    }

    dlg.appendChild(bar);
    dlg.appendChild(body);
    dlg.appendChild(acts);
    desktop.appendChild(dlg);

    ok.focus({ preventScroll: true });
    return dlg;
  }

  /* The house speciality: anything that isn't meant to work says so. */
  function illegalAction(what) {
    const message = ILLEGAL_MESSAGES[illegalIndex % ILLEGAL_MESSAGES.length];
    illegalIndex++;
    // the thunk that always accompanied one of these
    if (window.LDSound) LDSound.play("error");
    showDialog(what ? (what + " — Error") : "Error", message,
      { icon: DIALOG_ICONS[illegalIndex % DIALOG_ICONS.length] });
  }

  /* ---------- small event bus ----------
     Lets one window tell another that the file list changed, without
     either needing to know about the other. */
  const listeners = {};
  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
  }
  function broadcast(name, payload) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) {}
    });
  }

  function infoBox(title, message) {
    if (window.LDSound) LDSound.play("notify");
    showDialog(title, message, { okText: "OK" });
  }

  function errorBox(title, message) {
    if (window.LDSound) LDSound.play("error");
    showDialog(title + " — Error", message,
      { okText: "OK", icon: "assets/recycle-bin-32x32.png" });
  }

  /* ============================================================
     Notifications

     The little panel that slides out of the system tray, the way Windows
     did for a new message. Used when something arrives while you are
     looking at another program and a modal box would be rude.

     Several stack upward, each fades on its own, and any of them can be
     dismissed by clicking. A click also runs the action it carries, so a
     message notification takes you to the conversation.
     ============================================================ */

  let notifyHost = null;
  const NOTIFY_MS = 6000;
  const MAX_NOTIFY = 4;

  function notify(opts) {
    const o = opts || {};
    if (!o.title && !o.body) return null;

    if (!notifyHost) {
      notifyHost = document.createElement("div");
      notifyHost.className = "w98-notify-host";
      notifyHost.setAttribute("role", "status");
      notifyHost.setAttribute("aria-live", "polite");
      document.body.appendChild(notifyHost);
    }

    // a burst of messages should not paper over the screen
    while (notifyHost.children.length >= MAX_NOTIFY) {
      notifyHost.removeChild(notifyHost.firstChild);
    }

    const card = document.createElement("div");
    card.className = "w98-notify w98-raised";

    const bar = document.createElement("div");
    bar.className = "w98-notify-bar";
    const label = document.createElement("span");
    label.textContent = o.title || "Letterdrop";
    bar.appendChild(label);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "w98-notify-x";
    close.textContent = "\u00D7";
    close.setAttribute("aria-label", "Dismiss");
    bar.appendChild(close);

    const body = document.createElement("div");
    body.className = "w98-notify-body";

    const icon = document.createElement("img");
    icon.src = o.icon || "assets/aim.png";
    icon.alt = "";
    body.appendChild(icon);

    const text = document.createElement("div");
    text.className = "w98-notify-text";
    if (o.heading) {
      const h = document.createElement("div");
      h.className = "w98-notify-heading";
      h.textContent = o.heading;
      text.appendChild(h);
    }
    const p = document.createElement("div");
    p.className = "w98-notify-message";
    p.textContent = o.body || "";
    text.appendChild(p);
    body.appendChild(text);

    card.appendChild(bar);
    card.appendChild(body);

    let closed = false;
    function dismiss() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      card.classList.add("is-going");
      setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
      }, 220);
    }

    const timer = setTimeout(dismiss, o.duration || NOTIFY_MS);

    close.addEventListener("click", function (e) {
      e.stopPropagation();
      dismiss();
    });

    card.addEventListener("click", function () {
      dismiss();
      if (typeof o.onClick === "function") o.onClick();
    });

    // a notification you are hovering over should not vanish mid-read
    card.addEventListener("mouseenter", function () { clearTimeout(timer); });
    card.addEventListener("mouseleave", function () {
      if (!closed) setTimeout(dismiss, 1800);
    });

    notifyHost.appendChild(card);
    return card;
  }

  function confirmBox(title, message, onYes) {
    showDialog(title, message, {
      okText: "Yes",
      second: "No",
      icon: "assets/my-computer-32x32.png",
      onOk: onYes
    });
  }

  /* ============================================================
     Desktop icons
     ============================================================ */

  /* Most of these exist only to fail entertainingly. An entry with an `app`
     actually opens something; everything else raises the illegal-operation
     dialog. */
  const ICONS = [
    { id: "documents",  label: "My Documents",       icon: "assets/my-documents-folder-32x32.png", app: "documents" },
    { id: "notepad",    label: "Notepad",            icon: "assets/notepad-32x32.png",            app: "notepad" },
    { id: "accounts",   label: "User Accounts",      icon: "assets/network-32x32.png",            app: "accounts", adminOnly: true },
    { id: "control",    label: "Control Panel",      icon: "assets/task-scheduler-16x16.png",     app: "control", adminOnly: true },
    { id: "mycomputer", label: "My Computer",        icon: "assets/my-computer-32x32.png",        app: "mycomputer" },
    { id: "network",    label: "Network Neighbourhood", icon: "assets/network-32x32.png",         app: "network" },
    { id: "recycle",    label: "Recycle Bin",        icon: "assets/recycle-bin-32x32.png",        app: "recycle" },
    { id: "ie",         label: "Internet Explorer",  icon: "assets/internet-explorer-32x32.png",  msg: "IEXPLORE" },
    { id: "outlook",    label: "Inbox",              icon: "assets/notepad-file-32x32.png",       msg: "Inbox", mail: true },
    { id: "aim",        label: "AIM",                icon: "assets/aim.png",                      app: "aim" },
    { id: "newletter",  label: "Write a Letter",     icon: "assets/notepad-file-32x32.png",       app: "newletter" },
    { id: "profile",    label: "My Profile",         icon: "assets/my-computer-32x32.png",        app: "profile" },
    { id: "find",       label: "Find",               icon: "assets/internet-explorer-32x32.png",  app: "find" },
    { id: "winamp",     label: "Winamp",             icon: "assets/winamp2-32x32.png",            app: "winamp" },
    { id: "minesweeper",label: "Minesweeper",        icon: "assets/minesweeper-32x32.png",        app: "minesweeper" },
    { id: "solitaire",  label: "Solitaire",          icon: "assets/solitaire-32x32.png",          msg: "SOL" },
    { id: "pinball",    label: "3D Pinball",         icon: "assets/pinball-32x32.png",            msg: "PINBALL" },
    { id: "paint",      label: "Paint",              icon: "assets/paint-32x32.png",              app: "paint" },
    { id: "calculator", label: "Calculator",         icon: "assets/calculator-32x32.png",         app: "calculator" },
    { id: "msdos",      label: "MS-DOS Prompt",      icon: "assets/msdos-32x32.png",              app: "msdos" },
    { id: "pipes",      label: "Pipes",              icon: "assets/pipes-32x32.png",              app: "pipes" },
    { id: "folder",     label: "Downloads",          icon: "assets/folder-32x32.png",             msg: "Windows Explorer" }
  ];

  let selectedIcon = null;

  /* ============================================================
     Desktop icons

     Icons sit wherever you put them. Positions are kept in localStorage
     keyed by the icon's id, so a layout survives a reload, and a "Tidy up"
     action in the desktop's context menu puts them back in their columns.
     ============================================================ */

  const ICON_W = 84;
  const ICON_H = 76;
  const ICON_KEY = "letterdrop.icons";

  function loadIconPositions() {
    try {
      const raw = localStorage.getItem(ICON_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveIconPositions(positions) {
    try { localStorage.setItem(ICON_KEY, JSON.stringify(positions)); } catch (e) {}
  }

  let iconPositions = loadIconPositions();

  /* Where an icon goes if it has never been moved: down the first column,
     then the next, filling the height before wrapping -- which is how the
     real desktop behaved. */
  function defaultIconPosition(index) {
    const box = iconLayer.getBoundingClientRect();
    const pad = 8;
    const usableH = Math.max(ICON_H, box.height - pad * 2);
    const perColumn = Math.max(1, Math.floor(usableH / ICON_H));
    const col = Math.floor(index / perColumn);
    const row = index % perColumn;
    return { x: pad + col * ICON_W, y: pad + row * ICON_H };
  }

  function placeIcon(el, pos) {
    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";
  }

  /* Keep an icon inside the desktop, so one cannot be dragged somewhere it
     can never be grabbed again. */
  function clampIcon(x, y) {
    const box = iconLayer.getBoundingClientRect();
    const maxX = Math.max(0, box.width - ICON_W - 4);
    const maxY = Math.max(0, box.height - ICON_H - 4);
    return {
      x: Math.max(0, Math.min(Math.round(x), maxX)),
      y: Math.max(0, Math.min(Math.round(y), maxY))
    };
  }

  function layoutIcons() {
    const specs = Array.prototype.slice.call(iconLayer.querySelectorAll(".w98-icon"));
    specs.forEach(function (el, i) {
      const saved = iconPositions[el.dataset.appId];
      placeIcon(el, saved ? clampIcon(saved.x, saved.y) : defaultIconPosition(i));
    });
  }

  /* Put everything back in its default place. */
  function tidyIcons() {
    iconPositions = {};
    saveIconPositions(iconPositions);
    layoutIcons();
  }

  /* ---------- dragging ----------
     Pointer events cover mouse, touch and pen in one path. A drag only
     starts after a few pixels of movement, so a click still selects and a
     double-click still opens. */
  function makeDraggable(el, spec) {
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, originX = 0, originY = 0;
    let pointerId = null;

    el.addEventListener("pointerdown", function (e) {
      // left button only; let the context menu work
      if (e.button !== 0) return;

      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      const box = iconLayer.getBoundingClientRect();
      originX = rect.left - box.left;
      originY = rect.top - box.top;
      moved = false;
      dragging = false;
    });

    el.addEventListener("pointermove", function (e) {
      if (e.pointerId !== pointerId) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      /* A small dead zone, or every click would nudge the icon. */
      if (!dragging && Math.abs(dx) + Math.abs(dy) < 4) return;

      if (!dragging) {
        dragging = true;
        moved = true;
        el.classList.add("is-dragging");
        // capture so the drag survives the pointer leaving the icon
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
      }

      const next = clampIcon(originX + dx, originY + dy);
      placeIcon(el, next);
      e.preventDefault();
    });

    function finish(e) {
      if (e && e.pointerId !== pointerId) return;
      pointerId = null;

      if (dragging) {
        el.classList.remove("is-dragging");
        const box = iconLayer.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        iconPositions[spec.id] = {
          x: Math.round(rect.left - box.left),
          y: Math.round(rect.top - box.top)
        };
        saveIconPositions(iconPositions);
      }
      dragging = false;
    }

    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);

    /* Suppress the click and double-click that follow a drag, or moving an
       icon would also select it and open it. */
    el.addEventListener("click", function (e) {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
    }, true);

    el.addEventListener("dblclick", function (e) {
      if (moved) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  function buildIcons() {
    ICONS.forEach(function (spec, i) {
      const el = document.createElement("div");
      el.className = "w98-icon";
      el.tabIndex = 0;
      el.dataset.appId = spec.id;
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", spec.label);

      const img = document.createElement("img");
      img.src = spec.icon;
      img.alt = "";
      img.draggable = false;

      const span = document.createElement("span");
      span.textContent = spec.label;

      el.appendChild(img);
      el.appendChild(span);

      placeIcon(el, iconPositions[spec.id] || defaultIconPosition(i));

      el.addEventListener("click", function (e) {
        e.stopPropagation();
        if (selectedIcon) selectedIcon.classList.remove("is-selected");
        selectedIcon = el;
        el.classList.add("is-selected");
      });

      // opening a program: the ones with an `app` work, the rest fail
      el.addEventListener("dblclick", function (e) {
        e.stopPropagation();
        launch(spec);
      });

      el.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        launch(spec);
      });

      /* Right-click an icon for a little menu of its own. */
      el.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        showIconMenu(el, spec, e.clientX, e.clientY);
      });

      makeDraggable(el, spec);
      iconLayer.appendChild(el);
    });

    layoutIcons();
  }

  /* ---------- the desktop context menu ---------- */
  let desktopMenu = null;

  function closeDesktopMenu() {
    if (desktopMenu && desktopMenu.parentNode) desktopMenu.parentNode.removeChild(desktopMenu);
    desktopMenu = null;
  }

  function showDesktopMenu(x, y, items) {
    closeDesktopMenu();

    const menu = document.createElement("div");
    menu.className = "w98-iconmenu w98-raised";
    menu.setAttribute("role", "menu");

    items.forEach(function (item) {
      if (item.sep) {
        const s = document.createElement("div");
        s.className = "w98-iconmenu-sep";
        menu.appendChild(s);
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "w98-iconmenu-item";
      b.textContent = item.label;
      b.disabled = Boolean(item.disabled);
      b.addEventListener("click", function () {
        closeDesktopMenu();
        item.run();
      });
      menu.appendChild(b);
    });

    menu.style.left = x + "px";
    menu.style.top = y + "px";
    document.body.appendChild(menu);

    // keep it on screen
    const box = menu.getBoundingClientRect();
    if (box.right > window.innerWidth - 4) {
      menu.style.left = Math.max(4, window.innerWidth - box.width - 4) + "px";
    }
    if (box.bottom > window.innerHeight - 4) {
      menu.style.top = Math.max(4, window.innerHeight - box.height - 4) + "px";
    }

    desktopMenu = menu;
    // the first click anywhere else closes it
    setTimeout(function () {
      document.addEventListener("pointerdown", closeDesktopMenu, { once: true });
    }, 0);
  }

  function showIconMenu(el, spec, x, y) {
    const movable = ICONS.filter(function (s) { return !s.adminOnly || isAdmin(); });
    const at = movable.indexOf(spec);

    showDesktopMenu(x, y, [
      { label: "Open", run: function () { launch(spec); } },
      { sep: true },
      {
        label: "Move up",
        disabled: at <= 0,
        run: function () { nudgeIcon(el, spec, 0, -ICON_H); }
      },
      {
        label: "Move down",
        disabled: at === -1 || at >= movable.length - 1,
        run: function () { nudgeIcon(el, spec, 0, ICON_H); }
      },
      { sep: true },
      {
        label: "Reset this icon",
        disabled: !iconPositions[spec.id],
        run: function () {
          delete iconPositions[spec.id];
          saveIconPositions(iconPositions);
          layoutIcons();
        }
      },
      { label: "Tidy up all icons", run: tidyIcons }
    ]);
  }

  /* Move an icon by a grid step, for people who would rather not drag. */
  function nudgeIcon(el, spec, dx, dy) {
    const rect = el.getBoundingClientRect();
    const box = iconLayer.getBoundingClientRect();
    const next = clampIcon(rect.left - box.left + dx, rect.top - box.top + dy);
    placeIcon(el, next);
    iconPositions[spec.id] = next;
    saveIconPositions(iconPositions);
  }

  function isAdmin() {
    return Boolean(sessionUser && sessionUser.role === "admin");
  }

  /* ============================================================
     Start menu
     ============================================================ */

  /* Only the letter is reachable from Start; the rest fail. */
  const START_ITEMS = [
    { label: "Inbox",              icon: "assets/notepad-file-32x32.png", mail: true },
    { sep: true },
    { label: "Write a Letter",     icon: "assets/notepad-file-32x32.png", app: "newletter" },
    { label: "Notepad",            icon: "assets/notepad-32x32.png",      app: "notepad" },
    { label: "My Documents",       icon: "assets/my-documents-folder-32x32.png", app: "documents" },
    { label: "User Accounts",      icon: "assets/network-32x32.png",      app: "accounts", adminOnly: true },
    { label: "Invitations",        icon: "assets/network-32x32.png",      app: "invites", adminOnly: true },
    { sep: true },
    { label: "My Profile",         icon: "assets/my-computer-32x32.png",  app: "profile" },
    { label: "Find...",            icon: "assets/internet-explorer-32x32.png", app: "find" },
    { label: "Calculator",         icon: "assets/calculator-32x32.png",   app: "calculator" },
    { label: "Paint",              icon: "assets/paint-32x32.png",        app: "paint" },
    { label: "Minesweeper",        icon: "assets/minesweeper-32x32.png",  app: "minesweeper" },
    { label: "Pipes",              icon: "assets/pipes-32x32.png",        app: "pipes" },
    { label: "MS-DOS Prompt",      icon: "assets/msdos-32x32.png",        app: "msdos" },
    { label: "Winamp",             icon: "assets/winamp2-32x32.png",      app: "winamp" },
    { label: "My Computer",        icon: "assets/my-computer-32x32.png",  app: "mycomputer" },
    { label: "Control Panel",      icon: "assets/task-scheduler-16x16.png", app: "control", adminOnly: true },
    { sep: true },
    { label: "Sign In...",         icon: "assets/my-computer-32x32.png",  signIn: true },
    { label: "Programs",           icon: "assets/folder-32x32.png",       msg: "Programs" },
    { label: "Settings",           icon: "assets/task-scheduler-16x16.png", msg: "Control Panel" },
    { label: "Find",               icon: "assets/network-32x32.png",       msg: "Find: Files" },
    { label: "Help",               icon: "assets/audio-okay-16x16.png",    msg: "Windows Help" },
    { label: "Run...",             icon: "assets/msdos-32x32.png",         msg: "Run" },
    { sep: true },
    { label: "Shut Down...",       icon: "assets/recycle-bin-32x32.png",   shutdown: true }
  ];

  function buildStartMenu() {
    START_ITEMS.forEach(function (item) {
      if (item.sep) {
        const s = document.createElement("div");
        s.className = "w98-startsep";
        startItems.appendChild(s);
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "w98-startitem";
      b.setAttribute("role", "menuitem");

      const img = document.createElement("img");
      img.src = item.icon;
      img.alt = "";

      const span = document.createElement("span");
      span.textContent = item.label;

      b.appendChild(img);
      b.appendChild(span);

      // admin-only entries stay hidden until an admin signs in
      if (item.adminOnly) {
        b.dataset.adminOnly = "1";
        b.hidden = true;
      }

      b.addEventListener("click", function () {
        closeStartMenu();
        if (item.mail) openMail();
        else if (item.shutdown) shutdown();
        else if (item.signIn) doSignIn();
        else if (item.app) launch(item);
        else illegalAction(item.msg);
      });

      startItems.appendChild(b);
    });
  }

  function openStartMenu() {
    startMenu.hidden = false;
    startBtn.classList.add("is-open");
    startBtn.setAttribute("aria-expanded", "true");
    const first = startItems.querySelector(".w98-startitem");
    if (first) first.focus({ preventScroll: true });
  }

  function closeStartMenu() {
    startMenu.hidden = true;
    startBtn.classList.remove("is-open");
    startBtn.setAttribute("aria-expanded", "false");
  }

  startBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (startMenu.hidden) openStartMenu();
    else closeStartMenu();
  });

  // clicking elsewhere on the desktop closes the menu and clears selection
  desktop.addEventListener("mousedown", function (e) {
    if (!startMenu.hidden && !e.target.closest("#startMenu") && !e.target.closest("#startBtn")) {
      closeStartMenu();
    }
    if (e.target === desktop || e.target === iconLayer) {
      if (selectedIcon) selectedIcon.classList.remove("is-selected");
      selectedIcon = null;
    }
  });

  /* Right-clicking the desktop itself offers the layout actions. */
  iconLayer.addEventListener("contextmenu", function (e) {
    if (e.target !== iconLayer && e.target !== desktop) return;
    e.preventDefault();
    showDesktopMenu(e.clientX, e.clientY, [
      { label: "Tidy up icons", run: tidyIcons },
      {
        label: "Line up to grid",
        run: function () {
          /* Snap whatever is there to the nearest grid step, keeping the
             arrangement but squaring it off. */
          Array.prototype.forEach.call(iconLayer.querySelectorAll(".w98-icon"), function (el) {
            const rect = el.getBoundingClientRect();
            const box = iconLayer.getBoundingClientRect();
            const snapped = clampIcon(
              Math.round((rect.left - box.left) / ICON_W) * ICON_W,
              Math.round((rect.top - box.top) / ICON_H) * ICON_H
            );
            placeIcon(el, snapped);
            iconPositions[el.dataset.appId] = snapped;
          });
          saveIconPositions(iconPositions);
        }
      },
      { sep: true },
      {
        label: "Refresh",
        run: function () {
          broadcast("refresh", { win: null });
        }
      }
    ]);
  });

  /* Icons keep their relative places when the window is resized. */
  let relayoutTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(layoutIcons, 120);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!startMenu.hidden) closeStartMenu();
      closeDesktopMenu();
    }
  });

  /* Shut Down Windows.

     This signs you out and then closes the tab. A page cannot close a tab
     it did not open, so `window.close()` usually fails; when it does, the
     curtain stays up with a word about why, which is friendlier than
     claiming to have closed something that is still there. */
  function shutdown() {
    if (!sessionUser) {
      // nothing to sign out of, so go straight to the curtain
      return powerOff(null);
    }

    showDialog("Shut Down Windows",
      "Are you sure you want to:\n\n" +
      "     \u2022  sign out of " + sessionUser.username + ", and\n" +
      "     \u2022  close this tab?",
      {
        icon: "assets/recycle-bin-32x32.png",
        okText: "Shut down",
        onOk: function () { powerOff(sessionUser.username); },
        second: "Cancel"
      });
  }

  /* Sign out, then show the "safe to turn off" screen and try to close. */
  function powerOff(username) {
    const done = function () {
      showShutdownScreen(username);
    };

    if (!username) return done();

    LD.logout().then(done).catch(done);
  }

  function showShutdownScreen(username) {
    onSignedOut();

    const screen = document.createElement("div");
    screen.className = "w98-shutdown";
    screen.setAttribute("role", "alertdialog");
    screen.setAttribute("aria-label", "Shut down");

    const inner = document.createElement("div");
    inner.className = "w98-shutdown-inner";

    const big = document.createElement("p");
    big.className = "w98-shutdown-big";
    big.textContent = "It's now safe to turn off your computer.";
    inner.appendChild(big);

    const small = document.createElement("p");
    small.className = "w98-shutdown-small";
    small.textContent = username
      ? "Signed out of " + username + "."
      : "You were not signed in.";
    inner.appendChild(small);

    const note = document.createElement("p");
    note.className = "w98-shutdown-note";
    note.textContent = "Closing this tab\u2026";
    inner.appendChild(note);

    const again = document.createElement("button");
    again.type = "button";
    again.className = "w98-btn";
    again.textContent = "Close the tab";
    again.addEventListener("click", function () { tryClose(note); });
    inner.appendChild(again);

    const back = document.createElement("button");
    back.type = "button";
    back.className = "w98-btn";
    back.textContent = "Turn back on";
    back.addEventListener("click", function () {
      screen.remove();
      location.reload();
    });
    inner.appendChild(back);

    screen.appendChild(inner);
    document.body.appendChild(screen);

    /* Give the screen a moment to be seen, then try to close. A browser
       only allows this for a tab that script opened, so it usually fails
       and the note above is replaced with the honest reason. */
    setTimeout(function () { tryClose(note); }, 1200);
  }

  function tryClose(note) {
    try { window.close(); } catch (e) { /* blocked, handled below */ }

    /* If we are still here a moment later, the close was refused. */
    setTimeout(function () {
      if (!note.isConnected) return;
      note.textContent = "This tab could not be closed automatically \u2014 " +
        "your browser only allows that for windows a script opened. " +
        "You can close it yourself now.";
      note.classList.add("is-blocked");
    }, 700);
  }

  /* ============================================================
     The Inbox

     Mail between accounts on this machine. The old encoded-link
     letter is gone: nothing is read out of the URL any more, so the
     Inbox always opens the mailbox.
     ============================================================ */

  function openMail() {
    if (!sessionUser) {
      requireSignIn();
      return;
    }
    if (window.LDMail) window.LDMail.open("inbox");
    else errorBox("Inbox", "Mail could not be loaded.");
  }

  /* ============================================================
     Song files — our own UI over a hidden Spotify embed
     ============================================================ */

  function trackLabel(track, i) {
    return (track.name || ("Track " + (i + 1))) +
      (track.artist ? " — " + track.artist : "");
  }

  function buildSongFile(track, i) {
    const row = document.createElement("div");
    row.className = "w98-song";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.dataset.index = String(i);

    const img = document.createElement("img");
    img.src = "assets/audio-okay-16x16.png";
    img.alt = "";
    img.style.width = "16px";
    img.style.height = "16px";

    const name = document.createElement("span");
    name.className = "w98-song-name";
    name.textContent = trackLabel(track, i) + ".mp3";

    const meta = document.createElement("span");
    meta.className = "w98-song-meta";
    meta.textContent = "(click to play)";

    row.appendChild(img);
    row.appendChild(name);
    row.appendChild(meta);

    row.addEventListener("click", function () { playTrack(track, i, row); });
    row.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      playTrack(track, i, row);
    });

    return row;
  }

  /* ============================================================
     Song files — our own UI, with the real Spotify player behind it

     Why the embed is visible rather than hidden:

     Spotify's iframe is cross-origin, so its play button cannot be
     clicked from this page. The tempting workaround is to park the
     iframe off-screen and set `&autoplay=1`, but browsers only honour
     autoplay on a user activation, and a gesture on OUR button does not
     reliably carry across a cross-origin iframe navigation. So the embed
     would load and sit there paused.

     Showing the embed inside the Winamp window means the recipient
     clicks Spotify's own play button. That is a direct gesture on the
     iframe, so playback starts every time, with no guessing.

     (A CORS error about gabo-receiver-service may appear in the console.
     That is Spotify's own telemetry failing inside their iframe. It is
     harmless and cannot be fixed from this page.)
     ============================================================ */

  let nowPlayingRow = null;
  let playerWindow = null;
  let playerEmbed = null;

  function embedSrc(track) {
    return "https://open.spotify.com/embed/" + track.type + "/" + track.id +
      "?utm_source=generator&theme=0";
  }

  function playTrack(track, i, row) {
    if (nowPlayingRow) nowPlayingRow.classList.remove("is-playing");
    row.classList.add("is-playing");
    nowPlayingRow = row;

    openPlayer(track, i);
    loadEmbed(track);
  }

  /* Point the single embed at the chosen track. Reusing one iframe means only
     one Spotify player is ever alive, so nothing keeps playing in the
     background when the recipient switches songs. */
  function loadEmbed(track) {
    if (!playerEmbed) return;
    playerEmbed.src = embedSrc(track);
  }

  /* A Winamp-ish window. The visualiser is decorative; the Spotify embed below
     it is the real player. */
  let visualBars = [];
  let visualTimer = null;

  function openPlayer(track, i) {
    if (!playerWindow) {
      const built = makeWindow({
        title: "Winamp",
        icon: "assets/winamp2-32x32.png",
        width: 340,
        height: 300,
        x: 640,
        y: 300
      });
      playerWindow = built;
      buildPlayerBody(built.body);
    }
    playerWindow.win.hidden = false;
    focusWindow(playerWindow.win);
    syncTaskbar();

    playerWindow.titleEl.textContent = track.name || ("Track " + (i + 1));
    playerWindow.artistEl.textContent = track.artist || "Unknown Artist";
    startVisual();
  }

  function buildPlayerBody(body) {
    const panel = document.createElement("div");
    panel.className = "w98-player";

    const visual = document.createElement("div");
    visual.className = "w98-visual";
    for (let k = 0; k < 22; k++) {
      const barEl = document.createElement("i");
      visual.appendChild(barEl);
      visualBars.push(barEl);
    }

    const title = document.createElement("div");
    title.textContent = "1. ";
    const titleSpan = document.createElement("b");
    title.appendChild(titleSpan);

    const artist = document.createElement("div");
    artist.textContent = "";
    const artistSpan = document.createElement("b");
    artist.appendChild(artistSpan);

    const hint = document.createElement("div");
    hint.className = "w98-player-hint";
    hint.textContent = "press play on the player below";

    panel.appendChild(visual);
    panel.appendChild(title);
    panel.appendChild(artist);
    panel.appendChild(hint);

    /* the real Spotify player, in the window where the recipient can reach it */
    const slot = document.createElement("div");
    slot.className = "w98-player-embed";

    playerEmbed = document.createElement("iframe");
    playerEmbed.className = "w98-spotify";
    playerEmbed.width = "100%";
    playerEmbed.height = "152";
    playerEmbed.loading = "lazy";
    playerEmbed.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    playerEmbed.setAttribute("title", "Spotify player");
    slot.appendChild(playerEmbed);

    body.appendChild(panel);
    body.appendChild(slot);

    playerWindow.titleEl = titleSpan;
    playerWindow.artistEl = artistSpan;
  }

  function startVisual() {
    if (REDUCED) return;
    if (visualTimer) return;
    visualTimer = setInterval(function () {
      visualBars.forEach(function (b) {
        b.style.height = (4 + Math.random() * 52).toFixed(0) + "px";
      });
    }, 120);
  }

  /* ============================================================
     Clock
     ============================================================ */

  function tickClock() {
    const d = new Date();
    let h = d.getHours();
    const m = d.getMinutes();
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    trayClock.textContent = h + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }

  /* ============================================================
     Boot sequence
     ============================================================ */

  let bootTimers = [];

  function later(fn, ms) {
    bootTimers.push(setTimeout(fn, ms));
  }

  const DIAL_LOG = [
    "Initialising modem...",
    "ATZ",
    "OK",
    "ATDT 1-800-827-6364",
    "Dialling...",
    "CONNECT 56000",
    "Negotiating protocol...",
    "Verifying user name and password...",
    "Checking network availability...",
    "Connected at 56.6 Kbps"
  ];

  function skipBoot() {
    bootTimers.forEach(clearTimeout);
    bootTimers = [];
    clearTimeout(biosRevealTimer);
    stopDialupSound();
    bios.hidden = true;
    boot.hidden = true;
    aol.hidden = true;
    finishBoot();
  }

  function runDialup() {
    const step = REDUCED ? 40 : 620;
    let i = 0;

    function next() {
      if (i >= DIAL_LOG.length) {
        aolArt.dataset.phase = "connected";
        aolHeading.textContent = "Welcome";
        aolSub.textContent = "You have no new messages.";
        aolBar.style.width = "100%";
        later(function () {
          aol.hidden = true;
          finishBoot();
          // mail is per-account now, so the Inbox is opened by signing in
        }, REDUCED ? 60 : 900);
        return;
      }

      aolStatus.textContent = DIAL_LOG[i];
      if (i === 2) aolArt.dataset.phase = "dialling";
      aolBar.style.width = Math.round((i + 1) / DIAL_LOG.length * 100) + "%";
      i++;
      later(next, step);
    }

    aolArt.dataset.phase = "connecting";
    next();
  }

  /* ---------- sound ----------
     Browsers block audio until the user has interacted. The BIOS screen is
     dismissed by a click, which gives us that gesture, so the sounds are
     played from there. */
  const dialupAudio = new Audio("assets/dial-up.mp3");
  dialupAudio.volume = 0.32;

  /* The supplied clip runs nearly 19 seconds, which badly outstays the dial-up
     sequence it accompanies. Only the recognisable handshake is wanted, so
     playback is cut short and faded rather than left to run. */
  const DIAL_SOUND_MS = 7000;
  const DIAL_FADE_MS = 900;

  let dialFadeTimer = null;
  let soundOn = true;

  function stopDialupSound() {
    clearTimeout(dialFadeTimer);
    dialFadeTimer = null;
    try { dialupAudio.pause(); } catch (e) {}
  }

  function playDialupSound() {
    if (!soundOn) return;
    try {
      dialupAudio.currentTime = 0;
      dialupAudio.play().catch(function () {});
    } catch (e) { return; }

    // fade the tail out, then stop it outright
    clearTimeout(dialFadeTimer);
    const fadeAt = DIAL_SOUND_MS - DIAL_FADE_MS;
    setTimeout(function () {
      const steps = 10;
      let n = 0;
      const fade = setInterval(function () {
        n++;
        dialupAudio.volume = Math.max(0, 0.32 * (1 - n / steps));
        if (n >= steps) {
          clearInterval(fade);
          stopDialupSound();
          dialupAudio.volume = 0.32;
        }
      }, DIAL_FADE_MS / steps);
    }, fadeAt);
  }

  /* ============================================================
     Session and program launching
     ============================================================ */

  let sessionUser = null;   // null while signed out

  /* The apps need a few window helpers but should not reach into this
     file's internals, so they get an explicit interface. */
  function uiBridge() {
    return {
      makeWindow: makeWindow,
      focusWindow: focusWindow,
      illegal: illegalAction,
      infoBox: infoBox,
      errorBox: errorBox,
      notify: notify,
      confirmBox: confirmBox,
      broadcast: broadcast,
      on: on,
      // delegate to the real handler so signing in from a program does
      // everything the desktop does: badge, session broadcast, welcome
      onSignedIn: function (user) { onSignedIn(user); },
      onSignedOut: function () { onSignedOut(); },
      currentUser: function () { return sessionUser; },
      requireSignIn: requireSignIn,
      selectRow: selectRow,
      selectedRows: selectedRows,
      clearSelection: clearSelection,
      setWindowTitle: function (win, title) {
        const t = win.querySelector(".w98-title-text");
        if (t) t.textContent = title;
        win.dataset.title = title;
        syncTaskbar();
      }
    };
  }

  function setSession(user) {
    sessionUser = user || null;
    applySession();
  }

  /* Show or hide the programs that need an account.
     Both this and the Control Panel decide an icon's visibility, so they
     have to agree: an icon is hidden if the session forbids it OR the
     settings switched it off. Whichever runs last must not undo the other. */
  function applySession() {
    const signedIn = !!sessionUser;
    const isAdmin = signedIn && sessionUser.role === "admin";

    Array.prototype.forEach.call(
      document.querySelectorAll(".w98-icon"),
      function (node) {
        const id = node.dataset.appId;
        const spec = ICONS.filter(function (s) { return s.id === id; })[0];
        if (!spec) return;
        const adminBlocked = Boolean(spec.adminOnly) && !isAdmin;
        node.hidden = adminBlocked || !programEnabled(id);
      }
    );

    Array.prototype.forEach.call(
      document.querySelectorAll(".w98-startitem[data-admin-only]"),
      function (node) {
        const id = node.dataset.appId;
        const blockedBySettings = id ? !programEnabled(id) : false;
        node.hidden = !isAdmin || blockedBySettings;
      }
    );

    const tray = $("trayClock");
    if (tray) tray.title = signedIn ? ("Signed in as " + sessionUser.username) : "Not signed in";
  }

  function launch(spec) {
    /* A program switched off in the Control Panel is refused here as well
       as hidden, so a stale shortcut cannot get round it. "control" and
       "accounts" stay reachable: switching the panel off would otherwise
       leave no way back in. */
    const guard = spec.app || spec.id;
    if (guard && guard !== "control" && guard !== "accounts" && !programEnabled(guard)) {
      errorBox(spec.label || "Program",
        (spec.label || "That program") + " has been disabled on this computer.\n\n" +
        "An administrator can turn it back on in the Control Panel.");
      return;
    }

    if (spec.mail) { openMail(); return; }

    switch (spec.app) {
      case "notepad":
        if (!requireSignIn()) return;
        LDApps.openNotepad(null, "");
        return;
      case "documents":
        if (!requireSignIn()) return;
        LDApps.openDocuments();
        return;
      case "accounts":
        if (!requireSignIn()) return;
        if (sessionUser.role !== "admin") {
          errorBox("User Accounts", "You need an administrator account to open this.");
          return;
        }
        LDApps.openAccounts();
        return;
      case "aim":
        if (!requireSignIn()) return;
        if (window.LDAim) window.LDAim.open();
        else errorBox("AIM", "AIM could not be loaded.");
        return;
      case "letterdrop":
        /* Kept so an old shortcut still lands somewhere useful: the
           composer now lives under "Write a Letter". */
      case "newletter":
        if (!requireSignIn()) return;
        if (window.LDLetter) window.LDLetter.compose();
        else errorBox("Write a Letter", "The letter composer could not be loaded.");
        return;
      case "invites":
        if (!requireSignIn()) return;
        if (sessionUser.role !== "admin") {
          errorBox("Invitations", "You need an administrator account to open this.");
          return;
        }
        if (window.LDLetter) window.LDLetter.invites();
        return;
      case "profile":
        if (!requireSignIn()) return;
        LDApps.openProfile(sessionUser);
        return;
      case "find":
        if (!requireSignIn()) return;
        if (window.LDFind) window.LDFind.open();
        return;
      case "calculator":
        LDPrograms.openCalculator();
        return;
      case "msdos":
        if (!requireSignIn()) return;
        LDPrograms.openDos();
        return;
      case "paint":
        if (!requireSignIn()) return;
        LDPrograms.openPaint();
        return;
      case "minesweeper":
        LDPrograms.openMinesweeper();
        return;
      case "pipes":
        LDPrograms.openPipes();
        return;
      case "mycomputer":
        if (!requireSignIn()) return;
        LDPrograms.openComputer();
        return;
      case "recycle":
        LDPrograms.openRecycleBin();
        return;
      case "network":
        if (!requireSignIn()) return;
        LDPrograms.openNetwork();
        return;
      case "winamp":
        if (!requireSignIn()) return;
        if (window.LDWinamp) window.LDWinamp.open();
        return;
      case "control":
        if (!requireSignIn()) return;
        if (sessionUser.role !== "admin") {
          errorBox("Control Panel", "You need an administrator account to open this.");
          return;
        }
        if (window.LDControl) window.LDControl.open();
        return;
      default:
        illegalAction(spec.msg);
    }
  }

  function requireSignIn() {
    if (sessionUser) return true;
    doSignIn();
    return false;
  }

  function doSignIn() {
    if (sessionUser) {
      showDialog("Log Off",
        "Signed in as " + sessionUser.username + " (" + sessionUser.role + ").\n\nSign out?",
        {
          okText: "Sign out",
          second: "Stay",
          icon: "assets/my-computer-32x32.png",
          onOk: function () {
            LD.logout().catch(function () {}).then(function () {
              onSignedOut();
              infoBox("Log Off", "You have been signed out.");
            });
          }
        });
      return;
    }
    LDApps.openSignIn(function (user) { onSignedIn(user); });
  }

  function onSignedIn(user) {
    const next = user || null;

    /* Signing in is announced from more than one place -- the sign-in
       window broadcasts it, and callers pass their own callback -- so this
       is guarded against arriving twice with the same user. Without the
       guard the "Signed in as" box appeared twice, because both paths ran. */
    const samePerson = (sessionUser && next && sessionUser.username === next.username) ||
      (!sessionUser && !next);

    sessionUser = next;
    applySession();
    broadcast("session", sessionUser);

    if (samePerson) {
      // already told about this one; nothing more to announce
      refreshUnread();
      return;
    }

    if (user) {
      infoBox("Log On", "Signed in as " + user.username + " (" + user.role + ").");
    }
    refreshUnread();

    /* If the password was set by somebody else, nothing else works until
       it is changed, so ask straight away rather than letting the desktop
       look broken. */
    LD.me().then(function (res) {
      if (res && res.mustChangePassword && window.LDApps) {
        LDApps.openForcePasswordChange(function () {
          refreshUnread();
          openWaitingLetter();
        });
      } else {
        openWaitingLetter();
      }
    }).catch(function () { openWaitingLetter(); });
  }

  /* ============================================================
     Letters that arrive waiting

     A new account created from an invitation has the letter sitting
     unread in its Inbox. Rather than making them go and find it, the
     letter opens itself once, the way mail clients announce new post.
     ============================================================ */

  const ANNOUNCED_KEY = "letterdrop.announced";
  let announced = [];
  try {
    announced = JSON.parse(localStorage.getItem(ANNOUNCED_KEY) || "[]");
    if (!Array.isArray(announced)) announced = [];
  } catch (e) { announced = []; }

  function rememberAnnounced(id) {
    announced.push(id);
    if (announced.length > 200) announced = announced.slice(-200);
    try { localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(announced)); } catch (e) {}
  }

  function openWaitingLetter() {
    if (!sessionUser || !window.LDLetter) return;

    LD.mailFolders("inbox").then(function (res) {
      // an unread letter we have not already announced
      const waiting = (res.mail || []).filter(function (m) {
        return m.kind === "letter" && !m.read && announced.indexOf(m.id) === -1;
      });
      if (!waiting.length) return;

      const first = waiting[0];
      rememberAnnounced(first.id);

      later(function () {
        LDLetter.open(first.id).then(function () {
          refreshUnread();
        }).catch(function () {});
      }, 700);
    }).catch(function () {});
  }

  function onSignedOut() {
    sessionUser = null;
    applySession();
    broadcast("session", null);
    refreshUnread();
  }

  /* ---------- unread mail badge ----------
     Shown in the system tray with the count. */
  /* ---------- site settings ----------
     The Control Panel can switch programs off. A disabled program is
     removed from the desktop and the Start menu, and launch() refuses it
     as well, so hiding it is not the only defence. */

  let siteSettings = null;

  function programEnabled(id) {
    if (!siteSettings || !siteSettings.programs) return true;
    return siteSettings.programs[id] !== false;
  }

  function applySettings() {
    const set = siteSettings && siteSettings.programs ? siteSettings.programs : {};

    /* Visibility is decided by both the session and the settings, so the
       session pass is re-run here rather than each one writing `hidden`
       independently. Without this, loading settings would undo the
       admin-only hiding that happened a moment earlier at boot. */
    applySession();

    Array.prototype.forEach.call(desktop.querySelectorAll(".w98-icon"), function (node) {
      const id = node.dataset.appId;
      if (!id) return;
      if (set[id] === false) node.hidden = true;
    });

    Array.prototype.forEach.call(
      startMenu.querySelectorAll(".w98-startitem"),
      function (node) {
        const id = node.dataset.appId;
        if (!id) return;
        if (set[id] === false) node.hidden = true;
      }
    );

    if (siteSettings && siteSettings.siteName) {
      document.title = siteSettings.siteName;
    }
  }

  function refreshUnread() {
    const badge = $("trayMail");
    if (!badge) return;
    if (!sessionUser || !window.LD) { badge.hidden = true; lastUnread = null; return; }

    LD.mailUnread().then(function (res) {
      const n = res.unread || 0;

      /* A ding only when the count goes *up*, so opening your mail does
         not set it off and neither does the periodic poll. */
      if (lastUnread !== null && n > lastUnread && window.LDSound) {
        LDSound.play("mail");
      }
      lastUnread = n;

      badge.hidden = n === 0;
      badge.textContent = n > 99 ? "99+" : String(n);
      badge.title = n + " unread message" + (n === 1 ? "" : "s");
    }).catch(function () { badge.hidden = true; });
  }

  /* The unread count as of the last look, so a change can be detected. */
  let lastUnread = null;

  /* ============================================================
     Keyboard shortcuts

     A desktop that looks like Windows should behave like it. These are
     handled in one place on the document rather than scattered through
     the programs, and each bails out when the keystroke belongs to
     whatever the user is actually typing into.
     ============================================================ */

  /* Is the user typing into something? If so most shortcuts must keep
     their normal meaning, or the text areas would be unusable. */
  function isTyping(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  /* Every visible window, ordered by when it was last focused. */
  function openWindows() {
    const list = Array.prototype.slice.call(document.querySelectorAll(".w98-win"))
      .filter(function (w) { return !w.hidden; });
    list.sort(function (a, b) {
      return (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0);
    });
    return list;
  }

  function activeWindow() {
    const list = openWindows();
    return list.length ? list[list.length - 1] : null;
  }

  function closeWindow(win) {
    if (!win) return;
    /* Click the window's own close button if it has one, so the program
       gets to tear down whatever it was running. */
    const closer = win.querySelector(".w98-tbtn.close");
    if (closer && !closer.hidden) { closer.click(); return; }
    win.hidden = true;
    syncTaskbar();
    broadcast("windows-changed");
  }

  function minimiseWindow(win) {
    if (!win) return;
    win.hidden = true;
    syncTaskbar();
    broadcast("windows-changed");
  }

  /* Ctrl+Tab cycles windows; Alt+Tab does the same for anyone used to
     that. Both are swallowed, or the browser would take them for its own
     tab switching. */
  function cycleWindows(backwards) {
    const list = openWindows();
    if (list.length < 2) return;
    const order = backwards ? list : list.slice().reverse();
    const front = list[list.length - 1];
    const at = order.indexOf(front);
    focusWindow(order[(at + 1) % order.length]);
  }

  document.addEventListener("keydown", function (e) {
    const typing = isTyping(e);
    const ctrl = e.ctrlKey || e.metaKey;

    /* Tab means "next field" while typing, so the window cycle only
       applies when focus is on the desktop. */
    if (e.key === "Tab" && (e.altKey || ctrl) && !typing) {
      e.preventDefault();
      cycleWindows(e.shiftKey);
      return;
    }

    if (e.key === "Escape" && !typing) {
      /* A dialog on top handles its own Escape; if one is open, leave it
         to do so rather than closing the window behind it. */
      const dialogs = Array.prototype.filter.call(
        document.querySelectorAll(".w98-dialog"),
        function (d) { return !d.hidden && d.offsetParent !== null; }
      );
      if (dialogs.length) return;

      const win = activeWindow();
      if (win) {
        e.preventDefault();
        closeWindow(win);
      }
      return;
    }

    if (e.key === "F5" && !typing) {
      const win = activeWindow();
      if (win) {
        e.preventDefault();
        broadcast("refresh", { win: win });
      }
      return;
    }

    if (ctrl && (e.key === "a" || e.key === "A") && !typing) {
      const win = activeWindow();
      if (!win) return;
      const list = win.querySelector(".w98-filelist, .w98-maillist, .aim-log, .find-results");
      if (!list) return;
      e.preventDefault();
      selectAllRows(list);
      return;
    }

    if (e.key === "Delete" && !typing) {
      const win = activeWindow();
      if (!win) return;
      const rows = selectedRows(win);
      if (!rows.length) return;
      e.preventDefault();
      broadcast("delete-selected", { win: win, rows: rows });
      return;
    }

    if (ctrl && (e.key === "n" || e.key === "N")) {
      const win = activeWindow();
      if (!win) return;
      e.preventDefault();
      broadcast("new-item", { win: win });
      return;
    }

    if (ctrl && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      minimiseWindow(activeWindow());
      return;
    }

    if (ctrl && (e.key === "w" || e.key === "W")) {
      // inside a text field Ctrl+W is an ordinary word-delete
      if (typing) return;
      e.preventDefault();
      closeWindow(activeWindow());
      return;
    }
  });

  /* ---------- row selection ----------
     One shared notion of "selected", so Ctrl+A and Delete mean the same
     thing in every list rather than each program inventing its own. */

  const ROW_SELECTOR = ".w98-filerow, .w98-mailrow, .find-row, .wa-row";

  /* Select a row, honouring Ctrl (toggle) and Shift (extend). Exposed to
     the programs so a row's own click handler can call it directly. */
  function selectRow(row, e) {
    if (!row) return;

    if (e && (e.ctrlKey || e.metaKey)) {
      row.classList.toggle("is-selected");
      return;
    }

    if (e && e.shiftKey) {
      const all = Array.prototype.slice.call(row.parentNode.querySelectorAll(ROW_SELECTOR));
      const from = all.findIndex(function (r) { return r.classList.contains("is-selected"); });
      const to = all.indexOf(row);
      if (from !== -1) {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
          all[i].classList.add("is-selected");
        }
        return;
      }
    }

    Array.prototype.forEach.call(row.parentNode.querySelectorAll(".is-selected"), function (r) {
      if (r !== row) r.classList.remove("is-selected");
    });
    row.classList.add("is-selected");
  }

  function selectAllRows(list) {
    const rows = Array.prototype.slice.call(list.querySelectorAll(ROW_SELECTOR));
    rows.forEach(function (r) { r.classList.add("is-selected"); });
    return rows;
  }

  function selectedRows(win) {
    return Array.prototype.slice.call(win.querySelectorAll(".is-selected"));
  }

  function clearSelection(scope) {
    const root = scope || document;
    Array.prototype.forEach.call(root.querySelectorAll(".is-selected"), function (r) {
      r.classList.remove("is-selected");
    });
  }

  /* Clicking selects; Ctrl-click toggles; Shift-click extends. Delegated
     from the document so rows created later behave the same, and so the
     rules live in one place rather than in each program. */
  document.addEventListener("click", function (e) {
    const row = e.target.closest && e.target.closest(ROW_SELECTOR);

    if (!row) {
      // a click on empty list space clears the selection
      if (e.target.closest && e.target.closest(".w98-filelist, .w98-maillist, .find-results")) {
        clearSelection();
      }
      return;
    }

    // let controls inside a row do their job
    if (e.target.closest("button, a, input, select, textarea")) return;

    selectRow(row, e);
  });

  /* ============================================================
     Finish
     ============================================================ */

  let booted = false;

  function finishBoot() {
    if (booted) return;
    booted = true;
    desktop.classList.add("is-ready");
    broadcast("boot-finished");
  }

  /* ============================================================
     Wiring
     ============================================================ */

  buildIcons();
  buildStartMenu();
  tickClock();
  setInterval(tickClock, 20000);

  /* Hand the window helpers to the working programs. The bridge is also
     published on `window.LDUI`, so a notification or dialog can be raised
     from the console, and so the tests can drive one without reaching
     into a program's closure. */
  const bridge = uiBridge();
  window.LDUI = bridge;
  if (window.LDApps) window.LDApps.init(bridge);
  if (window.LDMail) window.LDMail.init(bridge);
  if (window.LDAim) window.LDAim.init(bridge);
  if (window.LDPrograms) window.LDPrograms.init(bridge);
  if (window.LDControl) window.LDControl.init(bridge);
  if (window.LDWinamp) window.LDWinamp.init(bridge);
  if (window.LDLetter) window.LDLetter.init(bridge);
  if (window.LDFind) window.LDFind.init(bridge);

  /* Site settings decide which programs exist. They are read once at boot
     and re-applied whenever the Control Panel changes them. */
  on("settings-changed", function () { applySettings(); });

  if (window.LD) {
    LD.settings().then(function (s) {
      siteSettings = s;
      applySettings();
    }).catch(function () {
      // no server: leave every program visible, the sign-in will explain
    });
  }

  /* Keep the taskbar badge current: refresh the unread count when a message
     is sent or read, and every so often as a fallback. */
  on("mail-changed", refreshUnread);
  setInterval(function () { if (sessionUser) refreshUnread(); }, 30000);

  /* Start from a known signed-out state: this is what hides the admin-only
     programs until an administrator signs in. */
  applySession();

  /* ask the server who we are, so a reload keeps you signed in */
  if (window.LD) {
    LD.me().then(function (res) {
      if (res && res.user) {
        sessionUser = res.user;
        applySession();
        // tell the programs who is signed in, and update the mail badge
        broadcast("session", sessionUser);
        refreshUnread();
        /* A session restored from a cookie can also be under a forced
           password change, so check before opening anything else. */
        if (res.mustChangePassword && window.LDApps) {
          LDApps.openForcePasswordChange(function () { openWaitingLetter(); });
        } else {
          // a letter may be waiting from a previous visit
          openWaitingLetter();
        }
      }
    }).catch(function () {
      // no server (opened as a plain file): the desktop still works, but
      // the account-only programs will ask for a sign-in that cannot succeed
    });
  }

  /* ---------- boot ----------
     The BIOS screen posts its messages one line at a time, the way a real
     POST does, then waits for a click. The wait is deliberate: browsers refuse
     to play audio until the user has interacted, so the click is what lets the
     dial-up sound start. It also mirrors switching a real machine on. */

  const BIOS_LINES = [
    "Award Modular BIOS v4.51PG, An Energy Star Ally",
    "Copyright (C) 1984-98, Award Software, Inc.",
    "",
    "Letterdrop 440BX/ZX AGPset",
    "Main Processor : Pentium II 350MHz",
    "Memory Test    : 65536K OK",
    "",
    "Detecting IDE Primary Master  ... QUANTUM FIREBALL",
    "Detecting IDE Primary Slave   ... None",
    "Detecting IDE Secondary Master... CD-ROM 40X",
    "Detecting IDE Secondary Slave ... None",
    "",
    "09/23/2000-i440BX-2A69KA1BC-00"
  ];

  const BIOS_LINE_MS = 85;    // fast: the whole POST lands in about a second
  let biosRevealTimer = null;
  let biosDone = false;

  function revealBios() {
    if (biosDone) return;
    biosDone = true;

    let i = 0;
    (function next() {
      if (i >= BIOS_LINES.length) {
        biosPrompt.hidden = false;
        return;
      }
      const line = document.createElement("div");
      // an empty entry still takes a line, as it would on a real POST screen
      line.textContent = BIOS_LINES[i] || "\u00a0";
      biosLines.appendChild(line);
      i++;
      biosRevealTimer = setTimeout(next, BIOS_LINE_MS);
    })();
  }

  function finishBiosInstantly() {
    clearTimeout(biosRevealTimer);
    biosDone = true;
    biosLines.textContent = "";
    BIOS_LINES.forEach(function (t) {
      const line = document.createElement("div");
      line.textContent = t || "\u00a0";
      biosLines.appendChild(line);
    });
    biosPrompt.hidden = false;
  }

  function startBoot() {
    if (booted) return;
    if (REDUCED) { skipBoot(); return; }

    // if the recipient clicks before the POST has finished, show the rest at once
    finishBiosInstantly();
    stopDialupSound();

    bios.hidden = true;
    boot.hidden = false;
    playDialupSound();

    later(function () {
      boot.hidden = true;
      aol.hidden = false;
      runDialup();
    }, 1200);
  }

  aolSkip.addEventListener("click", skipBoot);

  bios.addEventListener("click", startBoot);

  document.addEventListener("keydown", function (e) {
    if (booted) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      startBoot();
    }
  });

  /* Browsers will not start audio until the page has been interacted
     with. Dismissing the BIOS screen is a click or a keypress, so that is
     the gesture the sounds are unlocked from. */
  function unlockSoundOnce() {
    if (window.LDSound) LDSound.unlock();
    document.removeEventListener("click", unlockSoundOnce);
    document.removeEventListener("keydown", unlockSoundOnce);
  }
  document.addEventListener("click", unlockSoundOnce);
  document.addEventListener("keydown", unlockSoundOnce);

  /* The tray speaker doubles as a mute switch, the way it did in Windows. */
  (function wireSoundToggle() {
    const btn = $("traySound");
    if (!btn || !window.LDSound) return;

    const saved = localStorage.getItem("letterdrop.sound");
    if (saved === "off") LDSound.setEnabled(false);

    function paint() {
      const on = LDSound.isEnabled();
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on ? "Sound on \u2014 click to mute" : "Sound off \u2014 click to unmute";
      btn.classList.toggle("is-muted", !on);
    }

    btn.addEventListener("click", function () {
      LDSound.unlock();
      const on = !LDSound.isEnabled();
      LDSound.setEnabled(on);
      try { localStorage.setItem("letterdrop.sound", on ? "on" : "off"); } catch (e) {}
      paint();
      // a click that turns sound back on should prove it works
      if (on) LDSound.play("ok");
    });

    paint();
  })();

  /* The startup chime plays as the desktop appears, not when the BIOS
     goes away, so it lands with the wallpaper rather than the POST. */
  on("boot-finished", function () {
    if (window.LDSound) LDSound.play("startup");
  });

  // kick the POST off straight away so the screen is filling as it appears
  revealBios();
})();
