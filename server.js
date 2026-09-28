/* ============================================================
   Letterdrop — server

   A dependency-free Node HTTP server. It serves the static site and
   a small JSON API for accounts and file storage.

   Run:  node server.js            (then open http://localhost:8000)
         PORT=3000 node server.js

   On first run it creates an admin account and prints the password
   once. Change it after signing in.
   ============================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./lib/store");
const auth = require("./lib/auth");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "127.0.0.1";

const COOKIE = "ld_session";

/* The chat hub is created below, once the server exists, but the API
   routes above need to know who is online. This holds the live reference. */
let chat = { isOnline: function () { return false; }, onlineIds: function () { return []; } };

/* ---------- helpers ---------- */

/* The client's address, honouring a proxy header when one is set. Only
   trustworthy behind a reverse proxy you control; on a direct connection
   the socket address is used. */
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd && process.env.TRUST_PROXY === "1") {
    return String(fwd).split(",")[0].trim();
  }
  return (req.socket && (req.socket.remoteAddress || "")) || "unknown";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > (limit || 12 * 1024 * 1024)) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(";").forEach(function (part) {
    const i = part.indexOf("=");
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sessionToken(req) {
  return parseCookies(req)[COOKIE] || null;
}

function currentUser(req) {
  return store.sessionUser(sessionToken(req));
}

function setCookie(res, token) {
  res.setHeader("Set-Cookie",
    COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + Math.floor(12 * 3600));
}

function clearCookie(res) {
  res.setHeader("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
}

/* ---------- static files ----------
   Only files inside the project are served, and the data directory is
   never exposed directly: user files are reached through the API so
   every read is permission-checked. */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  // the root now serves the Windows 98 desktop; there is no separate
  // compose page any more.
  if (rel === "") rel = "card.html";

  const full = path.join(ROOT, rel);
  const resolved = path.resolve(full);

  if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  // never serve the data directory or server internals
  const guarded = ["data", "lib", "server.js", "package.json"].some(function (g) {
    return resolved === path.join(ROOT, g) || resolved.startsWith(path.join(ROOT, g) + path.sep);
  });
  if (guarded) { res.writeHead(404); res.end("Not found"); return; }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": fs.statSync(resolved).size,
    "Cache-Control": ext === ".html" ? "no-store" : "no-cache"
  });
  fs.createReadStream(resolved).pipe(res);
}

/* ---------- api ---------- */

async function api(req, res, urlPath, query) {
  const method = req.method;

  /* --- who am I --- */
  if (urlPath === "/api/me" && method === "GET") {
    const u = currentUser(req);
    return sendJson(res, 200, u
      ? { user: store.publicUser(u), mustChangePassword: store.passwordChangePending(u) }
      : { user: null });
  }

  /* --- site settings the desktop reads before signing in --- */
  if (urlPath === "/api/settings" && method === "GET") {
    const s = store.getSettings();
    return sendJson(res, 200, {
      siteName: s.siteName,
      motd: s.motd,
      allowSignups: s.allowSignups,
      maxUploadMB: s.maxUploadMB,
      programs: s.programs
    });
  }

  /* --- sign in ---
     Throttled per account and client: a few free attempts, then an
     increasing delay, then a lockout. */
  if (urlPath === "/api/login" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const ip = clientIp(req);
    const username = String(body.username || "");

    const wait = auth.throttleDelay(username, ip);
    if (wait > 0) {
      const secs = Math.ceil(wait / 1000);
      res.setHeader("Retry-After", String(secs));
      return sendJson(res, 429, {
        error: "Too many failed attempts. Try again in " +
          (secs >= 60 ? Math.ceil(secs / 60) + " minute(s)" : secs + " second(s)") + ".",
        retryAfter: secs
      });
    }

    const user = store.authenticate(username, body.password);
    if (!user) {
      const state = auth.recordFailure(username, ip);
      if (state.locked) {
        const secs = Math.ceil(auth.LOCKOUT_MS / 1000);
        res.setHeader("Retry-After", String(secs));
        return sendJson(res, 429, {
          error: "Too many failed attempts. This account is locked for " +
            Math.ceil(secs / 60) + " minutes.",
          retryAfter: secs
        });
      }
      return sendJson(res, 401, { error: "Wrong username or password." });
    }

    auth.clearFailures(username, ip);
    const token = store.createSession(user.id, {
      agent: req.headers["user-agent"],
      ip: ip
    });
    setCookie(res, token);
    return sendJson(res, 200, {
      user: store.publicUser(user),
      mustChangePassword: store.passwordChangePending(user)
    });
  }

  /* --- sign out --- */
  if (urlPath === "/api/logout" && method === "POST") {
    store.destroySession(sessionToken(req));
    clearCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  /* --- redeem an invitation ---
     Creates an account, so it runs before the session gate: the token is
     the credential, and the person has no account yet. */
  if (urlPath === "/api/redeem" && method === "POST") {
    const body = await readBody(req, 64 * 1024);

    const settings = store.getSettings();
    if (!settings.allowSignups) {
      return sendJson(res, 403, { error: "Account creation is turned off on this server." });
    }

    const out = store.redeemInvite(body.token, body.username, body.password);
    if (out.error) return sendJson(res, 400, { error: out.error });

    // sign the new account in straight away, so the letter opens on arrival
    setCookie(res, store.createSession(out.user.id, {
      agent: req.headers["user-agent"],
      ip: clientIp(req)
    }));
    return sendJson(res, 200, { user: out.user, mailId: out.mailId });
  }

  /* --- everything below needs a session --- */
  const user = currentUser(req);
  if (!user) return sendJson(res, 401, { error: "Not signed in." });

  /* An account whose password was set by somebody else has to choose its
     own before it can do anything. Only the handful of routes needed to
     do that stay open, or the account would be unusable. */
  if (store.passwordChangePending(user) && !store.allowWhilePending(urlPath)) {
    return sendJson(res, 403, {
      error: "You must choose a new password before you can do that.",
      mustChangePassword: true
    });
  }

  /* --- files: always scoped to the signed-in user --- */
  if (urlPath === "/api/files" && method === "GET") {
    const target = query.get("user");
    // only an admin may look at someone else's files
    if (target && target !== user.id) {
      if (user.role !== "admin") return sendJson(res, 403, { error: "Not allowed." });
      if (!store.findById(store.load(), target)) return sendJson(res, 404, { error: "No such user." });
      return sendJson(res, 200, {
        files: store.listFiles(target),
        quota: store.quotaFor(target)
      });
    }
    return sendJson(res, 200, {
      files: store.listFiles(user.id),
      quota: store.quotaFor(user.id)
    });
  }

  /* A folder listing, with its subfolders. `path` is relative to the
     user's own Documents; empty means the top level. */
  if (urlPath === "/api/folder" && method === "GET") {
    const target = query.get("user") || user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }
    const out = store.listFolder(target, query.get("path") || "");
    if (out.error) return sendJson(res, 400, { error: out.error });
    out.quota = store.quotaFor(target);
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/folder" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const target = body.user && body.user !== user.id ? body.user : user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }
    const out = store.makeFolder(target, body.path);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/folder" && method === "DELETE") {
    const target = query.get("user") || user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }
    const out = store.deleteFolder(target, query.get("path"));
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* Rename and move are the same operation: a new path. */
  if (urlPath === "/api/file/rename" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const target = body.user && body.user !== user.id ? body.user : user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }
    const out = store.renameFile(target, body.from, body.to);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* ---------- search ---------- */
  if (urlPath === "/api/search" && method === "GET") {
    return sendJson(res, 200, store.searchEverything(user.id, query.get("q")));
  }

  if (urlPath === "/api/file" && method === "GET") {
    const name = query.get("name");
    const target = query.get("user") || user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }
    const out = store.readFile(target, name);
    if (out.error) return sendJson(res, 404, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/file" && method === "POST") {
    const body = await readBody(req, 16 * 1024 * 1024);
    // an admin writing into another user's folder is allowed; a user is not
    const target = body.user && body.user !== user.id ? body.user : user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }

    /* Base64 is about 4/3 of the real size; the store re-checks against
       the true byte count, this is just an early, clearer refusal. */
    if (body.kind !== "note" && body.base64) {
      const approx = Math.floor(String(body.base64).length * 0.75);
      const room = store.quotaAllows(target, approx);
      if (!room.ok) return sendJson(res, 413, { error: room.error, quota: room.quota });
    }

    const out = (body.kind === "note" && typeof body.text === "string")
      ? store.saveNote(target, body.name, body.text, { overwrite: body.overwrite === true })
      : store.saveUpload(target, body.name, body.mime, body.base64);
    if (out.error) {
      /* An existing name is a conflict the caller has to resolve, not a
         malformed request, so it gets 409 and a flag to act on. */
      if (out.exists) return sendJson(res, 409, { error: out.error, exists: true, name: out.name });
      // an over-quota refusal is a 413; anything else is a plain bad request
      const status = /storage limit/i.test(out.error) ? 413 : 400;
      return sendJson(res, status, { error: out.error });
    }
    return sendJson(res, 200, out);
  }

  /* ---------- large uploads ----------
     A 1 GB body cannot be buffered, so the request stream is piped
     straight to disk. The name travels in a header because the body is
     the file itself. */
  if (urlPath === "/api/upload" && method === "PUT") {
    const target = query.get("user") && query.get("user") !== user.id ? query.get("user") : user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }

    const rawName = req.headers["x-file-name"];
    if (!rawName) return sendJson(res, 400, { error: "No file name was supplied." });

    let decoded;
    try { decoded = decodeURIComponent(String(rawName)); }
    catch (e) { decoded = String(rawName); }

    const spot = store.uniqueUploadPath(target, decoded);
    if (!spot) return sendJson(res, 400, { error: "That file name is not allowed." });

    const cap = store.maxUploadBytes();

    /* How much room is left for this account. Replacing an existing file
       frees its old bytes, so the room available is the free space plus
       whatever the file being overwritten currently occupies. */

    let replacing = 0;
    if (fs.existsSync(spot.path)) {
      try { replacing = fs.statSync(spot.path).size; } catch (e) {}
    }
    const quota = store.quotaFor(target);
    const roomLeft = quota.unlimited
      ? null
      : Math.max(0, (quota.quotaBytes - quota.usedBytes) + replacing);

    /* A declared length lets this be refused before a byte lands; the
       running check below still guards the streaming case, where the
       length is unknown or a lie. */
    const declared = Number(req.headers["content-length"] || 0);
    if (declared && roomLeft !== null && declared > roomLeft) {
      return sendJson(res, 413, {
        error: "That upload would put you over your storage limit.",
        quota: { usedBytes: quota.usedBytes, quotaBytes: quota.quotaBytes }
      });
    }

    let written = 0;
    let aborted = false;

    const out = fs.createWriteStream(spot.path);

    const fail = function (status, message) {
      if (aborted) return;
      aborted = true;
      try { out.destroy(); } catch (e) {}
      try { if (fs.existsSync(spot.path)) fs.unlinkSync(spot.path); } catch (e) {}
      if (!res.headersSent) sendJson(res, status, { error: message });
      else try { res.end(); } catch (e) {}
    };

    req.on("data", function (chunk) {
      written += chunk.length;
      if (written > cap) {
        fail(413, "That file is larger than the " + store.getSettings().maxUploadMB + " MB limit.");
        return;
      }
      if (roomLeft !== null && written > roomLeft) {
        fail(413, "That upload would put you over your storage limit.");
      }
    });

    req.on("aborted", function () { fail(499, "The upload was interrupted."); });
    req.on("error", function () { fail(500, "The upload failed."); });

    out.on("error", function () { fail(500, "Could not write the file to disk."); });

    out.on("finish", function () {
      if (aborted) return;
      if (!written) {
        try { fs.unlinkSync(spot.path); } catch (e) {}
        return sendJson(res, 400, { error: "That file is empty." });
      }
      sendJson(res, 200, {
        name: spot.name,
        size: written,
        kind: store.fileKind(spot.name),
        mime: store.mimeFor(spot.name)
      });
    });

    req.pipe(out);
    return;
  }

  /* ---------- raw file bytes ----------
     Used by the media player and the image viewer so large files are
     streamed rather than base64'd through JSON. */
  if (urlPath === "/api/raw" && method === "GET") {
    const name = query.get("name");
    const target = query.get("user") || user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }
    const spot = store.uploadPath(target, name);
    if (!spot || !fs.existsSync(spot.path)) return sendJson(res, 404, { error: "File not found." });

    const st = fs.statSync(spot.path);
    const mime = store.mimeFor(spot.name);
    const range = req.headers.range;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (start < st.size && end < st.size && start <= end) {
          res.writeHead(206, {
            "Content-Type": mime,
            "Content-Length": end - start + 1,
            "Content-Range": "bytes " + start + "-" + end + "/" + st.size,
            "Accept-Ranges": "bytes"
          });
          fs.createReadStream(spot.path, { start: start, end: end }).pipe(res);
          return;
        }
      }
    }

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": st.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60"
    });
    fs.createReadStream(spot.path).pipe(res);
    return;
  }

  if (urlPath === "/api/file" && method === "DELETE") {
    const name = query.get("name");
    const target = query.get("user") || user.id;
    if (target !== user.id && user.role !== "admin") {
      return sendJson(res, 403, { error: "Not allowed." });
    }
    const out = store.deleteFile(target, name);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* --- admin only --- */
  if (urlPath.startsWith("/api/admin/")) {
    if (user.role !== "admin") return sendJson(res, 403, { error: "Admins only." });

    if (urlPath === "/api/admin/users" && method === "GET") {
      return sendJson(res, 200, { users: store.listUsers() });
    }

    if (urlPath === "/api/admin/users" && method === "POST") {
      const body = await readBody(req, 64 * 1024);
      const out = store.createUser({
        username: body.username, password: body.password, role: body.role
      });
      if (out.error) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (urlPath === "/api/admin/user" && method === "DELETE") {
      const id = query.get("id");
      if (id === user.id) return sendJson(res, 400, { error: "You cannot delete your own account." });
      const out = store.deleteUser(id);
      if (out.error) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (urlPath === "/api/admin/password" && method === "POST") {
      const body = await readBody(req, 64 * 1024);
      /* An admin choosing someone else's password means that person has to
         pick their own next time they sign in. */
      const out = store.adminSetPassword(body.id, body.password);
      if (out.error) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (urlPath === "/api/admin/role" && method === "POST") {
      const body = await readBody(req, 64 * 1024);
      const out = store.setRole(body.id, body.role);
      if (out.error) return sendJson(res, 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    /* ---------- Control Panel ---------- */

    if (urlPath === "/api/admin/settings" && method === "GET") {
      return sendJson(res, 200, {
        settings: store.getSettings(),
        storage: store.storageReport()
      });
    }

    if (urlPath === "/api/admin/settings" && method === "POST") {
      const body = await readBody(req, 128 * 1024);
      return sendJson(res, 200, { settings: store.saveSettings(body) });
    }

    /* Destructive actions. Each needs the operator to type the word back,
       so a stray click cannot flatten the site. */
    if (urlPath === "/api/admin/danger" && method === "POST") {
      const body = await readBody(req, 64 * 1024);
      const action = String(body.action || "");

      if (body.confirm !== action) {
        return sendJson(res, 400, { error: "Type the action name to confirm." });
      }

      if (action === "wipe-files") {
        return sendJson(res, 200, store.wipeAllFiles());
      }
      if (action === "wipe-messages") {
        return sendJson(res, 200, store.wipeAllMessages());
      }
      if (action === "delete-users") {
        return sendJson(res, 200, store.deleteAllUsers(user.id));
      }
      return sendJson(res, 400, { error: "Unknown action." });
    }
  }

  /* --- change your own password --- */
  if (urlPath === "/api/password" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const out = store.changeOwnPassword(user.id, body.current, body.next, sessionToken(req));
    if (out.error) {
      const status = /current password is incorrect/i.test(out.error) ? 401 : 400;
      return sendJson(res, status, { error: out.error });
    }
    return sendJson(res, 200, out);
  }

  /* ---------- sessions ---------- */

  if (urlPath === "/api/sessions" && method === "GET") {
    return sendJson(res, 200, {
      sessions: store.listSessions(user.id, sessionToken(req))
    });
  }

  if (urlPath === "/api/sessions" && method === "DELETE") {
    const all = query.get("all") === "1";
    if (all) {
      const out = store.revokeAllSessions(user.id, sessionToken(req));
      return sendJson(res, 200, out);
    }
    const out = store.revokeSession(user.id, query.get("id"), sessionToken(req));
    if (out.error) return sendJson(res, 404, { error: out.error });
    // ending the session you are using signs you out
    if (out.wasCurrent) clearCookie(res);
    return sendJson(res, 200, out);
  }

  /* --- sharing your own files ---
     Only the owner may share. An admin browsing someone else's folder can
     read it but cannot publish it on that person's behalf. */
  if (urlPath === "/api/share" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    if (body.user && body.user !== user.id) {
      return sendJson(res, 403, { error: "You can only share your own files." });
    }
    const out = store.createShare(user.id, body.name);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/share" && method === "DELETE") {
    return sendJson(res, 200, store.revokeShare(user.id, query.get("name")));
  }

  /* ---------- internal mail ----------
     Every route here is scoped to the signed-in user: you can only read
     mail addressed to you or sent by you. */

  if (urlPath === "/api/mail" && method === "GET") {
    const folder = query.get("folder") || "inbox";
    return sendJson(res, 200, {
      folder: folder,
      mail: store.listMail(user.id, folder),
      unread: store.unreadCount(user.id)
    });
  }

  if (urlPath === "/api/mail/count" && method === "GET") {
    return sendJson(res, 200, { unread: store.unreadCount(user.id) });
  }

  if (urlPath === "/api/mail" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const out = store.sendMail(user.id, body);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/mail" && method === "DELETE") {
    const id = query.get("id");
    const permanent = query.get("permanent") === "1";
    const out = store.deleteMail(user.id, id, permanent);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/mail/restore" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const out = store.restoreMail(user.id, body.id);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/mail/read" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const out = store.setMailRead(user.id, body.id, body.read);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* One message, with its attachments. */
  if (urlPath === "/api/mail/one" && method === "GET") {
    const out = store.getMail(user.id, query.get("id"));
    if (out.error) return sendJson(res, 404, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* An attachment, readable by sender and recipient alike even though the
     file itself lives in the sender's folder. */
  if (urlPath === "/api/mail/attachment" && method === "GET") {
    const out = store.readAttachment(user.id, query.get("id"), query.get("name"));
    if (out.error) return sendJson(res, 404, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* The same attachment, streamed instead of base64'd, so a song or video
     enclosed in a letter can be seeked without loading it all. */
  if (urlPath === "/api/mail/stream" && method === "GET") {
    const out = store.readAttachment(user.id, query.get("id"), query.get("name"));
    if (out.error) return sendJson(res, 404, { error: out.error });
    if (!out.streamed) return sendJson(res, 400, { error: "That file is not streamable." });

    const mail = store.getMail(user.id, query.get("id"));
    const spot = store.uploadPath(mail.mail.fromId, out.name);
    if (!spot || !fs.existsSync(spot.path)) return sendJson(res, 404, { error: "File not found." });

    const st = fs.statSync(spot.path);
    const headers = {
      "Content-Type": out.mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60"
    };
    if (query.get("download") === "1") {
      headers["Content-Disposition"] = "attachment; filename=\"" + out.name.replace(/"/g, "") + "\"";
    }

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (start < st.size && end < st.size && start <= end) {
          res.writeHead(206, Object.assign({}, headers, {
            "Content-Length": end - start + 1,
            "Content-Range": "bytes " + start + "-" + end + "/" + st.size
          }));
          fs.createReadStream(spot.path, { start: start, end: end }).pipe(res);
          return;
        }
      }
    }

    res.writeHead(200, Object.assign({}, headers, { "Content-Length": st.size }));
    fs.createReadStream(spot.path).pipe(res);
    return;
  }

  /* The account list, for addressing a message. Only names are exposed. */
  if (urlPath === "/api/mail/recipients" && method === "GET") {
    const db = store.load();
    const names = db.users
      .filter(function (u) { return u.id !== user.id; })
      .map(function (u) {
        return { username: u.username, id: u.id, avatar: u.avatar || null };
      });
    return sendJson(res, 200, { users: names });
  }

  /* ---------- letters ---------- */

  if (urlPath === "/api/letter" && method === "POST") {
    const body = await readBody(req, 256 * 1024);
    const out = store.sendLetter(user.id, body);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* A letter the signed-in user may read: theirs in the Inbox, or one they
     sent. The reader and the public share both go through this. */
  if (urlPath === "/api/letter/one" && method === "GET") {
    const out = store.getMail(user.id, query.get("id"));
    if (out.error) return sendJson(res, 404, { error: out.error });
    if (out.mail.kind !== "letter") return sendJson(res, 400, { error: "That is not a letter." });
    return sendJson(res, 200, out);
  }

  /* ---------- invitations ---------- */

  if (urlPath === "/api/invites" && method === "GET") {
    if (user.role !== "admin") return sendJson(res, 403, { error: "Admins only." });
    return sendJson(res, 200, { invites: store.listInvites(user.id) });
  }

  if (urlPath === "/api/invites" && method === "DELETE") {
    if (user.role !== "admin") return sendJson(res, 403, { error: "Admins only." });
    const out = store.revokeInvite(user.id, query.get("id"));
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* ---------- profile pictures ---------- */

  if (urlPath === "/api/avatar" && method === "POST") {
    const body = await readBody(req, 4 * 1024 * 1024);
    const out = store.setAvatar(user.id, body.mime, body.base64);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/avatar" && method === "DELETE") {
    return sendJson(res, 200, store.clearAvatar(user.id));
  }

  /* Sharing a letter: any user may publish one they sent or received, so
     a recipient without an account can read it. */
  if (urlPath === "/api/letter/share" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const out = store.shareLetter(user.id, body.id);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/letter/share" && method === "DELETE") {
    const out = store.unshareLetter(user.id, query.get("id"));
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  /* ---------- instant messages ----------
     The live chat runs over the WebSocket, but history and the buddy
     list are also available over HTTP so a dropped socket is not fatal. */

  if (urlPath === "/api/im/buddies" && method === "GET") {
    const db = store.load();
    const unread = store.imUnreadByUser(user.id);
    const buddies = db.users
      .filter(function (u) { return u.id !== user.id; })
      .map(function (u) {
        return {
          id: u.id,
          username: u.username,
          online: chat.isOnline(u.id),
          unread: unread[u.id] || 0
        };
      });
    return sendJson(res, 200, { buddies: buddies, online: chat.onlineIds() });
  }

  if (urlPath === "/api/im/history" && method === "GET") {
    const out = store.conversationWith(user.id, query.get("with"));
    if (out.error) return sendJson(res, 404, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/im/read" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    return sendJson(res, 200, store.markImRead(user.id, body.with));
  }

  /* Fallback for when the socket is unavailable: the message is still
     stored, and the other side picks it up on their next roster refresh. */
  if (urlPath === "/api/im/send" && method === "POST") {
    const body = await readBody(req, 64 * 1024);
    const db = store.load();
    const recipient = store.findById(db, body.to);
    if (!recipient) return sendJson(res, 400, { error: "No such user." });
    const out = store.sendIm(user.id, recipient.username, body.text);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, { message: out.message });
  }

  /* ---------- drafts ----------
     One per account, so a half-written message survives closing the
     composer or reloading the page. */
  if (urlPath === "/api/draft" && method === "GET") {
    return sendJson(res, 200, store.getDraft(user.id));
  }

  if (urlPath === "/api/draft" && method === "POST") {
    const body = await readBody(req, 128 * 1024);
    const out = store.saveDraft(user.id, body);
    if (out.error) return sendJson(res, 400, { error: out.error });
    return sendJson(res, 200, out);
  }

  if (urlPath === "/api/draft" && method === "DELETE") {
    return sendJson(res, 200, store.clearDraft(user.id));
  }

  /* ---------- reply ----------
     Everything the composer needs to quote a message back. */
  if (urlPath === "/api/mail/reply" && method === "GET") {
    const out = store.getMail(user.id, query.get("id"));
    if (out.error) return sendJson(res, 404, { error: out.error });
    const m = out.mail;
    return sendJson(res, 200, {
      to: m.fromId,
      toName: m.from,
      subject: store.replySubject(m.subject),
      body: store.quoteFor(m, m.from)
    });
  }

  sendJson(res, 404, { error: "Unknown endpoint." });
}

/* ---------- public share handler ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function allowsGet(req) {
  return req.method === "GET" || req.method === "HEAD";
}

function methodNotAllowed(res) {
  res.writeHead(405); res.end("Method not allowed");
}

/* A link preview crawler asks for the page; it wants the image bytes. A
   browser hitting a bare /<token>.jpg also wants the bytes. Only a plain
   navigation to /<token> with no extension gets the HTML viewer. */
function wantsRaw(req) {
  const url = String(req.url || "");
  // an extension in the path means the visitor asked for a file
  if (/\.[A-Za-z0-9]{1,8}(\?|$)/.test(url.split("?")[0])) return true;

  const ua = String(req.headers["user-agent"] || "");
  return /bot|crawler|spider|discord|slack|twitter|facebook|telegram|whatsapp|embedly|preview/i.test(ua);
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || "localhost";
  return proto + "://" + host;
}

function notFound(res) {
  const body = "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<title>Not found</title></head><body style=\"font-family:system-ui;padding:40px;" +
    "background:#14100e;color:#e8e2da\">" +
    "<h1 style=\"font-size:18px\">This link is not available</h1>" +
    "<p style=\"color:#9a9088\">The file was removed, or the link was revoked.</p>" +
    "</body></html>";
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/* ---------- an attachment on a shared letter ----------
   Reachable without a session, but only for a letter that is actually
   shared, and only for a file that letter references. */

function handleLetterFile(req, res, token, name) {
  const letter = store.resolveLetterLink(token);
  if (!letter) return notFound(res);

  const want = store.safeName(name);
  const att = (letter.attachments || []).find(function (a) { return a.name === want; });
  if (!att) return notFound(res);

  const spot = store.uploadPath(letter.fromId, att.name);
  if (!spot || !fs.existsSync(spot.path)) return notFound(res);

  const st = fs.statSync(spot.path);
  const mime = store.mimeFor(att.name);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": st.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=300"
  });
  if (req.method === "HEAD") { res.end(); return; }

  // range support, so a song or video inside a letter can be seeked
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start < st.size && end < st.size && start <= end) {
        res.writeHead(206, {
          "Content-Type": mime,
          "Content-Length": end - start + 1,
          "Content-Range": "bytes " + start + "-" + end + "/" + st.size,
          "Accept-Ranges": "bytes"
        });
        fs.createReadStream(spot.path, { start: start, end: end }).pipe(res);
        return;
      }
    }
  }
  fs.createReadStream(spot.path).pipe(res);
}

/* ---------- avatars ---------- */

function handleAvatar(req, res, username) {
  const db = store.load();
  const user = db.users.find(function (u) {
    return u.username.toLowerCase() === username.toLowerCase();
  });
  if (!user) return notFound(res);

  const found = store.avatarPath(user.id);
  if (!found) return notFound(res);

  const st = fs.statSync(found.path);
  res.writeHead(200, {
    "Content-Type": found.mime,
    "Content-Length": st.size,
    // short cache: replacing an avatar should show up quickly
    "Cache-Control": "public, max-age=60"
  });
  if (req.method === "HEAD") { res.end(); return; }
  fs.createReadStream(found.path).pipe(res);
}

/* ---------- an invitation link ---------- */

function handleInvitePage(req, res, token) {
  const invite = store.peekInvite(token);
  const settings = store.getSettings();

  /* One shell for every outcome: a Windows 98 desktop with a window on it,
     the same way the logon dialog sits on the desktop inside the app.
     desktop.css does the chrome, so this looks like the same machine. */
  const shell = function (title, windowTitle, inner, behind) {
    const body =
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />' +
'<meta name="viewport" content="width=device-width, initial-scale=1" />' +
'<title>' + esc(title) + ' \u2014 ' + esc(settings.siteName) + '</title>' +
'<link rel="stylesheet" href="/desktop.css" />' +
'<style>' +
'  /* this page has no boot sequence to hide, so the desktop is visible at once */' +
'  html, body { height:100%; }' +
'  body { margin:0; overflow:hidden; }' +
'  .w98 { position:fixed; inset:0; }' +
'  .inv-behind { position:absolute; inset:0; display:grid; place-items:center; padding:24px; }' +
'  .inv-sheet { width:min(560px, 100%); max-height:100%; overflow:auto; background:#fffdf6;' +
'               color:#2a2621; box-shadow:0 10px 34px rgba(0,0,0,.45); padding:22px 24px;' +
'               border:2px solid; border-color:#fff #808080 #808080 #fff; }' +
'  .inv-sheet h2 { margin:0 0 4px; font-size:16px; }' +
'  .inv-sheet .inv-meta { color:#6a6058; font-size:11px; margin-bottom:12px; }' +
'  .inv-sheet .inv-body { line-height:1.6; white-space:pre-wrap; font-size:13px; }' +
'  .inv-toy { font-family:var(--w-mono); font-size:8px; line-height:1.03; white-space:pre;' +
'             text-align:center; margin:14px 0 0; color:#3a332d; }' +
'  /* the sign-up window floats above the letter, like the logon dialog does */' +
'  .inv-win { position:absolute; z-index:20; width:400px; max-width:calc(100% - 24px); }' +
'  .inv-note { font-size:11px; color:#404040; line-height:1.5; margin:0 0 8px; }' +
'  .inv-hint { font-size:10px; color:#707070; margin-top:2px; }' +
'  .inv-err { color:#a00; }' +
'  .w98-signin-msg { min-height:16px; }' +
'</style></head><body>' +

'<div class="w98" id="inviteDesktop">' +
'  <div class="w98-desktop inv-behind">' + (behind || '') + '</div>' +

'  <div class="inv-win w98-win w98-raised" id="inviteWin" role="dialog" aria-labelledby="invTitle">' +
'    <div class="w98-title">' +
'      <img src="/assets/network-32x32.png" alt="" />' +
'      <span class="w98-title-text" id="invTitle">' + esc(windowTitle) + '</span>' +
'    </div>' +
'    <div class="w98-body">' +
'      <div class="w98-signin">' + inner + '</div>' +
'    </div>' +
'  </div>' +

'  <div class="w98-taskbar">' +
'    <button class="w98-start" type="button" tabindex="-1">' +
'      <img src="/assets/start.png" alt="" />Start</button>' +
'    <div class="w98-tasks">' +
'      <button class="w98-task is-active" type="button">' +
'        <img src="/assets/network-32x32.png" alt="" />' + esc(windowTitle) + '</button>' +
'    </div>' +
'    <div class="w98-tray">' +
'      <img src="/assets/speaker-32x32.png" alt="" />' +
'      <span id="inviteClock">12:00 PM</span>' +
'    </div>' +
'  </div>' +
'</div>' +

'<script>' +
'  /* the tray clock, so the taskbar is not obviously frozen */' +
'  (function(){' +
'    var c=document.getElementById("inviteClock");' +
'    function tick(){var d=new Date(),h=d.getHours(),m=d.getMinutes();' +
'      var ap=h<12?"AM":"PM";h=h%12;if(h===0)h=12;' +
'      c.textContent=h+":"+(m<10?"0":"")+m+" "+ap;}' +
'    tick();setInterval(tick,15000);' +
'  })();' +
'</script>' +

'<script src="/ascii.js"></script>' +
(behind && /inv-toy/.test(behind)
  ? '<script>' +
    '(function(){' +
    '  var t=document.querySelector(".inv-toy");' +
    '  var name=' + JSON.stringify(invite.shape || null) + ';' +
    '  if(!t||!name||!window.LETTERDROP_ASCII)return;' +
    '  var s=LETTERDROP_ASCII.make(name),st=LETTERDROP_ASCII.STEP[name]||[0,0];' +
    '  setInterval(function(){s.step(st[0],st[1]);t.textContent=s.render();},120);' +
    '})();' +
    '<\/script>'
  : '') +
'</body></html>';

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store"
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  /* ---------- the letter, shown on the desktop behind the window ---------- */

  const sheetFor = function (heading, note) {
    return '<div class="inv-sheet">' +
      (invite && invite.shape ? '<pre class="inv-toy"></pre>' : '') +
      '<h2>' + esc(heading) + '</h2>' +
      '<div class="inv-meta">' + esc(note) + '</div>' +
      (invite ? '<div class="inv-body">' + esc(invite.body) + '</div>' : '') +
      '</div>';
  };

  /* ---------- the outcomes ---------- */

  if (!invite) {
    return shell("Invitation not found", "Log On to Letterdrop",
      '<div class="w98-signin-banner">' +
      '  <div class="w98-signin-title">Letterdrop Network</div>' +
      '  <div class="w98-signin-sub">This invitation could not be found.</div>' +
      '</div>' +
      '<p class="inv-note">That link does not match an invitation. It may have been ' +
      'mistyped, or the letter it belonged to was deleted.</p>' +
      '<div class="w98-signin-actions">' +
      '  <a class="w98-btn" href="/" style="text-decoration:none;color:#000">Go to Letterdrop</a>' +
      '</div>',
      sheetFor("Invitation not found", "Letterdrop Network"));
  }

  if (invite.used) {
    return shell("Invitation already used", "Log On to Letterdrop",
      '<div class="w98-signin-banner">' +
      '  <div class="w98-signin-title">Letterdrop Network</div>' +
      '  <div class="w98-signin-sub">This invitation has already been used.</div>' +
      '</div>' +
      '<p class="inv-note">An invitation link only works once. If you already made your ' +
      'account, sign in as usual. Otherwise ask ' + esc(invite.from) + ' for a new one.</p>' +
      '<div class="w98-signin-actions">' +
      '  <a class="w98-btn" href="/" style="text-decoration:none;color:#000">Sign in</a>' +
      '</div>',
      sheetFor(invite.subject || "An invitation", "from " + invite.from));
  }

  if (invite.expired) {
    return shell("Invitation expired", "Log On to Letterdrop",
      '<div class="w98-signin-banner">' +
      '  <div class="w98-signin-title">Letterdrop Network</div>' +
      '  <div class="w98-signin-sub">This invitation has expired.</div>' +
      '</div>' +
      '<p class="inv-note">Invitations are good for a week. Ask ' + esc(invite.from) +
      ' to send you a new one.</p>' +
      '<div class="w98-signin-actions">' +
      '  <a class="w98-btn" href="/" style="text-decoration:none;color:#000">Go to Letterdrop</a>' +
      '</div>',
      sheetFor(invite.subject || "An invitation", "from " + invite.from));
  }

  /* ---------- the real thing: a sign-up window over the letter ---------- */

  shell("You are invited to " + settings.siteName, "Create Your Account",

    '<div class="w98-signin-banner">' +
    '  <div class="w98-signin-title">Letterdrop Network</div>' +
    '  <div class="w98-signin-sub">' + esc(invite.from) + ' invited you. Choose a user name and password.</div>' +
    '</div>' +

    '<div class="w98-signin-row">' +
    '  <label for="u">User name:</label>' +
    '  <input class="w98-field" id="u" autocomplete="username" spellcheck="false" value="' +
        esc(invite.suggestedName) + '" />' +
    '</div>' +

    '<div class="w98-signin-row">' +
    '  <label for="p">Password:</label>' +
    '  <input class="w98-field" id="p" type="password" autocomplete="new-password" />' +
    '</div>' +
    '<div class="inv-hint">At least 8 characters.</div>' +

    '<div class="w98-signin-msg inv-err" id="err" role="status" aria-live="polite"></div>' +

    '<div class="w98-signin-actions">' +
    '  <button class="w98-btn" id="go" type="button">Create account</button>' +
    '  <a class="w98-btn" href="/" style="text-decoration:none;color:#000">Cancel</a>' +
    '</div>' +

    '<script>' +
    '(function(){' +
    '  var TOKEN=' + JSON.stringify(token) + ';' +
    '  var go=document.getElementById("go"),err=document.getElementById("err");' +
    '  var u=document.getElementById("u"),p=document.getElementById("p");' +
    '  var win=document.getElementById("inviteWin");' +
    '  function focusWin(){ if(win) win.classList.add("is-focused"); }' +
    '  focusWin();' +
    '  function fail(t){ err.textContent=t; go.disabled=false; }' +
    '  go.addEventListener("click",function(){' +
    '    var name=u.value.trim(),pass=p.value;' +
    '    if(!name||!pass){ fail("Fill in both boxes."); return; }' +
    '    if(pass.length<8){ fail("The password must be at least 8 characters."); return; }' +
    '    go.disabled=true; err.textContent="Creating your account...";' +
    '    fetch("/api/redeem",{method:"POST",headers:{"Content-Type":"application/json"},' +
    '      body:JSON.stringify({token:TOKEN,username:name,password:pass})})' +
    '    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })' +
    '    .then(function(res){' +
    '      if(!res.ok){ fail(res.j.error||"That did not work."); return; }' +
    '      err.style.color="#070";' +
    '      err.textContent="Account created. Starting Windows...";' +
    '      setTimeout(function(){ location.href="/"; },1100);' +
    '    })' +
    '    .catch(function(){ fail("Could not reach the server."); });' +
    '  });' +
    '  p.addEventListener("keydown",function(e){ if(e.key==="Enter") go.click(); });' +
    '  u.addEventListener("keydown",function(e){ if(e.key==="Enter") p.focus(); });' +
    '  setTimeout(function(){ (u.value?p:u).focus(); },150);' +
    '})();' +
    '<\/script>',

    sheetFor(invite.subject || "An invitation", "from " + invite.from +
      "  \u00B7  " + new Date().toDateString()));
}

/* ---------- a shared letter ---------- */

function handlePublicLetter(req, res, token) {
  const letter = store.resolveLetterLink(token);
  if (!letter) return notFound(res);

  const shape = letter.shape || null;
  const title = letter.subject || "A letter";

  const attachments = (letter.attachments || []).map(function (a) {
    const url = "/letter/" + token + "/file/" + encodeURIComponent(a.name);
    if (a.kind === "image") {
      return "<img class=\"att-img\" src=\"" + esc(url) + "\" alt=\"" + esc(a.name) + "\" />";
    }
    if (a.kind === "audio") {
      return "<audio class=\"att-audio\" src=\"" + esc(url) + "\" controls preload=\"metadata\"></audio>";
    }
    if (a.kind === "video") {
      return "<video class=\"att-video\" src=\"" + esc(url) + "\" controls playsinline preload=\"metadata\"></video>";
    }
    return "<a class=\"att-file\" href=\"" + esc(url) + "\" download=\"" + esc(a.name) + "\">" +
      esc(a.name) + "</a>";
  }).join("");

  const body =
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />' +
'<meta name="viewport" content="width=device-width, initial-scale=1" />' +
'<title>' + esc(title) + '</title>' +
'<meta property="og:title" content="' + esc(title) + '" />' +
'<meta property="og:description" content="A letter from ' + esc(letter.from) + '" />' +
'<meta property="og:url" content="' + esc(baseUrl(req) + "/letter/" + token) + '" />' +
'<meta name="twitter:card" content="summary" />' +
'<style>' +
'  :root { color-scheme: dark; }' +
'  body { margin:0; background:#14100e; color:#e8e2da; padding:24px 16px 60px;' +
'         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }' +
'  .letter { max-width:660px; margin:0 auto; background:#fffdf6; color:#2a2621;' +
'            border-radius:12px; padding:32px 30px; box-shadow:0 8px 30px rgba(0,0,0,.4); }' +
'  .toy { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:9px; line-height:1.05;' +
'         white-space:pre; text-align:center; overflow:hidden; margin:0 0 20px; color:#3a332d; }' +
'  h1 { font-size:20px; margin:0 0 4px; }' +
'  .meta { color:#8a8078; font-size:13px; margin-bottom:20px; }' +
'  .body { line-height:1.7; font-size:15px; white-space:pre-wrap; word-break:break-word; }' +
'  .atts { display:flex; flex-direction:column; gap:12px; margin-top:24px; }' +
'  .att-img, .att-video { max-width:100%; border-radius:8px; display:block; }' +
'  .att-audio { width:100%; }' +
'  .att-file { color:#3a5f9a; }' +
'  footer { max-width:660px; margin:18px auto 0; color:#6f665e; font-size:12px; text-align:center; }' +
'</style></head><body>' +
'<div class="letter">' +
(shape ? '<pre class="toy" id="toy"></pre>' : '') +
'<h1>' + esc(title) + '</h1>' +
'<div class="meta">from ' + esc(letter.from) +
' &middot; ' + esc(new Date(letter.sent).toDateString()) + '</div>' +
'<div class="body">' + esc(letter.body) + '</div>' +
(attachments ? '<div class="atts">' + attachments + '</div>' : '') +
'</div>' +
'<footer>Sent with Letterdrop.</footer>' +
(shape ? '<script src="/ascii.js"></script><script>' +
  'var SHAPE=' + JSON.stringify(shape) + ';var t=document.getElementById("toy");' +
  'if(window.LETTERDROP_ASCII&&t){var s=LETTERDROP_ASCII.make(SHAPE);' +
  'var st=LETTERDROP_ASCII.STEP[SHAPE]||[0,0];' +
  'setInterval(function(){s.step(st[0],st[1]);t.textContent=s.render();},120);}' +
  '</script>' : '') +
'</body></html>';

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function handleShare(req, res, token, wantRaw) {
  const share = store.resolveShare(token);
  if (!share) return notFound(res);

  if (wantRaw) {
    res.writeHead(200, {
      "Content-Type": share.mime,
      "Content-Length": share.size,
      "Cache-Control": "public, max-age=300",
      "Content-Disposition": "inline; filename=\"" + share.name.replace(/"/g, "") + "\"",
      "Accept-Ranges": "bytes"
    });
    if (req.method === "HEAD") { res.end(); return; }

    /* Range requests matter for audio and video: without them a browser
       cannot seek in an mp4. */
    const range = req.headers.range;
    if (range && (share.kind === "video" || share.kind === "audio")) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : share.size - 1;
        if (start < share.size && end < share.size && start <= end) {
          res.writeHead(206, {
            "Content-Type": share.mime,
            "Content-Length": end - start + 1,
            "Content-Range": "bytes " + start + "-" + end + "/" + share.size,
            "Accept-Ranges": "bytes"
          });
          fs.createReadStream(share.path, { start: start, end: end }).pipe(res);
          return;
        }
      }
    }

    fs.createReadStream(share.path).pipe(res);
    return;
  }

  const origin = baseUrl(req);
  const rawUrl = origin + "/s/" + token + "/raw";
  const pageUrl = origin + "/s/" + token;
  const title = share.name;
  const isMedia = share.kind === "image" || share.kind === "video" || share.kind === "audio";

  const og = share.kind === "image"
    ? '<meta property="og:image" content="' + esc(rawUrl) + '" />\n' +
      '<meta property="og:image:alt" content="' + esc(title) + '" />\n' +
      '<meta property="twitter:card" content="summary_large_image" />\n' +
      '<meta name="twitter:image" content="' + esc(rawUrl) + '" />'
    : share.kind === "video"
      ? '<meta property="og:video" content="' + esc(rawUrl) + '" />\n' +
        '<meta property="og:video:type" content="' + esc(share.mime) + '" />\n' +
        '<meta name="twitter:card" content="summary_large_image" />'
      : share.kind === "audio"
        ? '<meta property="og:audio" content="' + esc(rawUrl) + '" />\n' +
          '<meta property="og:audio:type" content="' + esc(share.mime) + '" />\n' +
          '<meta name="twitter:card" content="summary" />'
        : '<meta name="twitter:card" content="summary" />';

  // The page is deliberately bare: just the file, nothing around it.
  let viewer;
  if (share.kind === "image") {
    viewer = '<img class="media" src="' + esc(rawUrl) + '" alt="' + esc(title) + '" />';
  } else if (share.kind === "video") {
    viewer = '<video class="media" src="' + esc(rawUrl) + '" controls playsinline preload="metadata"></video>';
  } else if (share.kind === "audio") {
    viewer = '<audio class="media audio" src="' + esc(rawUrl) + '" controls preload="metadata"></audio>';
  } else if (share.kind === "note") {
    let text = "";
    try { text = fs.readFileSync(share.path, "utf8").slice(0, 200000); } catch (e) {}
    viewer = "<pre>" + esc(text) + "</pre>";
  } else {
    viewer = '<a class="dl" href="' + esc(rawUrl) + '" download="' + esc(title) + '">Download ' + esc(title) + "</a>";
  }

  const body =
'<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
'<title>' + esc(title) + '</title>\n' +
'<meta name="description" content="' + esc(title) + '" />\n' +
'<meta property="og:type" content="' + (share.kind === "video" ? "video.other" : share.kind === "audio" ? "music.song" : "article") + '" />\n' +
'<meta property="og:title" content="' + esc(title) + '" />\n' +
'<meta property="og:description" content="' + esc(title) + '" />\n' +
'<meta property="og:url" content="' + esc(pageUrl) + '" />\n' +
'<meta property="og:site_name" content="Letterdrop" />\n' +
og + '\n' +
'<style>\n' +
'  html,body { margin:0; height:100%; background:#14100e; }\n' +
'  body { display:grid; place-items:center; padding:16px; box-sizing:border-box; }\n' +
'  .media { max-width:100%; max-height:100vh; display:block; }\n' +
'  .audio { width:min(560px, 100%); }\n' +
'  pre { background:#fffdf6; color:#2a2621; padding:22px; border-radius:10px; max-width:900px;\n' +
'        white-space:pre-wrap; word-break:break-word; line-height:1.6;\n' +
'        font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13.5px; }\n' +
'  .dl { color:#e8e2da; background:#2a2521; border:1px solid #3a332d; border-radius:8px;\n' +
'        padding:12px 18px; text-decoration:none; font-family:system-ui,sans-serif; font-size:14px; }\n' +
'</style>\n</head>\n<body>\n' + viewer + '\n</body>\n</html>\n';

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(req.method === "HEAD" ? undefined : body);
}


/* ---------- server ---------- */

const server = http.createServer(function (req, res) {
  const parsed = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const urlPath = parsed.pathname;

  if (urlPath.startsWith("/api/")) {
    api(req, res, urlPath, parsed.searchParams).catch(function (err) {
      const msg = err && err.message === "too large" ? "That upload is too large."
        : err && err.message === "bad json" ? "Malformed request."
        : "Server error.";
      try { sendJson(res, 400, { error: msg }); } catch (e) {}
    });
    return;
  }

  /* ---------- public share routes ----------
     Deliberately outside /api/ and needing no session: a link preview
     crawler has no cookie, and the whole point of a share is that anyone
     with the link can see it. */

  /* An attachment on a shared letter, readable without an account. */
  const letterFile = urlPath.match(/^\/letter\/([a-z0-9]{6,32})\/file\/(.+)$/);
  if (letterFile) {
    if (!allowsGet(req)) { methodNotAllowed(res); return; }
    handleLetterFile(req, res, letterFile[1], decodeURIComponent(letterFile[2]));
    return;
  }

  /* An invitation link. The page is a sign-up form; redeeming it creates
     the account and delivers the letter into the new Inbox. */
  const inviteMatch = urlPath.match(/^\/invite\/([a-z0-9]{10,64})$/);
  if (inviteMatch) {
    if (!allowsGet(req)) { methodNotAllowed(res); return; }
    handleInvitePage(req, res, inviteMatch[1]);
    return;
  }

  /* A shared letter, readable without an account. */
  const letterMatch = urlPath.match(/^\/letter\/([a-z0-9]{6,32})$/);
  if (letterMatch) {
    if (!allowsGet(req)) { methodNotAllowed(res); return; }
    handlePublicLetter(req, res, letterMatch[1]);
    return;
  }

  /* Profile pictures. Public, because an avatar shows up next to a name
     in mail and on shared letters, where there is no session. */
  const avatarMatch = urlPath.match(/^\/avatar\/([A-Za-z0-9_.\-]{1,64})$/);
  if (avatarMatch) {
    if (!allowsGet(req)) { methodNotAllowed(res); return; }
    handleAvatar(req, res, avatarMatch[1]);
    return;
  }

  /* Short links: /<token> and /<token>.<ext> both serve the raw file, so a
     share URL can read like an ordinary file address. /s/<token> is kept
     for the viewer page and for links made before tokens were shortened. */

  const viewMatch = urlPath.match(/^\/s\/([A-Za-z0-9_-]{4,64})$/);
  if (viewMatch) {
    if (!allowsGet(req)) { methodNotAllowed(res); return; }
    handleShare(req, res, viewMatch[1], false);
    return;
  }

  const rawMatch = urlPath.match(/^\/s\/([A-Za-z0-9_-]{4,64})\/raw$/);
  if (rawMatch) {
    if (!allowsGet(req)) { methodNotAllowed(res); return; }
    handleShare(req, res, rawMatch[1], true);
    return;
  }

  /* A bare token at the root, optionally with an extension. This is what
     makes 127.0.0.1:8000/alb5fz.jpg work. It is only treated as a share if
     nothing by that name exists as a real file, so it cannot shadow the
     site's own assets. */
  const bareMatch = urlPath.match(/^\/([a-z0-9]{4,16})(?:\.[A-Za-z0-9]{1,8})?$/);
  if (bareMatch) {
    const asFile = path.resolve(path.join(ROOT, urlPath.slice(1)));
    const isRealFile = asFile.startsWith(ROOT + path.sep) && fs.existsSync(asFile) && fs.statSync(asFile).isFile();
    if (!isRealFile) {
      if (!allowsGet(req)) { methodNotAllowed(res); return; }
      // let the viewer decide: HTML for a browser, the bytes for a crawler
      handleShare(req, res, bareMatch[1], wantsRaw(req));
      return;
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405); res.end("Method not allowed"); return;
  }
  serveStatic(req, res, urlPath);
});

store.ensureDirs();

/* On a fresh install, create an admin and print the password once. The
   password is generated here rather than inside the store so it can be
   shown to the operator; it is only ever stored as a hash.

   A generated password is always treated as temporary and must be changed
   at first sign-in. An operator who supplies ADMIN_PASS has chosen that
   password deliberately, so it is not flagged. */
const firstRun = store.userCount() === 0;
const seedUser = process.env.ADMIN_USER || "admin";
const seedSupplied = Boolean(process.env.ADMIN_PASS);
const seedPass = process.env.ADMIN_PASS || (firstRun ? crypto.randomBytes(9).toString("base64url") : null);
const seed = firstRun
  ? store.ensureSeedAdmin(seedUser, seedPass, { mustChange: !seedSupplied })
  : null;

/* Real-time chat rides the same HTTP server on the /ws upgrade. The hub
   replaces the placeholder above so the API can report who is online. */
chat = require("./lib/chat").createHub(server, server);

/* Tidy the throttling table and any expired sessions now and then, so
   neither grows without bound on a long-running server. */
const housekeeping = setInterval(function () {
  auth.sweepThrottle();
  try { store.pruneSessions(store.load()); } catch (e) {}
}, 10 * 60 * 1000);
if (housekeeping.unref) housekeeping.unref();

server.listen(PORT, HOST, function () {
  console.log("");
  console.log("  Letterdrop  ->  http://" + HOST + ":" + PORT);
  if (seed) {
    console.log("");
    console.log("  Created the first admin account.");
    console.log("    username: " + seed.username);
    console.log("    password: " + seedPass);
    console.log("");
    console.log("  This is shown once, and must be changed at first sign-in.");
  }
  console.log("");
});
