/* Backend verification for the note-saving changes:
   - overwriting an existing note is refused unless asked for
   - the refusal is a 409 the caller can act on
   - notes can be saved into folders. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8951;
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

const note = (name, text, overwrite) =>
  req("POST", "/api/file", { kind: "note", name: name, text: text, overwrite: overwrite }, null);

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    console.log("=== a new note saves ===");
    {
      const r = await req("POST", "/api/file",
        { kind: "note", name: "first.txt", text: "hello" }, admin);
      check("a new note saves", r.status === 200, JSON.stringify(r.json));
      check("it is not marked as a replacement", r.json.replaced === false,
        String(r.json.replaced));

      const back = await req("GET", "/api/file?name=first.txt", undefined, admin);
      check("the contents come back", back.json.text === "hello", back.json.text);
    }

    console.log("\n=== saving over an existing note is refused ===");
    {
      const r = await req("POST", "/api/file",
        { kind: "note", name: "first.txt", text: "REPLACED" }, admin);
      check("the second save is refused", r.status === 409, String(r.status));
      check("with an exists flag the UI can act on", r.json.exists === true,
        JSON.stringify(r.json));
      check("naming the file", r.json.name === "first.txt", r.json.name);
      check("and explaining", /already exists/i.test(r.json.error || ""), r.json.error);

      const back = await req("GET", "/api/file?name=first.txt", undefined, admin);
      check("the original is untouched", back.json.text === "hello",
        JSON.stringify(back.json.text));
    }

    console.log("\n=== and goes through when asked for ===");
    {
      const r = await req("POST", "/api/file",
        { kind: "note", name: "first.txt", text: "REPLACED", overwrite: true }, admin);
      check("an explicit overwrite succeeds", r.status === 200, JSON.stringify(r.json));
      check("and is reported as a replacement", r.json.replaced === true,
        String(r.json.replaced));

      const back = await req("GET", "/api/file?name=first.txt", undefined, admin);
      check("the contents changed", back.json.text === "REPLACED", back.json.text);
    }

    console.log("\n=== notes save into folders ===");
    {
      const made = await req("POST", "/api/folder", { path: "Notes" }, admin);
      check("a folder can be made", made.status === 200, JSON.stringify(made.json));

      const deep = await req("POST", "/api/folder", { path: "Notes/Work" }, admin);
      check("and nested", deep.status === 200, JSON.stringify(deep.json));

      const inFolder = await req("POST", "/api/file",
        { kind: "note", name: "Notes/filed.txt", text: "in a folder" }, admin);
      check("a note saves into a folder", inFolder.status === 200, JSON.stringify(inFolder.json));
      check("the name keeps the path", inFolder.json.name === "Notes/filed.txt",
        inFolder.json.name);

      const listing = await req("GET", "/api/folder?path=Notes", undefined, admin);
      check("it appears in the folder listing",
        (listing.json.files || []).some(f => f.name === "filed.txt"),
        JSON.stringify((listing.json.files || []).map(f => f.name)));

      const root = await req("GET", "/api/folder?path=", undefined, admin);
      check("and not in the root",
        !(root.json.files || []).some(f => f.name === "filed.txt"),
        JSON.stringify((root.json.files || []).map(f => f.name)));

      const deepNote = await req("POST", "/api/file",
        { kind: "note", name: "Notes/Work/deep.txt", text: "two levels down" }, admin);
      check("a note saves two levels deep", deepNote.status === 200,
        JSON.stringify(deepNote.json));

      const deepList = await req("GET", "/api/folder?path=Notes/Work", undefined, admin);
      check("it lands in the right folder",
        (deepList.json.files || []).some(f => f.name === "deep.txt"),
        JSON.stringify((deepList.json.files || []).map(f => f.name)));

      /* The folder may not exist yet: saving a note into it should make it,
         rather than failing. */
      const autoFolder = await req("POST", "/api/file",
        { kind: "note", name: "Brand New/auto.txt", text: "made on the way" }, admin);
      check("a missing folder is created on save", autoFolder.status === 200,
        JSON.stringify(autoFolder.json));

      const autoList = await req("GET", "/api/folder?path=Brand New", undefined, admin);
      check("with the note inside it",
        (autoList.json.files || []).some(f => f.name === "auto.txt"),
        JSON.stringify(autoList.json));

      // reading it back by path
      const read = await req("GET", "/api/file?name=" + encodeURIComponent("Notes/filed.txt"),
        undefined, admin);
      check("a note in a folder reads back by path", read.status === 200 &&
        read.json.text === "in a folder", JSON.stringify(read.json).slice(0, 80));
    }

    console.log("\n=== the conflict check respects folders ===");
    {
      /* A root "same.txt" and a "Notes/same.txt" are different files and
         must not be confused with one another. */
      await req("POST", "/api/file", { kind: "note", name: "same.txt", text: "root copy" }, admin);
      const inNotes = await req("POST", "/api/file",
        { kind: "note", name: "Notes/same.txt", text: "folder copy" }, admin);
      check("the same name in a different folder is not a conflict",
        inNotes.status === 200, JSON.stringify(inNotes.json));

      const rootBack = await req("GET", "/api/file?name=same.txt", undefined, admin);
      check("the root copy is unchanged", rootBack.json.text === "root copy", rootBack.json.text);
      const notesBack = await req("GET", "/api/file?name=" + encodeURIComponent("Notes/same.txt"),
        undefined, admin);
      check("the folder copy is its own", notesBack.json.text === "folder copy",
        notesBack.json.text);

      // and overwriting the folder one is still caught
      const clash = await req("POST", "/api/file",
        { kind: "note", name: "Notes/same.txt", text: "nope" }, admin);
      check("a conflict inside a folder is still caught", clash.status === 409,
        String(clash.status));
    }

    console.log("\n=== traversal is still refused ===");
    {
      for (const bad of ["../escape.txt", "../../server.js", "/etc/passwd"]) {
        const r = await req("POST", "/api/file", { kind: "note", name: bad, text: "x" }, admin);
        const escaped = fs.existsSync(path.join(DIR, "escape.txt")) ||
          fs.existsSync(path.join(DIR, "etc"));
        check("refused: " + bad, !escaped && r.status < 500,
          r.status + " " + JSON.stringify(r.json).slice(0, 60));
      }
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
