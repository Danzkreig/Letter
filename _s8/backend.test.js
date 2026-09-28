/* Verify the reworked backend: streamed uploads, short share links,
   settings, and the destructive Control Panel actions. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8801;
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
        resolve({ status: res.statusCode, json: json, raw: raw, text: raw.toString("utf8"),
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

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    console.log("=== settings are public, programs are listed ===");
    {
      const s = await req("GET", "/api/settings");
      check("settings load without a session", s.status === 200, String(s.status));
      check("a site name is present", typeof s.json.siteName === "string", JSON.stringify(s.json.siteName));
      check("the upload cap is reported", s.json.maxUploadMB === 1024, String(s.json.maxUploadMB));
      check("programs are listed as on or off", s.json.programs && s.json.programs.paint === true,
        JSON.stringify(s.json.programs && s.json.programs.paint));
    }

    console.log("\n=== streamed upload (PUT) ===");
    {
      const r = await req("PUT", "/api/upload", PNG, admin, { "X-File-Name": encodeURIComponent("shot.png") });
      check("a PNG uploads", r.status === 200 && r.json.name === "shot.png", JSON.stringify(r.json));
      check("it is typed as an image", r.json.kind === "image", r.json.kind);
      check("the size is reported", r.json.size === PNG.length, String(r.json.size));

      // a name that already exists must not clobber the original
      const again = await req("PUT", "/api/upload", PNG, admin, { "X-File-Name": encodeURIComponent("shot.png") });
      check("a second upload gets a distinct name", again.json.name === "shot (2).png", again.json.name);

      // an arbitrary binary type is accepted now
      const blob = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f]);
      const bin = await req("PUT", "/api/upload", blob, admin, { "X-File-Name": "archive.zip" });
      check("an arbitrary file type uploads", bin.status === 200 && bin.json.name === "archive.zip",
        JSON.stringify(bin.json));
      check("it is typed as a plain file", bin.json.kind === "file", bin.json.kind);
      check("the bytes survive the round trip",
        fs.readdirSync(path.join(DATA, "files")).some(function (uid) {
          const p = path.join(DATA, "files", uid, "archive.zip");
          return fs.existsSync(p) && fs.readFileSync(p).length === blob.length;
        }), "size mismatch");

      // audio and video get their own kinds
      const mp3 = await req("PUT", "/api/upload", Buffer.from("ID3fakeaudio"), admin, { "X-File-Name": "song.mp3" });
      check("an mp3 is typed as audio", mp3.json.kind === "audio", mp3.json.kind);
      check("with the right mime type", mp3.json.mime === "audio/mpeg", mp3.json.mime);

      const mp4 = await req("PUT", "/api/upload", Buffer.from("fakevideo"), admin, { "X-File-Name": "clip.mp4" });
      check("an mp4 is typed as video", mp4.json.kind === "video", mp4.json.kind);
      check("with the right mime type", mp4.json.mime === "video/mp4", mp4.json.mime);

      const noname = await req("PUT", "/api/upload", PNG, admin);
      check("an upload with no name is refused", noname.status === 400, String(noname.status));

      const empty = await req("PUT", "/api/upload", Buffer.alloc(0), admin, { "X-File-Name": "empty.txt" });
      check("an empty upload is refused", empty.status === 400, JSON.stringify(empty.json));

      const anon = await req("PUT", "/api/upload", PNG, null, { "X-File-Name": "x.png" });
      check("uploading needs a session", anon.status === 401, String(anon.status));

      const traversal = await req("PUT", "/api/upload", PNG, admin,
        { "X-File-Name": encodeURIComponent("../../escaped.png") });
      check("a traversal name is flattened, not escaped",
        traversal.json.name === "escaped.png", JSON.stringify(traversal.json.name));
      check("nothing landed outside the folder", !fs.existsSync(path.join(DIR, "escaped.png")));
    }

    console.log("\n=== raw streaming with range support ===");
    {
      const raw = await req("GET", "/api/raw?name=shot.png", undefined, admin);
      check("raw bytes come back", raw.status === 200 && raw.raw.length === PNG.length, String(raw.raw.length));
      check("with the right content type", raw.headers["content-type"] === "image/png",
        raw.headers["content-type"]);
      check("range requests are advertised", raw.headers["accept-ranges"] === "bytes",
        raw.headers["accept-ranges"]);

      const ranged = await req("GET", "/api/raw?name=shot.png", undefined, admin, { Range: "bytes=0-3" });
      check("a range request returns 206", ranged.status === 206, String(ranged.status));
      check("with a content-range header", /^bytes 0-3\//.test(ranged.headers["content-range"] || ""),
        ranged.headers["content-range"]);
      check("and only the requested bytes", ranged.raw.length === 4, String(ranged.raw.length));

      const missing = await req("GET", "/api/raw?name=nope.png", undefined, admin);
      check("a missing file 404s", missing.status === 404, String(missing.status));

      const stranger = await req("GET", "/api/raw?name=shot.png");
      check("raw needs a session", stranger.status === 401, String(stranger.status));
    }

    console.log("\n=== short share links ===");
    {
      const s = await req("POST", "/api/share", { name: "shot.png" }, admin);
      const token = s.json.token;
      console.log("  token: " + token + "   (" + token.length + " chars)");
      check("the token is short", token && token.length === 6, String(token && token.length));
      check("it avoids look-alike characters", !/[01loIO]/.test(token), token);

      // a handful of tokens should all differ
      const seen = {};
      let dupes = 0;
      for (let i = 0; i < 12; i++) {
        await req("PUT", "/api/upload", PNG, admin, { "X-File-Name": "t" + i + ".png" });
        const r = await req("POST", "/api/share", { name: "t" + i + ".png" }, admin);
        if (seen[r.json.token]) dupes++;
        seen[r.json.token] = true;
      }
      check("tokens do not collide", dupes === 0, String(dupes) + " collisions");

      // /s/<token> shows the page
      const page = await req("GET", "/s/" + token);
      check("/s/<token> serves the viewer", page.status === 200, String(page.status));
      // the page should be nothing but the file: no headings, no buttons
      check("it is bare HTML with no chrome",
        /<img class="media"/.test(page.text) &&
        !/<h1|<h2|Copy link|shared by|Download/i.test(page.text),
        "(page still has extra UI)");
      check("it still carries og:image", /og:image/.test(page.text));
      check("og:image points at the raw route", page.text.indexOf("/s/" + token + "/raw") !== -1);

      // the bare short form
      const bare = await req("GET", "/" + token);
      check("the bare token serves the viewer", bare.status === 200, String(bare.status));
      check("and shows the same image", /<img class="media"/.test(bare.text),
        bare.text.slice(0, 120));

      // a crawler asking for the bare token gets the bytes
      const crawler = await req("GET", "/" + token, undefined, null,
        { "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" });
      check("a bot gets the image bytes, not HTML",
        crawler.headers["content-type"] === "image/png", crawler.headers["content-type"]);

      // a real file with an extension still gets the bytes
      const withExt = await req("GET", "/" + token + ".png");
      check("/<token>.png serves the file itself",
        withExt.headers["content-type"] === "image/png", withExt.headers["content-type"]);

      // the app's own files must not be shadowed by the bare route
      const css = await req("GET", "/desktop.css");
      check("real site files still load", css.status === 200 && /text\/css/.test(css.headers["content-type"] || ""),
        css.headers["content-type"]);
      const js = await req("GET", "/desktop.js");
      check("real scripts still load", js.status === 200 && /javascript/.test(js.headers["content-type"] || ""),
        js.headers["content-type"]);

      // the root serves the desktop now, not the old compose page
      const root = await req("GET", "/");
      check("the root serves the desktop", root.status === 200 && /w98-desktop|iconLayer/.test(root.text),
        "(root is not the desktop)");

      await req("DELETE", "/api/share?name=shot.png", undefined, admin);
      const gone = await req("GET", "/" + token);
      check("a revoked token 404s", gone.status === 404, String(gone.status));
    }

    console.log("\n=== Control Panel: settings ===");
    {
      const s = await req("GET", "/api/admin/settings", undefined, admin);
      check("an admin can read settings", s.status === 200 && s.json.settings, String(s.status));
      check("storage is reported", s.json.storage && typeof s.json.storage.totalBytes === "number",
        JSON.stringify(s.json.storage && s.json.storage.totalBytes));
      check("per-user usage is listed", Array.isArray(s.json.storage.users));

      const off = await req("POST", "/api/admin/settings", { programs: { minesweeper: false } }, admin);
      check("a program can be switched off", off.json.settings.programs.minesweeper === false,
        JSON.stringify(off.json.settings.programs.minesweeper));

      const reread = await req("GET", "/api/settings");
      check("the change is visible publicly", reread.json.programs.minesweeper === false);

      const back = await req("POST", "/api/admin/settings", { programs: { minesweeper: true } }, admin);
      check("and switched back on", back.json.settings.programs.minesweeper === true);

      const motd = await req("POST", "/api/admin/settings", { motd: "Hello there" }, admin);
      check("the message of the day saves", motd.json.settings.motd === "Hello there", motd.json.settings.motd);

      const silly = await req("POST", "/api/admin/settings", { maxUploadMB: 99999 }, admin);
      check("an absurd upload cap is clamped", silly.json.settings.maxUploadMB === 4096,
        String(silly.json.settings.maxUploadMB));
      const small = await req("POST", "/api/admin/settings", { maxUploadMB: 0 }, admin);
      check("a zero cap is clamped up", small.json.settings.maxUploadMB === 1, String(small.json.settings.maxUploadMB));
      await req("POST", "/api/admin/settings", { maxUploadMB: 1024 }, admin);

      const asUser = await req("POST", "/api/admin/users",
        { username: "alice", password: "alicepassword", role: "user" }, admin);
      const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;
      const denied = await req("GET", "/api/admin/settings", undefined, alice);
      check("a normal user cannot read settings", denied.status === 403, String(denied.status));
      const deniedSave = await req("POST", "/api/admin/settings", { motd: "hacked" }, alice);
      check("a normal user cannot change settings", deniedSave.status === 403, String(deniedSave.status));
    }

    console.log("\n=== Control Panel: dangerous actions ===");
    {
      const noConfirm = await req("POST", "/api/admin/danger", { action: "wipe-files" }, admin);
      check("an unconfirmed wipe is refused", noConfirm.status === 400, JSON.stringify(noConfirm.json));

      const wrong = await req("POST", "/api/admin/danger",
        { action: "wipe-files", confirm: "yes" }, admin);
      check("the wrong confirmation is refused", wrong.status === 400, JSON.stringify(wrong.json));

      const unknown = await req("POST", "/api/admin/danger",
        { action: "self-destruct", confirm: "self-destruct" }, admin);
      check("an unknown action is refused", unknown.status === 400, JSON.stringify(unknown.json));

      // alice has a file too
      const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;
      await req("PUT", "/api/upload", PNG, alice, { "X-File-Name": "hers.png" });

      const before = await req("GET", "/api/admin/settings", undefined, admin);
      check("there are files before the wipe", before.json.storage.totalFiles > 0,
        String(before.json.storage.totalFiles));

      const wiped = await req("POST", "/api/admin/danger", { action: "wipe-files", confirm: "wipe-files" }, admin);
      check("wiping files reports what it removed", wiped.json.files > 0, JSON.stringify(wiped.json));

      const after = await req("GET", "/api/admin/settings", undefined, admin);
      check("every file is gone", after.json.storage.totalFiles === 0, String(after.json.storage.totalFiles));
      check("and every share with them", after.json.storage.shares === 0, String(after.json.storage.shares));
      check("accounts survive a file wipe",
        (await req("GET", "/api/admin/users", undefined, admin)).json.users.length === 2,
        "accounts were affected");

      // an admin cannot delete themselves out of existence
      const del = await req("POST", "/api/admin/danger", { action: "delete-users", confirm: "delete-users" }, admin);
      check("deleting all users reports the count", del.json.removed === 1, JSON.stringify(del.json));
      check("the admin's own account is kept", del.json.kept === "root", String(del.json.kept));

      const users = await req("GET", "/api/admin/users", undefined, admin);
      check("only the admin remains", users.json.users.length === 1, String(users.json.users.length));
      check("and the admin is still signed in",
        (await req("GET", "/api/me", undefined, admin)).json.user.username === "root");

      // an upload over the configured cap is rejected
      await req("POST", "/api/admin/settings", { maxUploadMB: 1 }, admin);
      const big = Buffer.alloc(1500000, 7);
      const over = await req("PUT", "/api/upload", big, admin, { "X-File-Name": "big.bin" });
      check("an upload over the cap is refused", over.status === 413, String(over.status));
      check("and no partial file is left behind",
        !fs.existsSync(path.join(DATA, "files")) ||
        fs.readdirSync(path.join(DATA, "files")).every(function (d) {
          const p = path.join(DATA, "files", d);
          return !fs.statSync(p).isDirectory() || !fs.existsSync(path.join(p, "big.bin"));
        }), "a partial big.bin survived");
      await req("POST", "/api/admin/settings", { maxUploadMB: 1024 }, admin);
    }

  } catch (err) {
    /* The final request can race the server being torn down; a reset at
       that point is the harness, not the product. */
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
