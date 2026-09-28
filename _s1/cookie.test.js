/* Focused check on the session cookie's security attributes. */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const PORT = 8734;
const BASE = "http://127.0.0.1:" + PORT;

let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } }

const DATA = path.join(DIR, "data");
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

const env = Object.assign({}, process.env, { PORT: String(PORT), ADMIN_USER: "root", ADMIN_PASS: "rootpassword1" });
const server = spawn(process.execPath, ["server.js"], { cwd: DIR, env, stdio: ["ignore", "pipe", "pipe"] });

function rawLogin() {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ username: "root", password: "rootpassword1" });
    const req = http.request(BASE + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, function (res) {
      res.resume();
      res.on("end", function () { resolve(res.headers["set-cookie"] || []); });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function waitForServer() {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function go() {
      n++;
      const r = http.request(BASE + "/api/me", function (res) { res.resume(); resolve(); });
      r.on("error", function () { n > 60 ? reject(new Error("no start")) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

(async function () {
  try {
    await waitForServer();
    const cookies = await rawLogin();
    const c = cookies.join(" | ");
    console.log("  raw Set-Cookie: " + c);

    check("a cookie is set", cookies.length > 0, String(cookies.length));
    check("flagged HttpOnly (script cannot read it)", /HttpOnly/i.test(c), c);
    check("flagged SameSite=Strict (blocks CSRF)", /SameSite=Strict/i.test(c), c);
    check("scoped to Path=/", /Path=\//.test(c), c);
    check("has a finite Max-Age", /Max-Age=\d+/.test(c), c);
    check("the token is long and random", /ld_session=[A-Za-z0-9_-]{40,}/.test(c), c);
  } catch (e) {
    console.log("  ERROR: " + e.message);
    fail++;
  } finally {
    try { server.kill(); } catch (e) {}
    if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
  }
  console.log("\nPASS " + pass + "   FAIL " + fail);
  process.exit(fail ? 1 : 0);
})();
