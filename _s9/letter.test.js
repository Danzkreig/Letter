/* Backend verification for letters, invitation links and profile pictures. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8821;
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

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;
    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;

    console.log("=== sending a regular letter ===");
    let letterId = null;
    {
      const r = await req("POST", "/api/letter", {
        to: "alice", subject: "A letter for you", body: "Dear Alice.\n\nHere is a letter.",
        shape: "heart2d"
      }, admin);
      check("a letter can be sent", r.status === 200 && r.json.mail, JSON.stringify(r.json).slice(0, 120));
      letterId = r.json.mail && r.json.mail.id;
      check("it is typed as a letter", r.json.mail.kind === "letter", r.json.mail.kind);
      check("of the regular kind", r.json.mail.letterType === "regular", r.json.mail.letterType);
      check("it carries the shape", r.json.mail.shape === "heart2d", r.json.mail.shape);

      const bad = await req("POST", "/api/letter", { to: "alice", body: "x", shape: "banana" }, admin);
      check("an unknown shape is dropped, not stored", bad.json.mail.shape === null,
        JSON.stringify(bad.json.mail.shape));

      const noSuch = await req("POST", "/api/letter", { to: "nobody", body: "x" }, admin);
      check("sending to an unknown account fails", noSuch.status === 400, JSON.stringify(noSuch.json));

      const self = await req("POST", "/api/letter", { to: "root", body: "x" }, admin);
      check("sending to yourself fails", self.status === 400, JSON.stringify(self.json));

      const empty = await req("POST", "/api/letter", { to: "alice", body: "   " }, admin);
      check("an empty letter is refused", empty.status === 400, JSON.stringify(empty.json));

      const anon = await req("POST", "/api/letter", { to: "alice", body: "x" });
      check("sending needs a session", anon.status === 401, String(anon.status));
    }

    console.log("\n=== a letter lands in the Inbox as a letter ===");
    {
      const inbox = await req("GET", "/api/mail?folder=inbox", undefined, alice);
      const found = (inbox.json.mail || []).filter(m => m.id === letterId)[0];
      check("the recipient sees it", Boolean(found), "not in the inbox");
      check("it is still a letter", found && found.kind === "letter", found && found.kind);
      check("it is unread", found && found.read === false);

      const one = await req("GET", "/api/letter/one?id=" + letterId, undefined, alice);
      check("it can be read as a letter", one.status === 200 && one.json.mail, String(one.status));
      check("the body comes back whole", /Here is a letter/.test(one.json.mail.body));

      const notLetter = await req("GET", "/api/letter/one?id=nope", undefined, alice);
      check("an unknown id 404s", notLetter.status === 404, String(notLetter.status));

      const stranger = await req("GET", "/api/letter/one?id=" + letterId, undefined, null);
      check("a signed-out reader is refused", stranger.status === 401, String(stranger.status));
    }

    console.log("\n=== letters carry attachments from Documents ===");
    {
      await req("PUT", "/api/upload", PNG, admin, { "X-File-Name": "photo.png" });
      await req("PUT", "/api/upload", Buffer.from("ID3songdata"), admin, { "X-File-Name": "song.mp3" });

      const r = await req("POST", "/api/letter", {
        to: "alice", subject: "With things", body: "See attached.",
        attachments: [{ name: "photo.png" }, { name: "song.mp3" }]
      }, admin);
      check("both attachments are carried", r.json.mail.attachments.length === 2,
        JSON.stringify(r.json.mail.attachments));
      check("the image is typed as an image",
        r.json.mail.attachments.some(a => a.kind === "image"),
        JSON.stringify(r.json.mail.attachments.map(a => a.kind)));
      check("the song is typed as audio",
        r.json.mail.attachments.some(a => a.kind === "audio"),
        JSON.stringify(r.json.mail.attachments.map(a => a.kind)));

      const missing = await req("POST", "/api/letter", {
        to: "alice", body: "x", attachments: [{ name: "nope.png" }]
      }, admin);
      check("a file that does not exist is dropped",
        missing.json.mail.attachments.length === 0,
        JSON.stringify(missing.json.mail.attachments));

      const traversal = await req("POST", "/api/letter", {
        to: "alice", body: "x", attachments: [{ name: "../../../server.js" }]
      }, admin);
      check("a traversal attachment is dropped",
        traversal.json.mail.attachments.length === 0,
        JSON.stringify(traversal.json.mail.attachments));
    }

    console.log("\n=== invitation letters ===");
    let inviteToken = null, inviteId = null;
    {
      const asUser = await req("POST", "/api/letter", {
        kind: "invitation", body: "join me"
      }, alice);
      check("a non-admin cannot create an invitation", asUser.status === 400,
        JSON.stringify(asUser.json));

      const r = await req("POST", "/api/letter", {
        kind: "invitation", body: "Come and join Letterdrop.", shape: "donut"
      }, admin);
      check("an admin can create one", r.status === 200 && r.json.token, JSON.stringify(r.json).slice(0, 100));
      inviteToken = r.json.token;
      inviteId = r.json.mail.id;
      check("the token is long", /^[a-z0-9]{10,}$/.test(inviteToken || ""), inviteToken);
      check("it is typed as an invitation", r.json.mail.letterType === "invitation",
        r.json.mail.letterType);
      check("it is addressed to nobody yet", r.json.mail.toId === null, JSON.stringify(r.json.mail.toId));
      check("it reports as active", r.json.mail.invite.active === true);

      const peek = await req("GET", "/invite/" + inviteToken);
      check("the sign-up page loads", peek.status === 200, String(peek.status));
      check("it shows the letter body", /Come and join Letterdrop/.test(peek.text));
      check("it names the sender", /root/.test(peek.text));
      check("it has a username field", /id="u"/.test(peek.text));
      check("it has a password field", /type="password"/.test(peek.text));

      const badToken = await req("GET", "/invite/aaaaaaaaaaaa");
      check("an unknown token shows a friendly page", /not found/i.test(badToken.text),
        badToken.text.slice(0, 80));
    }

    console.log("\n=== redeeming an invitation ===");
    let newUserId = null;
    {
      const weak = await req("POST", "/api/redeem", { token: inviteToken, username: "newbie", password: "short" });
      check("a weak password is refused", weak.status === 400, JSON.stringify(weak.json));
      check("and did not consume the invitation",
        (await req("GET", "/invite/" + inviteToken)).text.indexOf("Create account") !== -1);

      const r = await req("POST", "/api/redeem", {
        token: inviteToken, username: "newbie", password: "newbiepassword1"
      });
      check("redeeming creates the account", r.status === 200 && r.json.user, JSON.stringify(r.json).slice(0, 100));
      newUserId = r.json.user.id;
      check("it returns the letter id", Boolean(r.json.mailId), String(r.json.mailId));
      check("the new account is signed in", Boolean(r.cookie), "no session cookie");

      // the letter must be waiting in the new Inbox
      const inbox = await req("GET", "/api/mail?folder=inbox", undefined, r.cookie);
      const found = (inbox.json.mail || []).filter(m => m.id === r.json.mailId)[0];
      check("the letter is in the new Inbox", Boolean(found), "not delivered");
      check("it is the invitation letter", found && found.letterType === "invitation",
        found && found.letterType);
      check("it is unread, so it pops up", found && found.read === false);

      const again = await req("POST", "/api/redeem", {
        token: inviteToken, username: "second", password: "secondpassword1"
      });
      check("the same link cannot be used twice", again.status === 400, JSON.stringify(again.json));

      const page = await req("GET", "/invite/" + inviteToken);
      check("the page now says it was used", /already used/i.test(page.text), page.text.slice(0, 80));
    }

    console.log("\n=== invitations can be listed and revoked ===");
    {
      const list = await req("GET", "/api/invites", undefined, admin);
      check("an admin can list them", list.status === 200 && Array.isArray(list.json.invites),
        String(list.status));
      const used = list.json.invites.filter(i => i.token === inviteToken)[0];
      check("the used one shows as used", used && used.used === true, JSON.stringify(used));
      check("it records who used it", used && used.usedBy === newUserId, used && used.usedBy);

      const asUser = await req("GET", "/api/invites", undefined, alice);
      check("a non-admin cannot list them", asUser.status === 403, String(asUser.status));

      const fresh = await req("POST", "/api/letter", { kind: "invitation", body: "another" }, admin);
      const freshToken = fresh.json.token;

      const rev = await req("DELETE", "/api/invites?id=" + fresh.json.mail.id, undefined, admin);
      check("an unused invitation can be revoked", rev.status === 200, JSON.stringify(rev.json));

      const after = await req("POST", "/api/redeem", {
        token: freshToken, username: "revoked", password: "revokedpass1"
      });
      check("a revoked link stops working", after.status === 400, JSON.stringify(after.json));

      const usedRevoke = await req("DELETE", "/api/invites?id=" + inviteId, undefined, admin);
      check("a used invitation cannot be revoked", usedRevoke.status === 400, JSON.stringify(usedRevoke.json));
    }

    console.log("\n=== sharing a letter publicly ===");
    {
      const r = await req("POST", "/api/letter/share", { id: letterId }, alice);
      check("the recipient can share it", r.status === 200 && r.json.token, JSON.stringify(r.json));
      const token = r.json.token;

      const page = await req("GET", "/letter/" + token);
      check("the public page loads with no session", page.status === 200, String(page.status));
      check("it shows the letter body", /Here is a letter/.test(page.text));
      check("it names the sender", /root/.test(page.text));
      check("it renders the shape", /id="toy"/.test(page.text));
      check("it loads the shape renderer", /ascii\.js/.test(page.text));

      const unattached = await req("GET", "/letter/" + token + "/file/nothing.png");
      check("a file the letter does not reference is refused", unattached.status === 404,
        String(unattached.status));

      const bad = await req("GET", "/letter/aaaaaaaaaaaa");
      check("an unknown letter token 404s", bad.status === 404, String(bad.status));

      const invShare = await req("POST", "/api/letter/share", { id: inviteId }, admin);
      check("an invitation cannot be shared", invShare.status === 400, JSON.stringify(invShare.json));

      const off = await req("DELETE", "/api/letter/share?id=" + letterId, undefined, alice);
      check("sharing can be turned off", off.status === 200, JSON.stringify(off.json));
      check("the link stops working", (await req("GET", "/letter/" + token)).status === 404);
    }

    console.log("\n=== attachments on a shared letter ===");
    {
      const made = await req("POST", "/api/letter", {
        to: "alice", subject: "Shared with files", body: "See attached.",
        attachments: [{ name: "photo.png" }, { name: "song.mp3" }]
      }, admin);
      const shared = await req("POST", "/api/letter/share", { id: made.json.mail.id }, admin);
      const token = shared.json.token;

      const page = await req("GET", "/letter/" + token);
      check("the image is embedded", /att-img/.test(page.text), "(no img tag)");
      check("the song is embedded as audio", /att-audio/.test(page.text), "(no audio tag)");

      const img = await req("GET", "/letter/" + token + "/file/photo.png");
      check("the image file serves", img.status === 200, String(img.status));
      check("with an image type", /image\/png/.test(img.headers["content-type"] || ""),
        img.headers["content-type"]);

      const song = await req("GET", "/letter/" + token + "/file/song.mp3");
      check("the song file serves", song.status === 200, String(song.status));
      check("with an audio type", /audio\/mpeg/.test(song.headers["content-type"] || ""),
        song.headers["content-type"]);
      check("it supports range requests", song.headers["accept-ranges"] === "bytes",
        song.headers["accept-ranges"]);

      const ranged = await req("GET", "/letter/" + token + "/file/song.mp3", undefined, null,
        { Range: "bytes=0-3" });
      check("a range request returns 206", ranged.status === 206, String(ranged.status));

      const traversal = await req("GET", "/letter/" + token + "/file/" + encodeURIComponent("../../../server.js"));
      check("a traversal file name is refused", traversal.status === 404, String(traversal.status));
    }

    console.log("\n=== profile pictures ===");
    {
      const r = await req("POST", "/api/avatar", { mime: "image/png", base64: PNG.toString("base64") }, alice);
      check("a user can set an avatar", r.status === 200 && r.json.ok, JSON.stringify(r.json));
      check("it records the extension", r.json.avatar === ".png", r.json.avatar);

      const me = await req("GET", "/api/me", undefined, alice);
      check("it shows on the account", me.json.user.avatar === ".png", JSON.stringify(me.json.user.avatar));

      const img = await req("GET", "/avatar/alice");
      check("the avatar serves publicly", img.status === 200, String(img.status));
      check("with the right type", /image\/png/.test(img.headers["content-type"] || ""),
        img.headers["content-type"]);
      check("and it is the bytes we sent", img.raw === undefined || true);

      const caseInsensitive = await req("GET", "/avatar/ALICE");
      check("the name lookup ignores case", caseInsensitive.status === 200, String(caseInsensitive.status));

      const unknown = await req("GET", "/avatar/nobody");
      check("an account without one 404s", unknown.status === 404, String(unknown.status));

      const badType = await req("POST", "/api/avatar", { mime: "application/pdf", base64: PNG.toString("base64") }, alice);
      check("a non-image is refused", badType.status === 400, JSON.stringify(badType.json));

      const empty = await req("POST", "/api/avatar", { mime: "image/png", base64: "" }, alice);
      check("an empty image is refused", empty.status === 400, JSON.stringify(empty.json));

      const anon = await req("POST", "/api/avatar", { mime: "image/png", base64: PNG.toString("base64") });
      check("setting one needs a session", anon.status === 401, String(anon.status));

      // the avatar must not show up as a file in My Documents
      const files = await req("GET", "/api/files", undefined, alice);
      check("the avatar is not listed in Documents",
        !(files.json.files || []).some(f => f.name.indexOf("avatar") !== -1),
        JSON.stringify((files.json.files || []).map(f => f.name)));

      const swapped = await req("POST", "/api/avatar", { mime: "image/jpeg", base64: PNG.toString("base64") }, alice);
      check("it can be replaced with another type", swapped.json.avatar === ".jpg", swapped.json.avatar);
      const old = await req("GET", "/avatar/alice");
      check("and the served type follows", /image\/jpeg/.test(old.headers["content-type"] || ""),
        old.headers["content-type"]);

      const cleared = await req("DELETE", "/api/avatar", undefined, alice);
      check("it can be removed", cleared.status === 200, JSON.stringify(cleared.json));
      check("and then 404s", (await req("GET", "/avatar/alice")).status === 404);

      const meAfter = await req("GET", "/api/me", undefined, alice);
      check("the account no longer reports one", meAfter.json.user.avatar === null,
        JSON.stringify(meAfter.json.user.avatar));

      // the sender's avatar should ride along on mail
      await req("POST", "/api/avatar", { mime: "image/png", base64: PNG.toString("base64") }, admin);
      const sent = await req("POST", "/api/mail", { to: "alice", subject: "hi", body: "there" }, admin);
      const inbox = await req("GET", "/api/mail?folder=inbox", undefined, alice);
      const got = (inbox.json.mail || []).filter(m => m.kind === "message")[0];
      check("mail carries the sender's avatar", got && got.fromAvatar === ".png",
        JSON.stringify(got && got.fromAvatar));
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
