/* ============================================================
   Letterdrop — passwords and sessions

   Passwords are hashed with scrypt, which is built into Node and
   is the memory-hard function OWASP recommends for passwords.
   bcrypt needs a third-party native module; scrypt gives the same
   properties (deliberately slow, salted, per-user cost) with no
   dependencies to trust.

   Format: scrypt$N$r$p$<salt-b64>$<hash-b64>
   Storing the parameters means the cost can be raised later
   without invalidating existing passwords.
   ============================================================ */

"use strict";

const crypto = require("crypto");

// Cost parameters. N must be a power of two. N=2^15 with r=8 is roughly
// 32 MB of memory per hash, which is slow enough to matter to an attacker
// and fast enough that a login still feels instant.
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };

const SALT_BYTES = 16;

function hashPassword(password) {
  if (typeof password !== "string" || !password) {
    throw new Error("password required");
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.scryptSync(password, salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p,
    // scrypt needs headroom above the default 32 MB maxmem
    maxmem: 256 * 1024 * 1024
  });
  return [
    "scrypt",
    PARAMS.N, PARAMS.r, PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64")
  ].join("$");
}

/* Constant-time comparison, so a wrong password cannot be discovered
   by measuring how long the check takes. */
function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt, expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch (e) {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  let derived;
  try {
    derived = crypto.scryptSync(password, salt, expected.length, {
      N: N, r: r, p: p, maxmem: 256 * 1024 * 1024
    });
  } catch (e) {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/* ---------- sessions ----------
   An opaque random token, stored server-side, sent as an HttpOnly
   cookie. Nothing about the user is encoded in the token, so it
   cannot be forged by editing a cookie. */

const SESSION_BYTES = 32;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;   // 12 hours

/* A session is renewed on use, so someone working steadily is not thrown
   out mid-sentence, but an idle one still lapses. The absolute cap stops
   a session living forever just because it keeps being touched. */
const SESSION_IDLE_MS = SESSION_TTL_MS;
const SESSION_ABSOLUTE_MS = 1000 * 60 * 60 * 24 * 14;   // 14 days

function newToken() {
  return crypto.randomBytes(SESSION_BYTES).toString("base64url");
}

function tokenExpired(session) {
  if (!session || typeof session.expires !== "number") return true;
  if (session.expires < Date.now()) return true;
  if (session.created && Date.now() - session.created > SESSION_ABSOLUTE_MS) return true;
  return false;
}

/* Should this session's expiry be pushed back? Renewed at most once a
   minute, so a busy page does not rewrite the store on every request. */
const RENEW_AFTER_MS = 60 * 1000;

function shouldRenew(session) {
  if (!session || typeof session.expires !== "number") return false;
  if (session.created && Date.now() - session.created > SESSION_ABSOLUTE_MS) return false;
  return session.expires - Date.now() < SESSION_IDLE_MS - RENEW_AFTER_MS;
}

/* ============================================================
   Sign-in throttling

   Passwords are scrypt-hashed, but nothing stopped unlimited attempts.
   This is a per-account delay with a lockout: the first few failures are
   free, then each one waits longer, and after enough the account is shut
   for a cooling-off period.

   Kept in memory rather than the store: it is per-process and resets on
   restart, which is the right trade for a small server and avoids
   growing the on-disk session file with attack traffic.
   ============================================================ */

const FREE_ATTEMPTS = 3;
const LOCKOUT_AFTER = 6;
const LOCKOUT_MS = 15 * 60 * 1000;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

const attempts = new Map();   // key -> { fails, first, lockedUntil }

function throttleKey(username, ip) {
  return String(username || "").toLowerCase() + "|" + String(ip || "");
}

/* How long this key must wait before another attempt is allowed, in ms.
   Zero means go ahead. */
function throttleDelay(username, ip) {
  const rec = attempts.get(throttleKey(username, ip));
  if (!rec) return 0;

  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return rec.lockedUntil - Date.now();
  }
  if (rec.lockedUntil) {
    // the lockout has passed; start again
    attempts.delete(throttleKey(username, ip));
    return 0;
  }

  if (rec.fails <= FREE_ATTEMPTS) return 0;
  // back off, doubling with each failure beyond the free ones
  const steps = rec.fails - FREE_ATTEMPTS;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, steps - 1));
}

/* Record a failed sign-in and return the new state. */
function recordFailure(username, ip) {
  const key = throttleKey(username, ip);
  const now = Date.now();
  let rec = attempts.get(key);

  if (!rec) { rec = { fails: 0, first: now, lockedUntil: 0 }; attempts.set(key, rec); }
  rec.fails++;
  rec.last = now;

  if (rec.fails >= LOCKOUT_AFTER) {
    rec.lockedUntil = now + LOCKOUT_MS;
    return { locked: true, until: rec.lockedUntil, fails: rec.fails };
  }
  return { locked: false, fails: rec.fails };
}

function clearFailures(username, ip) {
  attempts.delete(throttleKey(username, ip));
}

function lockoutInfo(username, ip) {
  const rec = attempts.get(throttleKey(username, ip));
  if (!rec || !rec.lockedUntil || rec.lockedUntil <= Date.now()) return null;
  return { until: rec.lockedUntil, fails: rec.fails };
}

/* Drop stale records so the map cannot grow without bound. */
function sweepThrottle() {
  const now = Date.now();
  const cutoff = now - Math.max(LOCKOUT_MS, 60 * 60 * 1000);
  attempts.forEach(function (rec, key) {
    const stale = (rec.last || rec.first || 0) < cutoff;
    const unlocked = !rec.lockedUntil || rec.lockedUntil < now;
    if (stale && unlocked) attempts.delete(key);
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  newToken,
  tokenExpired,
  shouldRenew,
  SESSION_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_ABSOLUTE_MS,
  throttleDelay,
  recordFailure,
  clearFailures,
  lockoutInfo,
  sweepThrottle,
  LOCKOUT_MS,
  LOCKOUT_AFTER,
  FREE_ATTEMPTS
};
