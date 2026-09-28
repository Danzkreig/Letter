/* Render the mail UI in a real browser: compose, send, read, attach. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8772;
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

function inBrowser(probe, budget) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_mail.html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + probe + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_mail_dump.txt");
  const fd = fs.openSync(dumpFile, "w");
  // a fresh profile each run, so a cached copy of a script cannot mask a change
  const profile = path.join(TMP, "dshmail-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  let __profileDir = profile;

  try {

    execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--window-size=1280,900", "--virtual-time-budget=" + (budget || 30000), "--dump-dom",
    "--user-data-dir=" + profile, BASE + "/_probe_mail.html"],
    { stdio: ["ignore", fd, "ignore"] });

    } finally {

      dropProfile(__profileDir);

    }
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
}

const helpers = `
function ready() {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
}
function signInAs(u, p) {
  return new Promise(function (resolve) {
    LDApps.openSignIn(function (user) { resolve(user || null); });
    setTimeout(function () {
      var inputs = document.querySelectorAll(".w98-signin input");
      inputs[0].value = u;
      inputs[1].value = p;
      document.querySelector(".w98-signin-actions .w98-btn").click();
      setTimeout(function () { resolve(null); }, 2400);
    }, 300);
  });
}
function visibleWins() {
  return Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
    function (w) { return !w.hidden; });
}
function winTitles() {
  return visibleWins().map(function (w) { return w.querySelector(".w98-title-text").textContent; });
}
`;

(async function run() {
  try {
    await waitForServer();

    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;
    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    await req("POST", "/api/admin/users", { username: "bob", password: "bobpassword1", role: "user" }, admin);
    await req("POST", "/api/admin/users", { username: "carol", password: "carolpassword1", role: "user" }, admin);

    // alice sends bob a message with an attachment, so there is mail to read
    const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await req("POST", "/api/file", { kind: "image", name: "pic.png", mime: "image/png", base64: PNG }, alice);
    await req("POST", "/api/mail", {
      to: "bob", subject: "From Alice", body: "Hello Bob.\n\nSecond paragraph.",
      attachments: [{ name: "pic.png" }]
    }, alice);

    console.log("=== the mailbox opens ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("bob", "bobpassword1").then(function () {
    LDMail.open("inbox");
    setTimeout(function () {
      var rows = document.querySelectorAll(".w98-mailrow");
      document.title = "PROBE" + JSON.stringify({
        titles: winTitles(),
        rows: rows.length,
        from: rows.length ? rows[0].querySelector(".w98-mailfrom").textContent : null,
        subject: rows.length ? rows[0].querySelector(".w98-mailsubject").textContent : null,
        unread: rows.length ? rows[0].className.indexOf("is-unread") !== -1 : false,
        folders: document.querySelectorAll(".w98-folder").length,
        status: document.querySelector(".w98-statusbar span").textContent
      });
    }, 1400);
  });
}, 700);
`, 30000);
      console.log("  " + JSON.stringify(r));
      check("the mailbox window opens", (r.titles || []).some(t => /Outlook/.test(t)), JSON.stringify(r.titles));
      check("the message is listed", r.rows === 1, String(r.rows));
      check("it shows the sender", r.from === "alice", r.from);
      check("it shows the subject", r.subject === "From Alice", r.subject);
      check("it is marked unread", r.unread === true);
      check("three folders are offered", r.folders === 3, String(r.folders));
      check("the status line counts it", /1 message/.test(r.status || ""), r.status);
    }

    console.log("\n=== reading a message ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("bob", "bobpassword1").then(function () {
    LDMail.open("inbox");
    setTimeout(function () {
      document.querySelector(".w98-mailrow").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      setTimeout(function () {
        var bodies = document.querySelectorAll(".w98-mail-body");
        var attach = document.querySelectorAll(".w98-attachitem");
        document.title = "PROBE" + JSON.stringify({
          titles: winTitles(),
          paras: bodies.length ? bodies[bodies.length - 1].querySelectorAll("p").length : 0,
          bodyText: bodies.length ? bodies[bodies.length - 1].textContent.slice(0, 40) : null,
          attachments: attach.length,
          attachName: attach.length ? attach[0].querySelector(".w98-attachname").textContent : null
        });
      }, 1400);
    }, 1200);
  });
}, 700);
`, 32000);
      console.log("  " + JSON.stringify(r));
      check("a message window opens", (r.titles || []).some(t => /From Alice/.test(t)), JSON.stringify(r.titles));
      check("the body is split into paragraphs", r.paras === 2, String(r.paras));
      check("the body text is there", /Hello Bob/.test(r.bodyText || ""), r.bodyText);
      check("the attachment is listed", r.attachments === 1, String(r.attachments));
      check("it is named correctly", r.attachName === "pic.png", r.attachName);
    }

    console.log("\n=== composing and sending ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("bob", "bobpassword1").then(function () {
    LDMail.openCompose();
    setTimeout(function () {
      var inputs = document.querySelectorAll(".w98-compose .ld-input");
      inputs[0].value = "alice";       // To
      inputs[1].value = "";            // CC
      inputs[2].value = "Reply test";  // Subject
      document.querySelector(".w98-compose-body").value = "A reply from Bob.";
      var sendBtn = Array.prototype.filter.call(
        document.querySelectorAll(".w98-compose-actions .w98-btn"),
        function (b) { return b.textContent === "Send"; })[0];
      sendBtn.click();
      setTimeout(function () {
        // confirm it landed on the server side
        LD.mailFolders("sent").then(function (res) {
          document.title = "PROBE" + JSON.stringify({
            sentCount: res.mail.length,
            subject: res.mail.length ? res.mail[0].subject : null,
            to: res.mail.length ? res.mail[0].to : null,
            composeClosed: visibleWins().filter(function (w) {
              return /New Message/.test(w.querySelector(".w98-title-text").textContent);
            }).length
          });
        });
      }, 1800);
    }, 1300);
  });
}, 700);
`, 34000);
      console.log("  " + JSON.stringify(r));
      check("the message is sent", r.sentCount === 1, String(r.sentCount));
      check("with the right subject", r.subject === "Reply test", r.subject);
      check("to the right person", r.to === "alice", r.to);
      check("the compose window closes on send", r.composeClosed === 0, String(r.composeClosed));
    }

    console.log("\n=== the unread badge ===");
    {
      // a fresh server state for this check, so the count is known: carol
      // sends bob two messages and we sign in as bob
      const carol = (await req("POST", "/api/login", { username: "carol", password: "carolpassword1" })).cookie;
      check("carol signed in for the badge test", !!carol);
      await req("POST", "/api/mail", { to: "bob", subject: "badge one", body: "x" }, carol);
      await req("POST", "/api/mail", { to: "bob", subject: "badge two", body: "y" }, carol);

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("bob", "bobpassword1").then(function () {
    LDMail.open("inbox");
    setTimeout(function () {
      var badge = document.getElementById("trayMail");
      document.title = "PROBE" + JSON.stringify({
        hidden: badge.hidden,
        text: badge.textContent,
        title: badge.title
      });
    }, 2600);
  });
}, 700);
`, 30000);
      console.log("  " + JSON.stringify(r));
      check("the tray shows an unread badge", r.hidden === false, JSON.stringify(r));
      check("with the count", r.text === "2", r.text);
      check("and a readable tooltip", /2 unread messages/.test(r.title || ""), r.title);
    }

    console.log("\n=== a signed-out desktop keeps mail shut ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  var ret = LDMail.open("inbox");
  setTimeout(function () {
    document.title = "PROBE" + JSON.stringify({
      returnedNull: ret === null,
      titles: winTitles(),
      anyMailbox: visibleWins().some(function (w) {
        return /Outlook/.test(w.querySelector(".w98-title-text").textContent);
      }),
      signinShown: !!document.querySelector(".w98-signin")
    });
  }, 1400);
}, 700);
`, 20000);
      console.log("  " + JSON.stringify(r));
      check("opening mail while signed out is refused", r.returnedNull === true, JSON.stringify(r));
      check("no mailbox is opened", r.anyMailbox === false, JSON.stringify(r.titles));
      check("a sign-in prompt is shown instead", r.signinShown === true, JSON.stringify(r));
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
