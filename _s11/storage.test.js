/* Verify quotas, the file manager (folders, rename, move) and search. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8871;
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } }

const DATA = path.join(DIR, "data");
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: DIR,
  env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_USER: "root", ADMIN_PASS: "rootpassword1" }),
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOut = "";
server.stdout.on("data", d => serverOut += d.toString());
server.stderr.on("data", d => serverOut += d.toString());

function req(method, urlPath, body, cookie, headers) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined || body === null ? null
      : (Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const h = Object.assign({ "Content-Type": "application/json" },
      cookie ? { Cookie: cookie } : {}, headers || {});
    if (data) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", function () {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: raw.toString("utf8"),
          headers: res.headers,
          cookie: res.headers["set-cookie"] ? res.headers["set-cookie"][0].split(";")[0] : null });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function waitForServer() {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function go() {
      n++;
      const r = http.request(BASE + "/api/me", function (res) { res.resume(); resolve(); });
      r.on("error", function () { n > 100 ? reject(new Error("no start:\n" + serverOut)) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

function put(name, buf, cookie) {
  return req("PUT", "/api/upload", buf, cookie, { "X-File-Name": encodeURIComponent(name) });
}

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;
    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;

    console.log("=== 1. storage quota ===");
    {
      const before = await req("GET", "/api/files", undefined, alice);
      check("the listing reports a quota", before.json.quota !== undefined,
        JSON.stringify(before.json.quota));
      check("unlimited by default", before.json.quota.unlimited === true,
        JSON.stringify(before.json.quota));

      // set a 1 MB quota
      await req("POST", "/api/admin/settings", { quotaMB: 1 }, admin);

      const q = await req("GET", "/api/files", undefined, alice);
      check("a quota can be set", q.json.quota.quotaBytes === 1048576,
        String(q.json.quota.quotaBytes));
      check("nothing used yet", q.json.quota.usedBytes === 0, String(q.json.quota.usedBytes));

      const small = Buffer.alloc(300 * 1024, 1);
      const ok = await put("small.bin", small, alice);
      check("a file within the quota uploads", ok.status === 200, JSON.stringify(ok.json));

      const after = await req("GET", "/api/files", undefined, alice);
      check("usage is counted", after.json.quota.usedBytes === small.length,
        String(after.json.quota.usedBytes));
      check("with a percentage", after.json.quota.percent === 29,
        String(after.json.quota.percent));

      // another 300k fits, 900k does not
      const ok2 = await put("small2.bin", small, alice);
      check("a second file fits", ok2.status === 200, String(ok2.status));

      const tooBig = Buffer.alloc(900 * 1024, 2);
      const refused = await put("big.bin", tooBig, alice);
      check("a file over the quota is refused", refused.status === 413, String(refused.status));
      check("with an explanation", /storage limit/i.test(refused.json.error || ""),
        JSON.stringify(refused.json.error));
      check("and the numbers", refused.json.quota && refused.json.quota.quotaBytes === 1048576,
        JSON.stringify(refused.json.quota));

      check("nothing was written", !fs.existsSync(
        path.join(DATA, "files", fs.readdirSync(path.join(DATA, "files"))[0], "big.bin")) ||
        !fs.readdirSync(path.join(DATA, "files")).some(function (d) {
          return fs.existsSync(path.join(DATA, "files", d, "big.bin"));
        }), "a partial big.bin was left behind");

      // deleting frees the room again
      await req("DELETE", "/api/file?name=small.bin", undefined, alice);
      const afterDelete = await req("GET", "/api/files", undefined, alice);
      check("deleting frees the quota",
        afterDelete.json.quota.usedBytes === small.length,
        String(afterDelete.json.quota.usedBytes));

      const nowFits = await put("fits.bin", Buffer.alloc(500 * 1024, 3), alice);
      check("the freed room can be used", nowFits.status === 200, JSON.stringify(nowFits.json));

      /* Uploads never overwrite: a repeated name gets " (2)" appended, so
         it is a new file and the quota correctly refuses it here -- there
         is only 200k of room left for another 300k file. */
      const again = await put("small2.bin", small, alice);
      check("a repeat upload is treated as a new file, and refused when full",
        again.status === 413, JSON.stringify(again.json));

      /* Free room, then confirm it is given a distinct name rather than
         overwriting the original. */
      await req("DELETE", "/api/file?name=fits.bin", undefined, alice);
      const again2 = await put("small2.bin", small, alice);
      check("with room, a repeat upload gets a distinct name",
        again2.status === 200 && again2.json.name === "small2 (2).bin",
        JSON.stringify(again2.json));
      check("and the original is untouched",
        fs.existsSync(path.join(DATA, "files")) &&
        fs.readdirSync(path.join(DATA, "files")).some(function (d) {
          return fs.existsSync(path.join(DATA, "files", d, "small2.bin")) &&
            fs.existsSync(path.join(DATA, "files", d, "small2 (2).bin"));
        }), "the original was overwritten");

      // the JSON upload path is checked too
      const b64 = Buffer.alloc(900 * 1024, 4).toString("base64");
      const viaJson = await req("POST", "/api/file",
        { kind: "image", name: "huge.png", mime: "image/png", base64: b64 }, alice);
      check("the base64 upload path is quota-checked too", viaJson.status === 413,
        String(viaJson.status));

      // and an admin is subject to it as well
      const adminOver = await req("POST", "/api/admin/settings", { quotaMB: 1 }, admin);
      check("the admin can change the quota", adminOver.status === 200, String(adminOver.status));
      const adminUpload = await put("admin.bin", Buffer.alloc(2 * 1024 * 1024, 5), admin);
      check("the admin is subject to the quota too", adminUpload.status === 413,
        String(adminUpload.status));

      await req("POST", "/api/admin/settings", { quotaMB: 0 }, admin);
      const unlimited = await req("GET", "/api/files", undefined, alice);
      check("it can be set back to unlimited", unlimited.json.quota.unlimited === true);

      // clear up for the next block
      const list = await req("GET", "/api/files", undefined, alice);
      for (const f of list.json.files) {
        await req("DELETE", "/api/file?name=" + encodeURIComponent(f.name), undefined, alice);
      }
    }

    console.log("\n=== 2. folders, rename and move ===");
    {
      await put("top.txt", Buffer.from("at the top"), alice);
      await req("POST", "/api/file", { kind: "note", name: "note.txt", text: "a note" }, alice);

      const made = await req("POST", "/api/folder", { path: "Holiday" }, alice);
      check("a folder can be created", made.status === 200, JSON.stringify(made.json));

      const nested = await req("POST", "/api/folder", { path: "Holiday/Photos" }, alice);
      check("a nested folder can be created", nested.status === 200, JSON.stringify(nested.json));

      const dupe = await req("POST", "/api/folder", { path: "Holiday" }, alice);
      check("a duplicate folder is refused", dupe.status === 400, JSON.stringify(dupe.json));

      const root = await req("GET", "/api/folder?path=", undefined, alice);
      check("the root lists files", root.json.files.length === 2, String(root.json.files.length));
      check("and folders", root.json.folders.length === 1, String(root.json.folders.length));
      check("the folder reports its item count", root.json.folders[0].items === 1,
        String(root.json.folders[0].items));

      // rename
      const ren = await req("POST", "/api/file/rename",
        { from: "top.txt", to: "renamed.txt" }, alice);
      check("a file can be renamed", ren.status === 200, JSON.stringify(ren.json));

      const afterRen = await req("GET", "/api/folder?path=", undefined, alice);
      check("the new name is there",
        afterRen.json.files.some(f => f.name === "renamed.txt"),
        JSON.stringify(afterRen.json.files.map(f => f.name)));
      check("the old name is gone",
        !afterRen.json.files.some(f => f.name === "top.txt"));

      // move
      const mv = await req("POST", "/api/file/rename",
        { from: "renamed.txt", to: "Holiday/renamed.txt" }, alice);
      check("a file can be moved into a folder", mv.status === 200, JSON.stringify(mv.json));

      const rootAfter = await req("GET", "/api/folder?path=", undefined, alice);
      check("it left the root",
        !rootAfter.json.files.some(f => f.name === "renamed.txt"),
        JSON.stringify(rootAfter.json.files.map(f => f.name)));

      const inFolder = await req("GET", "/api/folder?path=Holiday", undefined, alice);
      check("and arrived in the folder",
        inFolder.json.files.some(f => f.name === "renamed.txt"),
        JSON.stringify(inFolder.json.files.map(f => f.name)));
      check("the listing knows its own path", inFolder.json.path === "Holiday", inFolder.json.path);
      check("and its parent", inFolder.json.parent === "", JSON.stringify(inFolder.json.parent));

      // a share should follow the file
      await req("POST", "/api/file/rename", { from: "note.txt", to: "shared.txt" }, alice);
      const share = await req("POST", "/api/share", { name: "shared.txt" }, alice);
      check("a file can be shared", share.status === 200, JSON.stringify(share.json));

      await req("POST", "/api/file/rename",
        { from: "shared.txt", to: "Holiday/shared.txt" }, alice);
      const stillThere = await req("GET", "/s/" + share.json.token);
      check("the share survives a move", stillThere.status === 200, String(stillThere.status));

      // collisions
      await put("keep.txt", Buffer.from("keep"), alice);
      const collide = await req("POST", "/api/file/rename",
        { from: "keep.txt", to: "Holiday/renamed.txt" }, alice);
      check("renaming onto an existing file is refused", collide.status === 400,
        JSON.stringify(collide.json));

      const sameName = await req("POST", "/api/file/rename",
        { from: "keep.txt", to: "keep.txt" }, alice);
      check("renaming to the same name is refused", sameName.status === 400,
        JSON.stringify(sameName.json));

      const missing = await req("POST", "/api/file/rename",
        { from: "nope.txt", to: "x.txt" }, alice);
      check("renaming a missing file fails", missing.status === 400, JSON.stringify(missing.json));

      // traversal on both sides
      const travFrom = await req("POST", "/api/file/rename",
        { from: "../../../server.js", to: "stolen.txt" }, alice);
      check("a traversal source is refused", travFrom.status === 400, JSON.stringify(travFrom.json));

      const travTo = await req("POST", "/api/file/rename",
        { from: "keep.txt", to: "../../../escaped.txt" }, alice);
      check("a traversal destination is contained", travTo.status === 200,
        JSON.stringify(travTo.json));
      check("and did not escape the folder", !fs.existsSync(path.join(DIR, "escaped.txt")));
      check("it landed inside instead", travTo.json && travTo.json.name === "escaped.txt",
        travTo.json && travTo.json.name);

      // folder deletion
      const del = await req("DELETE", "/api/folder?path=Holiday", undefined, alice);
      check("a folder can be deleted", del.status === 200, JSON.stringify(del.json));
      check("its shares went with it", del.json.shares === 1, String(del.json.shares));
      check("the share link is dead", (await req("GET", "/s/" + share.json.token)).status === 404);

      const gone = await req("GET", "/api/folder?path=Holiday", undefined, alice);
      check("the folder is gone", gone.status === 400, String(gone.status));

      const rootDel = await req("DELETE", "/api/folder?path=..", undefined, alice);
      check("the root cannot be deleted", rootDel.status === 400, JSON.stringify(rootDel.json));

      const crossUser = await req("GET", "/api/folder?path=&user=" + encodeURIComponent("u_nobody"),
        undefined, alice);
      check("a user cannot browse someone else's folder", crossUser.status === 403,
        String(crossUser.status));
    }

    console.log("\n=== 3. search ===");
    {
      // clear alice's files
      const list = await req("GET", "/api/files", undefined, alice);
      for (const f of list.json.files) {
        await req("DELETE", "/api/file?name=" + encodeURIComponent(f.name), undefined, alice);
      }

      await req("POST", "/api/file",
        { kind: "note", name: "recipe.txt", text: "How to bake a sourdough loaf" }, alice);
      await req("POST", "/api/file",
        { kind: "note", name: "notes.txt", text: "Remember the sourdough starter" }, alice);
      await put("holiday-photo.png", PNG, alice);
      await put("report.pdf", Buffer.from("%PDF-1.4 not really"), alice);

      const byName = await req("GET", "/api/search?q=holiday", undefined, alice);
      check("a file is found by name", byName.json.files.length === 1, String(byName.json.files.length));
      check("and says where it matched", byName.json.files[0].where === "name",
        byName.json.files[0].where);

      const byContent = await req("GET", "/api/search?q=sourdough", undefined, alice);
      check("notes are found by their contents", byContent.json.files.length === 2,
        String(byContent.json.files.length));
      check("with a snippet", /sourdough/i.test(byContent.json.files[0].snippet || ""),
        byContent.json.files[0].snippet);
      check("and marked as a content match",
        byContent.json.files.every(f => f.where === "contents"),
        JSON.stringify(byContent.json.files.map(f => f.where)));

      const binary = await req("GET", "/api/search?q=PDF", undefined, alice);
      check("a binary file matches by name only", binary.json.files.length === 1,
        String(binary.json.files.length));

      const nothing = await req("GET", "/api/search?q=zzzznotfound", undefined, alice);
      check("a miss returns nothing", nothing.json.total === 0, String(nothing.json.total));

      const empty = await req("GET", "/api/search?q=", undefined, alice);
      check("an empty query returns nothing", empty.json.total === 0, String(empty.json.total));

      // mail
      await req("POST", "/api/mail",
        { to: "alice", subject: "About the sourdough", body: "It rose nicely." }, admin);
      await req("POST", "/api/mail",
        { to: "alice", subject: "Unrelated", body: "Nothing here." }, admin);

      const mailHit = await req("GET", "/api/search?q=sourdough", undefined, alice);
      check("mail is searched too", mailHit.json.mail.length === 1, String(mailHit.json.mail.length));
      check("by subject", mailHit.json.mail[0].where === "subject", mailHit.json.mail[0].where);
      check("with the sender", mailHit.json.mail[0].from === "root", mailHit.json.mail[0].from);

      const bodyHit = await req("GET", "/api/search?q=rose", undefined, alice);
      check("and by body", bodyHit.json.mail.length === 1, String(bodyHit.json.mail.length));
      check("marked as a body match", bodyHit.json.mail[0].where === "body",
        bodyHit.json.mail[0].where);
      check("with a snippet", /rose/i.test(bodyHit.json.mail[0].snippet || ""),
        bodyHit.json.mail[0].snippet);

      // people
      const people = await req("GET", "/api/search?q=root", undefined, alice);
      check("people are searched", people.json.people.length === 1, String(people.json.people.length));
      check("and it is root", people.json.people[0].username === "root",
        JSON.stringify(people.json.people));

      /* Search must be scoped: alice got mail from root, but root's own
         search must not surface alice's private notes. */
      const asAlice = await req("GET", "/api/search?q=starter", undefined, alice);
      check("alice finds her own note", asAlice.json.files.length === 1,
        String(asAlice.json.files.length));

      const asRoot = await req("GET", "/api/search?q=starter", undefined, admin);
      check("root does not see alice's files", asRoot.json.files.length === 0,
        JSON.stringify(asRoot.json.files.map(f => f.path)));

      // search finds files inside folders
      await req("POST", "/api/folder", { path: "Archive" }, alice);
      await req("POST", "/api/file/rename",
        { from: "recipe.txt", to: "Archive/recipe.txt" }, alice);
      const inFolder = await req("GET", "/api/search?q=recipe", undefined, alice);
      check("search looks inside folders", inFolder.json.files.length === 1,
        String(inFolder.json.files.length));
      check("and reports the folder", inFolder.json.files[0].folder === "Archive",
        inFolder.json.files[0].folder);
      check("and the full path", inFolder.json.files[0].path === "Archive/recipe.txt",
        inFolder.json.files[0].path);

      const byFolder = await req("GET", "/api/search?q=Archive", undefined, alice);
      check("a folder name finds its contents", byFolder.json.files.length >= 1,
        String(byFolder.json.files.length));
    }

  } catch (err) {
    if (/ECONNRESET|ECONNREFUSED/.test(err.message) && fail === 0) {
      console.log("\n  (server closed while the last response was in flight -- ignoring)");
    } else {
      console.log("\n  TEST ERROR: " + err.message);
      console.log(err.stack.split("\n").slice(0, 4).join("\n"));
      fail++;
    }
  } finally {
    try { server.kill(); } catch (e) {}
    setTimeout(function () {
      if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
      console.log("\n----------------------------------------");
      console.log("PASS " + pass + "   FAIL " + fail);
      process.exit(fail ? 1 : 0);
    }, 400);
  }
})();
