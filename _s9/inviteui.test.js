/* Verify the invitation sign-up renders inside the Windows 98 environment. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8841;
const BASE = "http://127.0.0.1:" + PORT;
const TMP = process.env.TEMP;

/* Remove a throwaway browser profile, so the temp directory does not
   fill up across runs. */
function dropProfile(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
}


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

function req(method, urlPath, body, cookie, headers) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
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

/* Render a URL and read values back out of the live DOM. */
function renderPage(url, probe, budget, tag) {
  const f = path.join(DIR, "_probe_inv" + tag + ".html");
  if (probe) fs.writeFileSync(f, probe, "utf8");
  const dumpFile = path.join(DIR, "_probe_inv" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshinv-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 14000), "--dump-dom",
      "--user-data-dir=" + __profile,
      url], { stdio: ["ignore", fd, "ignore"] });
} finally {
  dropProfile(__profile);
}
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  return { dump: dump, state: m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null };
}

/* Load the invite page, then interrogate the live DOM from inside it. */
function inspectInvite(url, script, budget, tag) {
  const dumpFile = path.join(DIR, "_probe_invi" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");

  /* Edge has no way to inject script into an arbitrary URL, so instead we
     fetch the page, append a probe, and serve it from the same origin via
     a temporary file the server will serve at /invite/...? No -- simpler:
     use --dump-dom and assert against the markup, then separately load the
     page and let its own script run. */
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--window-size=1280,900", "--virtual-time-budget=" + (budget || 14000), "--dump-dom",
    "--user-data-dir=" + path.join(TMP, "dshinvi-" + tag + "-" + Date.now()),
    url], { stdio: ["ignore", fd, "ignore"] });
  fs.closeSync(fd);
  void script;
  return fs.readFileSync(dumpFile, "utf8");
}

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    // an invitation with a shape and a body
    const inv = await req("POST", "/api/letter", {
      kind: "invitation", subject: "Come join us",
      body: "Hello!\n\nI have been using Letterdrop and thought you would like it.",
      shape: "donut2d"
    }, admin);
    const token = inv.json.token;
    console.log("invite token: " + token);

    console.log("\n=== the page is the Windows 98 desktop ===");
    {
      const dom = inspectInvite(BASE + "/invite/" + token, null, 16000, "main");

      check("it loads the desktop stylesheet", /\/desktop\.css/.test(dom));
      check("it has the w98 desktop shell", /class="w98"/.test(dom));
      check("it has a taskbar", /w98-taskbar/.test(dom));
      check("with a Start button", /w98-start/.test(dom));
      check("and a tray clock", /inviteClock/.test(dom));
      check("the stylesheet's assets are absolute",
        dom.indexOf('url("assets/') === -1 && dom.indexOf("url(assets/") === -1,
        "(a relative asset URL survived)");

      // the sign-up is inside a Win98 window
      check("the form is in a w98 window", /class="inv-win w98-win w98-raised/.test(dom),
        (dom.match(/<div class="[^"]*inv-win[^"]*"/) || ["(none)"])[0]);
      check("with a title bar", /w98-title-text/.test(dom));
      check("titled Create Your Account", /Create Your Account/.test(dom));
      check("using the same banner as the logon", /w98-signin-banner/.test(dom));
      check("which says Letterdrop Network", /Letterdrop Network/.test(dom));
      check("there is a user name field", /id="u"/.test(dom) && /w98-field/.test(dom));
      check("and a password field", /id="p"[\s\S]{0,80}type="password"/.test(dom));
      check("with a Create account button", /id="go"[\s\S]{0,60}Create account/.test(dom));
      check("no dark standalone styling left", dom.indexOf("color-scheme: dark") === -1);
    }

    console.log("\n=== the letter is shown behind the window ===");
    {
      const dom = inspectInvite(BASE + "/invite/" + token, null, 16000, "letter");
      check("the letter subject is shown", /Come join us/.test(dom));
      check("the letter body is shown", /I have been using Letterdrop/.test(dom));
      check("it names the sender", /root/.test(dom));
      check("the shape has somewhere to draw", /class="inv-toy"/.test(dom));
      check("and the shape renderer is loaded", /\/ascii\.js/.test(dom));
    }

    console.log("\n=== the sign-up actually works ===");
    {
      const r = await req("POST", "/api/redeem", {
        token: token, username: "invited", password: "invitedpass1"
      });
      check("account creation succeeds", r.status === 200 && r.json.user, JSON.stringify(r.json).slice(0, 90));
      check("it signs the new account in", Boolean(r.cookie));

      const inbox = await req("GET", "/api/mail?folder=inbox", undefined, r.cookie);
      check("the letter is delivered into the new Inbox",
        (inbox.json.mail || []).some(m => m.kind === "letter"), "not delivered");
      check("and it is unread, so it pops up",
        (inbox.json.mail || []).some(m => m.kind === "letter" && !m.read));
    }

    console.log("\n=== the other outcomes are Win98 too ===");
    {
      const used = inspectInvite(BASE + "/invite/" + token, null, 12000, "used");
      check("a used link stays in the desktop", /class="w98"/.test(used));
      check("and shows a window", /w98-win/.test(used));
      check("explaining it was already used", /already been used/i.test(used));
      check("it is not the old dark page", used.indexOf("color-scheme: dark") === -1);

      const missing = inspectInvite(BASE + "/invite/aaaaaaaaaaaa", null, 12000, "missing");
      check("an unknown link stays in the desktop", /class="w98"/.test(missing));
      check("with a clear message", /could not be found/i.test(missing));

      const expired = await req("POST", "/api/letter", { kind: "invitation", body: "old one" }, admin);
      await req("DELETE", "/api/invites?id=" + expired.json.mail.id, undefined, admin);
      const gone = inspectInvite(BASE + "/invite/" + expired.json.token, null, 12000, "expired");
      check("a revoked link stays in the desktop", /class="w98"/.test(gone));
      check("and says it expired", /expired/i.test(gone));
    }

    console.log("\n=== the desktop itself still looks right ===");
    {
      // the absolute asset paths must not have broken the main page
      const root = await req("GET", "/");
      check("the desktop still loads", root.status === 200 && /w98-desktop/.test(root.text),
        String(root.status));

      const css = await req("GET", "/desktop.css");
      check("the stylesheet serves", css.status === 200, String(css.status));
      check("with absolute asset paths", /url\("\/assets\/clouds\.jpg"\)/.test(css.text),
        "(clouds.jpg is not absolute)");

      const wallpaper = await req("GET", "/assets/clouds.jpg");
      check("the wallpaper loads at its absolute path", wallpaper.status === 200,
        String(wallpaper.status));
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
