/* Stage 3 verification: the composer runs inside the desktop, and the
   recipient page stays functionless. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8751;
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
let serverOut = "";
server.stdout.on("data", d => serverOut += d.toString());
server.stderr.on("data", d => serverOut += d.toString());

function waitForServer() {
  return new Promise(function (resolve, reject) {
    let n = 0;
    (function go() {
      n++;
      const r = http.request(BASE + "/api/me", function (res) { res.resume(); resolve(); });
      r.on("error", function () { n > 80 ? reject(new Error("no start:\n" + serverOut)) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

function inBrowser(pathAndQuery, probe, budget) {
  const src = fs.readFileSync(path.join(DIR, "card.html"), "utf8");
  const p = path.join(DIR, "_probe_s3.html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + probe + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_s3_dump.txt");
  const fd = fs.openSync(dumpFile, "w");
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--window-size=1280,900", "--virtual-time-budget=" + (budget || 40000), "--dump-dom",
    "--user-data-dir=" + TMP + "\\dshs3", BASE + (pathAndQuery || "/_probe_s3.html")],
    { stdio: ["ignore", fd, "ignore"] });
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
}

const signIn = `
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
      setTimeout(function () { resolve(null); }, 2200);
    }, 300);
  });
}
`;

(async function run() {
  try {
    await waitForServer();

    console.log("=== the composer opens inside the desktop ===");
    {
      const r = inBrowser("/_probe_s3.html", `
${signIn}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDComposer.open();
    setTimeout(function () {
      var wins = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
        function (w) { return !w.hidden; });
      var titles = wins.map(function (w) { return w.querySelector(".w98-title-text").textContent; });
      document.title = "PROBE" + JSON.stringify({
        winCount: wins.length,
        titles: titles,
        hasForm: !!document.querySelector(".ld-form"),
        fields: {
          to: !!document.getElementById("to"),
          from: !!document.getElementById("from"),
          note: !!document.getElementById("note"),
          trackEditor: !!document.getElementById("trackEditor"),
          themePicker: !!document.getElementById("themePicker"),
          shapePicker: !!document.getElementById("shapePicker"),
          createBtn: !!document.getElementById("createBtn")
        },
        createLoaded: typeof window.LD !== "undefined"
      });
    }, 1600);
  });
}, 700);
`, 30000);
      console.log("  " + JSON.stringify(r, null, 1).replace(/\n/g, "\n  "));
      check("the composer window opens", r.winCount === 1, String(r.winCount));
      check("it is titled as Letterdrop", /Letterdrop/.test((r.titles || []).join(" ")), JSON.stringify(r.titles));
      check("the form is present", r.hasForm === true);
      check("all the ids create.js needs exist",
        Object.keys(r.fields).every(function (k) { return r.fields[k]; }), JSON.stringify(r.fields));
    }

    console.log("\n=== it produces a working link ===");
    {
      const r = inBrowser("/_probe_s3.html", `
${signIn}
setTimeout(function () {
  ready();
  signInAs("root", "rootpassword1").then(function () {
    LDComposer.open();
    setTimeout(function () {
      document.getElementById("to").value = "Mira";
      document.getElementById("from").value = "Sam";
      document.getElementById("note").value = "Typed inside the desktop.";
      // fill the first track row using the classes create.js actually emits
      var row = document.querySelector("#trackEditor .track-row");
      var link = row.querySelector(".tr-link");
      link.value = "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT";
      link.dispatchEvent(new Event("input", { bubbles: true }));
      var fields = row.querySelectorAll(".tr-fields input");
      fields[1].value = "Perfect";
      fields[1].dispatchEvent(new Event("input", { bubbles: true }));
      fields[2].value = "Ed Sheeran";
      fields[2].dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("createBtn").click();
      setTimeout(function () {
        var out = document.getElementById("linkOut").value;
        var frag = out.slice(out.indexOf("#") + 1).replace(/-/g, "+").replace(/_/g, "/");
        while (frag.length % 4) frag += "=";
        var bin = atob(frag), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var payload = JSON.parse(new TextDecoder().decode(bytes));
        document.title = "PROBE" + JSON.stringify({
          hasLink: out.indexOf("#") !== -1,
          resultShown: document.getElementById("result").classList.contains("show"),
          payload: payload,
          toast: document.getElementById("toast").textContent
        });
      }, 900);
    }, 1600);
  });
}, 700);
`, 32000);
      console.log("  " + JSON.stringify(r, null, 1).replace(/\n/g, "  "));
      check("a link is produced", r.hasLink === true);
      check("the result box is shown", r.resultShown === true);
      check("the payload carries to/from/note",
        r.payload.to === "Mira" && r.payload.from === "Sam" && r.payload.note === "Typed inside the desktop.",
        JSON.stringify(r.payload));
      check("the track made it into the payload",
        Array.isArray(r.payload.tracks) && r.payload.tracks.length === 1 &&
        r.payload.tracks[0].n === "Perfect" && r.payload.tracks[0].a === "Ed Sheeran",
        JSON.stringify(r.payload.tracks));
      check("the shape is included", !!r.payload.shape, r.payload.shape);
    }

    console.log("\n=== the recipient's letter still opens ===");
    {
      // build a link, then render it as a recipient would
      const payloadObj = {
        to: "Mira", from: "Sam", note: "Hello from the desktop.\n\nSecond line.",
        date: "2000-09-23", shape: "heart2d",
        tracks: [{ t: "track", i: "4cOdK2wGLETKBW3PvgPWqT", n: "Perfect", a: "Ed Sheeran" }]
      };
      const frag = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

      const r = inBrowser("/_probe_s3.html#" + frag, `
setTimeout(function () { document.getElementById("bios").click(); }, 300);
var waited = 0;
var iv = setInterval(function () {
  waited += 200;
  var win = document.querySelector(".w98-win");
  if (win) {
    clearInterval(iv);
    document.title = "PROBE" + JSON.stringify({
      mailOpen: !!document.querySelector(".w98-mail-body"),
      paras: document.querySelectorAll(".w98-mail-body p").length,
      songs: document.querySelectorAll(".w98-song").length,
      toy: !!document.querySelector(".w98-toy"),
      hasComposerForm: !!document.querySelector(".ld-form"),
      welcome: document.getElementById("aolSub") ? document.getElementById("aolSub").textContent : null
    });
  }
  if (waited > 60000) { clearInterval(iv); document.title = "PROBE" + JSON.stringify({ mailOpen: false }); }
}, 200);
`, 70000);
      console.log("  " + JSON.stringify(r));
      check("the letter opens by itself", r.mailOpen === true, JSON.stringify(r));
      check("the note is split into paragraphs", r.paras === 2, String(r.paras));
      check("the song is attached", r.songs === 1, String(r.songs));
      check("the desktop toy shows", r.toy === true);
      check("the composer is NOT opened for a recipient", r.hasComposerForm === false);
    }

    console.log("\n=== a broken link shows the error, not the desktop ===");
    {
      const r = inBrowser("/_probe_s3.html#not-a-real-payload", `
setTimeout(function () {
  document.title = "PROBE" + JSON.stringify({
    showsError: /could not be displayed/.test(document.body.textContent),
    hasDesktop: !!document.getElementById("iconLayer")
  });
}, 1200);
`, 12000);
      console.log("  " + JSON.stringify(r));
      check("a malformed link shows the error state", r.showsError === true, JSON.stringify(r));
    }

    console.log("\n=== the plain desktop boot offers no letter ===");
    {
      const r = inBrowser("/_probe_s3.html", `
setTimeout(function () {
  document.getElementById("bios").click();
  setTimeout(function () {
    document.title = "PROBE" + JSON.stringify({
      aolSub: document.getElementById("aolSub").textContent,
      anyWindow: document.querySelectorAll(".w98-win").length,
      icons: document.querySelectorAll(".w98-icon").length
    });
  }, 14000);
}, 300);
`, 30000);
      console.log("  " + JSON.stringify(r));
      check("it reports no new messages", /no new messages/.test(r.aolSub || ""), r.aolSub);
      check("no letter window is forced open", r.anyWindow === 0, String(r.anyWindow));
      check("the desktop is still there", r.icons >= 15, String(r.icons));
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
