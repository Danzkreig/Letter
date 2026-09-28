/* ============================================================
   Letterdrop — letters

   A letter is a message with a shape that animates and, optionally,
   images and songs the reader plays in place.

   Two kinds:
     regular     an ordinary letter, sendable by anyone, shareable
     invitation  admin-only, one-use link that creates an account and
                 delivers itself into the new Inbox

   A letter opens in its own window rather than the plain message
   reader, because it has a toy and media to show.
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

  /* ============================================================
     The animated toy

     One timer per letter window, always cleared when it is torn down or
     hidden, so a window left open cannot burn a frame budget forever.
     ============================================================ */

  function makeToy(host, shape, small) {
    if (!shape || !global.LETTERDROP_ASCII || !LETTERDROP_ASCII.isValid(shape)) return null;

    const pre = el("pre", "ld-toy" + (small ? " is-small" : ""));
    pre.setAttribute("aria-label", "A spinning " + shape);

    const caption = el("div", "ld-toy-caption", LETTERDROP_ASCII.CAPTIONS[shape] || "TOY.EXE");

    const box = el("div", "ld-toy-box");
    box.appendChild(pre);
    box.appendChild(caption);
    host.appendChild(box);

    const renderer = LETTERDROP_ASCII.make(shape);
    const stepArgs = LETTERDROP_ASCII.STEP[shape] || [0, 0];

    /* The 2D shapes reveal line by line; the 3D ones turn. Either way one
       step per tick is right. */
    let timer = null;

    const draw = function () {
      renderer.step(stepArgs[0], stepArgs[1]);
      pre.textContent = renderer.render();
    };

    for (let i = 0; i < 30; i++) renderer.step(stepArgs[0], stepArgs[1]);
    pre.textContent = renderer.render();

    return {
      box: box,
      start: function () {
        if (timer) return;
        timer = setInterval(draw, 110);
      },
      stop: function () {
        clearInterval(timer);
        timer = null;
      }
    };
  }

  /* ============================================================
     Reading a letter
     ============================================================ */

  function openLetter(id) {
    return LD.letterOne(id).then(function (res) {
      renderLetter(res.mail);
    }).catch(function (e) {
      UI.errorBox("Letterdrop", e.message);
    });
  }

  function renderLetter(m) {
    const built = UI.makeWindow({
      title: m.subject + " — Letter",
      icon: "assets/notepad-file-32x32.png",
      width: 560, height: 520, x: 200, y: 70
    });

    const sheet = el("div", "ld-letter");

    /* the toy, if there is one */
    const toy = makeToy(sheet, m.shape, false);

    const head = el("div", "ld-letter-head");
    head.appendChild(el("h2", "ld-letter-subject", m.subject));
    const meta = el("div", "ld-letter-meta",
      "from " + m.from + "  \u00B7  " + new Date(m.sent).toLocaleString());
    head.appendChild(meta);
    sheet.appendChild(head);

    const body = el("div", "ld-letter-body");
    m.body.split("\n\n").forEach(function (block) {
      const t = block.replace(/^\n+|\n+$/g, "");
      if (!t) return;
      body.appendChild(el("p", null, t));
    });
    sheet.appendChild(body);

    /* attachments: images shown, songs playable right here */
    if (m.attachments && m.attachments.length) {
      const atts = el("div", "ld-letter-atts");
      atts.appendChild(el("div", "ld-att-label",
        m.attachments.length === 1 ? "1 thing enclosed" : m.attachments.length + " things enclosed"));

      m.attachments.forEach(function (a) {
        const card = el("div", "ld-att");

        if (a.kind === "image") {
          const img = el("img", "ld-att-img");
          img.alt = a.name;
          LD.mailAttachment(m.id, a.name).then(function (file) {
            img.src = "data:" + file.mime + ";base64," + file.base64;
          }).catch(function () { img.alt = a.name + " (could not be loaded)"; });
          card.appendChild(img);
          card.appendChild(el("div", "ld-att-name", a.name));
        } else if (a.kind === "audio") {
          /* streamed from the sender's folder, with range support, so a
             long track does not have to be fetched as base64 */
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.preload = "metadata";
          audio.className = "ld-att-audio";
          audio.src = "/api/mail/stream?id=" + encodeURIComponent(m.id) +
            "&name=" + encodeURIComponent(a.name);
          card.appendChild(el("div", "ld-att-name", "\u266B " + a.name));
          card.appendChild(audio);
        } else if (a.kind === "video") {
          const video = document.createElement("video");
          video.controls = true;
          video.playsInline = true;
          video.preload = "metadata";
          video.className = "ld-att-video";
          video.src = "/api/mail/stream?id=" + encodeURIComponent(m.id) +
            "&name=" + encodeURIComponent(a.name);
          card.appendChild(video);
          card.appendChild(el("div", "ld-att-name", a.name));
        } else {
          const btn = el("button", "w98-btn ld-small", "\uD83D\uDCC4 " + a.name + "  (" + fmtSize(a.size) + ")");
          btn.type = "button";
          btn.addEventListener("click", function () {
            const a2 = document.createElement("a");
            a2.href = "/api/mail/stream?id=" + encodeURIComponent(m.id) +
              "&name=" + encodeURIComponent(a.name) + "&download=1";
            a2.download = a.name;
            document.body.appendChild(a2);
            a2.click();
            document.body.removeChild(a2);
          });
          card.appendChild(btn);
        }

        atts.appendChild(card);
      });
      sheet.appendChild(atts);
    }

    built.body.appendChild(sheet);

    /* ---------- actions ---------- */
    const actions = el("div", "ld-letter-actions");

    if (m.letterType === "invitation" && m.invite && m.folder === "sent") {
      const link = el("button", "w98-btn ld-small", "Show invite link");
      link.type = "button";
      link.addEventListener("click", function () { showInviteLink(m); });
      actions.appendChild(link);
    }

    if (m.letterType !== "invitation") {
      const share = el("button", "w98-btn ld-small", "Share");
      share.type = "button";
      share.addEventListener("click", function () { shareDialog(m); });
      actions.appendChild(share);
    }

    const reply = el("button", "w98-btn ld-small", "Write back");
    reply.type = "button";
    reply.addEventListener("click", function () {
      if (window.LDMail) LDMail.openCompose({ to: m.fromId, subject: "Re: " + m.subject });
    });
    actions.appendChild(reply);

    const close = el("button", "w98-btn ld-small", "Close");
    close.type = "button";
    close.addEventListener("click", function () { built.win.hidden = true; });
    actions.appendChild(close);

    built.body.appendChild(actions);

    /* start the toy only while the window is actually on screen */
    if (toy) {
      toy.start();
      const observer = new MutationObserver(function () {
        if (built.win.hidden) toy.stop(); else toy.start();
      });
      observer.observe(built.win, { attributes: true, attributeFilter: ["hidden"] });
    }

    UI.broadcast("letter-opened", m);
    return built;
  }

  /* ============================================================
     Sharing a letter
     ============================================================ */

  function shareDialog(m) {
    const built = UI.makeWindow({
      title: "Share this letter",
      icon: "assets/network-32x32.png",
      width: 480, height: 250, x: 280, y: 180
    });

    const wrap = el("div", "w98-share");
    wrap.appendChild(el("p", "w98-share-lead",
      "Anyone with this link can read the letter, even without an account. " +
      "It shows the letter, its shape and anything enclosed \u2014 nothing else."));

    const row = el("div", "w98-share-row");
    const input = el("input", "ld-input w98-share-url");
    input.type = "text";
    input.readOnly = true;
    input.value = "Creating link...";
    row.appendChild(input);
    wrap.appendChild(row);

    const actions = el("div", "w98-share-actions");

    const copy = el("button", "w98-btn ld-small", "Copy link");
    copy.type = "button";
    copy.disabled = true;
    copy.addEventListener("click", function () {
      input.select();
      input.setSelectionRange(0, 99999);
      const done = function () {
        copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = "Copy link"; }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(input.value).then(done).catch(function () {
          try { document.execCommand("copy"); done(); } catch (e) {}
        });
      } else {
        try { document.execCommand("copy"); done(); } catch (e) {}
      }
    });
    actions.appendChild(copy);

    const stop = el("button", "w98-btn ld-small", "Stop sharing");
    stop.type = "button";
    stop.hidden = true;
    stop.addEventListener("click", function () {
      LD.unshareLetter(m.id).then(function () {
        input.value = "Sharing is off.";
        copy.disabled = true;
        stop.hidden = true;
      }).catch(function (e) { UI.errorBox("Letterdrop", e.message); });
    });
    actions.appendChild(stop);

    const close = el("button", "w98-btn ld-small", "Close");
    close.type = "button";
    close.addEventListener("click", function () { built.win.hidden = true; });
    actions.appendChild(close);

    wrap.appendChild(actions);
    built.body.appendChild(wrap);

    LD.shareLetter(m.id).then(function (res) {
      input.value = LD.letterUrl(res.token);
      copy.disabled = false;
      stop.hidden = false;
    }).catch(function (e) {
      input.value = "";
      UI.errorBox("Letterdrop", e.message);
      built.win.hidden = true;
    });

    return built;
  }

  function showInviteLink(m) {
    const built = UI.makeWindow({
      title: "Invitation link",
      icon: "assets/network-32x32.png",
      width: 520, height: 280, x: 280, y: 170
    });

    const wrap = el("div", "w98-share");
    wrap.appendChild(el("p", "w98-share-lead",
      "Send this to the person you are inviting. It works once: redeeming it " +
      "creates their account and delivers this letter into their Inbox."));

    const row = el("div", "w98-share-row");
    const input = el("input", "ld-input w98-share-url");
    input.type = "text";
    input.readOnly = true;
    input.value = LD.inviteUrl(m.invite.token);
    row.appendChild(input);
    wrap.appendChild(row);

    const state = el("p", "w98-share-hint");
    /* Deliberately no "still unused" line: this window cannot know whether
       the link has been redeemed since it opened, and there is nothing on
       the desktop that would tell you either. It only says what is certain
       from the record we already hold. */
    if (m.invite.used) {
      state.textContent = "This invitation has been used.";
    } else if (m.invite.expired) {
      state.textContent = "This invitation has expired.";
    } else {
      state.textContent = "Expires " + new Date(m.invite.expires).toDateString() + ".";
    }
    wrap.appendChild(state);

    const actions = el("div", "w98-share-actions");
    const copy = el("button", "w98-btn ld-small", "Copy link");
    copy.type = "button";
    copy.addEventListener("click", function () {
      input.select();
      input.setSelectionRange(0, 99999);
      try { document.execCommand("copy"); } catch (e) {}
      copy.textContent = "Copied";
      setTimeout(function () { copy.textContent = "Copy link"; }, 1600);
    });
    actions.appendChild(copy);

    const revoke = el("button", "w98-btn ld-small", "Revoke");
    revoke.type = "button";
    revoke.hidden = m.invite.used || m.invite.expired;
    revoke.addEventListener("click", function () {
      UI.confirmBox("Revoke invitation",
        "The link will stop working immediately.", function () {
          LD.revokeInvite(m.id).then(function () {
            state.textContent = "This invitation has been revoked.";
            revoke.hidden = true;
            copy.disabled = true;
          }).catch(function (e) { UI.errorBox("Letterdrop", e.message); });
        });
    });
    actions.appendChild(revoke);

    const close = el("button", "w98-btn ld-small", "Close");
    close.type = "button";
    close.addEventListener("click", function () { built.win.hidden = true; });
    actions.appendChild(close);

    wrap.appendChild(actions);
    built.body.appendChild(wrap);
    return built;
  }

  /* ============================================================
     Writing a letter
     ============================================================ */

  let composeWindow = null;
  let chosenShape = "heart2d";
  let enclosed = [];

  function openCompose(options) {
    const opts = options || {};

    if (composeWindow && !composeWindow.win.hidden) {
      UI.focusWindow(composeWindow.win);
      return composeWindow;
    }

    const isAdmin = UI.currentUser && UI.currentUser() && UI.currentUser().role === "admin";
    let kind = opts.kind === "invitation" && isAdmin ? "invitation" : "regular";
    enclosed = [];

    const built = UI.makeWindow({
      title: kind === "invitation" ? "New Invitation" : "New Letter",
      icon: "assets/notepad-file-32x32.png",
      width: 600, height: 560, x: 190, y: 50
    });
    composeWindow = built;

    const form = el("div", "ld-compose");

    /* ---------- kind, admins only ---------- */
    if (isAdmin) {
      const kindRow = el("div", "ld-kind");
      const regular = el("button", "ld-kindbtn is-active", "Regular letter");
      regular.type = "button";
      const invite = el("button", "ld-kindbtn", "Invitation");
      invite.type = "button";

      const describe = el("div", "ld-kindnote",
        "A regular letter goes to an account that already exists, and can be shared.");
      kindRow.appendChild(regular);
      kindRow.appendChild(invite);
      form.appendChild(kindRow);
      form.appendChild(describe);

      const setKind = function (next) {
        kind = next;
        regular.classList.toggle("is-active", next === "regular");
        invite.classList.toggle("is-active", next === "invitation");
        toField.disabled = next === "invitation";
        toField.placeholder = next === "invitation"
          ? "(the link creates the account \u2014 no name needed)"
          : "";
        describe.textContent = next === "invitation"
          ? "An invitation creates a one-use link. Redeeming it makes the account, " +
            "and this letter lands in their Inbox."
          : "A regular letter goes to an account that already exists, and can be shared.";
        UI.setWindowTitle(built.win, next === "invitation" ? "New Invitation" : "New Letter");
      };
      regular.addEventListener("click", function () { setKind("regular"); });
      invite.addEventListener("click", function () { setKind("invitation"); });
    }

    /* ---------- To ---------- */
    const toRow = el("div", "ld-row");
    toRow.appendChild(el("label", null, "To:"));
    const toWrap = el("div", "w98-to-wrap");
    const toField = el("input", "ld-input");
    toField.type = "text";
    toField.spellcheck = false;
    toField.autocomplete = "off";
    toWrap.appendChild(toField);
    const suggest = el("div", "w98-suggest");
    suggest.hidden = true;
    toWrap.appendChild(suggest);
    toRow.appendChild(toWrap);
    form.appendChild(toRow);
    if (window.LDMail && LDMail.wireAutocomplete) LDMail.wireAutocomplete(toField, suggest);

    /* ---------- Subject ---------- */
    const subjRow = el("div", "ld-row");
    subjRow.appendChild(el("label", null, "Subject:"));
    const subject = el("input", "ld-input");
    subject.type = "text";
    subject.maxLength = 120;
    subjRow.appendChild(subject);
    form.appendChild(subjRow);

    /* ---------- Body ---------- */
    form.appendChild(el("label", "ld-blocklabel", "Your letter:"));
    const body = el("textarea", "ld-input ld-letter-body-input");
    body.spellcheck = false;
    form.appendChild(body);

    /* ---------- Shape ---------- */
    form.appendChild(el("label", "ld-blocklabel", "Enclose a spinning toy:"));
    const shapeRow = el("div", "ld-shapes");
    const shapeButtons = [];

    const NONE = el("button", "ld-shape", "\u2014");
    NONE.type = "button";
    NONE.dataset.shape = "none";
    NONE.title = "None";
    NONE.addEventListener("click", function () { pickShape(null); });
    shapeRow.appendChild(NONE);
    shapeButtons.push(NONE);

    if (global.LETTERDROP_ASCII) {
      LETTERDROP_ASCII.NAMES.forEach(function (name) {
        const b = el("button", "ld-shape");
        b.type = "button";
        b.dataset.shape = name;
        b.title = LETTERDROP_ASCII.LABELS[name];
        const preview = el("pre", "ld-shape-preview");

        /* One frame of the real renderer, so the choice is what you get. */
        const r = LETTERDROP_ASCII.make(name);
        const st = LETTERDROP_ASCII.STEP[name] || [0, 0];
        for (let i = 0; i < (name.indexOf("2d") !== -1 ? 18 : 26); i++) r.step(st[0], st[1]);

        const frame = r.render();

        /* The 2D shapes are 23 columns wide and the 3D ones 78, so one font
           size cannot suit both: at the size that fits the 2D pair, three
           quarters of the 3D render is cut off and the shape is
           unrecognisable. Each preview is scaled to the room it is given. */
        const lines = frame.split("\n");
        const cols = lines.reduce(function (a, l) { return Math.max(a, l.length); }, 0);
        const rows = lines.length;
        const room = previewRoom();

        const size = Math.max(1, Math.min(
          room.width / (cols * 0.6),     // a monospace glyph is about 0.6em wide
          room.height / rows              // and about 1em tall
        ));

        preview.style.fontSize = size + "px";
        preview.style.lineHeight = size + "px";
        preview.textContent = frame;

        b.appendChild(preview);
        b.appendChild(el("span", "ld-shape-name", LETTERDROP_ASCII.LABELS[name]));
        b.addEventListener("click", function () { pickShape(name); });
        shapeRow.appendChild(b);
        shapeButtons.push(b);
      });
    }
    form.appendChild(shapeRow);

    /* How much room a preview actually has. Measured from a probe element
       styled by the same rule, so the CSS and this cannot drift apart. */
    function previewRoom() {
      const probe = el("pre", "ld-shape-preview");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.textContent = "M";
      form.appendChild(probe);
      const box = probe.getBoundingClientRect();
      form.removeChild(probe);
      return {
        width: box.width > 4 ? box.width : 66,
        height: box.height > 4 ? box.height : 40
      };
    }

    function pickShape(name) {
      chosenShape = name;
      shapeButtons.forEach(function (b) {
        b.classList.toggle("is-active", (b.dataset.shape === "none" ? null : b.dataset.shape) === name);
      });
    }
    pickShape(opts.shape || "heart2d");

    /* ---------- Enclosures ---------- */
    form.appendChild(el("label", "ld-blocklabel", "Enclose files from your Documents:"));
    const attBox = el("div", "ld-att-list");
    form.appendChild(attBox);

    const attBtn = el("button", "w98-btn ld-small", "Add a file");
    attBtn.type = "button";
    attBtn.addEventListener("click", function () {
      if (window.LDMail && LDMail.pickAttachment) LDMail.pickAttachment(renderEnclosed, enclosed, false);
      else UI.errorBox("Letterdrop", "The file picker is unavailable.");
    });
    form.appendChild(attBtn);

    function renderEnclosed() {
      attBox.textContent = "";
      if (!enclosed.length) {
        attBox.appendChild(el("div", "ld-hint", "Nothing enclosed yet."));
        return;
      }
      enclosed.forEach(function (a, i) {
        const chip = el("span", "w98-attachchip");
        const icon = a.kind === "image" ? "\uD83D\uDDBC " :
          a.kind === "audio" ? "\u266B " : a.kind === "video" ? "\uD83C\uDFA5 " : "\uD83D\uDCC4 ";
        chip.appendChild(el("span", null, icon + a.name));
        const x = el("button", "w98-chipx", "\u00D7");
        x.type = "button";
        x.setAttribute("aria-label", "Remove " + a.name);
        x.addEventListener("click", function () {
          enclosed.splice(i, 1);
          renderEnclosed();
        });
        chip.appendChild(x);
        attBox.appendChild(chip);
      });
    }
    renderEnclosed();

    /* ---------- send ---------- */
    const actions = el("div", "ld-compose-actions");
    const send = el("button", "w98-btn", "Seal and send");
    send.type = "button";
    const cancel = el("button", "w98-btn", "Cancel");
    cancel.type = "button";
    actions.appendChild(send);
    actions.appendChild(cancel);

    const msg = el("div", "w98-signin-msg");
    form.appendChild(actions);
    form.appendChild(msg);
    built.body.appendChild(form);

    if (opts.to) {
      LD.mailRecipients().then(function (res) {
        const match = (res.users || []).filter(function (u) { return u.id === opts.to; })[0];
        if (match) toField.value = match.username;
      }).catch(function () {});
    }
    if (opts.subject) subject.value = opts.subject;
    if (opts.body) body.value = opts.body;
    if (opts.attachments) {
      enclosed = opts.attachments.slice();
      renderEnclosed();
    }

    function doSend() {
      msg.style.color = "#a00";
      if (kind === "regular" && !toField.value.trim()) {
        msg.textContent = "Enter who this letter is for.";
        return;
      }
      if (!body.value.trim()) {
        msg.textContent = "The letter is empty.";
        return;
      }

      send.disabled = true;
      msg.style.color = "";
      msg.textContent = "Sealing...";

      LD.sendLetter({
        kind: kind,
        to: toField.value.trim(),
        subject: subject.value,
        body: body.value,
        shape: chosenShape,
        attachments: enclosed.map(function (a) { return { name: a.name }; })
      }).then(function (res) {
        built.win.hidden = true;
        UI.broadcast("mail-changed");
        if (window.LDMail) LDMail.refresh();

        if (res.token) showInviteLink({
          id: res.mail.id, invite: { token: res.token, used: false, expired: false,
            expires: res.mail.invite ? res.mail.invite.expires : "" }
        });
        else UI.infoBox("Letterdrop", "Your letter is on its way.");
      }).catch(function (e) {
        msg.style.color = "#a00";
        msg.textContent = e.message;
      }).then(function () { send.disabled = false; });
    }

    send.addEventListener("click", doSend);
    cancel.addEventListener("click", function () { built.win.hidden = true; });

    setTimeout(function () { (kind === "invitation" ? subject : toField).focus(); }, 60);
    return built;
  }

  /* ============================================================
     Invitation manager (admins)
     ============================================================ */

  function openInvites() {
    const user = UI.currentUser && UI.currentUser();
    if (!user || user.role !== "admin") {
      UI.errorBox("Invitations", "You need an administrator account to open this.");
      return null;
    }

    const built = UI.makeWindow({
      title: "Invitations",
      icon: "assets/network-32x32.png",
      width: 560, height: 380, x: 230, y: 130
    });

    const bar = el("div", "w98-toolbar");
    const newBtn = el("button", "w98-tool", "New invitation");
    newBtn.type = "button";
    newBtn.addEventListener("click", function () { openCompose({ kind: "invitation" }); });
    bar.appendChild(newBtn);

    const refreshBtn = el("button", "w98-tool", "Refresh");
    refreshBtn.type = "button";
    bar.appendChild(refreshBtn);

    const list = el("div", "w98-filelist");
    const status = el("div", "w98-statusbar");
    const st = el("span", null, "Loading...");
    status.appendChild(st);

    function load() {
      list.textContent = "";
      LD.invites().then(function (res) {
        const items = res.invites || [];
        if (!items.length) {
          list.appendChild(el("div", "w98-hint",
            "No invitations yet. Use New invitation to make one."));
        }
        items.forEach(function (inv) {
          const row = el("div", "w98-filerow ld-invrow");

          const icon = el("img");
          icon.src = "assets/network-32x32.png";
          icon.alt = "";
          row.appendChild(icon);

          const state = inv.used ? "used" : inv.expired ? "expired" : "unused";
          const name = el("span", "w98-filename", inv.toName || "(no name)");
          row.appendChild(name);
          row.appendChild(el("span", "w98-filekind ld-inv-" + state, state));

          const actions = el("span", "w98-fileactions");

          const copy = el("button", "w98-mini", "Copy link");
          copy.type = "button";
          copy.disabled = inv.used || inv.expired;
          copy.addEventListener("click", function (e) {
            e.stopPropagation();
            const url = LD.inviteUrl(inv.token);
            const tmp = document.createElement("input");
            tmp.value = url;
            document.body.appendChild(tmp);
            tmp.select();
            try { document.execCommand("copy"); } catch (err) {}
            document.body.removeChild(tmp);
            copy.textContent = "Copied";
            setTimeout(function () { copy.textContent = "Copy link"; }, 1400);
          });
          actions.appendChild(copy);

          const view = el("button", "w98-mini", "Open");
          view.type = "button";
          view.addEventListener("click", function (e) {
            e.stopPropagation();
            openLetter(inv.id);
          });
          actions.appendChild(view);

          if (!inv.used && !inv.expired) {
            const rev = el("button", "w98-mini", "Revoke");
            rev.type = "button";
            rev.addEventListener("click", function (e) {
              e.stopPropagation();
              UI.confirmBox("Revoke", "That link will stop working.", function () {
                LD.revokeInvite(inv.id).then(load)
                  .catch(function (err) { UI.errorBox("Invitations", err.message); });
              });
            });
            actions.appendChild(rev);
          }

          row.appendChild(actions);
          list.appendChild(row);
        });
        st.textContent = items.length + " invitation(s)";
      }).catch(function (e) {
        st.textContent = e.message;
      });
    }

    refreshBtn.addEventListener("click", load);
    built.body.appendChild(bar);
    built.body.appendChild(list);
    built.body.appendChild(status);
    load();
    return built;
  }

  global.LDLetter = {
    init: init,
    open: openLetter,
    render: renderLetter,
    compose: openCompose,
    invites: openInvites,
    makeToy: makeToy
  };
})(window);
