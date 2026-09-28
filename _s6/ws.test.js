/* Unit-test the WebSocket protocol code against the RFC 6455 examples. */

"use strict";

const assert = require("assert");
const ws = require("../lib/ws");

let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } }

console.log("=== handshake (RFC 6455 section 1.3 example) ===");
{
  // the exact vector from the spec
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const expected = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
  const got = ws.acceptKey(key);
  console.log("  key      " + key);
  console.log("  accept   " + got);
  check("produces the spec's accept value", got === expected, got);

  check("recognises a valid upgrade",
    ws.isWebSocketUpgrade({ headers: {
      upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "abc", "sec-websocket-version": "13"
    } }));
  check("rejects a missing key", !ws.isWebSocketUpgrade({ headers: {
    upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13"
  } }));
  check("rejects the wrong version", !ws.isWebSocketUpgrade({ headers: {
    upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "abc", "sec-websocket-version": "8"
  } }));
  check("rejects a plain HTTP request", !ws.isWebSocketUpgrade({ headers: {} }));
  check("accepts Connection: keep-alive, Upgrade",
    ws.isWebSocketUpgrade({ headers: {
      upgrade: "WebSocket", connection: "keep-alive, Upgrade",
      "sec-websocket-key": "abc", "sec-websocket-version": "13"
    } }));
}

console.log("\n=== frame encoding ===");
{
  // small text frame: FIN + opcode 1, unmasked, length in the byte itself
  const f = ws.encodeFrame(ws.OP.TEXT, "Hello");
  check("small frame header", f[0] === 0x81 && f[1] === 5, f.slice(0, 2).toString("hex"));
  check("payload follows the header", f.slice(2).toString() === "Hello");

  // 126..65535 uses a 16-bit length
  const big = ws.encodeFrame(ws.OP.TEXT, "x".repeat(300));
  check("16-bit length marker", big[1] === 126, String(big[1]));
  check("16-bit length value", big.readUInt16BE(2) === 300, String(big.readUInt16BE(2)));

  // 65536+ uses a 64-bit length
  const huge = ws.encodeFrame(ws.OP.TEXT, "y".repeat(70000));
  check("64-bit length marker", huge[1] === 127, String(huge[1]));
  const hi = huge.readUInt32BE(2), lo = huge.readUInt32BE(6);
  check("64-bit length value", hi * 4294967296 + lo === 70000, String(hi * 4294967296 + lo));

  check("control frames carry no FIN confusion", (ws.encodeFrame(ws.OP.PING, "")[0] & 0x80) !== 0);
}

console.log("\n=== frame parsing ===");
{
  /* Build a masked client frame the way a browser would. */
  function clientFrame(opcode, payload, fin) {
    const data = Buffer.from(payload, "utf8");
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i & 3];

    let header;
    if (data.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | data.length;
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(data.length, 6);
    }
    header[0] = (fin === false ? 0 : 0x80) | opcode;
    return Buffer.concat([header, mask, masked]);
  }

  function collect() {
    const got = [];
    const parser = ws.createParser(function (fr) { got.push(fr); }, function (e) { got.push({ error: e.message }); });
    return { got, parser };
  }

  // a single small text frame
  {
    const c = collect();
    c.parser(clientFrame(ws.OP.TEXT, "hi there"));
    check("parses one text frame", c.got.length === 1 && c.got[0].payload.toString() === "hi there",
      JSON.stringify(c.got.map(g => g.payload && g.payload.toString())));
  }

  // two frames arriving in one TCP chunk
  {
    const c = collect();
    c.parser(Buffer.concat([clientFrame(ws.OP.TEXT, "one"), clientFrame(ws.OP.TEXT, "two")]));
    check("parses two frames from one chunk", c.got.length === 2 &&
      c.got[0].payload.toString() === "one" && c.got[1].payload.toString() === "two",
      String(c.got.length));
  }

  // one frame split across three chunks
  {
    const whole = clientFrame(ws.OP.TEXT, "split across chunks");
    const c = collect();
    c.parser(whole.slice(0, 3));
    check("waits for a partial header", c.got.length === 0, String(c.got.length));
    c.parser(whole.slice(3, 9));
    check("waits for a partial payload", c.got.length === 0, String(c.got.length));
    c.parser(whole.slice(9));
    check("completes a split frame", c.got.length === 1 &&
      c.got[0].payload.toString() === "split across chunks",
      JSON.stringify(c.got.map(g => g.payload && g.payload.toString())));
  }

  // fragmentation: text then continuation
  {
    const c = collect();
    c.parser(clientFrame(ws.OP.TEXT, "Hello, ", false));
    check("a fragment alone is not delivered", c.got.length === 0, String(c.got.length));
    c.parser(clientFrame(ws.OP.CONT, "world", true));
    check("fragments are joined", c.got.length === 1 &&
      c.got[0].payload.toString() === "Hello, world",
      JSON.stringify(c.got.map(g => g.payload && g.payload.toString())));
  }

  // a medium payload exercising the 16-bit length
  {
    const text = "z".repeat(1000);
    const c = collect();
    c.parser(clientFrame(ws.OP.TEXT, text));
    check("parses a 16-bit length payload", c.got.length === 1 && c.got[0].payload.length === 1000,
      String(c.got[0] && c.got[0].payload.length));
  }

  // an unmasked client frame must be rejected
  {
    const c = collect();
    const bad = Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]);
    c.parser(bad);
    check("rejects an unmasked client frame",
      c.got.length === 1 && /not masked/.test(c.got[0].error || ""),
      JSON.stringify(c.got));
  }

  // RSV bits set (an extension we did not negotiate)
  {
    const c = collect();
    const bad = clientFrame(ws.OP.TEXT, "x");
    bad[0] |= 0x40;
    c.parser(bad);
    check("rejects RSV bits", c.got.length === 1 && /RSV/.test(c.got[0].error || ""),
      JSON.stringify(c.got));
  }

  // a continuation with no start
  {
    const c = collect();
    c.parser(clientFrame(ws.OP.CONT, "orphan", true));
    check("rejects a stray continuation",
      c.got.length === 1 && /continuation/.test(c.got[0].error || ""), JSON.stringify(c.got));
  }

  // ping survives fragmentation order
  {
    const c = collect();
    c.parser(clientFrame(ws.OP.TEXT, "start", false));
    c.parser(clientFrame(ws.OP.PING, ""));
    c.parser(clientFrame(ws.OP.CONT, "end", true));
    const ops = c.got.map(g => g.opcode);
    check("a ping between fragments is handled in order",
      ops.length === 2 && ops[0] === ws.OP.PING && ops[1] === ws.OP.TEXT,
      JSON.stringify(ops));
  }
}

console.log("\n=== round trip ===");
{
  // encode a server frame, then decode it with our own parser
  const parser = ws.createParser(function (fr) {
    check("a server frame decodes to the same text", fr.payload.toString() === "round trip", fr.payload.toString());
  }, function (e) { check("no parse error", false, e.message); });

  // our parser requires masked frames, so mask it by hand here
  const text = Buffer.from("round trip");
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) masked[i] = text[i] ^ mask[i & 3];
  parser(Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, masked]));
}

console.log("\n----------------------------------------");
console.log("PASS " + pass + "   FAIL " + fail);
process.exit(fail ? 1 : 0);
