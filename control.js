/* ============================================================
   Letterdrop — Control Panel

   Site settings and the dangerous switches, for admins only.
   The API enforces that too: a non-admin gets 403 whatever the UI shows.
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
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
  }

  /* The programs the Control Panel can switch off, and how they read. */
  const PROGRAM_LIST = [
    ["notepad", "Notepad"],
    ["documents", "My Documents"],
    ["paint", "Paint"],
    ["calculator", "Calculator"],
    ["minesweeper", "Minesweeper"],
    ["msdos", "MS-DOS Prompt"],
    ["mycomputer", "My Computer"],
    ["network", "Network Neighbourhood"],
    ["aim", "AIM"],
    ["mail", "Inbox / Mail"],
    ["letterdrop", "Letterdrop Network"],
    ["winamp", "Winamp"],
    ["find", "Find"],
    ["accounts", "User Accounts"]
  ];

  let panel = null;

  function open() {
    if (panel && !panel.win.hidden) {
      UI.focusWindow(panel.win);
      refresh();
      return panel;
    }

    const built = UI.makeWindow({
      title: "Control Panel",
      icon: "assets/task-scheduler-16x16.png",
      width: 560, height: 520, x: 180, y: 60
    });

    const tabs = el("div", "cp-tabs");
    const view = el("div", "cp-view");
    const status = el("div", "w98-statusbar");
    const st = el("span", null, "Loading...");
    status.appendChild(st);

    const PAGES = [
      ["general", "General"],
      ["programs", "Programs"],
      ["storage", "Storage"],
      ["danger", "Danger"]
    ];

    let current = "general";
    let settings = null;
    let storage = null;

    PAGES.forEach(function (p) {
      const b = el("button", "cp-tab", p[1]);
      b.type = "button";
      b.dataset.page = p[0];
      b.addEventListener("click", function () { current = p[0]; render(); });
      tabs.appendChild(b);
    });

    function save(patch, note) {
      return LD.saveSettings(patch).then(function (res) {
        settings = res.settings;
        st.textContent = note || "Saved.";
        render();
        UI.broadcast("settings-changed", settings);
      }).catch(function (e) {
        UI.errorBox("Control Panel", e.message);
      });
    }

    /* ---------- General ---------- */
    function pageGeneral() {
      const box = el("div", "cp-page");

      const nameRow = el("div", "cp-row");
      nameRow.appendChild(el("label", null, "Site name:"));
      const name = el("input", "ld-input");
      name.type = "text";
      name.value = settings.siteName;
      nameRow.appendChild(name);
      box.appendChild(nameRow);

      const motdRow = el("div", "cp-row");
      motdRow.appendChild(el("label", null, "Message of the day:"));
      const motd = el("textarea", "ld-input cp-motd");
      motd.value = settings.motd;
      motdRow.appendChild(motd);
      box.appendChild(motdRow);

      const capRow = el("div", "cp-row");
      capRow.appendChild(el("label", null, "Upload limit (MB):"));
      const cap = el("input", "ld-input");
      cap.type = "number";
      cap.min = "1";
      cap.max = "4096";
      cap.value = String(settings.maxUploadMB);
      capRow.appendChild(cap);
      box.appendChild(capRow);

      /* Storage per account. 0 means unlimited, which is the default so an
         existing install is not retroactively capped. */
      const quotaRow = el("div", "cp-row");
      quotaRow.appendChild(el("label", null, "Storage per account (MB):"));
      const quota = el("input", "ld-input");
      quota.type = "number";
      quota.min = "0";
      quota.max = "1048576";
      quota.value = String(settings.quotaMB || 0);
      quotaRow.appendChild(quota);
      box.appendChild(quotaRow);
      box.appendChild(el("div", "cp-hint",
        "0 means no limit. Applies to every account, admins included."));

      const signups = el("label", "cp-check");
      const signupBox = el("input");
      signupBox.type = "checkbox";
      signupBox.checked = Boolean(settings.allowSignups);
      signups.appendChild(signupBox);
      signups.appendChild(el("span", null, " Allow new accounts to be created"));
      box.appendChild(signups);

      const actions = el("div", "cp-actions");
      const saveBtn = el("button", "w98-btn", "Apply");
      saveBtn.type = "button";
      saveBtn.addEventListener("click", function () {
        save({
          siteName: name.value,
          motd: motd.value,
          maxUploadMB: Number(cap.value),
          quotaMB: Number(quota.value),
          allowSignups: signupBox.checked
        }, "Settings saved.");
      });
      actions.appendChild(saveBtn);
      box.appendChild(actions);

      return box;
    }

    /* ---------- Programs ---------- */
    function pagePrograms() {
      const box = el("div", "cp-page");
      box.appendChild(el("p", "cp-lead",
        "Turn a program off and it disappears from the desktop and the Start menu. " +
        "The server refuses to open it either, so this is not just cosmetic."));

      const list = el("div", "cp-programs");
      PROGRAM_LIST.forEach(function (pair) {
        const id = pair[0], label = pair[1];
        const row = el("label", "cp-program");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = settings.programs[id] !== false;
        cb.dataset.program = id;
        cb.addEventListener("change", function () {
          const patch = { programs: {} };
          patch.programs[id] = cb.checked;
          save(patch, label + (cb.checked ? " enabled." : " disabled."));
        });
        row.appendChild(cb);
        row.appendChild(el("span", null, label));
        list.appendChild(row);
      });
      box.appendChild(list);

      const all = el("div", "cp-actions");
      const on = el("button", "w98-btn", "Enable all");
      on.type = "button";
      on.addEventListener("click", function () {
        const patch = { programs: {} };
        PROGRAM_LIST.forEach(function (p) { patch.programs[p[0]] = true; });
        save(patch, "All programs enabled.");
      });
      all.appendChild(on);

      const off = el("button", "w98-btn", "Disable all");
      off.type = "button";
      off.addEventListener("click", function () {
        const patch = { programs: {} };
        PROGRAM_LIST.forEach(function (p) { patch.programs[p[0]] = false; });
        save(patch, "All programs disabled.");
      });
      all.appendChild(off);
      box.appendChild(all);

      return box;
    }

    /* ---------- Storage ---------- */
    function pageStorage() {
      const box = el("div", "cp-page");

      const summary = el("div", "cp-summary");
      summary.appendChild(el("div", "cp-big", fmtSize(storage.totalBytes)));
      summary.appendChild(el("div", "cp-sub",
        storage.totalFiles + " file(s)   |   " + storage.shares + " public link(s)"));
      summary.appendChild(el("div", "cp-sub",
        storage.mail + " mail message(s)   |   " + storage.ims + " instant message(s)"));
      box.appendChild(summary);

      const table = el("div", "cp-table");
      const head = el("div", "cp-trow cp-thead");
      head.appendChild(el("span", null, "Account"));
      head.appendChild(el("span", null, "Files"));
      head.appendChild(el("span", null, "Used"));
      table.appendChild(head);

      storage.users.forEach(function (u) {
        const row = el("div", "cp-trow");
        row.appendChild(el("span", null, u.username));
        row.appendChild(el("span", null, String(u.files)));
        row.appendChild(el("span", null, fmtSize(u.bytes)));
        table.appendChild(row);
      });
      if (!storage.users.length) {
        table.appendChild(el("div", "w98-hint", "No accounts."));
      }
      box.appendChild(table);

      const actions = el("div", "cp-actions");
      const reload = el("button", "w98-btn", "Refresh");
      reload.type = "button";
      reload.addEventListener("click", refresh);
      actions.appendChild(reload);
      box.appendChild(actions);

      return box;
    }

    /* ---------- Danger ---------- */
    function pageDanger() {
      const box = el("div", "cp-page");
      box.appendChild(el("p", "cp-lead",
        "These cannot be undone. Each one asks you to type the action name first."));

      const ITEMS = [
        ["wipe-files", "Delete all uploaded files",
          "Removes every file in every account, and every public link with them. " +
          "Accounts are kept."],
        ["wipe-messages", "Delete all mail and messages",
          "Empties every Inbox and every conversation. Accounts and files are kept."],
        ["delete-users", "Delete all accounts",
          "Removes every account except your own, along with their files, mail and " +
          "messages."]
      ];

      ITEMS.forEach(function (item) {
        const action = item[0];
        const card = el("div", "cp-danger");

        card.appendChild(el("div", "cp-danger-title", item[1]));
        card.appendChild(el("p", "cp-danger-note", item[2]));

        const row = el("div", "cp-danger-row");
        const input = el("input", "ld-input");
        input.type = "text";
        input.placeholder = "type " + action + " to confirm";
        input.setAttribute("aria-label", "Confirm " + item[1]);
        row.appendChild(input);

        const go = el("button", "w98-btn cp-danger-btn", "Do it");
        go.type = "button";
        go.addEventListener("click", function () {
          if (input.value.trim() !== action) {
            UI.errorBox("Control Panel", "Type " + action + " to confirm.");
            return;
          }
          UI.confirmBox("Are you sure?",
            item[1] + "\n\n" + item[2] + "\n\nThis cannot be undone.",
            function () {
              LD.danger(action)
                .then(function (res) {
                  input.value = "";
                  const bits = [];
                  if (res.files !== undefined) bits.push(res.files + " file(s)");
                  if (res.shares !== undefined) bits.push(res.shares + " link(s)");
                  if (res.mail !== undefined) bits.push(res.mail + " mail");
                  if (res.ims !== undefined) bits.push(res.ims + " message(s)");
                  if (res.removed !== undefined) bits.push(res.removed + " account(s)");
                  st.textContent = "Done: " + (bits.join(", ") || "nothing to do") + ".";
                  UI.infoBox("Control Panel", item[1] + "\n\n" +
                    (bits.join(", ") || "There was nothing to remove."));
                  UI.broadcast("files-changed");
                  refresh();
                })
                .catch(function (e) { UI.errorBox("Control Panel", e.message); });
            });
        });
        row.appendChild(go);

        card.appendChild(row);
        box.appendChild(card);
      });

      return box;
    }

    function render() {
      Array.prototype.forEach.call(tabs.querySelectorAll(".cp-tab"), function (b) {
        b.classList.toggle("is-active", b.dataset.page === current);
      });
      view.textContent = "";
      if (!settings || !storage) {
        view.appendChild(el("div", "w98-hint", "Loading..."));
        return;
      }
      if (current === "general") view.appendChild(pageGeneral());
      else if (current === "programs") view.appendChild(pagePrograms());
      else if (current === "storage") view.appendChild(pageStorage());
      else view.appendChild(pageDanger());
    }

    function refresh() {
      st.textContent = "Loading...";
      LD.adminSettings().then(function (res) {
        settings = res.settings;
        storage = res.storage;
        st.textContent = "Ready.";
        render();
      }).catch(function (e) {
        st.textContent = e.message;
        view.textContent = "";
        view.appendChild(el("div", "w98-hint", e.message));
      });
    }

    built.body.appendChild(tabs);
    built.body.appendChild(view);
    built.body.appendChild(status);

    panel = { win: built.win, refresh: refresh };
    refresh();
    return panel;
  }

  global.LDControl = { init: init, open: open };
})(window);
