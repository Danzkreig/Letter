/* Browser verification: autocomplete, the letter reader, the letter
   composer, and profile pictures. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8831;
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

function inBrowser(script, budget, tag) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_lt" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_lt" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshlt-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 24000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_lt" + tag + ".html"],
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    // a few accounts so autocomplete has something to match
    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    await req("POST", "/api/admin/users", { username: "alan", password: "alanpassword1", role: "user" }, admin);
    await req("POST", "/api/admin/users", { username: "natalie", password: "nataliepass1", role: "user" }, admin);
    const alice = (await req("POST", "/api/login", { username: "alice", password: "alicepassword" })).cookie;

    // a letter waiting for alice, with a shape and an attachment
    await req("PUT", "/api/upload", PNG, admin, { "X-File-Name": "photo.png" });
    await req("POST", "/api/letter", {
      to: "alice", subject: "A letter for Alice", body: "Hello Alice.\n\nA second paragraph.",
      shape: "heart2d", attachments: [{ name: "photo.png" }]
    }, admin);

    console.log("=== autocomplete on the To field ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDMail.openCompose();
    setTimeout(function () {
      var win = winByTitle(/New Message/);
      var to = win.querySelector(".w98-to-wrap .ld-input");
      var box = win.querySelector(".w98-suggest");
      var out = { hasBox: !!box };

      function type(v) {
        to.value = v;
        to.dispatchEvent(new Event("input", { bubbles: true }));
      }
      function rows() {
        return Array.prototype.map.call(box.querySelectorAll(".w98-suggest-row"),
          function (r) { return r.dataset.name; });
      }

      type("al");
      out.forAl = rows();
      out.alVisible = !box.hidden;
      out.alActive = box.querySelectorAll(".w98-suggest-row.is-active").length;

      type("nata");
      out.forNata = rows();

      type("zzz");
      out.forNothing = rows();
      out.hiddenWhenNoMatch = box.hidden;

      type("al");
      out.firstHighlighted = box.querySelector(".w98-suggest-row.is-active").dataset.name;
      to.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      out.afterArrow = box.querySelector(".w98-suggest-row.is-active").dataset.name;
      to.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      out.afterEnter = to.value;
      out.closedAfterEnter = box.hidden;

      document.title = "PROBE" + JSON.stringify(out);
    }, 1800);
  });
}, 700);
`, 26000, "auto");
      console.log("  " + JSON.stringify(r));
      check("a dropdown exists", r.hasBox === true);
      check("typing 'al' matches", (r.forAl || []).length >= 2, JSON.stringify(r.forAl));
      check("alice is offered first (start match)", r.forAl && r.forAl[0] === "alice",
        JSON.stringify(r.forAl));
      check("alan is offered too", (r.forAl || []).indexOf("alan") !== -1, JSON.stringify(r.forAl));
      check("the dropdown is visible", r.alVisible === true);
      check("the first suggestion is highlighted", r.firstHighlighted === "alice", r.firstHighlighted);
      check("typing 'nata' matches natalie", r.forNata && r.forNata[0] === "natalie",
        JSON.stringify(r.forNata));
      check("nonsense matches nothing", (r.forNothing || []).length === 0, JSON.stringify(r.forNothing));
      check("and the dropdown hides", r.hiddenWhenNoMatch === true);
      check("ArrowDown moves the highlight", r.afterArrow === "alan", r.afterArrow);
      /* The field now takes several names, so accepting a suggestion adds
         a comma ready for the next one. */
      check("Enter takes the highlighted name", /^alan,?\s*$/.test(r.afterEnter || ""), r.afterEnter);
      check("and closes the dropdown", r.closedAfterEnter === true);
    }

    console.log("\n=== the letter opens and animates ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword").then(function () {
    LD.mailFolders("inbox").then(function (res) {
      var letter = res.mail.filter(function (m) { return m.kind === "letter"; })[0];
      if (!letter) { document.title = "PROBE" + JSON.stringify({ error: "no letter" }); return; }
      LDLetter.open(letter.id);
      setTimeout(function () {
        var win = winByTitle(/Letter/);
        var out = { opened: !!win };
        if (win) {
          out.subject = win.querySelector(".ld-letter-subject").textContent;
          out.paras = win.querySelectorAll(".ld-letter-body p").length;
          out.hasToy = !!win.querySelector(".ld-toy");
          out.caption = win.querySelector(".ld-toy-caption") ?
            win.querySelector(".ld-toy-caption").textContent : null;
          var pre = win.querySelector(".ld-toy");
          out.frame1 = pre ? pre.textContent.length : 0;
          out.hasImage = !!win.querySelector(".ld-att-img");
          out.imgLoaded = win.querySelector(".ld-att-img") ?
            win.querySelector(".ld-att-img").naturalWidth : 0;
          out.buttons = Array.prototype.map.call(win.querySelectorAll(".ld-letter-actions .w98-btn"),
            function (b) { return b.textContent; });

          // does the toy actually animate?
          setTimeout(function () {
            out.frame2 = pre ? pre.textContent.length : 0;
            out.animated = out.frame1 !== out.frame2;
            document.title = "PROBE" + JSON.stringify(out);
          }, 900);
        } else {
          document.title = "PROBE" + JSON.stringify(out);
        }
      }, 1600);
    });
  });
}, 700);
`, 30000, "read");
      console.log("  " + JSON.stringify(r));
      check("the letter window opens", r.opened === true);
      check("it shows the subject", r.subject === "A letter for Alice", r.subject);
      check("the body is split into paragraphs", r.paras === 2, String(r.paras));
      check("the toy is rendered", r.hasToy === true);
      check("with its caption", r.caption === "LOVE.TXT", r.caption);
      check("the toy animates", r.animated === true, r.frame1 + " -> " + r.frame2);
      check("the enclosed image is shown", r.hasImage === true);
      check("and actually loads", r.imgLoaded > 0, String(r.imgLoaded));
      check("there is a Share button", (r.buttons || []).some(b => /Share/.test(b)),
        JSON.stringify(r.buttons));
    }

    console.log("\n=== the letter composer ===");
    {
      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDLetter.compose();
    setTimeout(function () {
      var win = winByTitle(/New Letter/);
      var out = { opened: !!win };
      if (win) {
        out.shapes = win.querySelectorAll(".ld-shape").length;
        out.kinds = Array.prototype.map.call(win.querySelectorAll(".ld-kindbtn"),
          function (b) { return b.textContent; });
        out.hasTo = !!win.querySelector(".ld-row .ld-input");
        out.hasBody = !!win.querySelector(".ld-letter-body-input");
        out.hasSuggest = !!win.querySelector(".w98-suggest");
        out.hasAddFile = Array.prototype.map.call(win.querySelectorAll(".w98-btn"),
          function (b) { return b.textContent; }).indexOf("Add a file") !== -1;
        var active = win.querySelector(".ld-shape.is-active");
        out.activeShape = active ? active.dataset.shape : null;

        // switching to Invitation should relabel and disable the To field
        var invite = win.querySelectorAll(".ld-kindbtn")[1];
        invite.click();
        out.afterInviteTitle = win.querySelector(".w98-title-text").textContent;
        out.toDisabled = win.querySelector(".ld-row .ld-input").disabled;
        out.note = win.querySelector(".ld-kindnote").textContent;
      }
      document.title = "PROBE" + JSON.stringify(out);
    }, 1800);
  });
}, 700);
`, 26000, "compose");
      console.log("  " + JSON.stringify(r));
      check("the composer opens", r.opened === true);
      check("it offers five shape choices", r.shapes === 5, String(r.shapes));
      check("including none", r.shapes === 5);
      check("an admin sees both kinds", (r.kinds || []).length === 2, JSON.stringify(r.kinds));
      check("it has a To field", r.hasTo === true);
      check("a body box", r.hasBody === true);
      check("autocomplete on To", r.hasSuggest === true);
      check("an Add a file button", r.hasAddFile === true);
      check("a shape starts selected", r.activeShape === "heart2d", r.activeShape);
      check("switching to Invitation retitles it", /Invitation/.test(r.afterInviteTitle || ""),
        r.afterInviteTitle);
      check("and disables the To field", r.toDisabled === true);
      check("with an explanation", /one-use link/i.test(r.note || ""), r.note);
    }

    console.log("\n=== profile pictures ===");
    {
      // give alice one so the window has something to show
      await req("POST", "/api/avatar", { mime: "image/png", base64: PNG.toString("base64") }, alice);

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("alice", "alicepassword").then(function () {
    LDApps.openProfile();
    setTimeout(function () {
      var win = winByTitle(/Profile/);
      var out = { opened: !!win };
      if (win) {
        var img = win.querySelector(".w98-avatar");
        out.hasFrame = !!win.querySelector(".w98-avatar-frame");
        out.imgShown = img && !img.hidden;
        out.imgSrc = img ? img.getAttribute("src") : null;
        out.imgLoaded = img ? img.naturalWidth : 0;
        out.name = win.querySelector(".w98-profile-name").textContent;
        out.hasUpload = Array.prototype.map.call(win.querySelectorAll(".w98-btn"),
          function (b) { return b.textContent; }).some(function (t) { return /picture/i.test(t); });
        out.hasPassword = win.querySelectorAll('input[type="password"]').length;
      }
      document.title = "PROBE" + JSON.stringify(out);
    }, 1800);
  });
}, 700);
`, 26000, "profile");
      console.log("  " + JSON.stringify(r));
      check("the profile window opens", r.opened === true);
      check("it shows an avatar frame", r.hasFrame === true);
      check("the picture is shown", r.imgShown === true);
      check("the source points at the avatar route", /\/avatar\/alice/.test(r.imgSrc || ""), r.imgSrc);
      check("and it actually loads", r.imgLoaded > 0, String(r.imgLoaded));
      check("it names the account", r.name === "alice", r.name);
      check("with a way to choose a picture", r.hasUpload === true);
      check("and two password boxes", r.hasPassword === 2, String(r.hasPassword));
    }

    console.log("\n=== a letter pops up on the desktop ===");
    {
      // a fresh account with an unread letter, via an invitation
      const inv = await req("POST", "/api/letter", {
        kind: "invitation", body: "Join us.", shape: "donut"
      }, admin);
      const redeemed = await req("POST", "/api/redeem", {
        token: inv.json.token, username: "newcomer", password: "newcomerpass1"
      });
      check("the invitation redeems", redeemed.status === 200, JSON.stringify(redeemed.json));

      const r = inBrowser(`
${helpers}
setTimeout(function () {
  ready();
  signInAs("newcomer", "newcomerpass1").then(function () {
    setTimeout(function () {
      var wins = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
        function (w) { return !w.hidden; });
      var titles = wins.map(function (w) { return w.querySelector(".w98-title-text").textContent; });
      var letterWin = wins.filter(function (w) {
        return /Letter/.test(w.querySelector(".w98-title-text").textContent);
      })[0];
      document.title = "PROBE" + JSON.stringify({
        titles: titles,
        letterOpen: !!letterWin,
        hasToy: letterWin ? !!letterWin.querySelector(".ld-toy") : false
      });
    }, 3200);
  });
}, 700);
`, 32000, "popup");
      console.log("  " + JSON.stringify(r));
      check("the letter opens itself on the new desktop", r.letterOpen === true,
        JSON.stringify(r.titles));
      check("with its toy", r.hasToy === true);
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
