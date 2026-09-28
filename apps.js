/* ============================================================
   Letterdrop — the working programs

   Notepad      write notes and save them to your own space
   My Documents browse, open, download and delete your files,
                and upload images into them
   Accounts     sign in; admins also manage users

   These are the only programs in the desktop that do real work.
   Everything else raises an "illegal operation" dialog on purpose.
   ============================================================ */

(function (global) {
  "use strict";

  /* Injected by desktop.js so this file does not depend on its internals. */
  let UI = null;

  function init(ui) { UI = ui; }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " bytes";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  /* ============================================================
     Notepad
     ============================================================ */

  const notepadWindows = {};   // name -> window handle, so a file opens once

  function openNotepad(name, text) {
    const key = name || ("untitled-" + Object.keys(notepadWindows).length);

    if (notepadWindows[key] && !notepadWindows[key].win.hidden) {
      UI.focusWindow(notepadWindows[key].win);
      return notepadWindows[key];
    }

    const built = UI.makeWindow({
      title: (name || "Untitled") + " - Notepad",
      icon: "assets/notepad-32x32.png",
      width: 520, height: 400, x: 120, y: 70
    });

    const menu = el("div", "w98-menubar");
    ["File", "Edit", "Search", "Help"].forEach(function (label) {
      const b = el("button", null, label);
      b.type = "button";
      b.addEventListener("click", function () { UI.illegal(label + " menu"); });
      menu.appendChild(b);
    });

    const area = el("textarea", "w98-notepad");
    area.spellcheck = false;
    area.value = text || "";
    area.setAttribute("aria-label", "Note text");

    const status = el("div", "w98-statusbar");
    const statusText = el("span", null, name ? "Opened " + name : "New file");
    status.appendChild(statusText);

    const actions = el("div", "w98-notepad-actions");
    const saveBtn = el("button", "w98-btn", "Save");
    saveBtn.type = "button";
    const saveAsBtn = el("button", "w98-btn", "Save As...");
    saveAsBtn.type = "button";
    const wrapBtn = el("button", "w98-btn", "Word Wrap");
    wrapBtn.type = "button";
    actions.appendChild(saveBtn);
    actions.appendChild(saveAsBtn);
    actions.appendChild(wrapBtn);

    built.body.appendChild(menu);
    built.body.appendChild(area);
    built.body.appendChild(actions);
    built.body.appendChild(status);

    let currentName = name || null;

    function say(msg, isError) {
      statusText.textContent = msg;
      statusText.style.color = isError ? "#a00" : "";
    }

    function doSave(asNew) {
      if (!asNew && currentName) {
        /* Plain Save means "write this back where it came from". The name
           is not a conflict -- it is the file you opened -- so it is passed
           as an intentional overwrite rather than asked about. */
        return commitSave(currentName, true);
      }
      saveAsDialog(currentName, function (chosen, overwrite) {
        commitSave(chosen, overwrite);
      });
    }

    function commitSave(target, overwrite) {
      saveBtn.disabled = true;
      LD.saveNote(target, area.value, null, overwrite)
        .then(function (res) {
          currentName = res.name;
          notepadWindows[res.name] = built;
          built.win.dataset.title = res.name + " - Notepad";
          UI.setWindowTitle(built.win, res.name + " - Notepad");
          say((res.replaced ? "Replaced " : "Saved ") + res.name +
            " at " + new Date().toLocaleTimeString());
          UI.broadcast("files-changed");
        })
        .catch(function (e) {
          /* The name is taken. Ask what to do rather than overwriting or
             silently failing. */
          if (e.status === 409) {
            const clash = e.data && e.data.name ? e.data.name : target;
            askAboutExisting(clash,
              function () { commitSave(clash, true); },
              function (other) { commitSave(other, false); });
            return;
          }
          say(e.message, true);
        })
        .then(function () { saveBtn.disabled = false; });
    }

    /* ---------- Save As ----------
       A folder browser rather than a bare name box, so a note can actually
       be filed. Double-click a folder to descend, Up to climb back. */
    function saveAsDialog(startName, done) {
      let folder = currentName && currentName.indexOf("/") !== -1
        ? currentName.slice(0, currentName.lastIndexOf("/"))
        : "";
      let baseName = startName && startName.indexOf("/") !== -1
        ? startName.slice(startName.lastIndexOf("/") + 1)
        : (startName || "note.txt");

      const dlg = UI.makeWindow({
        title: "Save As",
        icon: "assets/notepad-file-32x32.png",
        width: 440, height: 380, x: 300, y: 150
      });

      const bar = el("div", "w98-crumbs");
      const listing = el("div", "w98-filelist");
      const foot = el("div", "saveas-foot");

      const nameRow = el("div", "saveas-row");
      nameRow.appendChild(el("label", null, "File name:"));
      const nameInput = el("input", "ld-input");
      nameInput.type = "text";
      nameInput.value = baseName;
      nameRow.appendChild(nameInput);
      foot.appendChild(nameRow);

      const actions = el("div", "w98-signin-actions");
      const ok = el("button", "w98-btn", "Save");
      ok.type = "button";
      const cancel = el("button", "w98-btn", "Cancel");
      cancel.type = "button";
      actions.appendChild(ok);
      actions.appendChild(cancel);
      foot.appendChild(actions);

      const note = el("div", "w98-signin-msg", "");
      foot.appendChild(note);

      dlg.body.appendChild(bar);
      dlg.body.appendChild(listing);
      dlg.body.appendChild(foot);

      function fullPath() {
        const n = nameInput.value.trim().replace(/^\/+/, "");
        if (!n) return "";
        return folder ? folder + "/" + n : n;
      }

      function paintCrumbs() {
        bar.textContent = "";

        const up = el("button", "w98-crumb", "\u2191 Up");
        up.type = "button";
        up.disabled = !folder;
        up.addEventListener("click", function () {
          const cut = folder.lastIndexOf("/");
          folder = cut === -1 ? "" : folder.slice(0, cut);
          load();
        });
        bar.appendChild(up);

        const root = el("button", "w98-crumb", "My Documents");
        root.type = "button";
        root.addEventListener("click", function () { folder = ""; load(); });
        bar.appendChild(root);

        if (folder) {
          let sofar = "";
          folder.split("/").forEach(function (part) {
            sofar = sofar ? sofar + "/" + part : part;
            const at = sofar;
            bar.appendChild(el("span", "w98-crumb-sep", "\u203A"));
            const b = el("button", "w98-crumb", part);
            b.type = "button";
            b.addEventListener("click", function () { folder = at; load(); });
            bar.appendChild(b);
          });
        }
      }

      function load() {
        paintCrumbs();
        listing.textContent = "";
        listing.appendChild(el("div", "w98-hint", "Loading..."));

        LD.folder(folder).then(function (res) {
          listing.textContent = "";
          const folders = res.folders || [];

          if (!folders.length) {
            listing.appendChild(el("div", "w98-hint", "No folders here."));
          }

          folders.forEach(function (f) {
            const row = el("div", "w98-filerow w98-pickrow");
            row.tabIndex = 0;
            const icon = el("img");
            icon.src = "assets/folder-32x32.png";
            icon.alt = "";
            row.appendChild(icon);
            row.appendChild(el("span", "w98-filename", f.name));
            row.appendChild(el("span", "w98-filekind", "Folder"));

            const into = function () { folder = f.path; load(); };
            row.addEventListener("dblclick", into);
            row.addEventListener("keydown", function (e) {
              if (e.key === "Enter") { e.preventDefault(); into(); }
            });
            row.addEventListener("click", into);
            listing.appendChild(row);
          });
        }).catch(function (e) {
          listing.textContent = "";
          listing.appendChild(el("div", "w98-hint", e.message));
        });
      }

      function trySave(overwrite) {
        const path = fullPath();
        if (!path) { note.textContent = "Give the note a name."; note.style.color = "#a00"; return; }

        /* The dialog only chooses a name. Saving -- and asking about a
           conflict -- is commitSave's job, so the file is written once and
           the window title and currentName come from that one write. */
        dlg.win.hidden = true;
        done(path, overwrite);
      }

      ok.addEventListener("click", function () { trySave(false); });
      nameInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); trySave(false); }
      });
      cancel.addEventListener("click", function () { dlg.win.hidden = true; });

      load();
      setTimeout(function () { nameInput.focus(); nameInput.select(); }, 80);
      return dlg;
    }

    saveBtn.addEventListener("click", function () { doSave(false); });
    saveAsBtn.addEventListener("click", function () { doSave(true); });
    wrapBtn.addEventListener("click", function () {
      const on = area.classList.toggle("wrap");
      say(on ? "Word wrap on" : "Word wrap off");
    });

    // Ctrl+S is the one keyboard shortcut everybody tries
    area.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doSave(false);
      }
    });

    notepadWindows[key] = built;
    built.close = function () { delete notepadWindows[key]; };

    area.focus();
    return built;
  }

  /* ============================================================
     My Documents
     ============================================================ */

  let docsWindow = null;
  let docsListing = null;
  let viewingUserId = null;   // set when an admin browses someone else
  let currentPath = "";       // where we are inside the folder tree
  let docsQuota = null;       // the last quota reading, for the bar
  let pendingNote = "";       // extra text for the next status line

  function openDocuments(opts) {
    const o = opts || {};
    viewingUserId = o.userId || null;
    currentPath = o.path || "";

    if (docsWindow && !docsWindow.win.hidden) {
      UI.focusWindow(docsWindow.win);
      refreshListing();
      return docsWindow;
    }

    const title = o.title || "My Documents";
    const built = UI.makeWindow({
      title: title,
      icon: "assets/my-documents-folder-32x32.png",
      width: 660, height: 470, x: 150, y: 90
    });

    const menu = el("div", "w98-menubar");
    ["File", "Edit", "View", "Help"].forEach(function (label) {
      const b = el("button", null, label);
      b.type = "button";
      b.addEventListener("click", function () { UI.illegal(label + " menu"); });
      menu.appendChild(b);
    });

    const bar = el("div", "w98-toolbar");
    const uploadBtn = el("button", "w98-tool", "");
    uploadBtn.type = "button";
    const upIcon = el("img");
    upIcon.src = "assets/paint-32x32.png";
    upIcon.alt = "";
    uploadBtn.appendChild(upIcon);
    uploadBtn.appendChild(el("span", null, "Upload File"));
    bar.appendChild(uploadBtn);

    const newNoteBtn = el("button", "w98-tool", "");
    newNoteBtn.type = "button";
    const nnIcon = el("img");
    nnIcon.src = "assets/notepad-32x32.png";
    nnIcon.alt = "";
    newNoteBtn.appendChild(nnIcon);
    newNoteBtn.appendChild(el("span", null, "New Note"));
    bar.appendChild(newNoteBtn);

    const newFolderBtn = el("button", "w98-tool", "");
    newFolderBtn.type = "button";
    const nfIcon = el("img");
    nfIcon.src = "assets/folder-32x32.png";
    nfIcon.alt = "";
    newFolderBtn.appendChild(nfIcon);
    newFolderBtn.appendChild(el("span", null, "New Folder"));
    bar.appendChild(newFolderBtn);

    const refreshBtn = el("button", "w98-tool", "");
    refreshBtn.type = "button";
    const rIcon = el("img");
    rIcon.src = "assets/task-scheduler-16x16.png";
    rIcon.alt = "";
    refreshBtn.appendChild(rIcon);
    refreshBtn.appendChild(el("span", null, "Refresh"));
    bar.appendChild(refreshBtn);

    /* ---------- where am I ---------- */
    const crumbs = el("div", "w98-crumbs");
    built.crumbs = crumbs;

    const list = el("div", "w98-filelist");
    list.setAttribute("role", "list");

    const status = el("div", "w98-statusbar");
    const statusText = el("span", null, "Loading...");
    status.appendChild(statusText);

    /* ---------- quota ---------- */
    const quotaBar = el("div", "w98-quota");
    const quotaTrack = el("div", "w98-quota-track");
    const quotaFill = el("div", "w98-quota-fill");
    quotaTrack.appendChild(quotaFill);
    const quotaText = el("span", "w98-quota-text", "");
    quotaBar.appendChild(el("span", "w98-quota-label", "Storage"));
    quotaBar.appendChild(quotaTrack);
    quotaBar.appendChild(quotaText);

    const input = el("input", "w98-upload-input");
    input.type = "file";
    // anything goes: images, audio, video, archives, documents
    input.multiple = true;
    input.hidden = true;

    built.body.appendChild(menu);
    built.body.appendChild(bar);
    built.body.appendChild(crumbs);
    built.body.appendChild(list);
    built.body.appendChild(quotaBar);
    built.body.appendChild(status);
    built.body.appendChild(input);

    uploadBtn.addEventListener("click", function () { input.click(); });
    newNoteBtn.addEventListener("click", function () { openNotepad(null, ""); });
    refreshBtn.addEventListener("click", refreshListing);
    newFolderBtn.addEventListener("click", function () {
      const name = window.prompt("Name for the new folder:", "New Folder");
      if (!name) return;
      const rel = currentPath ? currentPath + "/" + name : name;
      LD.makeFolder(rel)
        .then(function () { UI.broadcast("files-changed"); refreshListing(); })
        .catch(function (e) { UI.errorBox("My Documents", e.message); });
    });

    input.addEventListener("change", function () {
      const files = Array.prototype.slice.call(input.files || []);
      input.value = "";
      if (!files.length) return;

      /* Uploads are streamed one at a time so the progress readout means
         something and a large file cannot starve the others. */
      let at = 0;
      let saved = 0;      // total bytes saved by shrinking images

      function nextFile() {
        if (at >= files.length) {
          const tail = saved > 0
            ? "Shrunk images by " + (saved / 1048576).toFixed(1) + " MB."
            : "";
          UI.broadcast("files-changed");
          /* Hand the summary to the refresh rather than writing it first,
             or the file count would land on top of it. */
          pendingNote = tail;
          refreshListing();
          return;
        }

        const original = files[at++];

        /* Images are downscaled before they are sent, which is the
           difference between a phone photo taking a minute to upload and
           a couple of seconds. */
        const prepare = window.LDImage && LDImage.canCompress(original)
          ? (function () {
              say("Shrinking " + original.name + "...");
              return LDImage.compress(original);
            })()
          : Promise.resolve({ file: original, changed: false });

        prepare.then(function (result) {
          const file = result.file;
          if (result.changed) {
            saved += result.from.size - result.to.size;
            say(original.name + ": " + LDImage.describe(result) + ". Uploading...");
          }

          const mb = (file.size / 1048576).toFixed(1);
          /* Upload into the folder we are looking at, unless this is
             someone else's folder, in which case the server puts it at
             their root. */
          const name = currentPath && !viewingUserId
            ? currentPath + "/" + file.name
            : file.name;

          if (!result.changed) say("Uploading " + file.name + " (" + mb + " MB)...");

          return LD.uploadFile(name, file, viewingUserId, function (sent, total) {
            if (total) {
              const pct = Math.round((sent / total) * 100);
              say("Uploading " + file.name + " \u2014 " + pct + "%");
            }
          });
        }).then(function () {
          nextFile();
        }).catch(function (e) {
          say(original.name + ": " + e.message, true);
          // carry on with the rest rather than abandoning the batch
          nextFile();
        });
      }

      nextFile();
    });

    function say(msg, isError) {
      statusText.textContent = msg;
      statusText.style.color = isError ? "#a00" : "";
    }

    docsWindow = built;
    docsListing = list;

    /* Keyboard shortcuts the desktop forwards: F5 refreshes, Ctrl+N makes
       a folder, Delete removes whatever is selected. Each only acts when
       it is this window that is in front. */
    UI.on("refresh", function (e) {
      if (e && e.win === built.win) refreshListing();
    });
    UI.on("new-item", function (e) {
      if (e && e.win === built.win) newFolderBtn.click();
    });
    UI.on("delete-selected", function (e) {
      if (!e || e.win !== built.win) return;
      deleteSelection(e.rows);
    });

    refreshListing();
    return built;
  }

  /* Delete every selected row: folders whole, files individually, after
     one confirmation. */
  function deleteSelection(rows) {
    const names = rows.map(function (r) {
      const n = r.querySelector(".w98-filename");
      return n ? n.textContent : "";
    }).filter(Boolean);

    if (!names.length) return;

    UI.confirmBox("Delete",
      names.length === 1
        ? "Delete " + names[0] + "?\n\nThis cannot be undone."
        : "Delete these " + names.length + " items?\n\nThis cannot be undone.",
      function () {
        /* Folders are rows without a file extension match in the store,
           so they are told apart by their class. */
        const jobs = rows.map(function (r) {
          const name = r.querySelector(".w98-filename");
          if (!name) return Promise.resolve();
          const isFolder = r.classList.contains("w98-folderrow");
          if (isFolder) {
            const p = (currentPath ? currentPath + "/" : "") + name.textContent;
            return LD.deleteFolder(p).catch(function () {});
          }
          const path = currentPath ? currentPath + "/" + name.textContent : name.textContent;
          return LD.deleteFile(path, viewingUserId).catch(function () {});
        });
        Promise.all(jobs).then(function () {
          UI.broadcast("files-changed");
          refreshListing();
        });
      });
  }

  /* The breadcrumb trail, so it is always clear which folder you are in
     and how to get back out. */
  function renderCrumbs() {
    if (!docsWindow || !docsWindow.crumbs) return;
    const bar = docsWindow.crumbs;
    bar.textContent = "";

    const back = el("button", "w98-crumb", "\u2191 Up");
    back.type = "button";
    back.disabled = !currentPath;
    back.addEventListener("click", function () {
      const cut = currentPath.lastIndexOf("/");
      currentPath = cut === -1 ? "" : currentPath.slice(0, cut);
      refreshListing();
    });
    bar.appendChild(back);

    const here = el("button", "w98-crumb", viewingUserId ? "Documents" : "My Documents");
    here.type = "button";
    here.addEventListener("click", function () { currentPath = ""; refreshListing(); });
    bar.appendChild(here);

    if (currentPath) {
      const parts = currentPath.split("/");
      let sofar = "";
      parts.forEach(function (p) {
        sofar = sofar ? sofar + "/" + p : p;
        const at = sofar;
        bar.appendChild(el("span", "w98-crumb-sep", "\u203A"));
        const b = el("button", "w98-crumb", p);
        b.type = "button";
        b.addEventListener("click", function () { currentPath = at; refreshListing(); });
        bar.appendChild(b);
      });
    }
  }

  function renderQuota() {
    if (!docsWindow || !docsQuota) return;
    const bar = docsWindow.win.querySelector(".w98-quota");
    if (!bar) return;

    const fill = bar.querySelector(".w98-quota-fill");
    const text = bar.querySelector(".w98-quota-text");
    const q = docsQuota;

    if (q.unlimited) {
      fill.style.width = "0%";
      fill.classList.remove("is-warn", "is-full");
      text.textContent = fmtSize(q.usedBytes) + " used \u00B7 no limit";
      return;
    }

    fill.style.width = Math.max(2, q.percent) + "%";
    fill.classList.toggle("is-warn", q.percent >= 80 && q.percent < 95);
    fill.classList.toggle("is-full", q.percent >= 95);
    text.textContent = fmtSize(q.usedBytes) + " of " + fmtSize(q.quotaBytes) +
      " (" + q.percent + "%)";
  }

  function refreshListing() {
    if (!docsListing) return;
    docsListing.textContent = "";
    renderCrumbs();
    const s = docsListing.parentNode.querySelector(".w98-statusbar span");
    if (s) { s.textContent = "Loading..."; s.style.color = ""; }

    LD.folder(currentPath, viewingUserId)
      .then(function (res) {
        if (res.error) throw new Error(res.error);

        docsQuota = res.quota;
        renderQuota();

        const folders = res.folders || [];
        const files = res.files || [];

        if (!folders.length && !files.length) {
          docsListing.appendChild(el("div", "w98-hint",
            "This folder is empty. Use New Note, New Folder or Upload File."));
        }

        folders.forEach(function (f) {
          docsListing.appendChild(folderRow(f));
        });
        files.forEach(function (f) { docsListing.appendChild(fileRow(f)); });

        const total = files.reduce(function (a, f) { return a + f.size; }, 0);
        if (s) {
          const bits = [];
          if (folders.length) bits.push(folders.length + (folders.length === 1 ? " folder" : " folders"));
          bits.push(files.length + (files.length === 1 ? " file" : " files"));
          /* `pendingNote` lets a caller say something extra without it
             being wiped by the refresh it triggered. */
          s.textContent = bits.join(", ") + ", " + fmtSize(total) +
            (pendingNote ? "  " + pendingNote : "");
          pendingNote = "";
        }
      })
      .catch(function (e) {
        if (s) { s.textContent = e.message; s.style.color = "#a00"; }
      });
  }

  /* A folder row: double-click to open, plus rename and delete. */
  function folderRow(f) {
    const row = el("div", "w98-filerow w98-folderrow");
    row.tabIndex = 0;
    row.setAttribute("role", "listitem");

    const icon = el("img");
    icon.src = "assets/folder-32x32.png";
    icon.alt = "";
    row.appendChild(icon);

    const name = el("span", "w98-filename", f.name);
    row.appendChild(name);
    row.appendChild(el("span", "w98-filekind", "Folder"));
    row.appendChild(el("span", "w98-filesize",
      f.items === 1 ? "1 item" : f.items + " items"));

    const actions = el("span", "w98-fileactions");

    const ren = el("button", "w98-mini", "Rename");
    ren.type = "button";
    ren.addEventListener("click", function (e) {
      e.stopPropagation();
      const next = window.prompt("New name for the folder:", f.name);
      if (!next || next === f.name) return;
      /* Renaming a folder is a move of the whole tree; the simplest
         correct way is to create the new folder, move each child, then
         drop the old one. */
      const target = currentPath ? currentPath + "/" + next : next;
      LD.makeFolder(target)
        .then(function () { return LD.folder(f.path, viewingUserId); })
        .then(function (res) {
          const jobs = [];
          (res.files || []).forEach(function (file) {
            jobs.push(LD.renameFile(file.path, target + "/" + file.name));
          });
          return Promise.all(jobs);
        })
        .then(function () { return LD.deleteFolder(f.path); })
        .then(function () { UI.broadcast("files-changed"); refreshListing(); })
        .catch(function (err) { UI.errorBox("My Documents", err.message); });
    });
    actions.appendChild(ren);

    const del = el("button", "w98-mini", "Delete");
    del.type = "button";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      UI.confirmBox("Delete Folder",
        "Delete " + f.name + " and everything in it?\n\nThis cannot be undone.",
        function () {
          LD.deleteFolder(f.path)
            .then(function () { UI.broadcast("files-changed"); refreshListing(); })
            .catch(function (err) { UI.errorBox("My Documents", err.message); });
        });
    });
    actions.appendChild(del);

    row.appendChild(actions);

    const open = function () { currentPath = f.path; refreshListing(); };
    row.addEventListener("dblclick", open);
    row.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); open(); }
    });

    return row;
  }

  function fileRow(f) {
    const row = el("div", "w98-filerow");
    row.tabIndex = 0;
    row.setAttribute("role", "listitem");

    /* Files inside folders are addressed by their full path, so every
       action uses `path` rather than `name`. */
    const key = f.path || f.name;

    const icon = el("img");
    icon.src = f.kind === "image" ? "assets/paint-32x32.png" :
      f.kind === "audio" || f.kind === "video" ? "assets/winamp2-32x32.png" :
      "assets/notepad-file-32x32.png";
    icon.alt = "";

    const name = el("span", "w98-filename", f.name);
    const kindLabel = { image: "Image", audio: "Audio", video: "Video", note: "Text", file: "File" };
    const kind = el("span", "w98-filekind", kindLabel[f.kind] || "File");
    const size = el("span", "w98-filesize", fmtSize(f.size));
    const when = el("span", "w98-filewhen", fmtDate(f.modified));

    const actions = el("span", "w98-fileactions");

    if (!viewingUserId) {
      const ren = el("button", "w98-mini", "Rename");
      ren.type = "button";
      ren.addEventListener("click", function (e) {
        e.stopPropagation();
        const next = window.prompt("New name:", f.name);
        if (!next || next === f.name) return;
        const folder = key.indexOf("/") === -1 ? "" : key.slice(0, key.lastIndexOf("/"));
        const target = folder ? folder + "/" + next : next;
        LD.renameFile(key, target)
          .then(function () { UI.broadcast("files-changed"); refreshListing(); })
          .catch(function (err) { UI.errorBox("Rename", err.message); });
      });
      actions.appendChild(ren);
    }

    /* Share: only the owner may publish a file, matching what the server
       allows. An admin browsing someone else's folder gets no Share button. */
    if (!viewingUserId) {
      const shareBtn = el("button", "w98-mini", f.share ? "Link" : "Share");
      shareBtn.type = "button";
      if (f.share) shareBtn.classList.add("is-shared");
      shareBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (f.share) {
          showShareLink(key, f.share);
        } else {
          LD.shareFile(key)
            .then(function (res) { refreshListing(); showShareLink(key, res.token); })
            .catch(function (err) { UI.errorBox("Share", err.message); });
        }
      });
      actions.appendChild(shareBtn);
    }

    const del = el("button", "w98-mini", "Delete");
    del.type = "button";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      UI.confirmBox("Delete File",
        "Delete " + f.name + "?\n\nThis cannot be undone.",
        function () {
          LD.deleteFile(key, viewingUserId)
            .then(function () {
              UI.broadcast("files-changed");
              refreshListing();
            })
            .catch(function (err) { UI.errorBox("Delete", err.message); });
        });
    });
    actions.appendChild(del);

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(kind);
    row.appendChild(size);
    row.appendChild(when);
    row.appendChild(actions);

    function open() { openFile(f); }

    row.addEventListener("dblclick", open);
    row.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      open();
    });
    /* A plain click selects the row. The shared helper honours Ctrl and
       Shift, so every list in the desktop behaves the same way. */
    row.addEventListener("click", function (e) {
      if (e.target.closest("button, a, input")) return;
      UI.selectRow(row, e);
    });

    return row;
  }

  function openFile(f) {
    const key = f.path || f.name;
    if (f.kind === "image") {
      openImageViewer(key);
      return;
    }
    if (f.kind === "audio" || f.kind === "video") {
      // a song or a clip belongs in the player, not a text window
      if (window.LDWinamp) LDWinamp.open(key);
      else openImageViewer(key);
      return;
    }
    LD.readFile(key, viewingUserId)
      .then(function (res) { openNotepad(res.name, res.text); })
      .catch(function (e) { UI.errorBox("Notepad", e.message); });
  }

  /* ============================================================
     Sharing
     Shows the public link with a Copy button, and a way to revoke.
     ============================================================ */

  function showShareLink(name, token) {
    const url = LD.shareUrl(token);

    const built = UI.makeWindow({
      title: "Share — " + name,
      icon: "assets/network-32x32.png",
      width: 470, height: 260, x: 260, y: 150
    });

    const body = el("div", "w98-share");

    body.appendChild(el("p", "w98-share-lead",
      "Anyone with this link can view the file. Paste it into Discord and it will " +
      "show a preview."));

    const row = el("div", "w98-share-row");
    const input = el("input", "ld-input w98-share-url");
    input.type = "text";
    input.readOnly = true;
    input.value = url;
    input.setAttribute("aria-label", "Public link");
    row.appendChild(input);
    body.appendChild(row);

    const actions = el("div", "w98-share-actions");

    const copy = el("button", "w98-btn", "Copy link");
    copy.type = "button";
    copy.addEventListener("click", function () {
      input.select();
      input.setSelectionRange(0, 99999);
      const done = function () {
        copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = "Copy link"; }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(done).catch(function () {
          try { document.execCommand("copy"); done(); } catch (e) {}
        });
      } else {
        try { document.execCommand("copy"); done(); } catch (e) {}
      }
    });
    actions.appendChild(copy);

    const openBtn = el("button", "w98-btn", "Open");
    openBtn.type = "button";
    openBtn.addEventListener("click", function () {
      window.open(url, "_blank", "noopener");
    });
    actions.appendChild(openBtn);

    const stop = el("button", "w98-btn", "Stop sharing");
    stop.type = "button";
    stop.addEventListener("click", function () {
      UI.confirmBox("Stop sharing",
        "The link will stop working immediately. Anyone you sent it to will " +
        "no longer be able to open it.",
        function () {
          LD.unshareFile(name)
            .then(function () {
              built.win.hidden = true;
              UI.broadcast("files-changed");
              refreshListing();
            })
            .catch(function (err) { UI.errorBox("Sharing", err.message); });
        });
    });
    actions.appendChild(stop);

    const close = el("button", "w98-btn", "Close");
    close.type = "button";
    close.addEventListener("click", function () { built.win.hidden = true; });
    actions.appendChild(close);

    body.appendChild(actions);

    const hint = el("p", "w98-share-hint",
      "For Discord to show a preview, the link must be reachable from the " +
      "internet — a localhost address will only work on this machine.");
    body.appendChild(hint);

    built.body.appendChild(body);
    setTimeout(function () { input.focus(); input.select(); }, 60);
    return built;
  }

  /* ============================================================
     Image viewer
     ============================================================ */

  function openImageViewer(name) {
    // `name` may be a path; show only the file part in the title bar
    const leaf = name.indexOf("/") === -1 ? name : name.slice(name.lastIndexOf("/") + 1);
    LD.readFile(name, viewingUserId)
      .then(function (res) {
        const built = UI.makeWindow({
          title: leaf + " - Imaging",
          icon: "assets/paint-32x32.png",
          width: 560, height: 460, x: 220, y: 110
        });

        const wrap = el("div", "w98-viewer");
        const img = el("img");
        img.src = "data:" + res.mime + ";base64," + res.base64;
        img.alt = leaf;
        wrap.appendChild(img);

        const bar = el("div", "w98-toolbar");
        const dl = el("button", "w98-tool", "Save a copy");
        dl.type = "button";
        dl.addEventListener("click", function () {
          const a = document.createElement("a");
          a.href = img.src;
          a.download = leaf;
          a.click();
        });
        bar.appendChild(dl);

        built.body.appendChild(bar);
        built.body.appendChild(wrap);
      })
      .catch(function (e) { UI.errorBox("Imaging", e.message); });
  }

  /* ============================================================
     "That file already exists"

     Saving a note over an existing name used to happen silently, which is
     how you lose work you meant to keep. This asks first, and offers a way
     out that is neither overwriting nor cancelling: pick another name.
     ============================================================ */

  function askAboutExisting(name, onReplace, onRename) {
    const dlg = UI.makeWindow({
      title: "Confirm Save As",
      icon: "assets/recycle-bin-32x32.png",
      width: 400, height: 200, x: 340, y: 220
    });

    const body = el("div", "w98-exists");
    body.appendChild(el("div", "w98-exists-text",
      name + " already exists."));
    body.appendChild(el("div", "w98-exists-sub",
      "Do you want to replace it?"));

    const actions = el("div", "w98-signin-actions");

    const replace = el("button", "w98-btn", "Replace");
    replace.type = "button";
    replace.addEventListener("click", function () {
      dlg.win.hidden = true;
      if (onReplace) onReplace();
    });
    actions.appendChild(replace);

    const rename = el("button", "w98-btn", "Keep Both");
    rename.type = "button";
    rename.title = "Save under a different name instead";
    rename.addEventListener("click", function () {
      dlg.win.hidden = true;
      if (onRename) onRename(suggestName(name));
    });
    actions.appendChild(rename);

    const cancel = el("button", "w98-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", function () { dlg.win.hidden = true; });
    actions.appendChild(cancel);

    body.appendChild(actions);
    dlg.body.appendChild(body);

    // Escape and the close button both mean cancel
    setTimeout(function () { replace.focus(); }, 60);
    return dlg;
  }

  /* "note.txt" -> "note (2).txt", avoiding any name already taken. */
  function suggestName(name) {
    const slash = name.lastIndexOf("/");
    const folder = slash === -1 ? "" : name.slice(0, slash + 1);
    const leaf = slash === -1 ? name : name.slice(slash + 1);

    const dot = leaf.lastIndexOf(".");
    const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
    const ext = dot > 0 ? leaf.slice(dot) : "";

    return folder + stem + " (2)" + ext;
  }

  /* ============================================================
     Sign in
     ============================================================ */

  /* ============================================================
     Forced password change

     Shown when the account's password was chosen by somebody else --
     the generated seed admin password, or one an admin set. The server
     refuses everything else until this is done, so it is not a nag:
     it is the only way forward.
     ============================================================ */

  let forceWindow = null;

  function openForcePasswordChange(onDone) {
    if (forceWindow && !forceWindow.win.hidden) {
      UI.focusWindow(forceWindow.win);
      return forceWindow;
    }

    const built = UI.makeWindow({
      title: "Change Your Password",
      icon: "assets/network-32x32.png",
      width: 430, height: 360, x: 260, y: 130
    });
    built.win.classList.add("w98-signin-win", "w98-force-win");

    const form = el("div", "w98-signin");

    const banner = el("div", "w98-signin-banner");
    banner.appendChild(el("div", "w98-signin-title", "Letterdrop Network"));
    banner.appendChild(el("div", "w98-signin-sub",
      "This password was set for you. Choose your own to continue."));
    form.appendChild(banner);

    form.appendChild(el("p", "w98-force-note",
      "Until you do, the rest of the desktop stays locked. Pick something " +
      "only you know \u2014 at least 8 characters."));

    const row1 = el("div", "w98-signin-row");
    row1.appendChild(el("label", null, "Current:"));
    const current = el("input", "w98-field");
    current.type = "password";
    current.autocomplete = "current-password";
    row1.appendChild(current);
    form.appendChild(row1);

    const row2 = el("div", "w98-signin-row");
    row2.appendChild(el("label", null, "New:"));
    const next = el("input", "w98-field");
    next.type = "password";
    next.autocomplete = "new-password";
    row2.appendChild(next);
    form.appendChild(row2);

    const row3 = el("div", "w98-signin-row");
    row3.appendChild(el("label", null, "Again:"));
    const again = el("input", "w98-field");
    again.type = "password";
    again.autocomplete = "new-password";
    row3.appendChild(again);
    form.appendChild(row3);

    const msg = el("div", "w98-signin-msg", "");
    form.appendChild(msg);

    const actions = el("div", "w98-signin-actions");
    const save = el("button", "w98-btn", "Change password");
    save.type = "button";
    const out = el("button", "w98-btn", "Sign out");
    out.type = "button";
    actions.appendChild(save);
    actions.appendChild(out);
    form.appendChild(actions);

    built.body.appendChild(form);

    function say(text, bad) {
      msg.textContent = text;
      msg.style.color = bad ? "#a00" : "";
    }

    function submit() {
      if (!current.value || !next.value) { say("Fill in every box.", true); return; }
      if (next.value.length < 8) { say("The new password must be at least 8 characters.", true); return; }
      if (next.value !== again.value) { say("The two new passwords do not match.", true); return; }

      save.disabled = true;
      say("Changing...");
      LD.changePassword(current.value, next.value)
        .then(function (res) {
          built.win.hidden = true;
          forceWindow = null;
          const ended = res && res.otherSessionsEnded;
          UI.infoBox("Password Changed",
            "Your password has been changed." +
            (ended ? "\n\n" + ended + " other session(s) were signed out." : ""));
          if (onDone) onDone(true);
        })
        .catch(function (e) {
          say(e.message, true);
          save.disabled = false;
        });
    }

    save.addEventListener("click", submit);
    again.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    out.addEventListener("click", function () {
      LD.logout().catch(function () {}).then(function () {
        built.win.hidden = true;
        forceWindow = null;
        if (UI.onSignedOut) UI.onSignedOut();
        location.reload();
      });
    });

    /* No close button: the window cannot be dismissed while the account is
       restricted, or the desktop would be a dead end. */
    const closer = built.win.querySelector(".w98-tbtn-close");
    if (closer) closer.hidden = true;

    forceWindow = { win: built.win };
    setTimeout(function () { current.focus(); }, 80);
    return forceWindow;
  }

  /* ============================================================
     Profile

     Your own name and picture. Any signed-in user can change their
     own; an admin can change anyone's from User Accounts.
     ============================================================ */

  let profileWindow = null;

  function openProfile(user) {
    const me = user || (UI.currentUser && UI.currentUser());
    if (!me) { if (UI.requireSignIn) UI.requireSignIn(); return null; }

    if (profileWindow && !profileWindow.win.hidden) {
      UI.focusWindow(profileWindow.win);
      profileWindow.refresh();
      return profileWindow;
    }

    const built = UI.makeWindow({
      title: "Profile — " + me.username,
      icon: "assets/my-computer-32x32.png",
      width: 420, height: 380, x: 260, y: 130
    });

    const form = el("div", "w98-profile");

    /* the picture */
    const picRow = el("div", "w98-profile-pic");
    const frame = el("div", "w98-avatar-frame");
    const img = el("img", "w98-avatar");
    img.alt = "Profile picture";
    frame.appendChild(img);
    const noPic = el("div", "w98-avatar-none", "No picture");
    frame.appendChild(noPic);
    picRow.appendChild(frame);

    const picActions = el("div", "w98-profile-picactions");
    const upload = el("button", "w98-btn ld-small", "Choose a picture...");
    upload.type = "button";
    const remove = el("button", "w98-btn ld-small", "Remove");
    remove.type = "button";
    const hint = el("div", "w98-hint", "PNG, JPEG, GIF or WebP, up to 2 MB.");
    picActions.appendChild(upload);
    picActions.appendChild(remove);
    picActions.appendChild(hint);
    picRow.appendChild(picActions);
    form.appendChild(picRow);

    const file = el("input");
    file.type = "file";
    file.accept = "image/png,image/jpeg,image/gif,image/webp";
    file.hidden = true;
    form.appendChild(file);

    /* the name */
    const nameRow = el("div", "w98-profile-row");
    nameRow.appendChild(el("label", null, "User name:"));
    nameRow.appendChild(el("div", "w98-profile-name", me.username));
    form.appendChild(nameRow);

    const roleRow = el("div", "w98-profile-row");
    roleRow.appendChild(el("label", null, "Account type:"));
    roleRow.appendChild(el("div", "w98-profile-name",
      me.role === "admin" ? "Administrator" : "Standard user"));
    form.appendChild(roleRow);

    /* password */
    form.appendChild(el("div", "w98-profile-sep"));
    const pwLabel = el("div", "w98-profile-note",
      "Change your password. You will stay signed in.");
    form.appendChild(pwLabel);

    const curRow = el("div", "w98-profile-row");
    curRow.appendChild(el("label", null, "Current:"));
    const cur = el("input", "w98-field");
    cur.type = "password";
    cur.autocomplete = "current-password";
    curRow.appendChild(cur);
    form.appendChild(curRow);

    const newRow = el("div", "w98-profile-row");
    newRow.appendChild(el("label", null, "New:"));
    const next = el("input", "w98-field");
    next.type = "password";
    next.autocomplete = "new-password";
    newRow.appendChild(next);
    form.appendChild(newRow);

    const msg = el("div", "w98-signin-msg", "");
    form.appendChild(msg);

    const actions = el("div", "w98-signin-actions");
    const save = el("button", "w98-btn", "Save password");
    save.type = "button";
    const close = el("button", "w98-btn", "Close");
    close.type = "button";
    actions.appendChild(save);
    actions.appendChild(close);
    form.appendChild(actions);

    /* ---------- active sessions ---------- */
    form.appendChild(el("div", "w98-profile-sep"));
    form.appendChild(el("div", "w98-profile-note",
      "Where you are signed in. Ending a session signs that device out."));

    const sessBox = el("div", "w98-sessions");
    form.appendChild(sessBox);

    const sessActions = el("div", "w98-signin-actions");
    const killOthers = el("button", "w98-btn ld-small", "Sign out other devices");
    killOthers.type = "button";
    sessActions.appendChild(killOthers);
    form.appendChild(sessActions);

    function when(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      const mins = Math.round((Date.now() - d.getTime()) / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return mins + " min ago";
      if (mins < 1440) return Math.round(mins / 60) + "h ago";
      return d.toLocaleDateString();
    }

    function shortAgent(ua) {
      if (!ua) return "Unknown device";
      const s = String(ua);
      // pull out the readable part rather than showing the whole string
      const browser =
        /Edg\//.test(s) ? "Edge" :
        /OPR\//.test(s) ? "Opera" :
        /Firefox\//.test(s) ? "Firefox" :
        /Chrome\//.test(s) ? "Chrome" :
        /Safari\//.test(s) ? "Safari" :
        /curl|node|fetch/i.test(s) ? "Command line" : "Browser";
      const os =
        /Windows/.test(s) ? "Windows" :
        /Mac OS|Macintosh/.test(s) ? "macOS" :
        /Android/.test(s) ? "Android" :
        /iPhone|iPad/.test(s) ? "iOS" :
        /Linux/.test(s) ? "Linux" : "";
      return os ? browser + " on " + os : browser;
    }

    function loadSessions() {
      sessBox.textContent = "";
      sessBox.appendChild(el("div", "w98-hint", "Loading..."));
      LD.sessions().then(function (res) {
        const list = res.sessions || [];
        sessBox.textContent = "";
        if (!list.length) {
          sessBox.appendChild(el("div", "w98-hint", "No active sessions."));
          killOthers.hidden = true;
          return;
        }
        killOthers.hidden = list.length < 2;

        list.forEach(function (s) {
          const row = el("div", "w98-session" + (s.current ? " is-current" : ""));

          const main = el("div", "w98-session-main");
          main.appendChild(el("div", "w98-session-name",
            shortAgent(s.agent) + (s.current ? "  (this device)" : "")));
          const bits = [];
          if (s.ip) bits.push(s.ip);
          if (s.created) bits.push("signed in " + when(s.created));
          main.appendChild(el("div", "w98-session-meta", bits.join("  \u00B7  ")));
          row.appendChild(main);

          if (!s.current) {
            const end = el("button", "w98-mini", "Sign out");
            end.type = "button";
            end.addEventListener("click", function () {
              LD.revokeSession(s.id).then(loadSessions)
                .catch(function (e) { UI.errorBox("Sessions", e.message); });
            });
            row.appendChild(end);
          }

          sessBox.appendChild(row);
        });
      }).catch(function (e) {
        sessBox.textContent = "";
        sessBox.appendChild(el("div", "w98-hint", e.message));
        killOthers.hidden = true;
      });
    }

    killOthers.addEventListener("click", function () {
      UI.confirmBox("Sign out other devices",
        "Every other session will be signed out. You will stay signed in here.",
        function () {
          LD.revokeOtherSessions().then(function (res) {
            UI.infoBox("Sessions", res.removed + " session(s) signed out.");
            loadSessions();
          }).catch(function (e) { UI.errorBox("Sessions", e.message); });
        });
    });

    built.body.appendChild(form);

    loadSessions();

    function refresh() {
      // pick up the latest avatar, including one just uploaded
      const fresh = UI.currentUser && UI.currentUser();
      const updated = fresh && fresh.avatarUpdated;
      LD.me().then(function (res) {
        const u = res.user;
        if (!u) return;
        if (u.avatar) {
          img.hidden = false;
          noPic.hidden = true;
          img.src = LD.avatarUrl(u.username, u.avatarUpdated);
          remove.disabled = false;
        } else {
          img.hidden = true;
          noPic.hidden = false;
          remove.disabled = true;
        }
        void updated;
      }).catch(function () {});
    }

    upload.addEventListener("click", function () { file.click(); });

    file.addEventListener("change", function () {
      const picked = file.files && file.files[0];
      file.value = "";
      if (!picked) return;

      msg.textContent = "Reading...";
      msg.style.color = "";

      /* An avatar is shown a hundred pixels wide, so there is no reason to
         store a full-size photo. A large one is shrunk to fit rather than
         simply rejected for being over the limit. */
      const prepare = window.LDImage && LDImage.canCompress(picked)
        ? LDImage.compress(picked)
        : Promise.resolve({ file: picked, changed: false });

      prepare.then(function (result) {
        const f = result.file;

        if (f.size > 2 * 1024 * 1024) {
          msg.textContent = "That picture is larger than 2 MB.";
          msg.style.color = "#a00";
          return;
        }

        if (result.changed) {
          msg.textContent = "Shrunk from " +
            (result.from.size / 1048576).toFixed(1) + " MB. Uploading...";
        } else {
          msg.textContent = "Uploading...";
        }

        return LD.fileToBase64(f).then(function (b64) {
          return LD.setAvatar(f.type, b64);
        }).then(function () {
          /* Report what was saved, not just that it worked, so the
             shrinking is visible rather than mysterious. */
          msg.textContent = result.changed
            ? "Picture updated (shrunk from " +
              (result.from.size / 1048576).toFixed(1) + " MB to " +
              (result.to.size / 1048576).toFixed(1) + " MB)."
            : "Picture updated.";
          msg.style.color = "#070";
          refresh();
          UI.broadcast("avatar-changed");
        });
      }).catch(function (e) {
        msg.textContent = e.message;
        msg.style.color = "#a00";
      });
    });

    remove.addEventListener("click", function () {
      LD.clearAvatar().then(function () {
        msg.textContent = "Picture removed.";
        msg.style.color = "#070";
        refresh();
        UI.broadcast("avatar-changed");
      }).catch(function (e) {
        msg.textContent = e.message;
        msg.style.color = "#a00";
      });
    });

    save.addEventListener("click", function () {
      if (!cur.value || !next.value) {
        msg.textContent = "Fill in both password boxes.";
        msg.style.color = "#a00";
        return;
      }
      save.disabled = true;
      LD.changePassword(cur.value, next.value).then(function () {
        msg.textContent = "Password changed.";
        msg.style.color = "#070";
        cur.value = "";
        next.value = "";
      }).catch(function (e) {
        msg.textContent = e.message;
        msg.style.color = "#a00";
      }).then(function () { save.disabled = false; });
    });

    close.addEventListener("click", function () { built.win.hidden = true; });

    profileWindow = { win: built.win, refresh: refresh };
    refresh();
    return profileWindow;
  }

  function openSignIn(onDone) {
    const built = UI.makeWindow({
      title: "Log On to Letterdrop",
      icon: "assets/network-32x32.png",
      width: 380, height: 260, x: 200, y: 120
    });
    built.win.classList.add("w98-signin-win");

    const form = el("div", "w98-signin");

    const banner = el("div", "w98-signin-banner");
    banner.appendChild(el("div", "w98-signin-title", "Letterdrop Network"));
    banner.appendChild(el("div", "w98-signin-sub", "Enter your user name and password."));
    form.appendChild(banner);

    const row1 = el("div", "w98-signin-row");
    row1.appendChild(el("label", null, "User name:"));
    const user = el("input", "w98-field");
    user.type = "text";
    user.autocomplete = "username";
    user.spellcheck = false;
    row1.appendChild(user);
    form.appendChild(row1);

    const row2 = el("div", "w98-signin-row");
    row2.appendChild(el("label", null, "Password:"));
    const pass = el("input", "w98-field");
    pass.type = "password";
    pass.autocomplete = "current-password";
    row2.appendChild(pass);
    form.appendChild(row2);

    const msg = el("div", "w98-signin-msg", "");
    form.appendChild(msg);

    const actions = el("div", "w98-signin-actions");
    const ok = el("button", "w98-btn", "OK");
    ok.type = "button";
    const cancel = el("button", "w98-btn", "Cancel");
    cancel.type = "button";
    actions.appendChild(ok);
    actions.appendChild(cancel);
    form.appendChild(actions);

    built.body.appendChild(form);

    function say(text, isError) {
      msg.textContent = text;
      msg.style.color = isError ? "#a00" : "";
    }

    function submit() {
      const u = user.value.trim();
      const p = pass.value;
      if (!u || !p) { say("Enter a user name and password.", true); return; }
      ok.disabled = true;
      say("Connecting...");
      LD.login(u, p)
        .then(function (res) {
          built.win.hidden = true;

          /* Tell the desktop who is signed in.

             `onDone` is the caller's own callback, and callers outside the
             desktop (tests, and anything driving the sign-in directly) may
             pass their own or none at all. Announcing the session on the
             bridge as well means the desktop always learns about it, so
             the tray, the admin-only programs and Shut Down cannot end up
             out of step with the server. */
          UI.onSignedIn(res.user);
          if (onDone) onDone(res.user);
        })
        .catch(function (e) { say(e.message, true); })
        .then(function () { ok.disabled = false; });
    }

    ok.addEventListener("click", submit);
    cancel.addEventListener("click", function () { built.win.hidden = true; });
    built.win.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    user.focus();
    return built;
  }

  /* ============================================================
     Accounts (admin)
     ============================================================ */

  let accountsWindow = null;

  function openAccounts() {
    if (accountsWindow && !accountsWindow.win.hidden) {
      UI.focusWindow(accountsWindow.win);
      refreshUsers();
      return accountsWindow;
    }

    const built = UI.makeWindow({
      title: "User Accounts",
      icon: "assets/network-32x32.png",
      width: 660, height: 420, x: 180, y: 100
    });

    const bar = el("div", "w98-toolbar");
    const addBtn = el("button", "w98-tool", "New Account");
    addBtn.type = "button";
    addBtn.addEventListener("click", newAccountDialog);
    bar.appendChild(addBtn);
    const refreshBtn = el("button", "w98-tool", "Refresh");
    refreshBtn.type = "button";
    refreshBtn.addEventListener("click", refreshUsers);
    bar.appendChild(refreshBtn);

    const list = el("div", "w98-userlist");
    const status = el("div", "w98-statusbar");
    const statusText = el("span", null, "");
    status.appendChild(statusText);

    built.body.appendChild(bar);
    built.body.appendChild(list);
    built.body.appendChild(status);

    accountsWindow = { win: built.win, list: list, status: statusText };
    UI.on("files-changed", refreshUsers);
    refreshUsers();
    return built;
  }

  function refreshUsers() {
    if (!accountsWindow) return;
    accountsWindow.list.textContent = "";
    LD.listUsers()
      .then(function (res) {
        const users = res.users || [];
        users.forEach(function (u) { accountsWindow.list.appendChild(userRow(u)); });
        accountsWindow.status.textContent = users.length + " account" + (users.length === 1 ? "" : "s");
      })
      .catch(function (e) { accountsWindow.status.textContent = e.message; });
  }

  function userRow(u) {
    const row = el("div", "w98-userrow");

    const icon = el("img");
    icon.src = u.role === "admin" ? "assets/network-32x32.png" : "assets/my-computer-32x32.png";
    icon.alt = "";

    const name = el("span", "w98-username", u.username);
    const role = el("span", "w98-userrole " + (u.role === "admin" ? "is-admin" : ""), u.role);
    const count = el("span", "w98-usercount", u.fileCount + " file" + (u.fileCount === 1 ? "" : "s"));

    const actions = el("span", "w98-fileactions");

    const open = el("button", "w98-mini", "Files");
    open.type = "button";
    open.addEventListener("click", function () {
      openDocuments({ userId: u.id, title: u.username + "'s Documents" });
    });
    actions.appendChild(open);

    const pw = el("button", "w98-mini", "Password");
    pw.type = "button";
    pw.addEventListener("click", function () {
      const next = window.prompt("New password for " + u.username + " (at least 8 characters):", "");
      if (!next) return;
      LD.setPassword(u.id, next)
        .then(function () { UI.infoBox("Accounts", "Password changed for " + u.username + "."); })
        .catch(function (e) { UI.errorBox("Accounts", e.message); });
    });
    actions.appendChild(pw);

    const toggle = el("button", "w98-mini", u.role === "admin" ? "Make User" : "Make Admin");
    toggle.type = "button";
    toggle.addEventListener("click", function () {
      LD.setRole(u.id, u.role === "admin" ? "user" : "admin")
        .then(refreshUsers)
        .catch(function (e) { UI.errorBox("Accounts", e.message); });
    });
    actions.appendChild(toggle);

    const del = el("button", "w98-mini", "Delete");
    del.type = "button";
    del.addEventListener("click", function () {
      UI.confirmBox("Delete Account",
        "Delete " + u.username + " and everything in their folder?\n\nThis cannot be undone.",
        function () {
          LD.deleteUser(u.id)
            .then(refreshUsers)
            .catch(function (e) { UI.errorBox("Accounts", e.message); });
        });
    });
    actions.appendChild(del);

    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(role);
    row.appendChild(count);
    row.appendChild(actions);
    return row;
  }

  function newAccountDialog() {
    const built = UI.makeWindow({
      title: "New Account",
      icon: "assets/network-32x32.png",
      width: 380, height: 280, x: 300, y: 150
    });

    const form = el("div", "w98-signin");

    function field(label, type) {
      const r = el("div", "w98-signin-row");
      r.appendChild(el("label", null, label));
      const i = el("input", "w98-field");
      i.type = type || "text";
      r.appendChild(i);
      form.appendChild(r);
      return i;
    }

    const user = field("User name:");
    const pw = field("Password:", "password");

    const roleRow = el("div", "w98-signin-row");
    roleRow.appendChild(el("label", null, "Type:"));
    const role = el("select", "w98-field");
    ["user", "admin"].forEach(function (r) {
      const o = el("option", null, r);
      o.value = r;
      role.appendChild(o);
    });
    roleRow.appendChild(role);
    form.appendChild(roleRow);

    const msg = el("div", "w98-signin-msg", "");
    form.appendChild(msg);

    const actions = el("div", "w98-signin-actions");
    const ok = el("button", "w98-btn", "Create");
    ok.type = "button";
    const cancel = el("button", "w98-btn", "Cancel");
    cancel.type = "button";
    actions.appendChild(ok);
    actions.appendChild(cancel);
    form.appendChild(actions);
    built.body.appendChild(form);

    ok.addEventListener("click", function () {
      ok.disabled = true;
      LD.createUser(user.value.trim(), pw.value, role.value)
        .then(function () {
          built.win.hidden = true;
          refreshUsers();
        })
        .catch(function (e) { msg.textContent = e.message; msg.style.color = "#a00"; })
        .then(function () { ok.disabled = false; });
    });
    cancel.addEventListener("click", function () { built.win.hidden = true; });

    user.focus();
  }

  global.LDApps = {
    init: init,
    openNotepad: openNotepad,
    openDocuments: openDocuments,
    openSignIn: openSignIn,
    openAccounts: openAccounts,
    openProfile: openProfile,
    openForcePasswordChange: openForcePasswordChange,
    refreshListing: refreshListing
  };
})(window);
