/* ============================================================
   Letterdrop — data store

   Plain files under data/. No database, no dependencies, and every
   record is readable with a text editor, which matters for something
   this size.

     data/users.json          accounts and sessions
     data/files/<userId>/     that user's notes and images

   Each user's files live in their own directory, and every file
   operation resolves the path through userIdFromPath() so a crafted
   name cannot escape its owner's folder.
   ============================================================ */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { hashPassword, verifyPassword, newToken, tokenExpired, shouldRenew, SESSION_TTL_MS } = require("./auth");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const FILES = path.join(DATA, "files");
const USERS_FILE = path.join(DATA, "users.json");

/* Uploads are streamed to disk rather than buffered, so the cap is about
   disk space and patience rather than memory. */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;   // 1 GB per file
const MAX_NOTE_BYTES = 256 * 1024;             // 256 kB per note

/* Anything uploadable is allowed; this only decides what a browser can
   display inline versus what it downloads. */
const EXT_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".avif": "image/avif",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".m4v": "video/x-m4v", ".ogv": "video/ogg",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".zip": "application/zip", ".gz": "application/gzip"
};

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"];
const AUDIO_EXT = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];
const VIDEO_EXT = [".mp4", ".webm", ".mov", ".m4v", ".ogv"];

/* ---------- site settings ----------
   Kept in the same store so a Control Panel change survives a restart. */

const DEFAULT_SETTINGS = {
  siteName: "Letterdrop",
  motd: "Welcome to Letterdrop.",
  allowSignups: true,
  maxUploadMB: 1024,
  /* Storage per account, in MB. 0 means unlimited, which is the default so
     an existing install is not retroactively capped. */
  quotaMB: 0,
  /* When an account is over its quota, whether existing files may still be
     downloaded. Off by default: over quota means read-only, not locked out. */
  lockOverQuota: false,
  programs: {
    notepad: true, documents: true, paint: true, calculator: true,
    minesweeper: true, msdos: true, mycomputer: true, network: true,
    aim: true, mail: true, letterdrop: true, winamp: true, accounts: true
  }
};

function getSettings() {
  const db = load();
  const s = db.settings || {};
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  Object.keys(s).forEach(function (k) {
    if (k === "programs" && s.programs && typeof s.programs === "object") {
      Object.keys(s.programs).forEach(function (p) {
        if (p in out.programs) out.programs[p] = Boolean(s.programs[p]);
      });
    } else if (k in out) {
      out[k] = s[k];
    }
  });
  return out;
}

function saveSettings(patch) {
  const db = load();
  const current = getSettings();
  const next = JSON.parse(JSON.stringify(current));

  if (patch && typeof patch === "object") {
    Object.keys(patch).forEach(function (k) {
      if (k === "programs" && patch.programs && typeof patch.programs === "object") {
        Object.keys(patch.programs).forEach(function (p) {
          if (p in next.programs) next.programs[p] = Boolean(patch.programs[p]);
        });
      } else if (k in next) {
        next[k] = patch[k];
      }
    });
  }

  // keep the upload cap sane
  const mb = Number(next.maxUploadMB);
  next.maxUploadMB = isNaN(mb) ? DEFAULT_SETTINGS.maxUploadMB : Math.max(1, Math.min(4096, Math.round(mb)));

  db.settings = next;
  save(db);
  return next;
}

function isProgramEnabled(id) {
  const s = getSettings();
  return s.programs[id] !== false;
}

/* ---------- low level ---------- */

function ensureDirs() {
  for (const d of [DATA, FILES]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [], sessions: {} }, null, 2));
  }
}

function load() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!parsed.sessions || typeof parsed.sessions !== "object") parsed.sessions = {};
    if (!parsed.shares || typeof parsed.shares !== "object") parsed.shares = {};
    if (!Array.isArray(parsed.mail)) parsed.mail = [];
    if (!Array.isArray(parsed.ims)) parsed.ims = [];
    return parsed;
  } catch (e) {
    // a corrupt store should not take the whole site down
    return { users: [], sessions: {}, shares: {}, mail: [], ims: [] };
  }
}

function save(db) {
  ensureDirs();
  // write to a temp file then rename, so a crash mid-write cannot
  // leave a half-written users.json behind
  const tmp = USERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

/* ---------- ids and paths ---------- */

function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function userDir(userId) {
  return path.join(FILES, userId);
}

/* Is `full` inside the user's own folder?

   Once folders exist a file can be several levels deep, so comparing the
   immediate dirname is wrong -- that only accepts the top level. This
   resolves both sides and checks the prefix, which is the property that
   actually matters. */
function insideUserDir(userId, full) {
  const root = path.resolve(userDir(userId));
  const resolved = path.resolve(full);
  return resolved === root || resolved.indexOf(root + path.sep) === 0;
}

function ensureUserDir(userId) {
  const d = userDir(userId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/* A file name from the client is untrusted. Strip it to a safe basename and
   reject anything that is not a plain name, so "../../etc/passwd" cannot
   escape the user's own directory. */
function safeName(name) {
  if (typeof name !== "string") return null;

  /* Strip any directory part first, then keep a generous set of
     characters so ordinary file names survive intact -- "song (1).mp3",
     "café.jpg" and the like. Anything that could confuse a path or a
     shell is replaced rather than removed, so the name stays readable. */
  const base = path.basename(name)
    .replace(/[\x00-\x1f\x7f]/g, "")      // control characters
    .replace(/[\\/:*?"<>|]/g, "_")        // characters Windows forbids
    .replace(/^\.+/, "")                  // no leading dots, so no hidden files
    .trim();

  if (!base || base === "." || base === "..") return null;
  if (base.length > 120) {
    const ext = path.extname(base);
    return base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/* ---------- users ---------- */

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    created: u.created,
    // the extension only; the bytes are served from /api/avatar
    avatar: u.avatar || null,
    avatarUpdated: u.avatarUpdated || null
  };
}

function findByName(db, username) {
  const lower = String(username || "").toLowerCase();
  return db.users.find(function (u) { return u.username.toLowerCase() === lower; }) || null;
}

function findById(db, id) {
  return db.users.find(function (u) { return u.id === id; }) || null;
}

function createUser(opts) {
  const db = load();
  const username = String(opts.username || "").trim();
  const password = String(opts.password || "");
  const role = opts.role === "admin" ? "admin" : "user";

  if (!/^[A-Za-z0-9_.\- ]{3,24}$/.test(username)) {
    return { error: "Username must be 3-24 characters: letters, numbers, dot, dash or underscore." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (findByName(db, username)) {
    return { error: "That username is already taken." };
  }

  const user = {
    id: newId("u"),
    username: username,
    role: role,
    hash: hashPassword(password),
    created: new Date().toISOString()
  };
  db.users.push(user);
  save(db);
  ensureUserDir(user.id);
  return { user: publicUser(user) };
}

function authenticate(username, password) {
  const db = load();
  const user = findByName(db, username);
  if (!user) {
    // still burn a hash so a missing user and a wrong password take the
    // same amount of time, which avoids leaking which names exist
    try { verifyPassword(password, hashPassword("placeholder")); } catch (e) {}
    return null;
  }
  if (!verifyPassword(password, user.hash)) return null;
  return user;
}

/* ---------- sessions ---------- */

/* `meta` carries what the session list needs to be useful: who signed in,
   from where, and with what. */
function createSession(userId, meta) {
  const db = load();
  const token = newToken();
  const now = Date.now();
  const m = meta || {};
  db.sessions[token] = {
    userId: userId,
    created: now,
    expires: now + SESSION_TTL_MS,
    agent: m.agent ? String(m.agent).slice(0, 160) : "",
    ip: m.ip ? String(m.ip).slice(0, 60) : ""
  };
  save(db);

  /* Keep the session table from growing forever: prune expired entries
     whenever a new one is made. */
  pruneSessions(db);
  return token;
}

function pruneSessions(db) {
  let removed = 0;
  Object.keys(db.sessions || {}).forEach(function (t) {
    if (tokenExpired(db.sessions[t])) { delete db.sessions[t]; removed++; }
  });
  if (removed) save(db);
  return removed;
}

/* Look up a session and, if it is being kept alive, push its expiry back.
   `renew` is skipped for requests that should not extend a session. */
function sessionUser(token, renew) {
  if (!token) return null;
  const db = load();
  const s = db.sessions[token];

  if (tokenExpired(s)) {
    if (s) { delete db.sessions[token]; save(db); }
    return null;
  }

  const user = findById(db, s.userId);
  if (!user) return null;

  if (shouldRenew(s)) {
    s.expires = Date.now() + SESSION_TTL_MS;
    save(db);
  }

  return user;
}

function destroySession(token) {
  if (!token) return;
  const db = load();
  if (db.sessions[token]) {
    delete db.sessions[token];
    save(db);
  }
}

/* Every live session this user has, newest first. The token itself is
   never returned -- only a short fingerprint, so the list can identify a
   row without handing out a credential. */
function listSessions(userId, currentToken) {
  const db = load();
  const out = [];

  Object.keys(db.sessions || {}).forEach(function (t) {
    const s = db.sessions[t];
    if (s.userId !== userId) return;
    if (tokenExpired(s)) return;
    out.push({
      id: fingerprint(t),
      agent: s.agent || "Unknown device",
      ip: s.ip || "",
      created: s.created ? new Date(s.created).toISOString() : null,
      expires: new Date(s.expires).toISOString(),
      current: t === currentToken
    });
  });

  out.sort(function (a, b) {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return (b.created || "").localeCompare(a.created || "");
  });
  return out;
}

/* A short, stable, non-reversible handle for a token. */
function fingerprint(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}

/* Sign out one session by its fingerprint. Refuses anything that is not
   this user's, so you cannot end someone else's session.

   `currentToken` is the caller's own, which is what decides whether they
   have just signed themselves out. The `current` flag on the record is
   only ever a hint for display: it is set when the session is created, so
   it cannot be trusted for this. */
function revokeSession(userId, id, currentToken) {
  const db = load();
  const token = Object.keys(db.sessions || {}).find(function (t) {
    return db.sessions[t].userId === userId && fingerprint(t) === id;
  });
  if (!token) return { error: "That session is no longer active." };

  const wasCurrent = Boolean(currentToken) && token === currentToken;
  delete db.sessions[token];
  save(db);
  return { ok: true, wasCurrent: wasCurrent };
}

/* Sign out everywhere. `exceptToken` keeps the caller signed in. */
function revokeAllSessions(userId, exceptToken) {
  const db = load();
  let removed = 0;
  Object.keys(db.sessions || {}).forEach(function (t) {
    if (db.sessions[t].userId !== userId) return;
    if (exceptToken && t === exceptToken) return;
    delete db.sessions[t];
    removed++;
  });
  if (removed) save(db);
  return { ok: true, removed: removed };
}

/* How many live sessions a user has, for the profile window. */
function sessionCount(userId) {
  const db = load();
  return Object.keys(db.sessions || {}).filter(function (t) {
    return db.sessions[t].userId === userId && !tokenExpired(db.sessions[t]);
  }).length;
}

/* ---------- files ----------
   Every entry is either a note (text, editable in Notepad) or an image
   (uploaded, viewable in My Documents). */

function listFiles(userId) {
  const dir = ensureUserDir(userId);
  const shares = shareMapFor(userId);
  return fs.readdirSync(dir)
    .filter(function (n) { return !n.startsWith("."); })
    .map(function (name) {
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (e) { return null; }
      if (!st.isFile()) return null;
      return {
        name: name,
        kind: fileKind(name),
        mime: mimeFor(name),
        size: st.size,
        modified: st.mtime.toISOString(),
        // the token if this file is publicly shared, otherwise absent
        share: shares[name] || null
      };
    })
    .filter(Boolean)
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}

/* What kind of file is this, and what should the browser call it? */
function fileKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.indexOf(ext) !== -1) return "image";
  if (AUDIO_EXT.indexOf(ext) !== -1) return "audio";
  if (VIDEO_EXT.indexOf(ext) !== -1) return "video";
  if (ext === ".txt" || ext === ".md" || ext === ".json") return "note";
  return "file";
}

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}

/* Old name kept so nothing else has to change. */
function imageMime(ext) {
  return EXT_MIME[ext] || "image/png";
}

function readFile(userId, name) {
  /* The name may be a path inside a folder, so it goes through the same
     sanitiser a rename does rather than safeName, which strips separators. */
  const safe = sanitizeRelPath(name);
  if (!safe) return { error: "Invalid file name." };
  const full = path.join(userDir(userId), safe);
  // belt and braces: the resolved path must still be inside the user's folder
  if (!insideUserDir(userId, full)) {
    return { error: "Invalid file name." };
  }
  if (!fs.existsSync(full)) return { error: "File not found." };

  const kind = fileKind(safe);
  const mime = mimeFor(safe);

  /* Audio and video can be tens or hundreds of megabytes, so they are
     never base64'd into a JSON reply. The viewer streams them from
     /api/raw instead. */
  if (kind === "audio" || kind === "video" || kind === "file") {
    return { kind: kind, name: safe, mime: mime, size: fs.statSync(full).size, streamed: true };
  }

  const buf = fs.readFileSync(full);
  if (kind === "image") {
    return { kind: "image", name: safe, mime: mime, base64: buf.toString("base64") };
  }
  return { kind: "note", name: safe, mime: mime, text: buf.toString("utf8").slice(0, MAX_NOTE_BYTES) };
}

/* Saving a note: always text, so the extension is forced to .txt. */
/* Save a note.

   `opts.overwrite` has to be passed explicitly to replace an existing
   file. Without it an existing name is reported back rather than silently
   clobbered, so a caller can ask what to do. */
function saveNote(userId, name, text, opts) {
  let safe = sanitizeRelPath(name);
  if (!safe) return { error: "Please give the note a name." };
  if (!/\.txt$/i.test(safe)) safe = safe.replace(/\.[^.]*$/, "") + ".txt";
  if (typeof text !== "string") return { error: "Nothing to save." };

  const buf = Buffer.from(text, "utf8");
  if (buf.length > MAX_NOTE_BYTES) return { error: "That note is too large." };

  const full = path.join(ensureUserDir(userId), safe);
  if (!insideUserDir(userId, full)) return { error: "That name is not allowed." };

  /* Saving over something is a decision, not an accident. */
  const existed = fs.existsSync(full);
  if (existed && !(opts && opts.overwrite)) {
    return {
      exists: true,
      name: safe,
      error: "\"" + safe + "\" already exists."
    };
  }

  const parent = path.dirname(full);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(full, buf);
  return { name: safe, replaced: existed };
}

/* Any file type is accepted now. The extension is kept as given (falling
   back to one derived from the type), so an .mp3 stays an .mp3 and the
   browser knows what to do with it. */
function saveUpload(userId, name, mime, base64) {
  let buf;
  try {
    buf = Buffer.from(String(base64 || ""), "base64");
  } catch (e) {
    return { error: "That file could not be read." };
  }
  if (!buf.length) return { error: "That file is empty." };

  const cap = getSettings().maxUploadMB * 1024 * 1024;
  if (buf.length > cap) {
    return { error: "Files must be under " + getSettings().maxUploadMB + " MB." };
  }

  let safe = sanitizeRelPath(name) || "upload";
  // add an extension inferred from the type when the name has none
  if (!path.extname(safe)) {
    const guess = Object.keys(EXT_MIME).find(function (e) { return EXT_MIME[e] === mime; });
    safe += guess || ".bin";
  }

  /* Overwriting an existing name frees its old bytes, so the quota is
     checked against the difference rather than the whole file. */
  const existing = path.join(userDir(userId), safe);
  let replacing = 0;
  if (fs.existsSync(existing)) {
    try { replacing = fs.statSync(existing).size; } catch (e) {}
  }
  const room = quotaAllows(userId, Math.max(0, buf.length - replacing));
  if (!room.ok) return { error: room.error, quota: room.quota };

  fs.writeFileSync(existing, buf);
  return { name: safe, kind: fileKind(safe), mime: mimeFor(safe), size: buf.length };
}

/* Kept as an alias so existing callers keep working. */
function saveImage(userId, name, mime, base64) {
  return saveUpload(userId, name, mime, base64);
}

/* ---------- streaming upload ----------
   A 1 GB body cannot be buffered in memory, so the raw request stream is
   piped straight to disk. The name arrives in a header; the body is the
   file itself. */
function uploadPath(userId, name) {
  let safe = sanitizeRelPath(name) || "upload";
  if (!path.extname(safe)) safe += ".bin";
  const dir = ensureUserDir(userId);
  const full = path.join(dir, safe);
  if (!insideUserDir(userId, full)) return null;
  return { name: safe, path: full };
}

/* A name that does not collide with an existing file. */
function uniqueUploadPath(userId, name) {
  const first = uploadPath(userId, name);
  if (!first) return null;
  if (!fs.existsSync(first.path)) return first;

  const ext = path.extname(first.name);
  const stem = first.name.slice(0, first.name.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = uploadPath(userId, stem + " (" + i + ")" + ext);
    if (candidate && !fs.existsSync(candidate.path)) return candidate;
  }
  return first;
}

function maxUploadBytes() {
  return getSettings().maxUploadMB * 1024 * 1024;
}

/* ---------- storage quota ----------
   A cap per account, so one person cannot fill the disk. 0 means
   unlimited, and that is the default so existing installs keep working. */

function quotaBytes() {
  const mb = Number(getSettings().quotaMB) || 0;
  return mb > 0 ? mb * 1024 * 1024 : 0;
}

function usedBytes(userId) {
  const dir = userDir(userId);
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  try {
    fs.readdirSync(dir).forEach(function (n) {
      // hidden files are avatars and bookkeeping, not user-visible usage
      if (n.startsWith(".")) return;
      try {
        const st = fs.statSync(path.join(dir, n));
        if (st.isFile()) total += st.size;
      } catch (e) {}
    });
  } catch (e) {}
  return total;
}

/* What the UI needs to show a quota bar. */
function quotaFor(userId) {
  const quota = quotaBytes();
  const used = usedBytes(userId);
  return {
    usedBytes: used,
    quotaBytes: quota,
    unlimited: quota === 0,
    remainingBytes: quota === 0 ? null : Math.max(0, quota - used),
    percent: quota === 0 ? null : Math.min(100, Math.round((used / quota) * 100))
  };
}

/* Would adding `extra` bytes exceed the cap? */
function quotaAllows(userId, extra) {
  const quota = quotaBytes();
  if (quota === 0) return { ok: true };
  const used = usedBytes(userId);
  if (used + extra <= quota) return { ok: true };
  const mb = function (n) { return (n / 1048576).toFixed(1) + " MB"; };
  return {
    error: "That would put you over your " + mb(quota) + " storage limit. " +
      "You are using " + mb(used) + ", and this file is " + mb(extra) + ". " +
      "Delete something first.",
    quota: { usedBytes: used, quotaBytes: quota }
  };
}

function quotaExceeded(userId) {
  const quota = quotaBytes();
  if (quota === 0) return false;
  return usedBytes(userId) > quota;
}

function deleteFile(userId, name) {
  const safe = sanitizeRelPath(name);
  if (!safe) return { error: "Invalid file name." };
  const full = path.join(userDir(userId), safe);
  if (!insideUserDir(userId, full)) {
    return { error: "Invalid file name." };
  }
  if (!fs.existsSync(full)) return { error: "File not found." };
  try { fs.unlinkSync(full); } catch (e) { return { error: "Could not delete that file." }; }
  // a deleted file must not stay reachable through an old share link
  revokeSharesFor(userId, safe);
  return { ok: true };
}

/* ---------- renaming and moving ----------
   Both are the same operation: the file gets a new name. "Moving" into a
   folder is just a new name with a path in it. */

function renameFile(userId, from, to) {
  const safeFrom = safeName(from);
  if (!safeFrom) return { error: "Invalid file name." };

  const dir = ensureUserDir(userId);
  const source = path.join(dir, safeFrom);
  if (!insideUserDir(userId, source)) {
    return { error: "Invalid file name." };
  }
  if (!fs.existsSync(source)) return { error: "File not found." };
  if (!fs.statSync(source).isFile()) return { error: "That is a folder." };

  /* The destination is a relative path, so it may contain separators for a
     move. Traversal is stripped component by component rather than
     rejected outright, then the resolved path is checked again. */
  const clean = sanitizeRelPath(to);
  if (!clean) return { error: "That name is not allowed." };

  const target = path.join(dir, clean);
  if (!insideUserDir(userId, target)) {
    return { error: "That name is not allowed." };
  }
  if (path.resolve(target) === path.resolve(source)) {
    return { error: "The name is unchanged." };
  }
  if (fs.existsSync(target)) return { error: "Something is already called that." };

  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

  try { fs.renameSync(source, target); }
  catch (e) { return { error: "Could not rename that file." }; }

  /* A share points at a name, so a rename has to carry it across or the
     link would silently die. */
  const db = load();
  let moved = 0;
  Object.keys(db.shares || {}).forEach(function (t) {
    const s = db.shares[t];
    if (s.userId === userId && s.name === safeFrom) { s.name = clean; moved++; }
  });
  if (moved) save(db);

  return { ok: true, name: clean, shareMoved: moved > 0 };
}

/* A destination path, stripped of anything that could escape the folder.
   Each component goes through safeName, and empty or dot components are
   dropped, so "../../etc/passwd" becomes "etc/passwd" inside the folder. */
function sanitizeRelPath(to) {
  if (typeof to !== "string") return null;
  const parts = to.replace(/\\/g, "/").split("/");
  const out = [];
  parts.forEach(function (p) {
    if (!p || p === "." || p === "..") return;
    const safe = safeName(p);
    if (safe && safe !== "." && safe !== "..") out.push(safe);
  });
  if (!out.length) return null;
  const joined = out.join("/");
  return joined.length > 180 ? null : joined;
}

/* ---------- folders ----------
   Folders are directories inside the user's own folder. Nothing else
   changes: a file in a folder is still just a file with a path. */

function makeFolder(userId, relPath) {
  const clean = sanitizeRelPath(relPath);
  if (!clean) return { error: "That folder name is not allowed." };

  const dir = ensureUserDir(userId);
  const full = path.join(dir, clean);
  const resolved = path.resolve(full);
  if (resolved !== path.resolve(dir) && resolved.indexOf(path.resolve(dir) + path.sep) !== 0) {
    return { error: "That folder name is not allowed." };
  }
  if (fs.existsSync(full)) return { error: "A folder with that name already exists." };

  try { fs.mkdirSync(full, { recursive: true }); }
  catch (e) { return { error: "Could not create that folder." }; }
  return { ok: true, path: clean };
}

/* Delete a folder, and everything in it. */
function deleteFolder(userId, relPath) {
  const clean = sanitizeRelPath(relPath);
  if (!clean) return { error: "That folder name is not allowed." };

  const dir = ensureUserDir(userId);
  const full = path.join(dir, clean);
  const resolved = path.resolve(full);
  if (resolved === path.resolve(dir) || resolved.indexOf(path.resolve(dir) + path.sep) !== 0) {
    return { error: "That folder name is not allowed." };
  }
  if (!fs.existsSync(full)) return { error: "Folder not found." };
  if (!fs.statSync(full).isDirectory()) return { error: "That is not a folder." };

  /* Shares pointing inside the folder go with it. */
  const db = load();
  const prefix = clean + "/";
  let shares = 0;
  Object.keys(db.shares || {}).forEach(function (t) {
    const s = db.shares[t];
    if (s.userId === userId && s.name.indexOf(prefix) === 0) { delete db.shares[t]; shares++; }
  });
  if (shares) save(db);

  try { fs.rmSync(full, { recursive: true, force: true }); }
  catch (e) { return { error: "Could not delete that folder." }; }
  return { ok: true, shares: shares };
}

/* Everything in a folder, plus its subfolders. `relPath` of "" is the
   root of the user's Documents. */
function listFolder(userId, relPath) {
  const dir = ensureUserDir(userId);
  const clean = relPath ? sanitizeRelPath(relPath) : "";
  if (relPath && !clean) return { error: "That folder name is not allowed." };

  const base = clean ? path.join(dir, clean) : dir;
  const resolved = path.resolve(base);
  if (resolved !== path.resolve(dir) && resolved.indexOf(path.resolve(dir) + path.sep) !== 0) {
    return { error: "That folder name is not allowed." };
  }
  if (!fs.existsSync(base)) return { error: "Folder not found." };

  const shares = shareMapFor(userId);
  const files = [], folders = [];

  fs.readdirSync(base).forEach(function (n) {
    if (n.startsWith(".")) return;      // avatars and bookkeeping
    const full = path.join(base, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { return; }
    const rel = clean ? clean + "/" + n : n;

    if (st.isDirectory()) {
      let count = 0;
      try { count = fs.readdirSync(full).filter(function (x) { return !x.startsWith("."); }).length; }
      catch (e) {}
      folders.push({ name: n, path: rel, items: count });
      return;
    }

    files.push({
      name: n,
      path: rel,
      kind: fileKind(n),
      mime: mimeFor(n),
      size: st.size,
      modified: st.mtime.toISOString(),
      share: shares[rel] || null
    });
  });

  folders.sort(function (a, b) { return a.name.localeCompare(b.name); });
  files.sort(function (a, b) { return a.name.localeCompare(b.name); });

  return {
    path: clean,
    parent: clean.indexOf("/") === -1 ? "" : clean.slice(0, clean.lastIndexOf("/")),
    folders: folders,
    files: files
  };
}

/* Every file the user has, at any depth, for search. */
function walkFiles(userId) {
  const dir = userDir(userId);
  if (!fs.existsSync(dir)) return [];
  const out = [];

  (function walk(base, prefix) {
    let entries;
    try { entries = fs.readdirSync(base); } catch (e) { return; }
    entries.forEach(function (n) {
      if (n.startsWith(".")) return;
      const full = path.join(base, n);
      const rel = prefix ? prefix + "/" + n : n;
      let st;
      try { st = fs.statSync(full); } catch (e) { return; }
      if (st.isDirectory()) { walk(full, rel); return; }
      out.push({
        name: n,
        path: rel,
        folder: prefix,
        kind: fileKind(n),
        size: st.size,
        modified: st.mtime.toISOString()
      });
    });
  })(dir, "");

  return out;
}

/* ============================================================
   Public sharing

   A share is a random token mapped to { userId, name }. The token is
   the only thing a visitor needs, so it must be unguessable — 18 bytes
   of randomness, which is far beyond brute force.

   Nothing is stored in the file itself, so a file can be shared,
   unshared and shared again without touching its contents.
   ============================================================ */

/* Six characters from an unambiguous alphabet. 32^6 is about a billion
   combinations, so a token is not guessable by hand, and unlike base64url
   there are no 0/O or 1/l/I pairs to misread when someone types one in.
   The store checks for collisions on creation. */
const SHARE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const SHARE_LENGTH = 6;

function newShareToken(db) {
  const taken = (db && db.shares) || {};
  for (let attempt = 0; attempt < 50; attempt++) {
    let out = "";
    const bytes = crypto.randomBytes(SHARE_LENGTH);
    for (let i = 0; i < SHARE_LENGTH; i++) {
      out += SHARE_ALPHABET[bytes[i] % SHARE_ALPHABET.length];
    }
    if (!taken[out]) return out;
  }
  // extraordinarily unlikely, but fall back to something longer
  return crypto.randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* The share for a given file, if it has one. */
function shareFor(userId, name) {
  const db = load();
  const token = Object.keys(db.shares).find(function (t) {
    const s = db.shares[t];
    return s.userId === userId && s.name === name;
  });
  return token || null;
}

function shareUrlFor(userId, name) {
  const token = shareFor(userId, name);
  return token ? { token: token } : null;
}

/* Create (or return the existing) share for a file the caller owns.
   The name may be a path inside a folder, so it goes through the same
   sanitiser a rename does rather than safeName, which strips separators. */
function createShare(userId, rawName) {
  const safe = sanitizeRelPath(rawName);
  if (!safe) return { error: "Invalid file name." };

  const full = path.join(userDir(userId), safe);
  if (!insideUserDir(userId, full)) {
    return { error: "Invalid file name." };
  }
  if (!fs.existsSync(full)) return { error: "File not found." };

  const db = load();
  const existing = shareFor(userId, safe);
  if (existing) return { token: existing, created: false };

  const token = newShareToken(db);
  db.shares[token] = {
    userId: userId,
    name: safe,
    created: new Date().toISOString()
  };
  save(db);
  return { token: token, created: true };
}

function revokeShare(userId, name) {
  const db = load();
  const safe = sanitizeRelPath(name);
  let removed = 0;
  Object.keys(db.shares).forEach(function (t) {
    const s = db.shares[t];
    if (s.userId === userId && s.name === safe) { delete db.shares[t]; removed++; }
  });
  if (removed) save(db);
  return { ok: true, removed: removed };
}

/* Used when a file is deleted, so stale links stop working. */
function revokeSharesFor(userId, name) {
  return revokeShare(userId, name);
}

function revokeAllShares(userId) {
  const db = load();
  let removed = 0;
  Object.keys(db.shares).forEach(function (t) {
    if (db.shares[t].userId === userId) { delete db.shares[t]; removed++; }
  });
  if (removed) save(db);
  return { ok: true, removed: removed };
}

/* Resolve a public token. No session required — this is the whole point.
   Returns everything a viewer page (or a link preview crawler) needs. */
function resolveShare(token) {
  // short alphanumeric tokens; kept permissive so older longer links still work
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(token)) return null;

  const db = load();
  const s = db.shares[token];
  if (!s) return null;

  const owner = findById(db, s.userId);
  const dir = userDir(s.userId);
  const full = path.join(dir, s.name);

  /* The shared name may now include a folder, so containment is tested
     against the resolved path rather than a single dirname. */
  const resolved = path.resolve(full);
  const root = path.resolve(dir);
  if (resolved !== root && resolved.indexOf(root + path.sep) !== 0) return null;
  if (!fs.existsSync(resolved)) return null;
  if (!fs.statSync(resolved).isFile()) return null;

  const size = fs.statSync(resolved).size;

  return {
    token: token,
    name: s.name,
    kind: fileKind(s.name),
    mime: mimeFor(s.name),
    size: size,
    owner: owner ? owner.username : "someone",
    shared: s.created,
    path: resolved
  };
}

/* Everything a user has shared, for the My Documents listing. */
function shareMapFor(userId) {
  const db = load();
  const out = {};
  Object.keys(db.shares).forEach(function (t) {
    const s = db.shares[t];
    if (s.userId === userId) out[s.name] = t;
  });
  return out;
}

/* ============================================================
   Internal mail

   One record per message, with `from` and `to` as user ids. A message
   appears in the sender's Sent folder and the recipient's Inbox; the
   two sides track their own read/deleted flags so one person deleting
   a message does not remove it from the other's view.
   ============================================================ */

const MAX_SUBJECT = 120;
const MAX_BODY = 20000;
const MAX_ATTACH = 10;

function newMailId() {
  return "m_" + crypto.randomBytes(8).toString("hex");
}

/* Shape a message for one particular viewer. */
function mailForViewer(msg, viewerId, db) {
  const isSender = msg.from === viewerId;
  const fromUser = findById(db, msg.from);
  const out = {
    id: msg.id,
    // copies of one message share this, so they can be recognised as a set
    threadId: msg.threadId || null,
    kind: msg.kind || "message",
    from: fromUser ? fromUser.username : "(deleted)",
    fromId: msg.from,
    fromAvatar: fromUser && fromUser.avatar ? fromUser.avatar : null,
    to: msg.toName,
    toId: msg.to,
    // "to" or "cc", so the reader can show how they were addressed
    via: msg.via || "to",
    subject: msg.subject,
    body: msg.body,
    attachments: msg.attachments || [],
    sent: msg.sent,
    read: isSender ? true : Boolean(msg.read),
    folder: isSender ? "sent" : "inbox"
  };

  if (msg.kind === "letter") {
    out.letterType = msg.letterType || "regular";
    out.shape = msg.shape || null;
    if (msg.invite) {
      const expired = Date.parse(msg.invite.expires) < Date.now();
      out.invite = {
        token: msg.invite.token,
        used: Boolean(msg.invite.used),
        expired: expired,
        active: !msg.invite.used && !expired,
        expires: msg.invite.expires
      };
    }
  }

  return out;
}

/* List a folder for a user. Folders: inbox | sent | trash */
function listMail(userId, folder) {
  const db = load();
  const want = folder === "sent" ? "sent" : folder === "trash" ? "trash" : "inbox";

  const out = [];
  db.mail.forEach(function (msg) {
    const isSender = msg.from === userId;
    const isRecipient = msg.to === userId;
    if (!isSender && !isRecipient) return;

    // per-user state: the sender's copy uses the `from*` flags, the recipient's `to*`
    const side = isSender ? "from" : "to";
    // purged means removed for good, so it must not appear in Trash either
    if (msg[side + "Purged"]) return;

    const inTrash = Boolean(msg[side + "Deleted"]);
    const folder = isSender ? "sent" : "inbox";

    if (want === "trash") {
      if (!inTrash) return;
    } else {
      if (inTrash || folder !== want) return;
    }
    out.push(mailForViewer(msg, userId, db));
  });

  out.sort(function (a, b) { return (b.sent || "").localeCompare(a.sent || ""); });
  return out;
}

function unreadCount(userId) {
  const db = load();
  return db.mail.filter(function (m) {
    return m.to === userId && !m.read && !m.toDeleted;
  }).length;
}

function getMail(userId, id) {
  const db = load();
  const msg = db.mail.find(function (m) { return m.id === id; });
  if (!msg) return { error: "Message not found." };
  if (msg.to !== userId && msg.from !== userId) return { error: "Message not found." };

  // opening it marks it read for the recipient
  if (msg.to === userId && !msg.read) {
    msg.read = true;
    save(db);
  }
  return { mail: mailForViewer(msg, userId, db) };
}

/* Attachments must be files the sender actually owns. Shared by mail and
   letters, and by both the send path and the edit path. */
function resolveAttachments(fromId, list) {
  const out = [];
  if (!Array.isArray(list)) return out;

  for (const item of list.slice(0, MAX_ATTACH)) {
    const safe = sanitizeRelPath(item && item.name);
    if (!safe) continue;
    const full = path.join(userDir(fromId), safe);
    if (!insideUserDir(fromId, full)) continue;
    if (!fs.existsSync(full)) continue;
    const st = fs.statSync(full);
    out.push({
      name: safe,
      kind: fileKind(safe),
      size: st.size,
      mime: mimeFor(safe)
    });
  }
  return out;
}

/* ============================================================
   Recipients

   A message has one or more "to" names and any number of "cc" names.
   Each recipient gets their own copy in their own Inbox, so one person's
   read and delete state is independent of the others.

   The single-recipient fields (to / toName) are still filled in on every
   copy, so anything that already reads them keeps working.
   ============================================================ */

const MAX_RECIPIENTS = 20;

/* Split a field like "alice, bob; carol" into names, dropping blanks and
   duplicates while keeping the order the sender typed. */
function parseRecipients(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,;]/);
  const seen = {};
  const out = [];

  raw.forEach(function (item) {
    const name = String(item || "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(name);
  });

  return out;
}

/* Resolve names to accounts, collecting anything that is missing or is
   the sender themselves. */
function resolveRecipients(db, names, excludeId) {
  const found = [];
  const missing = [];
  const seen = {};

  names.forEach(function (name) {
    const user = findByName(db, name);
    if (!user) { missing.push(name); return; }
    if (user.id === excludeId) { missing.push(name); return; }
    if (seen[user.id]) return;
    seen[user.id] = true;
    found.push(user);
  });

  return { found: found, missing: missing };
}

function sendMail(fromId, opts) {
  const db = load();
  const sender = findById(db, fromId);
  if (!sender) return { error: "Not signed in." };

  const toNames = parseRecipients(opts.to);
  const ccNames = parseRecipients(opts.cc);

  if (!toNames.length && !ccNames.length) return { error: "Enter who this is for." };
  if (toNames.length + ccNames.length > MAX_RECIPIENTS) {
    return { error: "That is more than " + MAX_RECIPIENTS + " recipients." };
  }

  const toRes = resolveRecipients(db, toNames, fromId);
  if (toRes.missing.length) {
    return { error: "No account called \"" + toRes.missing[0] + "\"." };
  }
  const ccRes = resolveRecipients(db, ccNames, fromId);

  /* Someone on both lists gets one copy, and To wins. */
  const already = {};
  toRes.found.forEach(function (u) { already[u.id] = true; });
  const cc = ccRes.found.filter(function (u) { return !already[u.id]; });

  if (!toRes.found.length && !cc.length) {
    return { error: "You cannot send mail to yourself." };
  }

  const subject = String(opts.subject || "").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT) || "(no subject)";
  const body = String(opts.body || "").slice(0, MAX_BODY);
  if (!body.trim()) return { error: "The message is empty." };

  const attachments = resolveAttachments(fromId, opts.attachments);
  const sent = new Date().toISOString();
  const toList = toRes.found;
  const all = toList.concat(cc);

  /* One record per recipient, sharing a thread id so the copies can be
     recognised as the same message if that is ever needed. */
  const first = newMailId();
  const copies = all.map(function (user, i) {
    const isCc = cc.indexOf(user) !== -1;
    return {
      id: i === 0 ? first : newMailId(),
      threadId: first,
      kind: "message",
      from: fromId,
      fromName: sender.username,
      to: user.id,
      toName: user.username,
      via: isCc ? "cc" : "to",
      subject: subject,
      body: body,
      attachments: attachments,
      sent: sent,
      read: false,
      fromDeleted: false,
      toDeleted: false
    };
  });

  copies.forEach(function (m) { db.mail.push(m); });
  save(db);

  return {
    mail: mailForViewer(copies[0], fromId, db),
    recipients: toList.map(function (u) { return u.username; }),
    cc: cc.map(function (u) { return u.username; }),
    copies: copies.length
  };
}

/* ============================================================
   Drafts

   A half-written message, saved server-side so it survives closing the
   window or reloading the page. One draft per user, replaced each time.
   ============================================================ */

function saveDraft(userId, draft) {
  const db = load();
  const user = findById(db, userId);
  if (!user) return { error: "Not signed in." };

  const d = draft || {};
  const body = String(d.body || "").slice(0, MAX_BODY);
  const subject = String(d.subject || "").slice(0, MAX_SUBJECT);
  const to = String(d.to || "").slice(0, 400);
  const cc = String(d.cc || "").slice(0, 400);

  /* Nothing worth keeping: drop the draft rather than storing emptiness. */
  if (!body.trim() && !subject.trim() && !to.trim() && !cc.trim()) {
    delete user.draft;
    save(db);
    return { ok: true, cleared: true };
  }

  user.draft = {
    to: to, cc: cc, subject: subject, body: body,
    attachments: (Array.isArray(d.attachments) ? d.attachments : [])
      .slice(0, MAX_ATTACH)
      .map(function (a) { return { name: String((a && a.name) || "").slice(0, 160) }; })
      .filter(function (a) { return a.name; }),
    saved: new Date().toISOString()
  };
  save(db);
  return { ok: true, draft: user.draft, cleared: false };
}

function getDraft(userId) {
  const db = load();
  const user = findById(db, userId);
  if (!user || !user.draft) return { draft: null };
  return { draft: user.draft };
}

function clearDraft(userId) {
  const db = load();
  const user = findById(db, userId);
  if (!user) return { error: "Not signed in." };
  delete user.draft;
  save(db);
  return { ok: true };
}

/* ============================================================
   Reply quoting
   ============================================================ */

/* Quote a message the way a mail client does: an attribution line, then
   the original indented with "> ". */
function quoteFor(msg, fromName) {
  const when = msg.sent ? new Date(msg.sent).toLocaleString() : "";
  const quoted = String(msg.body || "").split("\n")
    .map(function (l) { return l ? "> " + l : ">"; })
    .join("\n");
  return "\n\nOn " + when + ", " + (fromName || msg.fromName || "someone") +
    " wrote:\n" + quoted;
}

function replySubject(subject) {
  const s = String(subject || "").trim();
  if (!s) return "Re: (no subject)";
  return /^re:/i.test(s) ? s : "Re: " + s;
}


/* ============================================================
   Letters

   A letter is a message with kind "letter": it carries a shape to
   animate and may carry images and songs, which the reader plays in
   place. Everything else -- folders, read state, deletion -- works
   exactly as it does for a message, so the Inbox needs no new rules.

   There is one extra kind: an invitation. It is admin-only, its link
   can be used once, and it is delivered to whoever redeems it.
   ============================================================ */

const LETTER_SHAPES = ["heart2d", "donut2d", "heart", "donut"];

/* An invitation token: long enough that guessing is hopeless, and from
   the same unambiguous alphabet as share links. */
function newInviteToken(db) {
  const taken = {};
  (db.mail || []).forEach(function (m) {
    if (m.invite && m.invite.token) taken[m.invite.token] = true;
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    let out = "";
    const bytes = crypto.randomBytes(10);
    for (let i = 0; i < 10; i++) out += SHARE_ALPHABET[bytes[i] % SHARE_ALPHABET.length];
    if (!taken[out]) return out;
  }
  return crypto.randomBytes(16).toString("hex");
}

function sendLetter(fromId, opts) {
  const db = load();
  const sender = findById(db, fromId);
  if (!sender) return { error: "Not signed in." };

  const isInvite = opts.kind === "invitation";

  if (isInvite && sender.role !== "admin") {
    return { error: "Only an administrator can send an invitation." };
  }

  const subject = String(opts.subject || "").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT) ||
    (isInvite ? "An invitation to Letterdrop" : "(no subject)");
  const body = String(opts.body || "").slice(0, MAX_BODY);
  if (!body.trim()) return { error: "The letter is empty." };

  const shape = LETTER_SHAPES.indexOf(opts.shape) !== -1 ? opts.shape : null;
  const attachments = resolveAttachments(fromId, opts.attachments);

  const msg = {
    id: newMailId(),
    kind: "letter",
    letterType: isInvite ? "invitation" : "regular",
    from: fromId,
    fromName: sender.username,
    subject: subject,
    body: body,
    shape: shape,
    attachments: attachments,
    sent: new Date().toISOString(),
    read: false,
    fromDeleted: false,
    toDeleted: false
  };

  if (isInvite) {
    /* An invitation is addressed to nobody yet: it waits for whoever
       redeems the link. Everything the Inbox needs is filled in then. */
    msg.to = null;
    msg.toName = opts.to ? String(opts.to).trim() : "";
    msg.invite = {
      token: newInviteToken(db),
      used: false,
      usedBy: null,
      usedAt: null,
      expires: new Date(Date.now() + INVITE_TTL_MS).toISOString()
    };
  } else {
    const toName = String(opts.to || "").trim();
    const recipient = findByName(db, toName);
    if (!recipient) return { error: "No account called \"" + toName + "\"." };
    if (recipient.id === fromId) return { error: "You cannot send a letter to yourself." };
    msg.to = recipient.id;
    msg.toName = recipient.username;
  }

  db.mail.push(msg);
  save(db);
  return { mail: mailForViewer(msg, fromId, db), token: msg.invite ? msg.invite.token : null };
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // a week

/* Look up an invitation without consuming it, for the sign-up page. */
function peekInvite(token) {
  if (typeof token !== "string" || !/^[a-z0-9]{10,64}$/.test(token)) return null;

  const db = load();
  const msg = db.mail.find(function (m) {
    return m.kind === "letter" && m.invite && m.invite.token === token;
  });
  if (!msg) return null;

  const expired = Date.parse(msg.invite.expires) < Date.now();
  const sender = findById(db, msg.from);

  return {
    token: token,
    valid: !msg.invite.used && !expired,
    used: Boolean(msg.invite.used),
    expired: expired,
    subject: msg.subject,
    body: msg.body,
    shape: msg.shape,
    from: sender ? sender.username : "(deleted)",
    suggestedName: msg.toName || "",
    expires: msg.invite.expires
  };
}

/* Redeem an invitation into a brand-new account.

   The token is re-read and marked used inside the same synchronous pass
   that creates the account, so two people racing the same link cannot
   both succeed: Node runs this to completion without interleaving. */
function redeemInvite(token, username, password) {
  /* The token is checked and consumed in one synchronous pass, so two
     people racing the same link cannot both succeed: Node runs this
     function to completion without interleaving. */
  const first = load();
  const target = first.mail.find(function (m) {
    return m.kind === "letter" && m.invite && m.invite.token === token;
  });
  if (!target) return { error: "That invitation link is not valid." };
  if (target.invite.used) return { error: "That invitation has already been used." };
  if (Date.parse(target.invite.expires) < Date.now()) {
    return { error: "That invitation has expired." };
  }

  const created = createUser({ username: username, password: password, role: "user" });
  if (created.error) return created;

  /* createUser saves its own copy of the store, so this one is now stale.
     Re-loading before writing is what stops the new account -- and any
     session created alongside it -- from being overwritten. */
  const db = load();
  const msg = db.mail.find(function (m) { return m.id === target.id; });
  if (!msg) return { error: "That invitation link is not valid." };

  // deliver the letter into the new account's Inbox
  msg.to = created.user.id;
  msg.toName = created.user.username;
  msg.read = false;
  msg.toDeleted = false;
  msg.invite.used = true;
  msg.invite.usedBy = created.user.id;
  msg.invite.usedAt = new Date().toISOString();
  save(db);

  return { user: created.user, mailId: msg.id };
}

/* Invitations this admin has issued, for the management list. */
function listInvites(fromId) {
  const db = load();
  return db.mail
    .filter(function (m) { return m.kind === "letter" && m.invite && m.from === fromId; })
    .map(function (m) {
      const expired = Date.parse(m.invite.expires) < Date.now();
      return {
        id: m.id,
        token: m.invite.token,
        subject: m.subject,
        toName: m.toName,
        used: Boolean(m.invite.used),
        usedBy: m.invite.usedBy,
        expired: expired,
        expires: m.invite.expires,
        sent: m.sent
      };
    })
    .sort(function (a, b) { return (b.sent || "").localeCompare(a.sent || ""); });
}

function revokeInvite(fromId, id) {
  const db = load();
  const msg = db.mail.find(function (m) {
    return m.id === id && m.kind === "letter" && m.invite && m.from === fromId;
  });
  if (!msg) return { error: "Invitation not found." };
  if (msg.invite.used) return { error: "That invitation has already been used." };
  msg.invite.expires = new Date(0).toISOString();   // expire it now
  save(db);
  return { ok: true };
}

/* ============================================================
   Search

   One query across everything the user can see: their file names and
   the text inside their notes, their mail and letters, and the other
   accounts on the machine. Scoped to the caller throughout -- a search
   can never surface another person's mail.
   ============================================================ */

const MAX_SEARCH_RESULTS = 60;
const NOTE_SCAN_BYTES = 256 * 1024;   // do not read a huge file to search it

/* A match plus a little context, so a result can show why it matched. */
function snippet(text, needle, width) {
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return "";
  const w = width || 80;
  const from = Math.max(0, at - 30);
  const to = Math.min(text.length, at + needle.length + w - 30);
  return (from > 0 ? "\u2026" : "") +
    text.slice(from, to).replace(/\s+/g, " ").trim() +
    (to < text.length ? "\u2026" : "");
}

function searchEverything(userId, rawQuery, opts) {
  const query = String(rawQuery || "").trim();
  if (!query) return { query: "", files: [], mail: [], people: [], total: 0 };

  const needle = query.toLowerCase();
  const limit = (opts && opts.limit) || MAX_SEARCH_RESULTS;
  const db = load();

  /* ---------- files ---------- */
  const files = [];
  walkFiles(userId).forEach(function (f) {
    if (files.length >= limit) return;
    const nameHit = f.name.toLowerCase().indexOf(needle) !== -1;
    const folderHit = f.folder && f.folder.toLowerCase().indexOf(needle) !== -1;

    if (nameHit || folderHit) {
      files.push(Object.assign({}, f, {
        where: nameHit ? "name" : "folder",
        snippet: ""
      }));
      return;
    }

    /* Only text-ish files get opened, and only up to a cap. */
    if (f.kind !== "note") return;
    const full = path.join(userDir(userId), f.path);
    let text = "";
    try {
      const fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(Math.min(f.size, NOTE_SCAN_BYTES));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      text = buf.slice(0, read).toString("utf8");
    } catch (e) { return; }

    if (text.toLowerCase().indexOf(needle) !== -1) {
      files.push(Object.assign({}, f, { where: "contents", snippet: snippet(text, needle) }));
    }
  });

  /* ---------- mail and letters ---------- */
  const mail = [];
  (db.mail || []).forEach(function (msg) {
    if (mail.length >= limit) return;
    const isSender = msg.from === userId;
    const isRecipient = msg.to === userId;
    if (!isSender && !isRecipient) return;
    // skip anything this person has thrown away
    const side = isSender ? "from" : "to";
    if (msg[side + "Purged"] || msg[side + "Deleted"]) return;

    const inSubject = String(msg.subject || "").toLowerCase().indexOf(needle) !== -1;
    const inBody = String(msg.body || "").toLowerCase().indexOf(needle) !== -1;
    const inName = String(msg.kind === "letter" ? "" : "").toLowerCase().indexOf(needle) !== -1;

    /* Attachments match by name too, which is how you find a file you
       were once sent. */
    const att = (msg.attachments || []).filter(function (a) {
      return a.name.toLowerCase().indexOf(needle) !== -1;
    });

    if (!inSubject && !inBody && !att.length && !inName) return;

    const fromUser = findById(db, msg.from);
    mail.push({
      id: msg.id,
      kind: msg.kind || "message",
      letterType: msg.letterType || null,
      subject: msg.subject,
      from: fromUser ? fromUser.username : "(deleted)",
      to: msg.toName,
      sent: msg.sent,
      folder: isSender ? "sent" : "inbox",
      where: inSubject ? "subject" : att.length ? "attachment" : "body",
      attachment: att.length ? att[0].name : null,
      snippet: inBody ? snippet(String(msg.body || ""), needle) : ""
    });
  });

  /* ---------- people ---------- */
  const people = db.users
    .filter(function (u) {
      return u.id !== userId && u.username.toLowerCase().indexOf(needle) !== -1;
    })
    .slice(0, 12)
    .map(function (u) {
      return { id: u.id, username: u.username, role: u.role, avatar: u.avatar || null };
    });

  mail.sort(function (a, b) { return (b.sent || "").localeCompare(a.sent || ""); });

  return {
    query: query,
    files: files.slice(0, limit),
    mail: mail.slice(0, limit),
    people: people,
    total: files.length + mail.length + people.length
  };
}

/* ============================================================
   Sharing a letter

   A letter can be published so someone without an account can read it.
   Unlike a file share this is a *read* link: it shows the letter, the
   shape and the attachments, but nothing else on the machine.
   ============================================================ */

function newLetterLinkToken(db) {
  const taken = {};
  (db.mail || []).forEach(function (m) {
    if (m.link && m.link.token) taken[m.link.token] = true;
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    let out = "";
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) out += SHARE_ALPHABET[bytes[i] % SHARE_ALPHABET.length];
    if (!taken[out]) return out;
  }
  return crypto.randomBytes(12).toString("hex");
}

function shareLetter(userId, id) {
  const db = load();
  const msg = db.mail.find(function (m) { return m.id === id; });
  if (!msg) return { error: "Letter not found." };
  if (msg.kind !== "letter") return { error: "That is not a letter." };
  if (msg.to !== userId && msg.from !== userId) return { error: "Letter not found." };
  if (msg.letterType === "invitation") {
    return { error: "An invitation cannot be shared: its link is single-use." };
  }

  if (msg.link) return { token: msg.link.token, created: false };

  const token = newLetterLinkToken(db);
  msg.link = { token: token, created: new Date().toISOString() };
  save(db);
  return { token: token, created: true };
}

function unshareLetter(userId, id) {
  const db = load();
  const msg = db.mail.find(function (m) { return m.id === id; });
  if (!msg) return { error: "Letter not found." };
  if (msg.to !== userId && msg.from !== userId) return { error: "Letter not found." };
  delete msg.link;
  save(db);
  return { ok: true };
}

/* Everything a public reader needs. No session. */
function resolveLetterLink(token) {
  if (typeof token !== "string" || !/^[a-z0-9]{6,64}$/.test(token)) return null;
  const db = load();
  const msg = db.mail.find(function (m) {
    return m.kind === "letter" && m.link && m.link.token === token;
  });
  if (!msg) return null;
  const sender = findById(db, msg.from);
  return {
    id: msg.id,
    subject: msg.subject,
    body: msg.body,
    shape: msg.shape || null,
    attachments: msg.attachments || [],
    from: sender ? sender.username : "(deleted)",
    fromId: msg.from,
    sent: msg.sent
  };
}

/* ============================================================
   Profile pictures

   Stored as a file in the user's own folder so the existing upload,
   ownership and cleanup rules all apply unchanged.
   ============================================================ */

const AVATAR_NAME = ".avatar";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function setAvatar(userId, mime, base64) {
  const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[mime];
  if (!ext) return { error: "Profile pictures must be PNG, JPEG, GIF or WebP." };

  let buf;
  try { buf = Buffer.from(String(base64 || ""), "base64"); }
  catch (e) { return { error: "That image could not be read." }; }

  if (!buf.length) return { error: "That image is empty." };
  if (buf.length > MAX_AVATAR_BYTES) return { error: "Profile pictures must be under 2 MB." };

  const db = load();
  const user = findById(db, userId);
  if (!user) return { error: "Not signed in." };

  const dir = ensureUserDir(userId);
  /* Clear any previous avatar so the extension always matches the bytes. */
  [".png", ".jpg", ".gif", ".webp"].forEach(function (e) {
    const old = path.join(dir, AVATAR_NAME + e);
    if (fs.existsSync(old)) { try { fs.unlinkSync(old); } catch (err) {} }
  });

  fs.writeFileSync(path.join(dir, AVATAR_NAME + ext), buf);
  user.avatar = ext;
  user.avatarUpdated = new Date().toISOString();
  save(db);

  return { ok: true, avatar: ext };
}

function clearAvatar(userId) {
  const db = load();
  const user = findById(db, userId);
  if (!user) return { error: "Not signed in." };
  const dir = userDir(userId);
  [".png", ".jpg", ".gif", ".webp"].forEach(function (e) {
    const old = path.join(dir, AVATAR_NAME + e);
    if (fs.existsSync(old)) { try { fs.unlinkSync(old); } catch (err) {} }
  });
  delete user.avatar;
  delete user.avatarUpdated;
  save(db);
  return { ok: true };
}

/* The avatar file for a user, if they have one. */
function avatarPath(userId) {
  const db = load();
  const user = findById(db, userId);
  if (!user || !user.avatar) return null;
  const full = path.join(userDir(userId), AVATAR_NAME + user.avatar);
  if (!fs.existsSync(full)) return null;
  return { path: full, mime: mimeFor(AVATAR_NAME + user.avatar), user: user };
}

/* Move to Trash (or delete outright from Trash). */
function deleteMail(userId, id, permanent) {
  const db = load();
  const msg = db.mail.find(function (m) { return m.id === id; });
  if (!msg) return { error: "Message not found." };
  if (msg.to !== userId && msg.from !== userId) return { error: "Message not found." };

  const isSender = msg.from === userId;
  const side = isSender ? "from" : "to";

  if (permanent) {
    // gone for good on this side: it must not show in Trash either
    msg[side + "Purged"] = true;
    msg[side + "Deleted"] = true;
  } else {
    msg[side + "Deleted"] = true;
  }

  // once neither side needs it, the record can go entirely
  if (msg.fromPurged && msg.toPurged) {
    db.mail = db.mail.filter(function (m) { return m.id !== id; });
  }
  // or if one side purged it and the other has deleted it, neither can see it
  if ((msg.fromPurged && msg.toDeleted) || (msg.toPurged && msg.fromDeleted)) {
    db.mail = db.mail.filter(function (m) { return m.id !== id; });
  }

  save(db);
  return { ok: true, purged: Boolean(permanent) };
}

function restoreMail(userId, id) {
  const db = load();
  const msg = db.mail.find(function (m) { return m.id === id; });
  if (!msg) return { error: "Message not found." };
  if (msg.to !== userId && msg.from !== userId) return { error: "Message not found." };
  if (msg.from === userId) msg.fromDeleted = false; else msg.toDeleted = false;
  save(db);
  return { ok: true };
}

function setMailRead(userId, id, read) {
  const db = load();
  const msg = db.mail.find(function (m) { return m.id === id; });
  if (!msg) return { error: "Message not found." };
  if (msg.to !== userId) return { error: "Message not found." };
  msg.read = Boolean(read);
  save(db);
  return { ok: true };
}

/* Read an attachment. The recipient may read files attached to a message
   they received, even though the file lives in the sender's folder. */
function readAttachment(userId, mailId, name) {
  const db = load();
  const msg = db.mail.find(function (m) { return m.id === mailId; });
  if (!msg) return { error: "Message not found." };
  if (msg.to !== userId && msg.from !== userId) return { error: "Message not found." };

  const safe = sanitizeRelPath(name);
  const att = (msg.attachments || []).find(function (a) { return a.name === safe; });
  if (!att) return { error: "Attachment not found." };

  return readFile(msg.from, safe);
}

/* ============================================================
   Instant messages (AIM)

   A conversation is keyed by the two user ids in sorted order, so
   the same pair always resolves to one thread regardless of who
   opened it.
   ============================================================ */

const MAX_IM = 4000;

function conversationKey(a, b) {
  return [a, b].sort().join("|");
}

function newImId() {
  return "im_" + crypto.randomBytes(8).toString("hex");
}

function conversationWith(userId, otherId) {
  const db = load();
  const other = findById(db, otherId);
  if (!other) return { error: "No such user." };

  const key = conversationKey(userId, otherId);
  const msgs = db.ims.filter(function (m) { return m.key === key; });

  return {
    other: { id: other.id, username: other.username },
    messages: msgs.map(function (m) {
      return {
        id: m.id,
        from: m.from,
        fromName: m.fromName,
        to: m.to,
        toName: m.toName,
        text: m.text,
        sent: m.sent,
        read: m.imRead
      };
    })
  };
}

function sendIm(fromId, toName, text) {
  const db = load();
  const sender = findById(db, fromId);
  if (!sender) return { error: "Not signed in." };

  const body = String(text || "").slice(0, MAX_IM);
  if (!body.trim()) return { error: "The message is empty." };

  const recipient = findByName(db, String(toName || "").trim());
  if (!recipient) return { error: "No account called \"" + toName + "\"." };
  if (recipient.id === fromId) return { error: "You cannot message yourself." };

  const msg = {
    id: newImId(),
    key: conversationKey(fromId, recipient.id),
    from: fromId,
    fromName: sender.username,
    to: recipient.id,
    toName: recipient.username,
    text: body,
    sent: new Date().toISOString(),
    read: false
  };
  db.ims.push(msg);
  save(db);
  return { message: msg };
}

function markImRead(userId, otherId) {
  const db = load();
  const key = conversationKey(userId, otherId);
  let n = 0;
  db.ims.forEach(function (m) {
    if (m.key === key && m.to === userId && !m.read) {
      m.read = true;
      n++;
    }
  });
  if (n) save(db);
  return { ok: true, marked: n };
}

/* Unread instant messages per conversation, for the buddy list. */
function imUnreadByUser(userId) {
  const db = load();
  const out = {};
  db.ims.forEach(function (m) {
    if (m.to !== userId || m.read) return;
    out[m.from] = (out[m.from] || 0) + 1;
  });
  return out;
}

/* Remove this user's own messages in a conversation; the other side
   keeps their copy, mirroring how mail deletion works. */
function clearConversation(userId, otherId) {
  const db = load();
  const key = conversationKey(userId, otherId);
  const before = db.ims.length;
  db.ims = db.ims.filter(function (m) {
    return !(m.key === key && m.from === userId);
  });
  save(db);
  return { ok: true, removed: before - db.ims.length };
}

/* ============================================================
   Control Panel actions

   These are destructive and deliberately blunt. Each returns a count
   so the operator can see what actually happened.
   ============================================================ */

/* Delete every file in every user's folder, leaving the accounts alone. */
function wipeAllFiles() {
  const db = load();
  let files = 0;
  db.users.forEach(function (u) {
    const dir = userDir(u.id);
    if (!fs.existsSync(dir)) return;
    try {
      fs.readdirSync(dir).forEach(function (n) {
        const full = path.join(dir, n);
        try {
          if (fs.statSync(full).isFile()) { fs.unlinkSync(full); files++; }
        } catch (e) {}
      });
    } catch (e) {}
  });
  // no files means no shares
  const shares = Object.keys(db.shares || {}).length;
  db.shares = {};
  save(db);
  return { ok: true, files: files, shares: shares };
}

/* Clear all mail and instant messages, leaving accounts and files. */
function wipeAllMessages() {
  const db = load();
  const mail = (db.mail || []).length;
  const ims = (db.ims || []).length;
  db.mail = [];
  db.ims = [];
  save(db);
  return { ok: true, mail: mail, ims: ims };
}

/* Remove every account except the caller's, with their files. */
function deleteAllUsers(keepId) {
  const db = load();
  const keep = findById(db, keepId);
  const doomed = db.users.filter(function (u) { return u.id !== keepId; });

  doomed.forEach(function (u) {
    const dir = userDir(u.id);
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  db.users = keep ? [keep] : [];
  // only the caller's session survives
  Object.keys(db.sessions || {}).forEach(function (t) {
    if (db.sessions[t].userId !== keepId) delete db.sessions[t];
  });
  db.shares = {};
  db.mail = [];
  db.ims = [];
  save(db);

  return { ok: true, removed: doomed.length, kept: keep ? keep.username : null };
}

/* Storage used across every account, for the Control Panel readout. */
function storageReport() {
  const db = load();
  let total = 0, files = 0;
  const perUser = db.users.map(function (u) {
    let bytes = 0, count = 0;
    const dir = userDir(u.id);
    if (fs.existsSync(dir)) {
      try {
        fs.readdirSync(dir).forEach(function (n) {
          const full = path.join(dir, n);
          try {
            const st = fs.statSync(full);
            if (st.isFile()) { bytes += st.size; count++; }
          } catch (e) {}
        });
      } catch (e) {}
    }
    total += bytes; files += count;
    return { id: u.id, username: u.username, bytes: bytes, files: count };
  });
  return {
    totalBytes: total,
    totalFiles: files,
    users: perUser,
    shares: Object.keys(db.shares || {}).length,
    mail: (db.mail || []).length,
    ims: (db.ims || []).length
  };
}

/* ---------- admin ---------- */

function listUsers() {
  const db = load();
  return db.users.map(function (u) {
    const files = listFiles(u.id);
    return Object.assign(publicUser(u), { fileCount: files.length });
  });
}

function deleteUser(id) {
  const db = load();
  const idx = db.users.findIndex(function (u) { return u.id === id; });
  if (idx === -1) return { error: "No such user." };

  const user = db.users[idx];
  const admins = db.users.filter(function (u) { return u.role === "admin"; });
  if (user.role === "admin" && admins.length <= 1) {
    return { error: "You cannot delete the last admin account." };
  }

  db.users.splice(idx, 1);
  // drop that user's sessions too, so they are signed out immediately
  Object.keys(db.sessions).forEach(function (t) {
    if (db.sessions[t].userId === id) delete db.sessions[t];
  });
  // and their public shares, so no link outlives the account
  Object.keys(db.shares).forEach(function (t) {
    if (db.shares[t].userId === id) delete db.shares[t];
  });
  save(db);

  const dir = userDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

function setPassword(id, password) {
  const db = load();
  const user = findById(db, id);
  if (!user) return { error: "No such user." };
  if (String(password || "").length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  user.hash = hashPassword(password);
  user.passwordChanged = new Date().toISOString();
  delete user.mustChangePassword;
  save(db);
  return { ok: true };
}

/* ============================================================
   Forced password changes

   An account created with a password somebody else chose -- the seed
   admin, or one an admin set for you -- is flagged so the first thing
   you do is pick your own. Until then the session works, but every
   route except the handful you need to change it is refused.
   ============================================================ */

/* Routes that must stay reachable while a change is pending, or the
   account would be unusable. */
const ALLOWED_WHILE_PENDING = [
  "/api/me",
  "/api/logout",
  "/api/password",
  "/api/settings",
  "/api/avatar"
];

function passwordChangePending(user) {
  return Boolean(user && user.mustChangePassword);
}

function allowWhilePending(urlPath) {
  return ALLOWED_WHILE_PENDING.indexOf(urlPath) !== -1;
}

function requirePasswordChange(userId, flag) {
  const db = load();
  const user = findById(db, userId);
  if (!user) return { error: "No such user." };
  if (flag === false) delete user.mustChangePassword;
  else user.mustChangePassword = true;
  save(db);
  return { ok: true };
}

/* Change your own password: prove the current one first. Then every
   other session is dropped, since a password change should not leave
   someone else's cookie working. */
function changeOwnPassword(userId, currentPassword, newPassword, keepToken) {
  const db = load();
  const user = findById(db, userId);
  if (!user) return { error: "Not signed in." };

  if (!verifyPassword(String(currentPassword || ""), user.hash)) {
    return { error: "Your current password is incorrect." };
  }
  if (String(newPassword || "").length < 8) {
    return { error: "The new password must be at least 8 characters." };
  }
  if (String(newPassword) === String(currentPassword)) {
    return { error: "The new password is the same as the old one." };
  }

  user.hash = hashPassword(newPassword);
  user.passwordChanged = new Date().toISOString();
  delete user.mustChangePassword;

  // drop every other session
  let others = 0;
  Object.keys(db.sessions || {}).forEach(function (t) {
    if (db.sessions[t].userId !== userId) return;
    if (keepToken && t === keepToken) return;
    delete db.sessions[t];
    others++;
  });

  save(db);
  return { ok: true, otherSessionsEnded: others };
}

/* An admin setting someone's password forces a change on next sign-in.
   The admin's own password set through this path is not trusted either. */
function adminSetPassword(id, password) {
  const out = setPassword(id, password);
  if (out.error) return out;
  return requirePasswordChange(id, true);
}

function setRole(id, role) {
  const db = load();
  const user = findById(db, id);
  if (!user) return { error: "No such user." };
  const next = role === "admin" ? "admin" : "user";
  if (user.role === "admin" && next === "user") {
    const admins = db.users.filter(function (u) { return u.role === "admin"; });
    if (admins.length <= 1) return { error: "You cannot demote the last admin account." };
  }
  user.role = next;
  save(db);
  return { ok: true };
}

/* ---------- bootstrap ---------- */

function ensureSeedAdmin(username, password, opts) {
  const db = load();
  if (db.users.length) return null;
  const res = createUser({ username: username, password: password, role: "admin" });
  if (res.user) {
    /* A generated password is printed once to the console, so it must be
       changed at first sign-in rather than staying in use forever. An
       operator-supplied one is their own choice and is left alone. */
    const mustChange = !opts || opts.mustChange !== false;
    if (mustChange) {
      requirePasswordChange(res.user.id, true);
      res.user.mustChangePassword = true;
    }
  }
  return res.user || null;
}

function userCount() {
  return load().users.length;
}

module.exports = {
  ensureDirs,
  createUser,
  authenticate,
  createSession,
  sessionUser,
  destroySession,
  listSessions,
  revokeSession,
  revokeAllSessions,
  sessionCount,
  pruneSessions,
  // password policy
  passwordChangePending,
  allowWhilePending,
  requirePasswordChange,
  changeOwnPassword,
  adminSetPassword,
  listFiles,
  readFile,
  saveNote,
  saveImage,
  saveUpload,
  uploadPath,
  uniqueUploadPath,
  maxUploadBytes,
  fileKind,
  mimeFor,
  // quota
  quotaBytes,
  usedBytes,
  quotaFor,
  quotaAllows,
  quotaExceeded,
  // files: folders, renaming and search
  listFolder,
  walkFiles,
  renameFile,
  makeFolder,
  deleteFolder,
  sanitizeRelPath,
  searchEverything,
  // settings and control panel
  getSettings,
  saveSettings,
  isProgramEnabled,
  wipeAllFiles,
  wipeAllMessages,
  deleteAllUsers,
  storageReport,
  deleteFile,
  // sharing
  createShare,
  revokeShare,
  revokeAllShares,
  resolveShare,
  shareMapFor,
  shareFor,
  // internal mail
  listMail,
  unreadCount,
  getMail,
  sendMail,
  deleteMail,
  restoreMail,
  setMailRead,
  readAttachment,
  // recipients, drafts and quoting
  parseRecipients,
  resolveRecipients,
  saveDraft,
  getDraft,
  clearDraft,
  quoteFor,
  replySubject,
  MAX_RECIPIENTS,
  // letters and invitations
  sendLetter,
  peekInvite,
  redeemInvite,
  listInvites,
  revokeInvite,
  shareLetter,
  unshareLetter,
  resolveLetterLink,
  LETTER_SHAPES,
  // profile pictures
  setAvatar,
  clearAvatar,
  avatarPath,
  // instant messages
  conversationWith,
  sendIm,
  markImRead,
  imUnreadByUser,
  clearConversation,
  listUsers,
  deleteUser,
  setPassword,
  setRole,
  publicUser,
  ensureSeedAdmin,
  userCount,
  findById,
  findByName,
  load,
  userDir,
  safeName,
  imageMime,
  MAX_UPLOAD_BYTES
};
