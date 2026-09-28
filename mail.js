/* ============================================================
   Letterdrop — the mail program

   Internal mail between accounts on this machine. Inbox, Sent and
   Trash; compose with attachments drawn from your own Documents;
   unread counts on the taskbar.

   This replaces the old "letter" flow: instead of encoding a payload
   into a link, a message is delivered to another account on the same
   server.
   ============================================================ */

(function (global) {
  "use strict";

  let UI = null;

  /* Who is signed in. The desktop pushes this on every change, and we ask
     once at init in case a session was already restored from the server. */
  let currentUser = null;

  function init(ui) {
    UI = ui;
    if (UI.on) UI.on("session", function (user) { currentUser = user || null; });
    if (UI.currentUser) {
      try { currentUser = UI.currentUser(); } catch (e) {}
    }
  }

  function setUser(user) { currentUser = user || null; }

  /* Re-read the session from the desktop, so the guard cannot go stale. */
  function whoami() {
    if (UI && UI.currentUser) {
      try { return UI.currentUser(); } catch (e) {}
    }
    return currentUser;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  /* ============================================================
     The mailbox window
     ============================================================ */

  let mailbox = null;      // { win, list, status, folder, toolbar }
  let currentFolder = "inbox";

  function open(folder) {
    // Mail is per-account, so refuse to open without one. The desktop
    // normally gates this, but the module should be safe on its own too.
    if (!whoami()) {
      if (UI && UI.requireSignIn) UI.requireSignIn();
      return null;
    }

    if (folder) currentFolder = folder;

    if (mailbox && !mailbox.win.hidden) {
      UI.focusWindow(mailbox.win);
      if (folder) setFolder(folder);
      else refresh();
      return mailbox;
    }

    const built = UI.makeWindow({
      title: "Outlook Express",
      icon: "assets/notepad-file-32x32.png",
      width: 680, height: 460, x: 120, y: 50
    });

    const menu = el("div", "w98-menubar");
    ["File", "Edit", "View", "Tools", "Help"].forEach(function (label) {
      const b = el("button", null, label);
      b.type = "button";
      b.addEventListener("click", function () { UI.illegal(label + " menu"); });
      menu.appendChild(b);
    });

    const bar = el("div", "w98-toolbar");

    const composeBtn = el("button", "w98-tool", "");
    composeBtn.type = "button";
    const cIcon = el("img");
    cIcon.src = "assets/notepad-32x32.png";
    cIcon.alt = "";
    composeBtn.appendChild(cIcon);
    composeBtn.appendChild(el("span", null, "New Message"));
    bar.appendChild(composeBtn);

    const refreshBtn = el("button", "w98-tool", "Refresh");
    refreshBtn.type = "button";
    bar.appendChild(refreshBtn);

    const folders = el("div", "w98-folders");
    [["inbox", "Inbox"], ["sent", "Sent Items"], ["trash", "Deleted Items"]].forEach(function (pair) {
      const b = el("button", "w98-folder", pair[1]);
      b.type = "button";
      b.dataset.folder = pair[0];
      b.addEventListener("click", function () { setFolder(pair[0]); });
      folders.appendChild(b);
    });

    const list = el("div", "w98-maillist");
    list.setAttribute("role", "list");

    const status = el("div", "w98-statusbar");
    const statusText = el("span", null, "Loading...");
    status.appendChild(statusText);

    built.body.appendChild(menu);
    built.body.appendChild(bar);
    built.body.appendChild(folders);
    built.body.appendChild(list);
    built.body.appendChild(status);

    composeBtn.addEventListener("click", function () { openCompose(); });
    refreshBtn.addEventListener("click", refresh);

    mailbox = { win: built.win, list: list, status: statusText };

    /* Keyboard shortcuts forwarded by the desktop, each only acting when
       this window is the one in front. */
    UI.on("refresh", function (e) {
      if (e && e.win === built.win) refresh();
    });
    UI.on("new-item", function (e) {
      if (e && e.win === built.win) openCompose();
    });
    UI.on("delete-selected", function (e) {
      if (!e || e.win !== built.win) return;
      const ids = e.rows.map(function (r) { return r.dataset.id; }).filter(Boolean);
      if (!ids.length) return;
      const permanent = currentFolder === "trash";
      const go = function () {
        Promise.all(ids.map(function (id) {
          return LD.mailDelete(id, permanent).catch(function () {});
        })).then(refresh);
      };
      if (permanent) UI.confirmBox("Delete", "Delete these messages for good?", go);
      else go();
    });

    setFolder(currentFolder);
    return built;
  }

  function setFolder(folder) {
    currentFolder = folder;
    if (!mailbox) return;
    Array.prototype.forEach.call(
      mailbox.win.querySelectorAll(".w98-folder"),
      function (b) { b.classList.toggle("is-active", b.dataset.folder === folder); }
    );
    refresh();
  }

  function refresh() {
    if (!mailbox) return;
    mailbox.list.textContent = "";
    mailbox.status.textContent = "Loading...";
    mailbox.status.style.color = "";

    LD.mailFolders(currentFolder)
      .then(function (res) {
        const items = res.mail || [];
        if (!items.length) {
          const empty = el("div", "w98-hint",
            currentFolder === "trash" ? "Deleted items will appear here."
            : currentFolder === "sent" ? "Messages you send will appear here."
            : "No messages. Click New Message to write one.");
          mailbox.list.appendChild(empty);
        } else {
          items.forEach(function (m) { mailbox.list.appendChild(mailRow(m)); });
        }
        const unread = res.unread || 0;
        mailbox.status.textContent = items.length + (items.length === 1 ? " message" : " messages") +
          (currentFolder === "inbox" && unread ? ", " + unread + " unread" : "");
        UI.broadcast("mail-changed", { unread: unread });
      })
      .catch(function (e) {
        mailbox.status.textContent = e.message;
        mailbox.status.style.color = "#a00";
      });
  }

  function mailRow(m) {
    const row = el("div", "w98-mailrow" + (m.read ? "" : " is-unread"));
    row.tabIndex = 0;
    row.setAttribute("role", "listitem");
    row.dataset.id = m.id;

    const icon = el("img");
    icon.src = m.read ? "assets/notepad-file-32x32.png" : "assets/notepad-32x32.png";
    icon.alt = "";

    const from = el("span", "w98-mailfrom", m.folder === "sent" ? "To: " + m.to : m.from);
    const subject = el("span", "w98-mailsubject", m.subject);
    const when = el("span", "w98-mailwhen", fmtDate(m.sent));

    const actions = el("span", "w98-fileactions");
    if (currentFolder === "trash") {
      const restore = el("button", "w98-mini", "Restore");
      restore.type = "button";
      restore.addEventListener("click", function (e) {
        e.stopPropagation();
        LD.mailRestore(m.id).then(refresh).catch(function (err) { UI.errorBox("Mail", err.message); });
      });
      actions.appendChild(restore);
    }
    const del = el("button", "w98-mini", "Delete");
    del.type = "button";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      const permanent = currentFolder === "trash";
      const go = function () {
        LD.mailDelete(m.id, permanent)
          .then(refresh)
          .catch(function (err) { UI.errorBox("Mail", err.message); });
      };
      if (permanent) {
        UI.confirmBox("Delete", "Delete this message permanently?", go);
      } else {
        go();
      }
    });
    actions.appendChild(del);

    if (m.attachments && m.attachments.length) {
      const clip = el("span", "w98-mailclip", "\uD83D\uDCCE");
      clip.title = m.attachments.length + " attachment" + (m.attachments.length === 1 ? "" : "s");
      row.appendChild(clip);
    }

    row.appendChild(icon);
    row.appendChild(from);
    row.appendChild(subject);
    row.appendChild(when);
    row.appendChild(actions);

    row.addEventListener("dblclick", function () { openMessage(m.id); });
    row.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      openMessage(m.id);
    });
    row.addEventListener("click", function () { openMessage(m.id); });

    return row;
  }

  /* ============================================================
     Reading a message
     ============================================================ */

  function openMessage(id) {
    LD.mailOne(id)
      .then(function (res) {
        const m = res.mail;
        /* A letter opens in the letter reader, which knows how to show a
           spinning toy and play the things enclosed in it. */
        if (m.kind === "letter" && window.LDLetter) {
          LDLetter.render(m);
        } else {
          renderMessage(m);
        }
        refresh();
      })
      .catch(function (e) { UI.errorBox("Mail", e.message); });
  }

  function renderMessage(m) {
    const built = UI.makeWindow({
      title: m.subject + " — Message",
      icon: "assets/notepad-file-32x32.png",
      width: 560, height: 440, x: 180, y: 90
    });

    const meta = el("dl", "w98-mail-meta");
    const rows = [
      ["From:", m.from],
      // a copy delivered by CC says so, so the reader knows why they got it
      ["To:", m.to + (m.via === "cc" ? "  (you were copied in)" : "")],
      ["Subject:", m.subject],
      ["Date:", new Date(m.sent).toLocaleString()]
    ];
    rows.forEach(function (pair) {
      meta.appendChild(el("dt", null, pair[0]));
      meta.appendChild(el("dd", null, pair[1]));
    });
    built.body.appendChild(meta);

    const body = el("div", "w98-mail-body w98-field");
    m.body.split("\n\n").forEach(function (block) {
      const t = block.replace(/^\n+|\n+$/g, "");
      if (!t) return;
      body.appendChild(el("p", null, t));
    });
    built.body.appendChild(body);

    if (m.attachments && m.attachments.length) {
      const attach = el("div", "w98-attach");
      attach.appendChild(el("span", "w98-attach-label",
        m.attachments.length === 1 ? "1 attachment:" : m.attachments.length + " attachments:"));

      const holder = el("div", "w98-attach-list");
      m.attachments.forEach(function (a) {
        const item = el("div", "w98-attachitem");
        item.tabIndex = 0;
        item.setAttribute("role", "button");

        const icon = el("img");
        icon.src = a.kind === "image" ? "assets/paint-32x32.png" : "assets/notepad-file-32x32.png";
        icon.alt = "";

        const name = el("span", "w98-attachname", a.name);
        const size = el("span", "w98-attachsize", fmtSize(a.size));

        item.appendChild(icon);
        item.appendChild(name);
        item.appendChild(size);

        const openIt = function () {
          LD.mailAttachment(m.id, a.name)
            .then(function (res) {
              if (res.kind === "image") {
                showImage(a.name, res.mime, res.base64);
              } else {
                LDApps.openNotepad(a.name, res.text);
              }
            })
            .catch(function (e) { UI.errorBox("Attachment", e.message); });
        };
        item.addEventListener("dblclick", openIt);
        item.addEventListener("click", openIt);
        item.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); openIt(); }
        });

        holder.appendChild(item);
      });
      attach.appendChild(holder);
      built.body.appendChild(attach);
    }

    const actions = el("div", "w98-mail-actions");
    const reply = el("button", "w98-btn", "Reply");
    reply.type = "button";
    reply.addEventListener("click", function () {
      /* Ask the server to build the quote, so the attribution format and
         the Re: handling live in one place. */
      LD.replyTo(m.id)
        .then(function (r) {
          openCompose({ to: r.to, toName: r.toName, subject: r.subject, body: r.body });
        })
        .catch(function () {
          // fall back to a plain reply if the lookup fails
          openCompose({ to: m.fromId, subject: "Re: " + m.subject });
        });
    });
    actions.appendChild(reply);

    const close = el("button", "w98-btn", "Close");
    close.type = "button";
    close.addEventListener("click", function () { built.win.hidden = true; });
    actions.appendChild(close);
    built.body.appendChild(actions);

    return built;
  }

  function showImage(name, mime, base64) {
    const built = UI.makeWindow({
      title: name + " — Imaging",
      icon: "assets/paint-32x32.png",
      width: 520, height: 420, x: 240, y: 130
    });
    const wrap = el("div", "w98-viewer");
    const img = el("img");
    img.src = "data:" + mime + ";base64," + base64;
    img.alt = name;
    wrap.appendChild(img);
    built.body.appendChild(wrap);
  }

  /* ============================================================
     Composing
     ============================================================ */

  let attachments = [];   // [{ name, kind, size }]

  function openCompose(prefill) {
    const p = prefill || {};
    attachments = [];

    const built = UI.makeWindow({
      title: p.subject && /^re:/i.test(p.subject) ? "Reply" : "New Message",
      icon: "assets/notepad-32x32.png",
      width: 600, height: 520, x: 200, y: 60
    });

    const form = el("div", "w98-compose");

    /* To: a real dropdown rather than a native datalist, which renders in
       the browser's own style and shows nothing until you type.

       Several names may be typed, separated by commas or semicolons, so
       the autocomplete fills in the last one and leaves the rest alone. */
    const toRow = el("div", "w98-compose-row");
    toRow.appendChild(el("label", null, "To:"));
    const toWrap = el("div", "w98-to-wrap");
    const to = el("input", "ld-input");
    to.type = "text";
    to.spellcheck = false;
    to.autocomplete = "off";
    to.placeholder = "names, separated by commas";
    to.setAttribute("role", "combobox");
    to.setAttribute("aria-autocomplete", "list");
    to.setAttribute("aria-expanded", "false");
    toWrap.appendChild(to);
    const suggest = el("div", "w98-suggest");
    suggest.hidden = true;
    suggest.setAttribute("role", "listbox");
    toWrap.appendChild(suggest);
    toRow.appendChild(toWrap);
    form.appendChild(toRow);
    wireAutocomplete(to, suggest);

    /* CC: the same field again, but its names are copied rather than
       addressed directly. */
    const ccRow = el("div", "w98-compose-row");
    ccRow.appendChild(el("label", null, "CC:"));
    const ccWrap = el("div", "w98-to-wrap");
    const cc = el("input", "ld-input");
    cc.type = "text";
    cc.spellcheck = false;
    cc.autocomplete = "off";
    cc.placeholder = "optional";
    cc.setAttribute("role", "combobox");
    cc.setAttribute("aria-autocomplete", "list");
    cc.setAttribute("aria-expanded", "false");
    ccWrap.appendChild(cc);
    const ccSuggest = el("div", "w98-suggest");
    ccSuggest.hidden = true;
    ccSuggest.setAttribute("role", "listbox");
    ccWrap.appendChild(ccSuggest);
    ccRow.appendChild(ccWrap);
    form.appendChild(ccRow);
    wireAutocomplete(cc, ccSuggest);

    /* Subject */
    const subjRow = el("div", "w98-compose-row");
    subjRow.appendChild(el("label", null, "Subject:"));
    const subject = el("input", "ld-input");
    subject.type = "text";
    subject.maxLength = 120;
    subjRow.appendChild(subject);
    form.appendChild(subjRow);

    /* Body */
    const body = el("textarea", "ld-input w98-compose-body");
    body.spellcheck = false;
    body.setAttribute("aria-label", "Message");
    form.appendChild(body);

    /* Attachments */
    const attachBox = el("div", "w98-compose-attach");
    const attachLabel = el("span", "w98-attach-label", "No attachments");
    attachBox.appendChild(attachLabel);
    const attachList = el("div", "w98-attach-list");
    attachBox.appendChild(attachList);
    form.appendChild(attachBox);

    const attachBtn = el("button", "w98-btn ld-small", "Attach from Documents");
    attachBtn.type = "button";
    attachBtn.addEventListener("click", function () { pickAttachment(renderAttachments); });

    const actions = el("div", "w98-compose-actions");
    const send = el("button", "w98-btn", "Send");
    send.type = "button";
    const cancel = el("button", "w98-btn", "Cancel");
    cancel.type = "button";
    actions.appendChild(send);
    actions.appendChild(attachBtn);
    actions.appendChild(cancel);

    form.appendChild(actions);

    built.body.appendChild(form);

    function renderAttachments() {
      attachList.textContent = "";
      attachLabel.textContent = attachments.length
        ? (attachments.length === 1 ? "1 attachment:" : attachments.length + " attachments:")
        : "No attachments";
      attachments.forEach(function (a, i) {
        const chip = el("span", "w98-attachchip");
        chip.appendChild(el("span", null, a.name));
        const x = el("button", "w98-chipx", "×");
        x.type = "button";
        x.setAttribute("aria-label", "Remove " + a.name);
        x.addEventListener("click", function () {
          attachments.splice(i, 1);
          renderAttachments();
        });
        chip.appendChild(x);
        attachList.appendChild(chip);
      });
    }

    /* prefill */
    const isReply = Boolean(p.to) && /^re:/i.test(p.subject || "");
    if (p.to) to.value = p.to;
    if (p.cc) cc.value = p.cc;
    if (p.subject) subject.value = p.subject;
    if (p.body) body.value = p.body;
    if (p.attachments) {
      attachments = p.attachments.slice();
    }

    /* If we were given an id (a reply), resolve it to a name once the
       account list arrives. */
    if (p.to && p.toName) {
      to.value = p.toName;
    } else if (p.to) {
      LD.mailRecipients().then(function (res) {
        const match = (res.users || []).filter(function (u) { return u.id === p.to; })[0];
        if (match) to.value = match.username;
      }).catch(function () {});
    }

    /* ---------- drafts ----------
       A half-written message is saved server-side as you type, so closing
       the window or reloading the page does not lose it. Restoring only
       happens when the composer was opened empty, so a reply is never
       overwritten by an old draft. */
    const draftKey = function () {
      const a = attachments.map(function (x) { return x.name; }).join("|");
      return [to.value, cc.value, subject.value, body.value, a].join("\u0000");
    };
    let lastSaved = draftKey();
    let draftTimer = null;
    let restoring = false;

    function pushDraft() {
      const d = {
        to: to.value, cc: cc.value, subject: subject.value, body: body.value,
        attachments: attachments.map(function (a) { return { name: a.name }; })
      };
      lastSaved = draftKey();
      LD.saveDraft(d).catch(function () {});
    }

    function scheduleDraft() {
      if (restoring) return;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(function () {
        if (draftKey() === lastSaved) return;
        pushDraft();
        say2("Draft saved.", false);
      }, 700);
    }

    [to, cc, subject, body].forEach(function (field) {
      field.addEventListener("input", scheduleDraft);
    });

    /* A small line under the buttons, for draft notices. */
    const draftNote = el("div", "w98-draft-note", "");
    form.appendChild(draftNote);
    function say2(text, isError) {
      draftNote.textContent = text;
      draftNote.style.color = isError ? "#a00" : "#070";
    }

    const openedEmpty = !p.to && !p.cc && !p.subject && !p.body && !(p.attachments || []).length;

    if (openedEmpty) {
      LD.draft().then(function (res) {
        const d = res && res.draft;
        if (!d) return;
        if (d.to) to.value = d.to;
        if (d.cc) cc.value = d.cc;
        if (d.subject) subject.value = d.subject;
        if (d.body) body.value = d.body;
        if (d.attachments && d.attachments.length) {
          attachments = d.attachments.map(function (a) {
            return { name: a.name, kind: "file", size: 0 };
          });
          renderAttachments();
        }
        lastSaved = draftKey();
        say2("Draft restored from " + new Date(d.saved).toLocaleString() + ".", false);
      }).catch(function () {});
    } else {
      lastSaved = draftKey();
    }

    function doSend() {
      if (!to.value.trim() && !cc.value.trim()) {
        draftNote.textContent = "Enter who this is for.";
        draftNote.style.color = "#a00";
        return;
      }
      if (!body.value.trim()) {
        draftNote.textContent = "The message is empty.";
        draftNote.style.color = "#a00";
        return;
      }

      send.disabled = true;
      LD.mailSend({
        to: to.value,
        cc: cc.value,
        subject: subject.value,
        body: body.value,
        attachments: attachments.map(function (a) { return { name: a.name }; })
      })
        .then(function (res) {
          /* The draft has become a real message, so it is no longer a
             draft. Cleared before closing so a fast reopen cannot restore
             what was just sent. */
          clearTimeout(draftTimer);
          lastSaved = draftKey();
          return LD.clearDraft().catch(function () {}).then(function () {
            built.win.hidden = true;
            UI.broadcast("mail-changed");
            if (mailbox) refresh();
            const n = (res && res.copies) || 1;
            if (n > 1) UI.infoBox("Sent", "Your message went to " + n + " people.");
          });
        })
        .catch(function (e) {
          draftNote.textContent = e.message;
          draftNote.style.color = "#a00";
        })
        .then(function () { send.disabled = false; });
    }

    send.addEventListener("click", doSend);
    cancel.addEventListener("click", function () {
      /* Closing keeps the draft; only sending clears it. */
      clearTimeout(draftTimer);
      if (draftKey() !== lastSaved) pushDraft();
      built.win.hidden = true;
    });
    body.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); doSend(); }
    });

    renderAttachments();
    setTimeout(function () { (p.to ? subject : to).focus(); }, 60);
    void isReply;
    return built;
  }

  /* Pick one of your own documents to attach. */
  /* Pick a file to attach. By default it targets the mail composer's own
     list; the letter composer passes its own list and callback so both
     can share the picker. */
  function pickAttachment(done, list, multiple) {
    const target = list || attachments;

    LD.listFiles()
      .then(function (res) {
        const files = (res.files || []).filter(function (f) {
          return !target.some(function (a) { return a.name === f.name; });
        });
        if (!files.length) {
          UI.infoBox("Attach", "There is nothing left in your Documents to attach.");
          return;
        }
        chooser(files, done, target, multiple);
      })
      .catch(function (e) { UI.errorBox("Attach", e.message); });
  }

  let chooserWindow = null;

  function chooser(files, done, target, multiple) {
    if (chooserWindow) chooserWindow.hidden = true;
    const into = target || attachments;
    const keepOpen = Boolean(multiple);

    const built = UI.makeWindow({
      title: "Attach File",
      icon: "assets/folder-32x32.png",
      width: 440, height: 340, x: 300, y: 180
    });
    chooserWindow = built.win;

    const list = el("div", "w98-filelist");

    /* Show a readable kind, covering everything the site now accepts. */
    const kindLabel = function (k) {
      return k === "image" ? "Image"
        : k === "audio" ? "Audio"
        : k === "video" ? "Video"
        : k === "note" ? "Text"
        : "File";
    };
    const iconFor = function (k) {
      return k === "image" || k === "video" ? "assets/paint-32x32.png"
        : k === "audio" ? "assets/winamp2-32x32.png"
        : "assets/notepad-file-32x32.png";
    };

    function build() {
      list.textContent = "";
      const left = files.filter(function (f) {
        return !into.some(function (a) { return a.name === f.name; });
      });

      if (!left.length) {
        list.appendChild(el("div", "w98-hint", "Everything has been added."));
        return;
      }

      left.forEach(function (f) {
        const row = el("div", "w98-filerow w98-pickrow");
        row.tabIndex = 0;

        const icon = el("img");
        icon.src = iconFor(f.kind);
        icon.alt = "";
        row.appendChild(icon);
        row.appendChild(el("span", "w98-filename", f.name));
        row.appendChild(el("span", "w98-filekind", kindLabel(f.kind)));
        row.appendChild(el("span", "w98-filesize", fmtSize(f.size)));

        const take = function () {
          into.push({ name: f.name, kind: f.kind, size: f.size });
          if (done) done();
          if (keepOpen) build();
          else built.win.hidden = true;
        };
        row.addEventListener("dblclick", take);
        row.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); take(); }
        });
        row.addEventListener("click", take);
        list.appendChild(row);
      });
    }

    build();

    const hint = el("div", "w98-hint", "Pick a file from your Documents.");
    built.body.appendChild(list);
    built.body.appendChild(hint);
    return built;
  }

  /* ============================================================
     Autocomplete for the To field

     Matches on the start of the name first, then anywhere inside it, so
     typing "al" puts "alice" above "natalie". Keyboard driven: up and
     down move, Enter takes the highlighted one, Escape closes.
     ============================================================ */

  function wireAutocomplete(input, panel) {
    let people = [];
    let matches = [];
    let at = -1;

    const close = function () {
      panel.hidden = true;
      panel.textContent = "";
      input.setAttribute("aria-expanded", "false");
      matches = [];
      at = -1;
    };

    const choose = function (name) {
      /* Replace only the segment being typed, so names already entered
         survive and a comma is added ready for the next one. */
      const before = input.value.slice(0, segmentFrom);
      input.value = before + name + ", ";
      close();
      input.focus();
      // let the composer know the field changed, so the draft is saved
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const paint = function () {
      panel.textContent = "";
      if (!matches.length) { close(); return; }

      matches.forEach(function (u, i) {
        const row = el("div", "w98-suggest-row" + (i === at ? " is-active" : ""));
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", i === at ? "true" : "false");
        row.dataset.name = u.username;

        if (u.avatar) {
          const img = el("img", "w98-suggest-av");
          img.src = LD.avatarUrl(u.username);
          img.alt = "";
          row.appendChild(img);
        } else {
          row.appendChild(el("span", "w98-suggest-av w98-suggest-blank"));
        }

        row.appendChild(el("span", "w98-suggest-name", u.username));
        row.addEventListener("mousedown", function (e) {
          // mousedown, not click: the input must not blur before we read it
          e.preventDefault();
          choose(u.username);
        });
        row.addEventListener("mouseenter", function () {
          at = i;
          Array.prototype.forEach.call(panel.children, function (c, n) {
            c.classList.toggle("is-active", n === i);
          });
        });
        panel.appendChild(row);
      });

      panel.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };

    /* Only the name being typed at the moment is matched: with
       "alice, bo" the suggestion list should be about "bo", not the whole
       field. Choosing a suggestion replaces just that segment and leaves
       the names already entered alone. */
    let segmentFrom = 0;

    const currentSegment = function () {
      const v = input.value;
      const cut = Math.max(v.lastIndexOf(","), v.lastIndexOf(";"));
      segmentFrom = cut + 1;
      return v.slice(segmentFrom).trim();
    };

    const refresh = function () {
      const typed = currentSegment().toLowerCase();
      if (!typed) { close(); return; }

        const already = {};
        input.value.split(/[,;]/).forEach(function (n) {
          already[n.trim().toLowerCase()] = true;
        });

        const starts = [], contains = [];
        people.forEach(function (u) {
          const name = u.username.toLowerCase();
          if (name === typed) return;              // already exact
          if (already[name]) return;               // already in the field
          if (name.indexOf(typed) === 0) starts.push(u);
          else if (name.indexOf(typed) !== -1) contains.push(u);
        });

        matches = starts.concat(contains).slice(0, 8);
        at = matches.length ? 0 : -1;
        paint();
      };

      /* Load the accounts once and keep them, so typing does not hit the API. */
      const load = function () {
        LD.mailRecipients().then(function (res) {
          people = res.users || [];
          if (input.value.trim()) refresh();
        }).catch(function () {});
      };
      load();

      input.addEventListener("input", refresh);
      input.addEventListener("focus", function () { if (input.value.trim()) refresh(); });

      input.addEventListener("blur", function () {
        // let a mousedown on a row land first
        setTimeout(close, 120);
      });

      input.addEventListener("keydown", function (e) {
      if (panel.hidden) {
        if (e.key === "ArrowDown" && input.value.trim()) { e.preventDefault(); refresh(); }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        at = (at + 1) % matches.length;
        paint();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        at = (at - 1 + matches.length) % matches.length;
        paint();
      } else if (e.key === "Enter") {
        if (at >= 0 && matches[at]) { e.preventDefault(); choose(matches[at].username); }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab") {
        if (at >= 0 && matches[at]) choose(matches[at].username);
      }
    });
  }

  global.LDMail = {
    init: init,
    setUser: setUser,
    open: open,
    openCompose: openCompose,
    refresh: refresh,
    wireAutocomplete: wireAutocomplete,
    pickAttachment: pickAttachment
  };
})(window);
