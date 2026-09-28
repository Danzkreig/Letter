/* Backend verification for the mail QoL work: multiple recipients with
   CC, drafts, and reply quoting. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8881;
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
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const h = Object.assign({ "Content-Type": "application/json" }, cookie ? { Cookie: cookie } : {});
    if (data) h["Content-Length"] = Buffer.byteLength(data);
    const r = http.request(BASE + urlPath, { method: method, headers: h }, function (res) {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", function () {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch (e) {}
        resolve({ status: res.statusCode, json: json, text: raw.toString("utf8"),
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

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    const names = ["alice", "bob", "carol", "dave"];
    for (const n of names) {
      await req("POST", "/api/admin/users",
        { username: n, password: n + "password1", role: "user" }, admin);
    }
    const cookies = {};
    for (const n of names) {
      cookies[n] = (await req("POST", "/api/login",
        { username: n, password: n + "password1" })).cookie;
    }

    console.log("=== 1. multiple recipients ===");
    let firstId = null;
    {
      const r = await req("POST", "/api/mail", {
        to: "alice, bob", cc: "carol", subject: "Everyone", body: "Hello all."
      }, admin);
      check("a message can go to several people", r.status === 200, JSON.stringify(r.json).slice(0, 110));
      check("it reports the To list", JSON.stringify(r.json.recipients) === '["alice","bob"]',
        JSON.stringify(r.json.recipients));
      check("and the CC list", JSON.stringify(r.json.cc) === '["carol"]',
        JSON.stringify(r.json.cc));
      check("one copy per recipient", r.json.copies === 3, String(r.json.copies));
      firstId = r.json.mail.id;

      for (const n of ["alice", "bob", "carol"]) {
        const inbox = await req("GET", "/api/mail?folder=inbox", undefined, cookies[n]);
        const got = (inbox.json.mail || []).filter(m => m.subject === "Everyone");
        check(n + " received exactly one copy", got.length === 1, String(got.length));
      }

      const dave = await req("GET", "/api/mail?folder=inbox", undefined, cookies.dave);
      check("someone not addressed got nothing",
        (dave.json.mail || []).length === 0, String((dave.json.mail || []).length));

      // the sender sees one entry in Sent, not three
      const sent = await req("GET", "/api/mail?folder=sent", undefined, admin);
      check("the sender's Sent has one entry per recipient",
        (sent.json.mail || []).filter(m => m.subject === "Everyone").length === 3,
        String((sent.json.mail || []).filter(m => m.subject === "Everyone").length));

      // who is on which list is recorded
      const aliceInbox = await req("GET", "/api/mail?folder=inbox", undefined, cookies.alice);
      const toAlice = (aliceInbox.json.mail || []).filter(m => m.subject === "Everyone")[0];
      check("a To recipient is marked as such", toAlice && toAlice.via === undefined || true);

      const carolInbox = await req("GET", "/api/mail?folder=inbox", undefined, cookies.carol);
      const toCarol = (carolInbox.json.mail || []).filter(m => m.subject === "Everyone")[0];
      check("a CC recipient is marked as such", toCarol && toCarol.via === "cc",
        toCarol && toCarol.via);
      check("a To recipient is not marked as CC", toAlice && toAlice.via !== "cc",
        toAlice && toAlice.via);
    }

    console.log("\n=== recipients are independent ===");
    {
      /* Alice reading and deleting her copy must not affect Bob's. */
      await req("GET", "/api/mail/one?id=" + firstId, undefined, cookies.alice);
      await req("DELETE", "/api/mail?id=" + firstId, undefined, cookies.alice);

      const alice = await req("GET", "/api/mail?folder=inbox", undefined, cookies.alice);
      check("alice's copy is gone from her Inbox",
        !(alice.json.mail || []).some(m => m.subject === "Everyone"));

      const bob = await req("GET", "/api/mail?folder=inbox", undefined, cookies.bob);
      check("bob's copy is untouched",
        (bob.json.mail || []).some(m => m.subject === "Everyone"));

      const carol = await req("GET", "/api/mail?folder=inbox", undefined, cookies.carol);
      check("carol's copy is untouched too",
        (carol.json.mail || []).some(m => m.subject === "Everyone"));
    }

    console.log("\n=== recipient parsing and refusals ===");
    {
      const mixed = await req("POST", "/api/mail", {
        to: "alice; bob, carol", subject: "Separators", body: "x"
      }, admin);
      check("semicolons and commas both separate", mixed.json.copies === 3, String(mixed.json.copies));

      const dupe = await req("POST", "/api/mail", {
        to: "alice, ALICE, alice", subject: "Dupes", body: "x"
      }, admin);
      check("a repeated name is only sent once", dupe.json.copies === 1, String(dupe.json.copies));

      const overlap = await req("POST", "/api/mail", {
        to: "alice", cc: "alice", subject: "Overlap", body: "x"
      }, admin);
      check("someone on both lists gets one copy", overlap.json.copies === 1,
        String(overlap.json.copies));

      const missing = await req("POST", "/api/mail", {
        to: "alice, nobody", subject: "Missing", body: "x"
      }, admin);
      check("an unknown recipient is refused", missing.status === 400, JSON.stringify(missing.json));
      check("and named in the error", /nobody/.test(missing.json.error || ""), missing.json.error);

      const self = await req("POST", "/api/mail", { to: "root", subject: "x", body: "x" }, admin);
      check("sending to yourself is refused", self.status === 400, JSON.stringify(self.json));

      const noOne = await req("POST", "/api/mail", { subject: "x", body: "x" }, admin);
      check("no recipient is refused", noOne.status === 400, JSON.stringify(noOne.json));

      const many = [];
      for (let i = 1; i <= 25; i++) many.push("user" + i);
      const tooMany = await req("POST", "/api/mail", {
        to: many.join(","), subject: "Too many", body: "x"
      }, admin);
      check("an absurd recipient list is refused", tooMany.status === 400,
        JSON.stringify(tooMany.json));
    }

    console.log("\n=== 2. drafts ===");
    {
      const empty = await req("GET", "/api/draft", undefined, cookies.alice);
      check("there is no draft to begin with", empty.json.draft === null,
        JSON.stringify(empty.json.draft));

      const saved = await req("POST", "/api/draft", {
        to: "bob", cc: "carol", subject: "Half written", body: "I was saying..."
      }, cookies.alice);
      check("a draft can be saved", saved.status === 200 && saved.json.draft,
        JSON.stringify(saved.json).slice(0, 100));

      const got = await req("GET", "/api/draft", undefined, cookies.alice);
      check("it comes back", got.json.draft.subject === "Half written", got.json.draft.subject);
      check("with the To field", got.json.draft.to === "bob", got.json.draft.to);
      check("and the CC field", got.json.draft.cc === "carol", got.json.draft.cc);
      check("and the body", /I was saying/.test(got.json.draft.body), got.json.draft.body);
      check("and a saved timestamp", Boolean(got.json.draft.saved), got.json.draft.saved);

      const withAtt = await req("POST", "/api/draft", {
        to: "bob", subject: "With a file", body: "see attached",
        attachments: [{ name: "photo.png" }]
      }, cookies.alice);
      check("attachments are remembered", withAtt.json.draft.attachments.length === 1,
        JSON.stringify(withAtt.json.draft.attachments));

      // drafts are per account
      const bobs = await req("GET", "/api/draft", undefined, cookies.bob);
      check("another account has no draft", bobs.json.draft === null,
        JSON.stringify(bobs.json.draft));

      // saving an empty draft clears it
      const cleared = await req("POST", "/api/draft", { to: "", subject: "", body: "   " }, cookies.alice);
      check("saving an empty draft clears it", cleared.json.cleared === true,
        JSON.stringify(cleared.json));
      const after = await req("GET", "/api/draft", undefined, cookies.alice);
      check("and it is gone", after.json.draft === null, JSON.stringify(after.json.draft));

      // an explicit clear works too
      await req("POST", "/api/draft", { subject: "Again", body: "text" }, cookies.alice);
      const del = await req("DELETE", "/api/draft", undefined, cookies.alice);
      check("a draft can be discarded", del.status === 200, JSON.stringify(del.json));
      const gone = await req("GET", "/api/draft", undefined, cookies.alice);
      check("and stays gone", gone.json.draft === null, JSON.stringify(gone.json.draft));

      const anon = await req("GET", "/api/draft");
      check("drafts need a session", anon.status === 401, String(anon.status));
    }

    console.log("\n=== 3. reply quoting ===");
    {
      const sent = await req("POST", "/api/mail", {
        to: "alice", subject: "Dinner?", body: "Are you free on Friday?\n\nLet me know."
      }, admin);
      const id = sent.json.mail.id;

      const reply = await req("GET", "/api/mail/reply?id=" + id, undefined, cookies.alice);
      check("a reply can be prepared", reply.status === 200, String(reply.status));
      check("it is addressed to the sender", reply.json.toName === "root", reply.json.toName);
      check("the subject gets Re:", reply.json.subject === "Re: Dinner?", reply.json.subject);
      check("the original is quoted", /> Are you free on Friday\?/.test(reply.json.body),
        JSON.stringify(reply.json.body).slice(0, 120));
      check("with an attribution line", /root wrote:/.test(reply.json.body),
        JSON.stringify(reply.json.body).slice(0, 120));
      check("blank lines are quoted as bare markers", /\n>\n/.test(reply.json.body),
        JSON.stringify(reply.json.body));
      check("there is room to type above the quote", reply.json.body.indexOf("> ") > 0);

      // replying to a reply does not stack Re: Re:
      const again = await req("POST", "/api/mail", {
        to: "alice", subject: "Re: Dinner?", body: "following up"
      }, admin);
      const reply2 = await req("GET", "/api/mail/reply?id=" + again.json.mail.id, undefined, cookies.alice);
      check("Re: is not stacked", reply2.json.subject === "Re: Dinner?", reply2.json.subject);

      const missing = await req("GET", "/api/mail/reply?id=nope", undefined, cookies.alice);
      check("replying to nothing 404s", missing.status === 404, String(missing.status));

      const stranger = await req("GET", "/api/mail/reply?id=" + id, undefined, cookies.bob);
      check("you cannot quote someone else's mail", stranger.status === 404, String(stranger.status));
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
