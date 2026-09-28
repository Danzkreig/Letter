/* Render the public share page in a real browser: does an image actually
   display, and does a note show its text? */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8762;
const BASE = "http://127.0.0.1:" + PORT;
const TMP = process.env.TEMP;

let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } }

const DATA = path.join(DIR, "data");
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: DIR,
  env: Object.assign({}, process.env, { PORT: String(PORT), ADMIN_USER: "root", ADMIN_PASS: "rootpassword1" }),
  stdio: ["ignore", "pipe", "pipe"]
});

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
      r.on("error", function () { n > 80 ? reject(new Error("no start")) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

/* A real 2x2 red PNG so the viewer has something visible to show. */
const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ7mzMsAAAAASUVORK5CYII=";

(async function run() {
  try {
    await waitForServer();

    const login = await req("POST", "/api/login", { username: "root", password: "rootpassword1" });
    const admin = login.cookie;
    await req("POST", "/api/file", { kind: "image", name: "shot.png", mime: "image/png", base64: RED_PNG }, admin);
    await req("POST", "/api/file", { kind: "note", name: "readme.txt", text: "Line one of the note.\n\nLine two." }, admin);

    const imgShare = await req("POST", "/api/share", { name: "shot.png" }, admin);
    const noteShare = await req("POST", "/api/share", { name: "readme.txt" }, admin);

    console.log("=== an image share renders in the browser ===");
    {
      const dumpFile = path.join(DIR, "_probe_share.txt");
      const fd = fs.openSync(dumpFile, "w");
      execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--window-size=900,800", "--virtual-time-budget=8000", "--dump-dom",
        "--user-data-dir=" + TMP + "\\dshshr", BASE + "/s/" + imgShare.json.token],
        { stdio: ["ignore", fd, "ignore"] });
      fs.closeSync(fd);
      const dom = fs.readFileSync(dumpFile, "utf8");

      check("the page shows the file name", dom.indexOf("shot.png") !== -1);
      check("an <img> points at the raw route", /img class="media" src="[^"]*\/raw"/.test(dom),
        (dom.match(/<img[^>]*>/) || [""])[0]);
      // the page is deliberately bare: just the image, nothing else
      check("there is no download button", !/download=/.test(dom));
      check("there is no copy button", !/id="copy"/.test(dom));
      check("and no heading", !/<h1/i.test(dom));
    }

    console.log("\n=== a note share renders its text ===");
    {
      const dumpFile = path.join(DIR, "_probe_share2.txt");
      const fd = fs.openSync(dumpFile, "w");
      execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--window-size=900,800", "--virtual-time-budget=8000", "--dump-dom",
        "--user-data-dir=" + TMP + "\\dshshr2", BASE + "/s/" + noteShare.json.token],
        { stdio: ["ignore", fd, "ignore"] });
      fs.closeSync(fd);
      const dom = fs.readFileSync(dumpFile, "utf8");

      check("the note's text is shown", dom.indexOf("Line one of the note.") !== -1, "text missing");
      check("it is in a <pre> block", /<pre>/.test(dom));
      check("no image tag for a note", !/<img src="\/s\//.test(dom));
    }

    console.log("\n=== a revoked link shows the 404 page ===");
    {
      await req("DELETE", "/api/share?name=" + encodeURIComponent("shot.png"), undefined, admin);
      const dumpFile = path.join(DIR, "_probe_share3.txt");
      const fd = fs.openSync(dumpFile, "w");
      execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--window-size=900,600", "--virtual-time-budget=6000", "--dump-dom",
        "--user-data-dir=" + TMP + "\\dshshr3", BASE + "/s/" + imgShare.json.token],
        { stdio: ["ignore", fd, "ignore"] });
      fs.closeSync(fd);
      const dom = fs.readFileSync(dumpFile, "utf8");
      check("it says the link is unavailable", /not available/i.test(dom), dom.slice(0, 120));
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
