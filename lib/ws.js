/* ============================================================
   Letterdrop — a minimal WebSocket server (RFC 6455)

   Written by hand so the project keeps its zero-dependency promise.
   It implements what chat actually needs:

     - the opening handshake (Sec-WebSocket-Accept)
     - text, close and ping/pong frames
     - fragmentation (continuation frames)
     - payloads up to 64 MB (16-bit and 64-bit lengths)
     - masked frames from the client, unmasked to the client

   Not implemented, because nothing here needs them: extensions
   (permessage-deflate), subprotocol negotiation, and binary
   application data beyond passing Buffers through.
   ============================================================ */

"use strict";

const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP = {
  CONT: 0x0, TEXT: 0x1, BINARY: 0x2,
  CLOSE: 0x8, PING: 0x9, PONG: 0xA
};

const MAX_PAYLOAD = 64 * 1024 * 1024;

/* ---------- handshake ---------- */

function acceptKey(clientKey) {
  return crypto.createHash("sha1").update(clientKey + GUID).digest("base64");
}

/* Returns true if the request looks like a valid WebSocket upgrade. */
function isWebSocketUpgrade(req) {
  const h = req.headers;
  if (!h) return false;
  return String(h.upgrade || "").toLowerCase() === "websocket" &&
    /(^|,)\s*upgrade\s*(,|$)/i.test(String(h.connection || "")) &&
    typeof h["sec-websocket-key"] === "string" &&
    String(h["sec-websocket-version"]) === "13";
}

/* ---------- framing ---------- */

/* Build a frame to send to the client. Server frames are never masked. */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // JS numbers are safe to 2^53, and payloads are capped well below that
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode;   // FIN set, no RSV bits

  return Buffer.concat([header, data]);
}

/* A parser that turns a byte stream into whole frames. TCP gives no
   guarantee that one chunk equals one frame, so this buffers. */
function createParser(onFrame, onError) {
  let buffer = Buffer.alloc(0);
  let fragments = null;        // { opcode, chunks } while a message is split
  let fragmentOpcode = 0;

  function fail(msg) {
    if (onError) onError(new Error(msg));
  }

  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

    for (;;) {
      if (buffer.length < 2) return;

      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;

      if (rsv !== 0) { fail("unexpected RSV bits"); return; }

      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        const hi = buffer.readUInt32BE(offset);
        const lo = buffer.readUInt32BE(offset + 4);
        len = hi * 4294967296 + lo;
        offset += 8;
      }

      if (len > MAX_PAYLOAD) { fail("payload too large"); return; }

      // clients must mask; the server must not
      if (!masked) { fail("client frame was not masked"); return; }

      if (buffer.length < offset + 4 + len) return;

      const maskKey = buffer.slice(offset, offset + 4);
      offset += 4;

      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) {
        payload[i] = buffer[offset + i] ^ maskKey[i & 3];
      }
      offset += len;

      buffer = buffer.slice(offset);

      // ---- control frames may arrive mid-fragment and are handled at once ----
      if (opcode === OP.CLOSE) {
        onFrame({ opcode: OP.CLOSE, payload: payload, fin: true });
        return;
      }
      if (opcode === OP.PING) {
        onFrame({ opcode: OP.PING, payload: payload, fin: true });
        continue;
      }
      if (opcode === OP.PONG) {
        onFrame({ opcode: OP.PONG, payload: payload, fin: true });
        continue;
      }

      // ---- data frames ----
      if (opcode === OP.CONT) {
        if (!fragments) { fail("continuation without a start"); return; }
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments);
          const op = fragmentOpcode;
          fragments = null;
          onFrame({ opcode: op, payload: whole, fin: true });
        }
        continue;
      }

      if (fin) {
        onFrame({ opcode: opcode, payload: payload, fin: true });
      } else {
        fragments = [payload];
        fragmentOpcode = opcode;
      }
    }
  };
}

/* ---------- a single connection ---------- */

function createConnection(socket, req) {
  const conn = {
    socket: socket,
    req: req,
    open: true,
    data: null,               // room for the application to hang state on
    _listeners: {}
  };

  const parser = createParser(function (frame) {
    if (frame.opcode === OP.CLOSE) {
      conn.close(1000, "");
      return;
    }
    if (frame.opcode === OP.PING) {
      send(OP.PONG, frame.payload);
      return;
    }
    if (frame.opcode === OP.PONG) {
      if (conn._listeners.pong) conn._listeners.pong();
      return;
    }

    const text = frame.payload.toString("utf8");
    if (conn._listeners.message) conn._listeners.message(text, frame.opcode === OP.BINARY);
  }, function (err) {
    conn.close(1002, String(err.message || "protocol error"));
  });

  socket.on("data", parser);
  socket.on("error", function () { conn._emitClose(); });
  socket.on("close", function () { conn._emitClose(); });
  socket.setNoDelay(true);

  function send(opcode, payload) {
    if (!conn.open) return;
    try { socket.write(encodeFrame(opcode, payload)); } catch (e) { conn._emitClose(); }
  }

  conn.send = function (data) {
    if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) {
      send(OP.TEXT, JSON.stringify(data));
    } else {
      send(OP.TEXT, String(data));
    }
  };

  conn.sendBinary = function (buf) { send(OP.BINARY, buf); };
  conn.ping = function () { send(OP.PING, Buffer.alloc(0)); };

  conn.close = function (code, reason) {
    if (!conn.open) return;
    conn.open = false;
    try {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason || ""));
      body.writeUInt16BE(code || 1000, 0);
      body.write(reason || "", 2);
      socket.write(encodeFrame(OP.CLOSE, body));
    } catch (e) {}
    try { socket.end(); } catch (e) {}
    conn._emitClose();
  };

  conn.on = function (name, fn) {
    conn._listeners[name] = fn;
    return conn;
  };

  /* Called when the peer answers a ping. */
  conn.onPong = function (fn) {
    conn._listeners.pong = fn;
    return conn;
  };

  conn._emitClose = function () {
    if (conn._closed) return;
    conn._closed = true;
    conn.open = false;
    if (conn._listeners.close) conn._listeners.close();
  };

  return conn;
}

/* ---------- the upgrade handler ---------- */

/* Attach to an http server. `onConnection(conn, req)` is called for each
   accepted socket. Requests to other paths are destroyed. */
function attach(server, path, onConnection) {
  server.on("upgrade", function (req, socket, head) {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

    if (url.pathname !== path || !isWebSocketUpgrade(req)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + acceptKey(key)
    ];
    socket.write(headers.join("\r\n") + "\r\n\r\n");

    const conn = createConnection(socket, req);
    if (head && head.length) socket.unshift(head);
    onConnection(conn, req, url);
  });
}

module.exports = {
  attach,
  encodeFrame,
  createParser,
  acceptKey,
  isWebSocketUpgrade,
  OP,
  GUID
};
