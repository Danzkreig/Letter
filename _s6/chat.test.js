/* Stage 3 verification: real-time chat over the hand-rolled WebSocket.
   Uses real WebSocket clients against the running server. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8781;
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
      r.on("error", function () { n > 100 ? reject(new Error("no start:\n" + serverOut)) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

/* ---- a WebSocket client built on the same primitives as the server ---- */
const ws = require(path.join(DIR, "lib", "ws.js"));
const crypto = require("crypto");

function connectSocket(cookie) {
  return new Promise(function (resolve, reject) {
    const key = crypto.randomBytes(16).toString("base64");
    const r = http.request({
      host: "127.0.0.1", port: PORT, path: "/ws", method: "GET",
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13",
        Cookie: cookie || ""
      }
    });
    r.on("upgrade", function (res, socket) {
      const client = {
        socket: socket,
        messages: [],
        waiters: [],
        closed: false,
        handshake: {
          status: res.statusCode,
          accept: res.headers["sec-websocket-accept"],
          expect: ws.acceptKey(key)
        },
        send: function (obj) {
          const data = Buffer.from(JSON.stringify(obj), "utf8");
          const mask = crypto.randomBytes(4);
          const masked = Buffer.alloc(data.length);
          for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];
          let header;
          if (data.length < 126) {
            header = Buffer.alloc(2);
            header[1] = 0x80 | data.length;
          } else {
            header = Buffer.alloc(4);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(data.length, 2);
          }
          header[0] = 0x81;
          socket.write(Buffer.concat([header, mask, masked]));
        },
        close: function () {
          // a proper close handshake, the way a browser tab closing behaves
          try {
            const body = Buffer.alloc(2);
            body.writeUInt16BE(1000, 0);
            const mask = crypto.randomBytes(4);
            const masked = Buffer.alloc(2);
            for (let i = 0; i < 2; i++) masked[i] = body[i] ^ mask[i & 3];
            socket.write(Buffer.concat([Buffer.from([0x88, 0x80 | 2]), mask, masked]));
            socket.end();
          } catch (e) {}
          client.closed = true;
        },
        /* wait for a NEW message of a given type. `since` lets a caller skip
           messages it has already seen, which matters when the same type
           arrives more than once (two chat messages in a row, say). */
        await: function (type, ms, since) {
          const from = since || 0;
          const existing = client.messages.slice(from).find(m => m.type === type);
          if (existing) return Promise.resolve(existing);
          return new Promise(function (res2) {
            const t = setTimeout(function () { res2(null); }, ms || 2500);
            client.waiters.push({
              type: type,
              from: from,
              resolve: function (m) { clearTimeout(t); res2(m); }
            });
          });
        },
        /* how many messages have arrived so far */
        mark: function () { return client.messages.length; }
      };

      /* Server frames are unmasked, but ws.createParser is the *server*
         side parser and (correctly) rejects unmasked input. So the test
         client needs its own small decoder for the unmasked direction. */
      const decoder = (function () {
        let buf = Buffer.alloc(0);
        return function push(chunk) {
          buf = Buffer.concat([buf, chunk]);
          for (;;) {
            if (buf.length < 2) return;
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) {
              if (buf.length < off + 2) return;
              len = buf.readUInt16BE(off); off += 2;
            } else if (len === 127) {
              if (buf.length < off + 8) return;
              const hi = buf.readUInt32BE(off), lo = buf.readUInt32BE(off + 4);
              len = hi * 4294967296 + lo; off += 8;
            }
            const maskLen = masked ? 4 : 0;
            if (buf.length < off + maskLen + len) return;
            const maskKey = masked ? buf.slice(off, off + 4) : null;
            off += maskLen;
            let payload = buf.slice(off, off + len);
            if (masked) {
              const out = Buffer.alloc(len);
              for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
              payload = out;
            }
            buf = buf.slice(off + len);

            if (opcode === ws.OP.PING) {
              socket.write(ws.encodeFrame(ws.OP.PONG, payload));
              continue;
            }
            if (opcode === ws.OP.CLOSE) { client.closed = true; continue; }

            let msg = null;
            try { msg = JSON.parse(payload.toString("utf8")); } catch (e) { continue; }
            client.messages.push(msg);
            client.waiters = client.waiters.filter(function (w) {
              if (w.type === msg.type && client.messages.length - 1 >= w.from) {
                w.resolve(msg);
                return false;
              }
              return true;
            });
          }
        };
      })();

      socket.on("data", decoder);
      socket.on("close", function () { client.closed = true; });
      socket.on("error", function () { client.closed = true; });

      resolve(client);
    });
    r.on("response", function (res) {
      // a non-101 response means the upgrade was refused
      res.resume();
      resolve({ refused: true, status: res.statusCode });
    });
    r.on("error", reject);
    r.end();
  });
}

(async function run() {
  try {
    await waitForServer();

    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;
    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    await req("POST", "/api/admin/users", { username: "bob", password: "bobpassword1", role: "user" }, admin);
    const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;
    const bob = (await req("POST", "/api/login", { username: "bob", password: "bobpassword1" })).cookie;

    console.log("=== the handshake ===");
    {
      const a = await connectSocket(alice);
      check("the upgrade succeeds", !a.refused, JSON.stringify(a.refused && a.status));
      check("the accept header matches the RFC computation",
        a.handshake.accept === a.handshake.expect,
        a.handshake.accept + " vs " + a.handshake.expect);

      const hello = await a.await("hello", 3000);
      check("the server greets with the signed-in user", hello && hello.you.username === "alice",
        JSON.stringify(hello));

      const roster = await a.await("roster", 3000);
      check("the roster lists the other account", roster && roster.buddies.some(b => b.username === "bob"),
        JSON.stringify(roster && roster.buddies.map(b => b.username)));

      a.close();
    }

    console.log("\n=== an unauthenticated socket is refused ===");
    {
      const anon = await connectSocket(null);
      const err = await anon.await("error", 2500);
      check("it gets an error, not a greeting", err && /Not signed in/.test(err.error || ""),
        JSON.stringify(err));

      // the server sends a close frame then ends the socket; give both a moment
      await new Promise(r => setTimeout(r, 400));
      check("and the connection is closed", anon.closed === true, "still open");

      const forged = await connectSocket("ld_session=made-up-token");
      const err2 = await forged.await("error", 2500);
      check("a forged cookie is refused too", err2 && /Not signed in/.test(err2.error || ""),
        JSON.stringify(err2));
      await new Promise(r => setTimeout(r, 300));
      check("the forged socket is closed as well", forged.closed === true, "still open");
    }

    console.log("\n=== presence ===");
    {
      const a = await connectSocket(alice);
      await a.await("hello", 3000);

      const b = await connectSocket(bob);
      await b.await("hello", 3000);

      // presence arrives as each socket joins; by the time both have said
      // hello the last one must list both of us
      await new Promise(r => setTimeout(r, 400));
      const presence = a.messages.filter(m => m.type === "presence").pop();
      check("both are reported online",
        presence && presence.online.length === 2, JSON.stringify(presence && presence.online));

      const api = await req("GET", "/api/im/buddies", undefined, alice);
      const bobEntry = (api.json.buddies || []).filter(x => x.username === "bob")[0];
      check("the HTTP roster agrees", bobEntry && bobEntry.online === true, JSON.stringify(bobEntry));

      b.close();
      // a destroyed socket can take a moment to be noticed; the hub also
      // pings every 20s so a ghost cannot last longer than that
      await new Promise(r => setTimeout(r, 900));

      const after = await req("GET", "/api/im/buddies", undefined, alice);
      const bobAfter = (after.json.buddies || []).filter(x => x.username === "bob")[0];
      check("disconnecting marks them offline", bobAfter && bobAfter.online === false,
        JSON.stringify(bobAfter));

      a.close();
      await new Promise(r => setTimeout(r, 300));
    }

    console.log("\n=== real-time delivery ===");
    {
      const a = await connectSocket(alice);
      const b = await connectSocket(bob);
      await a.await("hello", 3000);
      await b.await("hello", 3000);

      const meA = (await a.await("hello", 500)).you;
      const meB = (await b.await("hello", 500)).you;

      const aMark = a.mark();
      a.send({ type: "send", to: meB.id, text: "Hello Bob, this is live." });

      const gotByBob = await b.await("message", 3000);
      check("the recipient receives it over the socket",
        gotByBob && gotByBob.text === "Hello Bob, this is live.", JSON.stringify(gotByBob));
      check("it carries the sender's name", gotByBob && gotByBob.fromName === "alice", gotByBob && gotByBob.fromName);

      const echo = await a.await("message", 3000, aMark);
      check("the sender gets a copy back", echo && echo.text === "Hello Bob, this is live.",
        JSON.stringify(echo));

      const aMark2 = a.mark();
      b.send({ type: "send", to: meA.id, text: "Hello Alice, got it." });
      const reply = await a.await("message", 3000, aMark2);
      check("the reply arrives too", reply && reply.text === "Hello Alice, got it.",
        JSON.stringify(reply));

      console.log("  (both directions delivered)");
      a.close(); b.close();
    }

    console.log("\n=== history persists ===");
    {
      const stored = await req("GET", "/api/im/history?with=", undefined, alice);
      check("history needs a valid user", stored.status === 404, String(stored.status));

      const db = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"));
      const aliceId = db.users.filter(u => u.username === "alice")[0].id;
      const bobId = db.users.filter(u => u.username === "bob")[0].id;

      const h = await req("GET", "/api/im/history?with=" + bobId, undefined, alice);
      check("the conversation is stored", h.json.messages && h.json.messages.length === 2,
        JSON.stringify(h.json.messages && h.json.messages.length));
      check("both messages are there in order",
        h.json.messages[0].text === "Hello Bob, this is live." &&
        h.json.messages[1].text === "Hello Alice, got it.",
        JSON.stringify(h.json.messages.map(m => m.text)));
      check("the conversation names the other party",
        h.json.other.username === "bob", JSON.stringify(h.json.other));

      // and bob sees the same thread even though he is the other side
      const hb = await req("GET", "/api/im/history?with=" + aliceId, undefined, bob);
      check("the other side sees the same thread", hb.json.messages.length === 2,
        String(hb.json.messages.length));
      check("instant messages did not leak into mail",
        (await req("GET", "/api/mail?folder=inbox", undefined, alice)).json.mail.length === 0,
        "IMs appeared in the mailbox");
    }

    console.log("\n=== unread and read receipts ===");
    {
      const db = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"));
      const aliceId = db.users.filter(u => u.username === "alice")[0].id;
      const bobId = db.users.filter(u => u.username === "bob")[0].id;

      const a = await connectSocket(alice);
      const b = await connectSocket(bob);
      await a.await("hello", 3000);
      await b.await("hello", 3000);

      a.send({ type: "send", to: bobId, text: "unread test" });
      await b.await("message", 3000);

      const roster = await b.await("roster", 3000);
      const aliceEntry = roster && roster.buddies.filter(x => x.username === "alice")[0];
      // bob already received it, so the count may already be refreshing
      check("the roster carries unread counts", aliceEntry && typeof aliceEntry.unread === "number",
        JSON.stringify(aliceEntry));

      b.send({ type: "read", with: aliceId });
      const readMark = await a.await("read", 3000);
      check("a read receipt reaches the sender", readMark && readMark.by === bobId,
        JSON.stringify(readMark));

      a.close(); b.close();
    }

    console.log("\n=== the history request over the socket ===");
    {
      const db = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"));
      const bobId = db.users.filter(u => u.username === "bob")[0].id;

      const a = await connectSocket(alice);
      await a.await("hello", 3000);
      a.send({ type: "history", with: bobId });
      const hist = await a.await("history", 3000);
      check("history comes back over the socket",
        hist && hist.messages.length >= 3, JSON.stringify(hist && hist.messages.length));
      a.close();
    }

    console.log("\n=== the HTTP fallback ===");
    {
      const db = JSON.parse(fs.readFileSync(path.join(DATA, "users.json"), "utf8"));
      const aliceId = db.users.filter(u => u.username === "alice")[0].id;
      const bobId = db.users.filter(u => u.username === "bob")[0].id;

      const sent = await req("POST", "/api/im/send", { to: bobId, text: "sent over HTTP" }, alice);
      check("a message can be sent without a socket", sent.status === 200, JSON.stringify(sent.json));

      const h = await req("GET", "/api/im/history?with=" + aliceId, undefined, bob);
      check("it lands in the conversation",
        h.json.messages.some(m => m.text === "sent over HTTP"),
        JSON.stringify(h.json.messages.map(m => m.text)));

      const anon = await req("POST", "/api/im/send", { to: bobId, text: "sneaky" });
      check("the fallback still needs a session", anon.status === 401, String(anon.status));

      const toNobody = await req("POST", "/api/im/send", { to: "u_nope", text: "hi" }, alice);
      check("sending to a missing account fails", toNobody.status === 400, String(toNobody.status));
    }

    console.log("\n=== non-upgrade traffic on /ws ===");
    {
      const plain = await req("GET", "/ws");
      check("a plain GET to /ws is refused, not hung", plain.status >= 400, String(plain.status));
    }

  } catch (err) {
    console.log("\n  TEST ERROR: " + err.message);
    console.log(err.stack.split("\n").slice(0, 4).join("\n"));
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
