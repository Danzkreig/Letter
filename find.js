/* ============================================================
   Letterdrop — Find

   One search across your files (names and the text inside notes), your
   mail and letters, and the other accounts on this machine.

   The server scopes every result to the caller, so a search can never
   surface another person's mail or files.
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

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  }

  const KIND_ICON = {
    image: "assets/paint-32x32.png",
    audio: "assets/winamp2-32x32.png",
    video: "assets/winamp2-32x32.png",
    note: "assets/notepad-file-32x32.png",
    file: "assets/notepad-file-32x32.png"
  };

  let findWindow = null;
  let lastQuery = "";
  let searchTimer = null;

  function open(initial) {
    if (findWindow && !findWindow.win.hidden) {
      UI.focusWindow(findWindow.win);
      if (initial) { findWindow.input.value = initial; run(initial); }
      return findWindow;
    }

    const built = UI.makeWindow({
      title: "Find",
      icon: "assets/internet-explorer-32x32.png",
      width: 640, height: 500, x: 200, y: 80
    });

    const bar = el("div", "find-bar");
    const field = el("input", "ld-input find-input");
    field.type = "search";
    field.spellcheck = false;
    field.placeholder = "Search files, notes, mail and people";
    field.setAttribute("aria-label", "Search");
    bar.appendChild(field);

    const go = el("button", "w98-btn find-go", "Search");
    go.type = "button";
    bar.appendChild(go);

    built.body.appendChild(bar);

    const tabs = el("div", "find-tabs");
    const view = el("div", "find-results");
    const status = el("div", "w98-statusbar");
    const statusText = el("span", null, "Type something to search for.");
    status.appendChild(statusText);

    let scope = "all";
    const SCOPES = [["all", "All"], ["files", "Files"], ["mail", "Mail"], ["people", "People"]];

    SCOPES.forEach(function (s) {
      const b = el("button", "find-tab", s[1]);
      b.type = "button";
      b.dataset.scope = s[0];
      if (s[0] === "all") b.classList.add("is-active");
      b.addEventListener("click", function () {
        scope = s[0];
        Array.prototype.forEach.call(tabs.querySelectorAll(".find-tab"), function (x) {
          x.classList.toggle("is-active", x.dataset.scope === scope);
        });
        if (lastQuery) run(lastQuery);
      });
      tabs.appendChild(b);
    });

    built.body.appendChild(tabs);
    built.body.appendChild(view);
    built.body.appendChild(status);

    /* `body` is already the window's content element, so the class goes on
       it directly rather than being searched for inside itself. */
    built.body.classList.add("find-body");

    function render(res) {
      view.textContent = "";

      if (!res || !res.total) {
        view.appendChild(el("div", "w98-hint",
          lastQuery ? "Nothing matched \u201C" + lastQuery + "\u201D."
                    : "Type something to search for."));
        statusText.textContent = lastQuery ? "No results." : "Type something to search for.";
        return;
      }

      const files = res.files || [];
      const mail = res.mail || [];
      const people = res.people || [];

      if ((scope === "all" || scope === "files") && files.length) {
        view.appendChild(el("div", "find-group", "Files (" + files.length + ")"));
        files.forEach(function (f) {
          const row = el("div", "find-row");

          const icon = el("img", "find-icon");
          icon.src = KIND_ICON[f.kind] || KIND_ICON.file;
          icon.alt = "";
          row.appendChild(icon);

          const main = el("div", "find-main");
          main.appendChild(el("div", "find-title", f.name));

          const bits = [];
          if (f.folder) bits.push("in " + f.folder);
          bits.push(fmtSize(f.size));
          if (f.modified) bits.push(fmtDate(f.modified));
          bits.push(f.where === "contents" ? "matched inside" : "matched by name");
          main.appendChild(el("div", "find-meta", bits.join("  \u00B7  ")));

          if (f.snippet) main.appendChild(el("div", "find-snippet", f.snippet));
          row.appendChild(main);

          row.tabIndex = 0;
          const goThere = function () {
            if (window.LDApps) {
              LDApps.openDocuments({ path: f.folder || "" });
            }
          };
          row.addEventListener("dblclick", goThere);
          row.addEventListener("click", goThere);
          row.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); goThere(); }
          });

          view.appendChild(row);
        });
      }

      if ((scope === "all" || scope === "mail") && mail.length) {
        view.appendChild(el("div", "find-group", "Mail (" + mail.length + ")"));
        mail.forEach(function (m) {
          const row = el("div", "find-row");

          const icon = el("img", "find-icon");
          icon.src = m.kind === "letter" ? "assets/notepad-file-32x32.png" : "assets/notepad-32x32.png";
          icon.alt = "";
          row.appendChild(icon);

          const main = el("div", "find-main");
          main.appendChild(el("div", "find-title", m.subject || "(no subject)"));

          const bits = [m.kind === "letter" ? "Letter" : "Message"];
          bits.push(m.folder === "sent" ? "to " + m.to : "from " + m.from);
          if (m.attachment) bits.push("enclosed " + m.attachment);
          else bits.push("matched in the " + m.where);
          bits.push(fmtDate(m.sent));
          main.appendChild(el("div", "find-meta", bits.join("  \u00B7  ")));

          if (m.snippet) main.appendChild(el("div", "find-snippet", m.snippet));
          row.appendChild(main);

          row.tabIndex = 0;
          const openIt = function () {
            if (!window.LDMail) return;
            if (m.kind === "letter" && window.LDLetter) LDLetter.open(m.id);
            else LDMail.open(m.folder);
          };
          row.addEventListener("dblclick", openIt);
          row.addEventListener("click", openIt);
          row.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); openIt(); }
          });

          view.appendChild(row);
        });
      }

      if ((scope === "all" || scope === "people") && people.length) {
        view.appendChild(el("div", "find-group", "People (" + people.length + ")"));
        people.forEach(function (p) {
          const row = el("div", "find-row");

          if (p.avatar) {
            const img = el("img", "find-icon");
            img.src = LD.avatarUrl(p.username);
            img.alt = "";
            row.appendChild(img);
          } else {
            const blank = el("img", "find-icon");
            blank.src = "assets/aim.png";
            blank.alt = "";
            row.appendChild(blank);
          }

          const main = el("div", "find-main");
          main.appendChild(el("div", "find-title", p.username));
          main.appendChild(el("div", "find-meta",
            p.role === "admin" ? "Administrator" : "Standard user"));
          row.appendChild(main);

          row.tabIndex = 0;
          const write = function () {
            if (window.LDMail) LDMail.openCompose({ to: p.id });
          };
          row.addEventListener("dblclick", write);
          row.addEventListener("click", write);
          row.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); write(); }
          });

          view.appendChild(row);
        });
      }

      statusText.textContent = res.total + (res.total === 1 ? " result" : " results") +
        " for \u201C" + res.query + "\u201D";
    }

    function run(q) {
      lastQuery = String(q || "").trim();
      if (!lastQuery) { render(null); return; }
      statusText.textContent = "Searching...";
      LD.search(lastQuery)
        .then(render)
        .catch(function (e) {
          statusText.textContent = e.message;
          statusText.style.color = "#a00";
        });
    }

    /* Search as you type, but not on every keystroke. */
    field.addEventListener("input", function () {
      clearTimeout(searchTimer);
      const v = field.value;
      searchTimer = setTimeout(function () { run(v); }, 220);
    });
    field.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); run(field.value); }
      if (e.key === "Escape") { field.value = ""; run(""); }
    });
    go.addEventListener("click", function () { clearTimeout(searchTimer); run(field.value); });

    findWindow = { win: built.win, input: field, run: run };
    render(null);
    setTimeout(function () { field.focus(); }, 80);
    if (initial) { field.value = initial; run(initial); }
    return findWindow;
  }

  global.LDFind = { init: init, open: open };
})(window);
