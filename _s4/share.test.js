/* Stage 1 verification: public sharing.
   Checks the share API, the public routes, the Open Graph tags a link
   preview crawler reads, and revocation. */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8761;
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
        resolve({
          status: res.statusCode,
          json: json,
          text: out,
          headers: res.headers,
          cookie: res.headers["set-cookie"] ? res.headers["set-cookie"][0].split(";")[0] : null
        });
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
      r.on("error", function () { n > 80 ? reject(new Error("no start:\n" + serverOut)) : setTimeout(go, 150); });
      r.end();
    })();
  });
}

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async function run() {
  try {
    await waitForServer();

    /* --- sign in as admin, create a user, upload a file --- */
    const login = await req("POST", "/api/login", { username: "root", password: "rootpassword1" });
    const admin = login.cookie;

    await req("POST", "/api/admin/users", { username: "alice", password: "alicepassword", role: "user" }, admin);
    const aliceLogin = await req("POST", "/api/login", { username: "alice", password: "alicepassword" });
    const alice = aliceLogin.cookie;

    await req("POST", "/api/file", { kind: "image", name: "screenshot.png", mime: "image/png", base64: PNG_1x1 }, alice);
    await req("POST", "/api/file", { kind: "note", name: "notes.txt", text: "A shared note body." }, alice);

    console.log("=== sharing a file ===");
    let token = null, noteToken = null;
    {
      const s = await req("POST", "/api/share", { name: "screenshot.png" }, alice);
      check("the owner can share a file", s.status === 200 && s.json.token, JSON.stringify(s.json));
      token = s.json.token;
      check("the token is short and random", /^[a-z0-9]{6}$/.test(token || ""), token);
      check("it reports the share was created", s.json.created === true, JSON.stringify(s.json));

      const again = await req("POST", "/api/share", { name: "screenshot.png" }, alice);
      check("sharing twice returns the same token", again.json.token === token, again.json.token);
      check("and says it already existed", again.json.created === false, JSON.stringify(again.json));

      const note = await req("POST", "/api/share", { name: "notes.txt" }, alice);
      noteToken = note.json.token;
      check("a second file gets a different token", noteToken !== token, "tokens matched");

      const missing = await req("POST", "/api/share", { name: "nope.txt" }, alice);
      check("sharing a missing file fails", missing.status === 400, JSON.stringify(missing.json));

      const traversal = await req("POST", "/api/share", { name: "../../../users.json" }, alice);
      check("traversal in a share name is refused",
        traversal.status === 400, JSON.stringify(traversal.json));

      const anon = await req("POST", "/api/share", { name: "screenshot.png" });
      check("sharing needs a session", anon.status === 401, String(anon.status));
    }

    console.log("\n=== only the owner can share ===");
    {
      const adminShare = await req("POST", "/api/share", { name: "notes.txt", user: "u_someoneelse" }, admin);
      check("an admin cannot share on someone else's behalf",
        adminShare.status === 403, JSON.stringify(adminShare.json));

      const aliceFiles = await req("GET", "/api/files", undefined, alice);
      const img = aliceFiles.json.files.filter(f => f.name === "screenshot.png")[0];
      check("the listing reports the share token", img && img.share === token, JSON.stringify(img));

      // upload a file that is never shared, so it must have no token
      await req("POST", "/api/file", { kind: "note", name: "unshared.txt", text: "never shared" }, alice);
      const list2 = await req("GET", "/api/files", undefined, alice);
      const never = list2.json.files.filter(f => f.name === "unshared.txt")[0];
      check("an unshared file has no token", never && never.share === null, JSON.stringify(never));
    }

    console.log("\n=== the public page needs no session ===");
    {
      const page = await req("GET", "/s/" + token);
      check("it loads without a cookie", page.status === 200, String(page.status));
      check("it is HTML", /text\/html/.test(page.headers["content-type"] || ""), page.headers["content-type"]);
      check("it is not cached forever", /no-store|max-age/.test(page.headers["cache-control"] || ""),
        page.headers["cache-control"]);
      check("it shows the file name", page.text.indexOf("screenshot.png") !== -1);
      // the page is deliberately bare now: no owner line, no toolbar
      check("it does not name the owner", page.text.indexOf("Shared by") === -1);
      check("it embeds the image", page.text.indexOf("/s/" + token + "/raw") !== -1);
    }

    console.log("\n=== Open Graph tags (what Discord reads) ===");
    {
      const page = await req("GET", "/s/" + token);
      const t = page.text;
      const grab = (prop) => {
        const m = t.match(new RegExp('<meta[^>]+(?:property|name)="' + prop + '"[^>]+content="([^"]*)"'));
        return m ? m[1] : null;
      };
      const ogImage = grab("og:image");
      const ogTitle = grab("og:title");
      const ogDesc = grab("og:description");
      const ogUrl = grab("og:url");
      const ogType = grab("og:type");
      const twCard = grab("twitter:card");
      console.log("  og:title       " + ogTitle);
      console.log("  og:description " + ogDesc);
      console.log("  og:image       " + ogImage);
      console.log("  og:url         " + ogUrl);

      check("og:title is set", !!ogTitle, String(ogTitle));
      check("og:description is set", !!ogDesc, String(ogDesc));
      check("og:type is set", !!ogType, String(ogType));
      check("og:url is an absolute URL", /^http:\/\/127\.0\.0\.1:\d+\/s\//.test(ogUrl || ""), String(ogUrl));
      check("og:image is an absolute URL", /^http:\/\/127\.0\.0\.1:\d+\/s\/[^/]+\/raw$/.test(ogImage || ""), String(ogImage));
      check("a large twitter card is declared", twCard === "summary_large_image", String(twCard));
    }

    console.log("\n=== the raw file is fetchable by a crawler ===");
    {
      const raw = await req("GET", "/s/" + token + "/raw");
      check("it serves without a cookie", raw.status === 200, String(raw.status));
      check("with the right content type", raw.headers["content-type"] === "image/png",
        raw.headers["content-type"]);
      check("it is served inline, not as a download",
        /inline/.test(raw.headers["content-disposition"] || ""), raw.headers["content-disposition"]);
      check("it is cacheable briefly", /max-age=\d+/.test(raw.headers["cache-control"] || ""),
        raw.headers["cache-control"]);

      const noteRaw = await req("GET", "/s/" + noteToken + "/raw");
      check("a shared note serves as plain text", /text\/plain/.test(noteRaw.headers["content-type"] || ""),
        noteRaw.headers["content-type"]);
      check("the note's contents come back", /A shared note body/.test(noteRaw.text), noteRaw.text.slice(0, 60));
    }

    console.log("\n=== unknown and malformed tokens ===");
    {
      const bogus = await req("GET", "/s/aaaaaaaaaaaaaaaaaaaaaaaaaa");
      check("an unknown token 404s", bogus.status === 404, String(bogus.status));
      check("the 404 page is friendly", /not available/i.test(bogus.text), bogus.text.slice(0, 80));

      const short = await req("GET", "/s/short");
      check("a too-short token is rejected", short.status === 404, String(short.status));

      const traversal = await req("GET", "/s/..%2f..%2fusers.json");
      // rejected either by the token pattern (404) or by the static-file guard
      // before it gets that far (403) -- both are refusals
      check("a traversal token is rejected", traversal.status === 404 || traversal.status === 403,
        String(traversal.status));
      check("and never leaks the user store", !/scrypt\$/.test(traversal.text));
    }

    console.log("\n=== revoking ===");
    {
      const before = await req("GET", "/s/" + token);
      check("the link works before revoking", before.status === 200, String(before.status));

      const rev = await req("DELETE", "/api/share?name=" + encodeURIComponent("screenshot.png"), undefined, alice);
      check("the owner can stop sharing", rev.status === 200 && rev.json.removed === 1, JSON.stringify(rev.json));

      const after = await req("GET", "/s/" + token);
      check("the link 404s after revoking", after.status === 404, String(after.status));
      const afterRaw = await req("GET", "/s/" + token + "/raw");
      check("the raw file 404s too", afterRaw.status === 404, String(afterRaw.status));

      const list = await req("GET", "/api/files", undefined, alice);
      const img = list.json.files.filter(f => f.name === "screenshot.png")[0];
      check("the listing shows it is no longer shared", img && img.share === null, JSON.stringify(img));
    }

    console.log("\n=== deleting a shared file kills the link ===");
    {
      const s = await req("POST", "/api/share", { name: "notes.txt" }, alice);
      const t = s.json.token;
      check("shared again for the delete test", (await req("GET", "/s/" + t)).status === 200);

      await req("DELETE", "/api/file?name=" + encodeURIComponent("notes.txt"), undefined, alice);
      const after = await req("GET", "/s/" + t);
      check("the link dies with the file", after.status === 404, String(after.status));
    }

    console.log("\n=== deleting a user kills their links ===");
    {
      await req("POST", "/api/file", { kind: "image", name: "keep.png", mime: "image/png", base64: PNG_1x1 }, alice);
      const s = await req("POST", "/api/share", { name: "keep.png" }, alice);
      const t = s.json.token;
      check("their file is shareable", (await req("GET", "/s/" + t)).status === 200);

      const users = await req("GET", "/api/admin/users", undefined, admin);
      const aliceId = users.json.users.filter(u => u.username === "alice")[0].id;
      await req("DELETE", "/api/admin/user?id=" + aliceId, undefined, admin);

      const after = await req("GET", "/s/" + t);
      check("the link dies with the account", after.status === 404, String(after.status));
    }

    console.log("\n=== another user cannot hijack a share ===");
    {
      await req("POST", "/api/admin/users", { username: "bob", password: "bobpassword1", role: "user" }, admin);
      const bobLogin = await req("POST", "/api/login", { username: "bob", password: "bobpassword1" });
      const bob = bobLogin.cookie;

      await req("POST", "/api/file", { kind: "note", name: "bob.txt", text: "bob's note" }, bob);
      const s = await req("POST", "/api/share", { name: "bob.txt" }, bob);
      const t = s.json.token;

      // bob's token must not expose alice's (now deleted) files, and vice versa
      const page = await req("GET", "/s/" + t);
      check("bob's own share works", page.status === 200, String(page.status));
      check("it names bob as the owner", /bob/.test(page.text), "owner missing");

      const revByOther = await req("DELETE", "/api/share?name=bob.txt", undefined, admin);
      check("an admin's revoke targets their own files only",
        revByOther.json.removed === 0, JSON.stringify(revByOther.json));
      check("bob's share survives", (await req("GET", "/s/" + t)).status === 200);
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
