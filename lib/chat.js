/* ============================================================
   Letterdrop — the AIM hub

   Ties the WebSocket server to accounts and the message store.

   A socket is authenticated from the same session cookie the rest of
   the site uses, so a connection is exactly as trusted as a page
   load. An unauthenticated socket is closed immediately.
   ============================================================ */

"use strict";

const ws = require("./ws");
const store = require("./store");

const HEARTBEAT_MS = 20000;
const MAX_TEXT = 4000;

function createHub(server, httpServer) {
  const clients = new Map();   // userId -> Set<conn>

  /* ---------- who is online ---------- */

  function onlineIds() {
    return Array.from(clients.keys());
  }

  function isOnline(userId) {
    return clients.has(userId);
  }

  function broadcast(payload, exceptUserId) {
    const text = JSON.stringify(payload);
    clients.forEach(function (set, userId) {
      if (userId === exceptUserId) return;
      set.forEach(function (conn) { conn.send(text); });
    });
  }

  /* Tell everyone the roster changed. */
  function announcePresence() {
    broadcast({ type: "presence", online: onlineIds() });
  }

  /* ---------- helpers ---------- */

  function sendTo(userId, payload) {
    const set = clients.get(userId);
    if (!set) return false;
    const text = JSON.stringify(payload);
    set.forEach(function (conn) { conn.send(text); });
    return true;
  }

  function safeUser(u) {
    return { id: u.id, username: u.username };
  }

  /* Every user except the caller, with online state and unread counts. */
  function rosterFor(userId) {
    const db = store.load();
    const unread = store.imUnreadByUser(userId);
    return db.users
      .filter(function (u) { return u.id !== userId; })
      .map(function (u) {
        return {
          id: u.id,
          username: u.username,
          online: isOnline(u.id),
          unread: unread[u.id] || 0
        };
      });
  }

  /* ---------- a connection ---------- */

  function onConnection(conn, req) {
    // authenticate from the session cookie
    const cookie = String(req.headers.cookie || "");
    const match = cookie.match(/(?:^|;\s*)ld_session=([^;]+)/);
    const token = match ? decodeURIComponent(match[1]) : null;
    const user = store.sessionUser(token);

    if (!user) {
      // never let an anonymous socket listen in
      conn.send({ type: "error", error: "Not signed in." });
      conn.close(1008, "unauthenticated");
      return;
    }

    conn.data = { userId: user.id, username: user.username, awaitingPong: false };

    /* The protocol layer answers pings automatically; this only clears the
       flag so the heartbeat knows the socket is alive. */
    if (conn.onPong) conn.onPong(function () {
      if (conn.data) conn.data.awaitingPong = false;
    });

    if (!clients.has(user.id)) clients.set(user.id, new Set());
    clients.get(user.id).add(conn);

    // the client learns who it is, then the roster
    conn.send({ type: "hello", you: safeUser(user) });
    conn.send({ type: "roster", buddies: rosterFor(user.id) });
    announcePresence();

    /* ---------- messages ---------- */

    conn.on("message", function (raw) {
      let msg = null;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg.type !== "string") return;

      const me = conn.data.userId;

      if (msg.type === "roster") {
        conn.send({ type: "roster", buddies: rosterFor(me) });
        return;
      }

      if (msg.type === "history") {
        const convo = store.conversationWith(me, String(msg.with || ""));
        if (convo.error) { conn.send({ type: "error", error: convo.error }); return; }
        conn.send({ type: "history", with: convo.other, messages: convo.messages });
        return;
      }

      if (msg.type === "send") {
        const text = String(msg.text || "").slice(0, MAX_TEXT);

        /* The client addresses a buddy by id, but sendIm takes a
           username, so resolve one to the other first. */
        const db = store.load();
        let target = store.findById(db, String(msg.to || ""));
        if (!target) target = findByName(db, String(msg.to || ""));
        if (!target) { conn.send({ type: "error", error: "No such user." }); return; }

        const out = store.sendIm(me, target.username, text);
        if (out.error) { conn.send({ type: "error", error: out.error }); return; }

        const m = out.message;
        const payload = {
          type: "message",
          id: m.id,
          from: m.from,
          fromName: m.fromName,
          to: m.to,
          toName: m.toName,
          text: m.text,
          sent: m.sent
        };

        // to the sender (so their window can render it) and the recipient
        conn.send(payload);
        sendTo(m.to, payload);

        // if the recipient is looking at this conversation, it is read at once
        return;
      }

      if (msg.type === "read") {
        const withId = String(msg.with || "");
        store.markImRead(me, withId);
        // let the other side know their messages were seen
        sendTo(withId, { type: "read", by: me });
        conn.send({ type: "roster", buddies: rosterFor(me) });
        return;
      }

      if (msg.type === "typing") {
        const withId = String(msg.with || "");
        sendTo(withId, { type: "typing", from: me, fromName: conn.data.username, on: Boolean(msg.on) });
        return;
      }

      if (msg.type === "clear") {
        const out = store.clearConversation(me, String(msg.with || ""));
        conn.send({ type: "cleared", with: msg.with, removed: out.removed });
        return;
      }

      if (msg.type === "ping") {
        conn.send({ type: "pong" });
        return;
      }
    });

    conn.on("close", function () {
      const set = clients.get(user.id);
      if (set) {
        set.delete(conn);
        if (!set.size) clients.delete(user.id);
      }
      announcePresence();
    });
  }

  ws.attach(httpServer, "/ws", onConnection);

  /* ---------- heartbeat ----------
     Browsers do not always deliver a close when a tab is killed, and a
     dropped TCP connection can go unnoticed for a long time. A ping every
     30 seconds proves the socket is still there; one that does not answer
     by the next beat is dropped, so the roster cannot fill with ghosts. */
  const beat = setInterval(function () {
    clients.forEach(function (set) {
      set.forEach(function (conn) {
        if (!conn.open) return;
        if (conn.data && conn.data.awaitingPong) {
          // missed a whole interval: treat it as gone
          conn.close(1001, "no heartbeat");
          return;
        }
        if (conn.data) conn.data.awaitingPong = true;
        conn.ping();
      });
    });
  }, HEARTBEAT_MS);
  if (beat.unref) beat.unref();

  return {
    onlineIds: onlineIds,
    isOnline: isOnline,
    count: function () { return clients.size; }
  };
}

module.exports = { createHub };
