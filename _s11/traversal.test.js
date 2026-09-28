/* Confirm the containment refactor did not open a hole: traversal must
   still be refused everywhere, including through the new folder paths. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8872;
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } }

const DATA = path.join(DIR, "data");
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
const OUTSIDE = path.join(DIR, "_s11", "canary.txt");
fs.writeFileSync(OUTSIDE, "this must never be reachable");

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

const TRAVERSALS = [
  "../../../server.js",
  "..%2f..%2f..%2fserver.js",
  "....//....//....//server.js",
  "..\\..\\..\\server.js",
  "Folder/../../../server.js",
  "Folder/../../server.js",
  "/etc/passwd",
  "../../../data/users.json",
  "Folder/../../data/users.json"
];

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    await req("POST", "/api/file", { kind: "note", name: "mine.txt", text: "my own note" }, admin);
    await req("POST", "/api/folder", { path: "Papers" }, admin);
    await req("POST", "/api/file/rename", { from: "mine.txt", to: "Papers/mine.txt" }, admin);

    console.log("=== reading ===");
    for (const t of TRAVERSALS) {
      const r = await req("GET", "/api/file?name=" + encodeURIComponent(t), undefined, admin);
      const leaked = r.status === 200 && /require\(|scrypt\$|root:/.test(r.text);
      check("refused: " + t, !leaked, r.status + " " + r.text.slice(0, 60));
    }

    console.log("\n=== renaming ===");
    for (const t of TRAVERSALS) {
      const r = await req("POST", "/api/file/rename",
        { from: "Papers/mine.txt", to: t }, admin);
      // either refused, or contained inside the folder
      const escaped = fs.existsSync(path.join(DIR, "server.js")) &&
        fs.readFileSync(path.join(DIR, "server.js"), "utf8").indexOf("my own note") !== -1;
      check("contained: " + t, !escaped && r.status < 500, r.status + " " + JSON.stringify(r.json).slice(0, 60));
    }

    console.log("\n=== sharing ===");
    for (const t of TRAVERSALS) {
      const r = await req("POST", "/api/share", { name: t }, admin);
      check("refused: " + t, r.status === 400, r.status + " " + JSON.stringify(r.json).slice(0, 60));
    }

    console.log("\n=== folders ===");
    for (const t of TRAVERSALS) {
      const r = await req("POST", "/api/folder", { path: t }, admin);
      const escaped = fs.existsSync(path.join(DIR, "etc")) || fs.existsSync(path.join(DIR, "data", "etc"));
      check("contained: " + t, !escaped, r.status + " " + JSON.stringify(r.json).slice(0, 60));
    }

    for (const t of TRAVERSALS) {
      const r = await req("GET", "/api/folder?path=" + encodeURIComponent(t), undefined, admin);
      const leaked = r.status === 200 && /scrypt\$|require\(/.test(r.text);
      check("refused listing: " + t, !leaked, r.status + " " + r.text.slice(0, 60));
    }

    console.log("\n=== the canary is still where it was ===");
    check("the file outside the data folder is untouched",
      fs.existsSync(OUTSIDE) && fs.readFileSync(OUTSIDE, "utf8") === "this must never be reachable");
    check("nothing escaped into the project root",
      !fs.existsSync(path.join(DIR, "canary.txt")));

    console.log("\n=== a file in a folder still works normally ===");
    {
      const listing = await req("GET", "/api/folder?path=Papers", undefined, admin);
      check("the folder lists its file", listing.json.files.length === 1,
        JSON.stringify(listing.json.files.map(f => f.name)));

      const read = await req("GET", "/api/file?name=" + encodeURIComponent("Papers/mine.txt"), undefined, admin);
      check("a file inside a folder can be read", read.status === 200, String(read.status));
      check("with its contents", /my own note/.test(read.json.text || ""), read.json.text);

      const shared = await req("POST", "/api/share", { name: "Papers/mine.txt" }, admin);
      check("a file inside a folder can be shared", shared.status === 200, JSON.stringify(shared.json));
      const page = await req("GET", "/s/" + shared.json.token);
      check("and the link serves it", page.status === 200, String(page.status));
      check("with the right contents", /my own note/.test(page.text));

      const raw = await req("GET", "/s/" + shared.json.token + "/raw");
      check("the raw file serves too", raw.status === 200, String(raw.status));
    }

  } catch (err) {
    console.log("\n  TEST ERROR: " + err.message);
    fail++;
  } finally {
    try { server.kill(); } catch (e) {}
    setTimeout(function () {
      if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
      if (fs.existsSync(OUTSIDE)) fs.unlinkSync(OUTSIDE);
      console.log("\n----------------------------------------");
      console.log("PASS " + pass + "   FAIL " + fail);
      process.exit(fail ? 1 : 0);
    }, 400);
  }
})();
