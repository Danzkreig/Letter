/* Verify the mail QoL UI: CC field, drafts surviving a close, and reply
   quoting. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8882;
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

function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_mq" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_mq" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshmq-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 28000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_mq" + tag + ".html"],
      { stdio: ["ignore", fd, "ignore"] });
} finally {
  dropProfile(__profile);
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
function winByTitle(re) {
  return Array.prototype.filter.call(document.querySelectorAll(".w98-win"), function (w) {
    return !w.hidden && re.test(w.querySelector(".w98-title-text").textContent);
  })[0];
}
`;

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    for (const n of ["alice", "bob", "carol"]) {
      await req("POST", "/api/admin/users", { username: n, password: n + "password1", role: "user" }, admin);
    }

    console.log("=== the composer has a CC field ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDMail.openCompose();
    setTimeout(function () {
      var win = winByTitle(/New Message/);
      var out = { opened: !!win };
      if (win) {
        var labels = Array.prototype.map.call(win.querySelectorAll(".w98-compose-row label"),
          function (l) { return l.textContent; });
        out.labels = labels;
        out.suggestBoxes = win.querySelectorAll(".w98-suggest").length;
        out.hasDraftNote = !!win.querySelector(".w98-draft-note");
      }
      document.title = "PROBE" + JSON.stringify(out);
    }, 1800);
  });
}, 700);
`, 26000, "cc");
      console.log("  " + JSON.stringify(r));
      check("the composer opens", r.opened === true);
      check("it has To and CC", (r.labels || []).indexOf("To:") !== -1 &&
        (r.labels || []).indexOf("CC:") !== -1, JSON.stringify(r.labels));
      check("both have autocomplete", r.suggestBoxes === 2, String(r.suggestBoxes));
      check("there is a draft indicator", r.hasDraftNote === true);
    }

    console.log("\n=== sending to several people ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDMail.openCompose();
    setTimeout(function () {
      var win = winByTitle(/New Message/);
      var inputs = win.querySelectorAll(".w98-compose .ld-input");
      var to = inputs[0], cc = inputs[1], subject = inputs[2];
      to.value = "alice, bob";
      to.dispatchEvent(new Event("input", { bubbles: true }));
      cc.value = "carol";
      cc.dispatchEvent(new Event("input", { bubbles: true }));
      subject.value = "To several";
      subject.dispatchEvent(new Event("input", { bubbles: true }));
      win.querySelector(".w98-compose-body").value = "Hello everyone.";

      Array.prototype.filter.call(win.querySelectorAll(".w98-compose-actions .w98-btn"),
        function (b) { return b.textContent === "Send"; })[0].click();

      setTimeout(function () {
        LD.mailFolders("sent").then(function (res) {
          var mine = res.mail.filter(function (m) { return m.subject === "To several"; });
          document.title = "PROBE" + JSON.stringify({
            copies: mine.length,
            closed: !winByTitle(/New Message/)
          });
        });
      }, 1800);
    }, 1800);
  });
}, 700);
`, 30000, "send");
      console.log("  " + JSON.stringify(r));
      check("one copy per recipient in Sent", r.copies === 3, String(r.copies));
      check("the composer closes on send", r.closed === true);

      const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword1" })).cookie;
      const inbox = await req("GET", "/api/mail?folder=inbox", undefined, alice);
      check("alice received it", (inbox.json.mail || []).some(m => m.subject === "To several"));

      const carol = (await req("POST", "/api/login", { username: "carol", password: "carolpassword1" })).cookie;
      const carolInbox = await req("GET", "/api/mail?folder=inbox", undefined, carol);
      const hers = (carolInbox.json.mail || []).filter(m => m.subject === "To several")[0];
      check("carol was copied rather than addressed", hers && hers.via === "cc",
        hers && hers.via);
    }

    console.log("\n=== the reader marks a CC ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("carol", "carolpassword1").then(function () {
    LDMail.open("inbox");
    setTimeout(function () {
      var win = winByTitle(/Outlook/);
      var row = win.querySelector(".w98-mailrow");
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      setTimeout(function () {
        var reader = winByTitle(/Message/);
        document.title = "PROBE" + JSON.stringify({
          opened: !!reader,
          meta: reader ? reader.querySelector(".w98-mail-meta").textContent : null
        });
      }, 1500);
    }, 1600);
  });
}, 700);
`, 30000, "reader");
      console.log("  " + JSON.stringify(r));
      check("the message opens", r.opened === true);
      check("and says you were copied in", /copied in/.test(r.meta || ""), r.meta);
    }

    console.log("\n=== drafts survive closing the composer ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword1").then(function () {
    LDMail.openCompose();
    setTimeout(function () {
      var win = winByTitle(/New Message/);
      var inputs = win.querySelectorAll(".w98-compose .ld-input");
      inputs[0].value = "bob";
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[2].value = "Half a thought";
      inputs[2].dispatchEvent(new Event("input", { bubbles: true }));
      win.querySelector(".w98-compose-body").value = "I was going to say...";
      win.querySelector(".w98-compose-body").dispatchEvent(new Event("input", { bubbles: true }));

      var out = {};
      setTimeout(function () {
        // close without sending
        Array.prototype.filter.call(win.querySelectorAll(".w98-compose-actions .w98-btn"),
          function (b) { return b.textContent === "Cancel"; })[0].click();
        out.closed = !winByTitle(/New Message/);

        // reopen: the draft should come back
        setTimeout(function () {
          LDMail.openCompose();
          setTimeout(function () {
            var win2 = winByTitle(/New Message/);
            var f = win2.querySelectorAll(".w98-compose .ld-input");
            out.to = f[0].value;
            out.subject = f[2].value;
            out.body = win2.querySelector(".w98-compose-body").value;
            out.note = win2.querySelector(".w98-draft-note").textContent;
            document.title = "PROBE" + JSON.stringify(out);
          }, 1600);
        }, 900);
      }, 1400);
    }, 1800);
  });
}, 700);
`, 34000, "draft");
      console.log("  " + JSON.stringify(r));
      check("the composer closed", r.closed === true);
      check("the To field came back", r.to === "bob", r.to);
      check("the subject came back", r.subject === "Half a thought", r.subject);
      check("the body came back", r.body === "I was going to say...", r.body);
      check("it says a draft was restored", /restored/i.test(r.note || ""), r.note);
    }

    console.log("\n=== sending clears the draft ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword1").then(function () {
    LDMail.openCompose();
    setTimeout(function () {
      var win = winByTitle(/New Message/);
      var inputs = win.querySelectorAll(".w98-compose .ld-input");
      inputs[0].value = "bob";
      inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[2].value = "Finished";
      inputs[2].dispatchEvent(new Event("input", { bubbles: true }));
      win.querySelector(".w98-compose-body").value = "Done now.";
      win.querySelector(".w98-compose-body").dispatchEvent(new Event("input", { bubbles: true }));

      setTimeout(function () {
        Array.prototype.filter.call(win.querySelectorAll(".w98-compose-actions .w98-btn"),
          function (b) { return b.textContent === "Send"; })[0].click();
        setTimeout(function () {
          LD.draft().then(function (res) {
            document.title = "PROBE" + JSON.stringify({ draft: res.draft });
          });
        }, 1800);
      }, 1400);
    }, 1800);
  });
}, 700);
`, 32000, "cleared");
      console.log("  " + JSON.stringify(r));
      check("no draft is left behind after sending", r.draft === null, JSON.stringify(r.draft));
    }

    console.log("\n=== reply quotes the original ===");
    {
      await req("POST", "/api/mail", {
        to: "alice", subject: "Dinner on Friday?", body: "Are you free?\n\nLet me know."
      }, admin);

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword1").then(function () {
    LDMail.open("inbox");
    setTimeout(function () {
      var win = winByTitle(/Outlook/);
      // open the newest message
      var rows = win.querySelectorAll(".w98-mailrow");
      rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      setTimeout(function () {
        var reader = winByTitle(/Message/);
        var out = { opened: !!reader };
        if (reader) {
          var reply = Array.prototype.filter.call(reader.querySelectorAll(".w98-btn"),
            function (b) { return /Reply/.test(b.textContent); })[0];
          out.hasReply = !!reply;
          if (reply) reply.click();
        }
        setTimeout(function () {
          var comp = winByTitle(/Reply|New Message/);
          out.composerOpened = !!comp;
          if (comp) {
            var f = comp.querySelectorAll(".w98-compose .ld-input");
            out.to = f[0].value;
            out.subject = f[2].value;
            out.body = comp.querySelector(".w98-compose-body").value;
            out.title = comp.querySelector(".w98-title-text").textContent;
          }
          document.title = "PROBE" + JSON.stringify(out);
        }, 1800);
      }, 1500);
    }, 1600);
  });
}, 700);
`, 34000, "reply");
      console.log("  " + JSON.stringify(r).slice(0, 220));
      check("the message opens", r.opened === true);
      check("it has a Reply button", r.hasReply === true);
      check("reply opens the composer", r.composerOpened === true);
      check("titled Reply", /Reply/.test(r.title || ""), r.title);
      check("addressed back to the sender", r.to === "root", r.to);
      check("the subject gets Re:", r.subject === "Re: Dinner on Friday?", r.subject);
      /* The probe's JSON rides in <title>, so ">" arrives HTML-escaped as
         &gt;. Accept either form rather than being fooled by the transport. */
      const bodyText = (r.body || "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
      check("the original is quoted", /> Are you free\?/.test(bodyText),
        JSON.stringify(bodyText.slice(0, 160)));
      check("blank lines become bare quote markers", /\n>\n/.test(bodyText), JSON.stringify(bodyText));
      check("with an attribution line", /root wrote:/.test(bodyText),
        JSON.stringify(bodyText.slice(0, 160)));
      check("there is room to type above the quote", bodyText.indexOf("> ") > 0,
        String(bodyText.indexOf("> ")));
    }

    console.log("\n=== autocomplete works with several names ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDMail.openCompose();
    setTimeout(function () {
      var win = winByTitle(/New Message/);
      var to = win.querySelectorAll(".w98-compose .ld-input")[0];
      var box = win.querySelector(".w98-suggest");
      var out = {};

      // type a first name, choose it, then type a second
      to.value = "ali";
      to.dispatchEvent(new Event("input", { bubbles: true }));
      setTimeout(function () {
        out.firstSuggestions = Array.prototype.map.call(box.querySelectorAll(".w98-suggest-row"),
          function (r) { return r.dataset.name; });
        box.querySelector(".w98-suggest-row").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        out.afterPick = to.value;

        to.value = out.afterPick + "bo";
        to.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(function () {
          out.secondSuggestions = Array.prototype.map.call(box.querySelectorAll(".w98-suggest-row"),
            function (r) { return r.dataset.name; });
          document.title = "PROBE" + JSON.stringify(out);
        }, 700);
      }, 800);
    }, 1800);
  });
}, 700);
`, 30000, "multi");
      console.log("  " + JSON.stringify(r));
      check("typing suggests matches", (r.firstSuggestions || []).indexOf("alice") !== -1,
        JSON.stringify(r.firstSuggestions));
      check("picking adds a comma", /^alice, $/.test(r.afterPick || ""), JSON.stringify(r.afterPick));
      check("the second name is matched independently",
        (r.secondSuggestions || []).indexOf("bob") !== -1, JSON.stringify(r.secondSuggestions));
      check("and the first name is not offered again",
        (r.secondSuggestions || []).indexOf("alice") === -1, JSON.stringify(r.secondSuggestions));
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
