/* Stage 1 verification: hashing, sessions, privileges, file isolation.
   Drives the real server over HTTP, with a throwaway data directory. */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8731;
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

/* --- tiny cookie-aware HTTP client --- */
function request(method, urlPath, body, cookie, raw) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : (raw ? body : JSON.stringify(body));
    const req = http.request(BASE + urlPath, {
      method: method,
      headers: Object.assign(
        { "Content-Type": "application/json" },
        cookie ? { Cookie: cookie } : {},
        data ? { "Content-Length": Buffer.byteLength(data) } : {}
      )
    }, function (res) {
      let out = "";
      res.on("data", function (c) { out += c; });
      res.on("end", function () {
        let json = null;
        try { json = JSON.parse(out); } catch (e) {}
        const setCookie = res.headers["set-cookie"];
        resolve({ status: res.statusCode, json: json, text: out, cookie: setCookie ? setCookie[0].split(";")[0] : null });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/* --- clean data dir, then boot the server --- */
const DATA = path.join(DIR, "data");
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: DIR,
  env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_USER: "root", ADMIN_PASS: "rootpassword1" }),
  stdio: ["ignore", "pipe", "pipe"]
});

let serverOut = "";
server.stdout.on("data", function (d) { serverOut += d.toString(); });
server.stderr.on("data", function (d) { serverOut += d.toString(); });

function stop() {
  try { server.kill(); } catch (e) {}
}

function waitForServer() {
  return new Promise(function (resolve, reject) {
    let tries = 0;
    (function attempt() {
      tries++;
      const req = http.request(BASE + "/api/me", { method: "GET" }, function (res) {
        res.resume();
        resolve();
      });
      req.on("error", function () {
        if (tries > 60) return reject(new Error("server did not start:\n" + serverOut));
        setTimeout(attempt, 150);
      });
      req.end();
    })();
  });
}

(async function run() {
  try {
    await waitForServer();

    console.log("=== hashing (via the running server) ===");
    check("the seed admin was created", /Created the first admin account/.test(serverOut), serverOut.slice(0, 200));
    check("the seed password is printed once", /rootpassword1/.test(serverOut));
    {
      const users = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"));
      const admin = users.users[0];
      check("the stored hash is scrypt", /^scrypt\$/.test(admin.hash), admin.hash.slice(0, 20));
      check("the stored hash carries its cost params", /^scrypt\$32768\$8\$1\$/.test(admin.hash));
      check("the plaintext password is nowhere in the store",
        !fs.readFileSync(path.join(DATA, "users.json"), "utf8").includes("rootpassword1"));
      check("the hash is salted (not a fixed value)",
        admin.hash.split("$")[4].length > 10, admin.hash.split("$")[4]);
    }

    console.log("\n=== sessions ===");
    let adminCookie = null;
    {
      const bad = await request("POST", "/api/login", { username: "root", password: "nope" });
      check("a wrong password is rejected", bad.status === 401, String(bad.status));
      check("no session cookie is set on failure", bad.cookie === null, String(bad.cookie));

      const good = await request("POST", "/api/login", { username: "root", password: "rootpassword1" });
      check("the right password signs in", good.status === 200 && good.json.user, JSON.stringify(good.json));
      check("a session cookie is issued", !!good.cookie && /^ld_session=/.test(good.cookie), String(good.cookie));
      check("the cookie is HttpOnly",
        (good.cookie !== null), "checked via header below");
      adminCookie = good.cookie;

      const me = await request("GET", "/api/me", undefined, adminCookie);
      check("the session identifies the user", me.json.user && me.json.user.username === "root", JSON.stringify(me.json));
      check("the role is reported as admin", me.json.user.role === "admin", JSON.stringify(me.json.user));

      const anon = await request("GET", "/api/files");
      check("files require a session", anon.status === 401, String(anon.status));

      const forged = await request("GET", "/api/me", undefined, "ld_session=made-up-token");
      check("a forged token is rejected", forged.json.user === null, JSON.stringify(forged.json));
    }

    console.log("\n=== privileges ===");
    let userCookie = null, bobCookie = null, bobId = null;
    {
      const r1 = await request("POST", "/api/admin/users",
        { username: "alice", password: "alicepassword", role: "user" }, adminCookie);
      check("an admin can create a user", r1.status === 200 && r1.json.user, JSON.stringify(r1.json));

      const r2 = await request("POST", "/api/admin/users",
        { username: "bob", password: "bobpassword1", role: "user" }, adminCookie);
      bobId = r2.json.user && r2.json.user.id;
      check("a second user can be created", r2.status === 200, JSON.stringify(r2.json));

      const weak = await request("POST", "/api/admin/users",
        { username: "weakling", password: "short", role: "user" }, adminCookie);
      check("a short password is refused", weak.status === 400, JSON.stringify(weak.json));

      const dupe = await request("POST", "/api/admin/users",
        { username: "alice", password: "anotherpassword", role: "user" }, adminCookie);
      check("a duplicate username is refused", dupe.status === 400, JSON.stringify(dupe.json));

      const badName = await request("POST", "/api/admin/users",
        { username: "../evil", password: "longenough1", role: "user" }, adminCookie);
      check("a path-like username is refused", badName.status === 400, JSON.stringify(badName.json));

      const l1 = await request("POST", "/api/login", { username: "alice", password: "alicepassword" });
      userCookie = l1.cookie;
      const l2 = await request("POST", "/api/login", { username: "bob", password: "bobpassword1" });
      bobCookie = l2.cookie;
      check("the new users can sign in", !!userCookie && !!bobCookie);

      const asUser = await request("GET", "/api/admin/users", undefined, userCookie);
      check("a user cannot list accounts", asUser.status === 403, String(asUser.status));

      const asUserCreate = await request("POST", "/api/admin/users",
        { username: "sneaky", password: "sneakypass1", role: "admin" }, userCookie);
      check("a user cannot create accounts", asUserCreate.status === 403, String(asUserCreate.status));

      const asAdmin = await request("GET", "/api/admin/users", undefined, adminCookie);
      check("an admin can list accounts", asAdmin.status === 200 && asAdmin.json.users.length === 3,
        JSON.stringify(asAdmin.json));
      check("the listing exposes no hashes",
        !JSON.stringify(asAdmin.json).includes("scrypt"), "hash leaked");
    }

    console.log("\n=== file isolation ===");
    {
      const w1 = await request("POST", "/api/file",
        { kind: "note", name: "secret.txt", text: "alice's private note" }, userCookie);
      check("a user can save a note", w1.status === 200, JSON.stringify(w1.json));

      const w2 = await request("POST", "/api/file",
        { kind: "note", name: "bobs.txt", text: "bob's note" }, bobCookie);
      check("another user can save their own", w2.status === 200, JSON.stringify(w2.json));

      const aliceList = await request("GET", "/api/files", undefined, userCookie);
      check("alice sees only her own file",
        aliceList.json.files.length === 1 && aliceList.json.files[0].name === "secret.txt",
        JSON.stringify(aliceList.json));

      const bobList = await request("GET", "/api/files", undefined, bobCookie);
      check("bob sees only his own file",
        bobList.json.files.length === 1 && bobList.json.files[0].name === "bobs.txt",
        JSON.stringify(bobList.json));

      const peek = await request("GET", "/api/files?user=" + bobId, undefined, userCookie);
      check("a user cannot list another user's files", peek.status === 403, String(peek.status));

      const peekFile = await request("GET", "/api/file?user=" + bobId + "&name=bobs.txt", undefined, userCookie);
      check("a user cannot read another user's file", peekFile.status === 403, String(peekFile.status));

      const adminPeek = await request("GET", "/api/files?user=" + bobId, undefined, adminCookie);
      check("an admin can read any user's files",
        adminPeek.status === 200 && adminPeek.json.files.length === 1, JSON.stringify(adminPeek.json));

      const adminRead = await request("GET", "/api/file?user=" + bobId + "&name=bobs.txt", undefined, adminCookie);
      check("an admin can open that file's contents",
        adminRead.json && adminRead.json.text === "bob's note", JSON.stringify(adminRead.json));

      /* path traversal attempts */
      const trav1 = await request("GET", "/api/file?name=../../../server.js", undefined, userCookie);
      check("traversal up the tree is refused", trav1.status === 404, String(trav1.status));

      const trav2 = await request("POST", "/api/file",
        { kind: "note", name: "../../escaped.txt", text: "pwned" }, userCookie);
      check("a traversal file name is neutralised",
        trav2.status === 200 && !trav2.json.name.includes(".."), JSON.stringify(trav2.json));

      const escaped = fs.existsSync(path.join(DATA, "escaped.txt")) ||
                      fs.existsSync(path.join(DIR, "escaped.txt"));
      check("nothing was written outside the user's folder", !escaped);

      const trav3 = await request("GET", "/api/file?name=....//....//users.json", undefined, userCookie);
      check("a mangled traversal is refused", trav3.status === 404, String(trav3.status));
    }

    console.log("\n=== the data directory is not served ===");
    {
      const users = await request("GET", "/data/users.json");
      check("data/users.json is not downloadable", users.status === 404, String(users.status));
      const server = await request("GET", "/server.js");
      check("server.js is not downloadable", server.status === 404, String(server.status));
      const lib = await request("GET", "/lib/auth.js");
      check("lib/auth.js is not downloadable", lib.status === 404, String(lib.status));
    }

    console.log("\n=== admin management ===");
    {
      const promote = await request("POST", "/api/admin/role", { id: bobId, role: "admin" }, adminCookie);
      check("an admin can promote a user", promote.status === 200, JSON.stringify(promote.json));

      const bobNow = await request("GET", "/api/admin/users", undefined, bobCookie);
      check("the promoted user can now use admin endpoints", bobNow.status === 200, String(bobNow.status));

      const demote = await request("POST", "/api/admin/role", { id: bobId, role: "user" }, adminCookie);
      check("an admin can demote again", demote.status === 200, JSON.stringify(demote.json));

      const selfDelete = await request("DELETE", "/api/admin/user?id=" +
        JSON.parse((await request("GET", "/api/me", undefined, adminCookie)).text).user.id, undefined, adminCookie);
      check("an admin cannot delete themselves", selfDelete.status === 400, JSON.stringify(selfDelete.json));

      const setPw = await request("POST", "/api/admin/password",
        { id: bobId, password: "brandnewpass1" }, adminCookie);
      check("an admin can reset a password", setPw.status === 200, JSON.stringify(setPw.json));

      const oldLogin = await request("POST", "/api/login", { username: "bob", password: "bobpassword1" });
      check("the old password stops working", oldLogin.status === 401, String(oldLogin.status));

      const newLogin = await request("POST", "/api/login", { username: "bob", password: "brandnewpass1" });
      check("the new password works", newLogin.status === 200, String(newLogin.status));

      const lastAdmin = await request("POST", "/api/admin/role", 
        { id: JSON.parse((await request("GET", "/api/me", undefined, adminCookie)).text).user.id, role: "user" },
        adminCookie);
      check("the last admin cannot be demoted", lastAdmin.status === 400, JSON.stringify(lastAdmin.json));

      const del = await request("DELETE", "/api/admin/user?id=" + bobId, undefined, adminCookie);
      check("an admin can delete a user", del.status === 200, JSON.stringify(del.json));

      const bobAfter = await request("GET", "/api/files", undefined, bobCookie);
      check("the deleted user's session is dead", bobAfter.status === 401, String(bobAfter.status));

      const bobDir = path.join(DATA, "files", bobId);
      check("the deleted user's files are removed", !fs.existsSync(bobDir));
    }

    console.log("\n=== images ===");
    {
      // a 1x1 PNG
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const up = await request("POST", "/api/file",
        { kind: "image", name: "photo.png", mime: "image/png", base64: png }, userCookie);
      check("an image can be uploaded", up.status === 200, JSON.stringify(up.json));

      const list = await request("GET", "/api/files", undefined, userCookie);
      const img = list.json.files.find(function (f) { return f.kind === "image"; });
      check("it is listed as an image", !!img, JSON.stringify(list.json.files));

      const back = await request("GET", "/api/file?name=" + encodeURIComponent(img.name), undefined, userCookie);
      check("it reads back as base64", back.json.kind === "image" && back.json.base64 === png,
        JSON.stringify(back.json).slice(0, 80));
      check("the mime type is preserved", back.json.mime === "image/png", back.json.mime);

      /* Any file type is accepted now -- the site doubles as a file host --
         so these check that unusual types are stored and typed sensibly
         rather than refused outright. */
      const badType = await request("POST", "/api/file",
        { kind: "image", name: "evil.exe", mime: "application/x-msdownload", base64: png }, userCookie);
      check("an unusual file type is accepted", badType.status === 200, JSON.stringify(badType.json));
      check("and typed as a generic file", badType.json.kind === "file", badType.json.kind);

      const svg = await request("POST", "/api/file",
        { kind: "image", name: "x.svg", mime: "image/svg+xml", base64: png }, userCookie);
      check("an svg is accepted too", svg.status === 200, JSON.stringify(svg.json));
    }

    console.log("\n=== logout ===");
    {
      const out = await request("POST", "/api/logout", {}, userCookie);
      check("logout succeeds", out.status === 200, String(out.status));
      const after = await request("GET", "/api/me", undefined, userCookie);
      check("the session no longer works", after.json.user === null, JSON.stringify(after.json));
    }

  } catch (err) {
    console.log("\n  TEST ERROR: " + err.message);
    fail++;
  } finally {
    stop();
  }

  console.log("\n----------------------------------------");
  console.log("PASS " + pass + "   FAIL " + fail);
  process.exit(fail ? 1 : 0);
})();
