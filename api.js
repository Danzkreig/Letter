/* ============================================================
   Letterdrop — API client

   A thin wrapper over the JSON API. Every call goes through one
   helper so error handling and the "not signed in" case are dealt
   with in a single place rather than at each call site.
   ============================================================ */

(function (global) {
  "use strict";

  function request(method, url, body) {
    const opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!res.ok) {
          const err = new Error((data && data.error) || ("Request failed (" + res.status + ")"));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  global.LD = {
    me:        function () { return request("GET", "/api/me"); },
    login:     function (username, password) { return request("POST", "/api/login", { username: username, password: password }); },
    logout:    function () { return request("POST", "/api/logout", {}); },
    changePassword: function (current, next) { return request("POST", "/api/password", { current: current, next: next }); },

    listFiles: function (userId) {
      return request("GET", "/api/files" + (userId ? "?user=" + encodeURIComponent(userId) : ""));
    },
    readFile: function (name, userId) {
      let q = "?name=" + encodeURIComponent(name);
      if (userId) q += "&user=" + encodeURIComponent(userId);
      return request("GET", "/api/file" + q);
    },
    saveNote: function (name, text, userId, overwrite) {
      return request("POST", "/api/file", {
        kind: "note", name: name, text: text, user: userId,
        overwrite: overwrite === true
      });
    },
    saveImage: function (name, mime, base64, userId) {
      return request("POST", "/api/file", { kind: "image", name: name, mime: mime, base64: base64, user: userId });
    },
    deleteFile: function (name, userId) {
      let q = "?name=" + encodeURIComponent(name);
      if (userId) q += "&user=" + encodeURIComponent(userId);
      return request("DELETE", "/api/file" + q);
    },

    // --- public sharing ---
    shareFile: function (name) {
      return request("POST", "/api/share", { name: name });
    },
    unshareFile: function (name) {
      return request("DELETE", "/api/share?name=" + encodeURIComponent(name));
    },
    shareUrl: function (token) {
      return location.origin + "/s/" + token;
    },
    // the short form, which is what the copy button uses now
    shortShareUrl: function (token) {
      return location.origin + "/" + token;
    },

    // --- site settings ---
    settings: function () { return request("GET", "/api/settings"); },

    // --- big uploads: streamed with PUT, not base64 inside JSON ---
    uploadFile: function (name, file, userId, onProgress) {
      return new Promise(function (resolve, reject) {
        const xhr = new XMLHttpRequest();
        const q = userId ? "?user=" + encodeURIComponent(userId) : "";
        xhr.open("PUT", "/api/upload" + q, true);
        xhr.setRequestHeader("X-File-Name", encodeURIComponent(name));
        xhr.setRequestHeader("Content-Type", "application/octet-stream");

        if (onProgress && xhr.upload) {
          xhr.upload.addEventListener("progress", function (e) {
            if (e.lengthComputable) onProgress(e.loaded, e.total);
          });
        }

        xhr.addEventListener("load", function () {
          let out = null;
          try { out = JSON.parse(xhr.responseText); } catch (e) {}
          if (xhr.status >= 200 && xhr.status < 300 && out) resolve(out);
          else reject(new Error((out && out.error) || "The upload failed (" + xhr.status + ")."));
        });
        xhr.addEventListener("error", function () { reject(new Error("The upload failed.")); });
        xhr.addEventListener("abort", function () { reject(new Error("The upload was cancelled.")); });

        xhr.send(file);
      });
    },

    /* A URL a media element can play directly. Range requests make
       seeking work, so nothing is fetched as base64. */
    rawUrl: function (name, userId) {
      const q = "?name=" + encodeURIComponent(name) + (userId ? "&user=" + encodeURIComponent(userId) : "");
      return "/api/raw" + q;
    },

    // --- control panel (admins) ---
    adminSettings: function () { return request("GET", "/api/admin/settings"); },
    saveSettings: function (patch) { return request("POST", "/api/admin/settings", patch); },
    danger: function (action) { return request("POST", "/api/admin/danger", { action: action, confirm: action }); },

    // --- internal mail ---
    mailFolders: function (folder) {
      return request("GET", "/api/mail?folder=" + encodeURIComponent(folder || "inbox"));
    },
    mailUnread: function () { return request("GET", "/api/mail/count"); },
    mailOne: function (id) { return request("GET", "/api/mail/one?id=" + encodeURIComponent(id)); },
    mailSend: function (msg) { return request("POST", "/api/mail", msg); },
    mailDelete: function (id, permanent) {
      return request("DELETE", "/api/mail?id=" + encodeURIComponent(id) + (permanent ? "&permanent=1" : ""));
    },
    mailRestore: function (id) { return request("POST", "/api/mail/restore", { id: id }); },
    mailRecipients: function () { return request("GET", "/api/mail/recipients"); },
    mailAttachment: function (id, name) {
      return request("GET", "/api/mail/attachment?id=" + encodeURIComponent(id) +
        "&name=" + encodeURIComponent(name));
    },

    // --- letters ---
    sendLetter: function (letter) { return request("POST", "/api/letter", letter); },
    letterOne: function (id) { return request("GET", "/api/letter/one?id=" + encodeURIComponent(id)); },
    shareLetter: function (id) { return request("POST", "/api/letter/share", { id: id }); },
    unshareLetter: function (id) { return request("DELETE", "/api/letter/share?id=" + encodeURIComponent(id)); },
    letterUrl: function (token) { return location.origin + "/letter/" + token; },

    // --- invitations ---
    invites: function () { return request("GET", "/api/invites"); },
    revokeInvite: function (id) { return request("DELETE", "/api/invites?id=" + encodeURIComponent(id)); },
    inviteUrl: function (token) { return location.origin + "/invite/" + token; },

    // --- profile pictures ---
    setAvatar: function (mime, base64) { return request("POST", "/api/avatar", { mime: mime, base64: base64 }); },
    clearAvatar: function () { return request("DELETE", "/api/avatar"); },
    avatarUrl: function (username, updated) {
      return "/avatar/" + encodeURIComponent(username) + (updated ? "?v=" + encodeURIComponent(updated) : "");
    },

    // --- instant messages (the socket is the main path; these are the fallback) ---
    imBuddies: function () { return request("GET", "/api/im/buddies"); },
    imHistory: function (withId) { return request("GET", "/api/im/history?with=" + encodeURIComponent(withId)); },
    imRead: function (withId) { return request("POST", "/api/im/read", { with: withId }); },
    imSend: function (toId, text) { return request("POST", "/api/im/send", { to: toId, text: text }); },

    // --- folders, renaming and search ---
    folder: function (relPath, userId) {
      let q = "?path=" + encodeURIComponent(relPath || "");
      if (userId) q += "&user=" + encodeURIComponent(userId);
      return request("GET", "/api/folder" + q);
    },
    makeFolder: function (relPath) { return request("POST", "/api/folder", { path: relPath }); },
    deleteFolder: function (relPath) {
      return request("DELETE", "/api/folder?path=" + encodeURIComponent(relPath));
    },
    renameFile: function (from, to) { return request("POST", "/api/file/rename", { from: from, to: to }); },
    search: function (q) { return request("GET", "/api/search?q=" + encodeURIComponent(q)); },

    // --- drafts and replies ---
    draft: function () { return request("GET", "/api/draft"); },
    saveDraft: function (d) { return request("POST", "/api/draft", d); },
    clearDraft: function () { return request("DELETE", "/api/draft"); },
    replyTo: function (id) { return request("GET", "/api/mail/reply?id=" + encodeURIComponent(id)); },

    // --- sessions ---
    sessions: function () { return request("GET", "/api/sessions"); },
    revokeSession: function (id) { return request("DELETE", "/api/sessions?id=" + encodeURIComponent(id)); },
    revokeOtherSessions: function () { return request("DELETE", "/api/sessions?all=1"); },

    listUsers:    function () { return request("GET", "/api/admin/users"); },
    createUser:   function (username, password, role) { return request("POST", "/api/admin/users", { username: username, password: password, role: role }); },
    deleteUser:   function (id) { return request("DELETE", "/api/admin/user?id=" + encodeURIComponent(id)); },
    setRole:      function (id, role) { return request("POST", "/api/admin/role", { id: id, role: role }); },
    setPassword:  function (id, password) { return request("POST", "/api/admin/password", { id: id, password: password }); },

    /* Read a File object from an <input type=file> as base64. */
    fileToBase64: function (file) {
      return new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onload = function () {
          const s = String(fr.result);
          const comma = s.indexOf(",");
          resolve(comma === -1 ? "" : s.slice(comma + 1));
        };
        fr.onerror = function () { reject(new Error("Could not read that file.")); };
        fr.readAsDataURL(file);
      });
    }
  };
})(window);
