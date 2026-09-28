/* Stage 2 verification: internal mail between accounts.
   Checks send/receive, folders, unread counts, attachments, per-side
   deletion, and that one account can never read another's mail. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8771;
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

function req(method, urlPath, body, cookie) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(BASE + urlPath, {
      method: method,
      headers: Object.assign({ "Content-Type": "application/json" },
        cookie ? { Cookie: cookie } : {},
        data ? { "Content-Length": Buffer.byteLength(data) } : {})
    }, function (res) {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", function () {
        let json = null;
        try { json = JSON.parse(out); } catch (e) {}
        resolve({ status: res.statusCode, json, text: out,
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
      r.on("error", function () { n > 80 ? reject(new Error("no start:\n" + serverOut)) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async function run() {
  try {
    await waitForServer();

    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;
    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    await req("POST", "/api/admin/users", { username: "bob", password: "bobpassword1", role: "user" }, admin);
    const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;
    const bob = (await req("POST", "/api/login", { username: "bob", password: "bobpassword1" })).cookie;

    console.log("=== sending ===");
    let mailId = null;
    {
      const r = await req("POST", "/api/mail", {
        to: "bob", subject: "Hello there", body: "First paragraph.\n\nSecond paragraph."
      }, alice);
      check("a message can be sent", r.status === 200 && r.json.mail, JSON.stringify(r.json).slice(0, 120));
      mailId = r.json.mail && r.json.mail.id;
      check("it records the sender", r.json.mail.from === "alice", r.json.mail.from);
      check("it records the recipient", r.json.mail.to === "bob", r.json.mail.to);

      const noUser = await req("POST", "/api/mail", { to: "nobody", subject: "x", body: "y" }, alice);
      check("sending to an unknown account fails", noUser.status === 400, JSON.stringify(noUser.json));

      const self = await req("POST", "/api/mail", { to: "alice", subject: "x", body: "y" }, alice);
      check("sending to yourself fails", self.status === 400, JSON.stringify(self.json));

      const empty = await req("POST", "/api/mail", { to: "bob", subject: "x", body: "   " }, alice);
      check("an empty message is refused", empty.status === 400, JSON.stringify(empty.json));

      const noSubject = await req("POST", "/api/mail", { to: "bob", body: "no subject here" }, alice);
      check("a missing subject gets a default", noSubject.json.mail.subject === "(no subject)",
        noSubject.json.mail.subject);

      const anon = await req("POST", "/api/mail", { to: "bob", body: "hi" });
      check("sending needs a session", anon.status === 401, String(anon.status));
    }

    console.log("\n=== folders ===");
    {
      const bobInbox = await req("GET", "/api/mail?folder=inbox", undefined, bob);
      check("the recipient sees it in their Inbox",
        bobInbox.json.mail.length === 2, String(bobInbox.json.mail.length));
      check("it is unread", bobInbox.json.mail[0].read === false, JSON.stringify(bobInbox.json.mail[0].read));
      check("the inbox reports an unread count", bobInbox.json.unread === 2, String(bobInbox.json.unread));

      const aliceInbox = await req("GET", "/api/mail?folder=inbox", undefined, alice);
      check("the sender's Inbox does not contain it", aliceInbox.json.mail.length === 0,
        String(aliceInbox.json.mail.length));

      const aliceSent = await req("GET", "/api/mail?folder=sent", undefined, alice);
      check("the sender sees it in Sent", aliceSent.json.mail.length === 2, String(aliceSent.json.mail.length));
      check("a sent message is not marked unread", aliceSent.json.mail[0].read === true);
      check("the Sent list shows who it went to",
        aliceSent.json.mail.some(m => m.to === "bob"), JSON.stringify(aliceSent.json.mail.map(m => m.to)));

      const carol = await req("GET", "/api/mail?folder=inbox", undefined, admin);
      check("an unrelated account sees none of it", carol.json.mail.length === 0, String(carol.json.mail.length));
    }

    console.log("\n=== reading marks it read ===");
    {
      const before = await req("GET", "/api/mail/count", undefined, bob);
      check("unread count before opening", before.json.unread === 2, String(before.json.unread));

      const one = await req("GET", "/api/mail/one?id=" + mailId, undefined, bob);
      check("the recipient can open it", one.status === 200 && one.json.mail, JSON.stringify(one.json).slice(0, 80));
      check("the body comes back whole", /Second paragraph/.test(one.json.mail.body), one.json.mail.body);

      const after = await req("GET", "/api/mail/count", undefined, bob);
      check("opening it clears one unread", after.json.unread === 1, String(after.json.unread));

      const again = await req("GET", "/api/mail?folder=inbox", undefined, bob);
      const m = again.json.mail.filter(x => x.id === mailId)[0];
      check("it is now flagged read", m && m.read === true, JSON.stringify(m && m.read));
    }

    console.log("\n=== one account cannot read another's mail ===");
    {
      const asAlice = await req("GET", "/api/mail/one?id=" + mailId, undefined, admin);
      check("an unrelated account gets 404", asAlice.status === 404, String(asAlice.status));
      check("and the body is not leaked", !/Second paragraph/.test(asAlice.text), asAlice.text.slice(0, 80));

      const del = await req("DELETE", "/api/mail?id=" + mailId, undefined, admin);
      check("an unrelated account cannot delete it", del.status === 400, String(del.status));

      const stillThere = await req("GET", "/api/mail?folder=inbox", undefined, bob);
      check("it is still in the recipient's inbox",
        stillThere.json.mail.some(m => m.id === mailId));
    }

    console.log("\n=== attachments ===");
    {
      await req("POST", "/api/file", { kind: "image", name: "photo.png", mime: "image/png", base64: PNG_1x1 }, alice);
      await req("POST", "/api/file", { kind: "note", name: "notes.txt", text: "attached note text" }, alice);

      const sent = await req("POST", "/api/mail", {
        to: "bob", subject: "With files", body: "See attached.",
        attachments: [{ name: "photo.png" }, { name: "notes.txt" }]
      }, alice);
      check("attachments are carried", sent.json.mail.attachments.length === 2,
        JSON.stringify(sent.json.mail.attachments));
      check("an image attachment is typed as an image",
        sent.json.mail.attachments.some(a => a.kind === "image"),
        JSON.stringify(sent.json.mail.attachments.map(a => a.kind)));

      const id = sent.json.mail.id;

      const img = await req("GET", "/api/mail/attachment?id=" + id + "&name=photo.png", undefined, bob);
      check("the recipient can read an image attachment",
        img.status === 200 && img.json.base64 === PNG_1_1, JSON.stringify(img.json).slice(0, 60));

      const note = await req("GET", "/api/mail/attachment?id=" + id + "&name=notes.txt", undefined, bob);
      check("the recipient can read a text attachment",
        note.json.text === "attached note text", JSON.stringify(note.json).slice(0, 60));

      const stranger = await req("GET", "/api/mail/attachment?id=" + id + "&name=notes.txt", undefined, admin);
      check("a stranger cannot read the attachment", stranger.status === 404, String(stranger.status));

      const traversal = await req("GET",
        "/api/mail/attachment?id=" + id + "&name=" + encodeURIComponent("../../users.json"), undefined, bob);
      check("a traversal attachment name is refused", traversal.status === 404, String(traversal.status));

      const notAttached = await req("POST", "/api/mail", {
        to: "bob", subject: "no files", body: "body",
        attachments: [{ name: "../../../server.js" }]
      }, alice);
      check("a traversal attachment is dropped, not sent",
        notAttached.json.mail.attachments.length === 0,
        JSON.stringify(notAttached.json.mail.attachments));
    }

    console.log("\n=== delete is per-side ===");
    {
      const bobInbox = await req("GET", "/api/mail?folder=inbox", undefined, bob);
      const target = bobInbox.json.mail[0].id;

      await req("DELETE", "/api/mail?id=" + target, undefined, bob);

      const bobAfter = await req("GET", "/api/mail?folder=inbox", undefined, bob);
      check("it leaves the recipient's Inbox",
        !bobAfter.json.mail.some(m => m.id === target));

      const bobTrash = await req("GET", "/api/mail?folder=trash", undefined, bob);
      check("and appears in their Trash", bobTrash.json.mail.some(m => m.id === target),
        JSON.stringify(bobTrash.json.mail.map(m => m.id)));

      const aliceSent = await req("GET", "/api/mail?folder=sent", undefined, alice);
      check("the sender's copy is untouched", aliceSent.json.mail.some(m => m.id === target),
        "sender lost their copy");

      const restore = await req("POST", "/api/mail/restore", { id: target }, bob);
      check("it can be restored", restore.status === 200, JSON.stringify(restore.json));
      const restored = await req("GET", "/api/mail?folder=inbox", undefined, bob);
      check("and is back in the Inbox", restored.json.mail.some(m => m.id === target));

      // permanent delete from trash
      await req("DELETE", "/api/mail?id=" + target, undefined, bob);
      await req("DELETE", "/api/mail?id=" + target + "&permanent=1", undefined, bob);
      const gone = await req("GET", "/api/mail?folder=trash", undefined, bob);
      check("deleting from Trash removes it for good",
        !gone.json.mail.some(m => m.id === target));
    }

    console.log("\n=== recipients list ===");
    {
      const r = await req("GET", "/api/mail/recipients", undefined, alice);
      const names = (r.json.users || []).map(u => u.username);
      check("it lists other accounts", names.indexOf("bob") !== -1, JSON.stringify(names));
      check("it excludes yourself", names.indexOf("alice") === -1, JSON.stringify(names));
      const bobR = await req("GET", "/api/mail/recipients", undefined, bob);
      check("bob sees alice", (bobR.json.users || []).some(u => u.username === "alice"));
    }

  } catch (err) {
    console.log("\n  TEST ERROR: " + err.message);
    fail++;
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

/* a PNG that has a real (if tiny) body, used for the attachment check */
const PNG_1_1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
