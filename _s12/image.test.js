/* Verify image compression in a real browser: does a large photo get
   genuinely smaller, stay the right shape, and land in Documents? */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");

const DIR = "C:\\Users\\user\\Downloads\\Letter";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 8901;
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
  const p = path.join(DIR, "_probe_img" + tag + ".html");
  fs.writeFileSync(p, src.replace("</body>", "<script>" + script + "</script></body>"), "utf8");
  const dumpFile = path.join(DIR, "_probe_img" + tag + ".txt");
  const fd = fs.openSync(dumpFile, "w");
  const __profile = path.join(TMP, "dshimg-" + tag + "-" + Date.now());
try {
  execFileSync(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--window-size=1280,900", "--virtual-time-budget=" + (budget || 40000), "--dump-dom",
      "--user-data-dir=" + __profile,
      BASE + "/_probe_img" + tag + ".html"],
      { stdio: ["ignore", fd, "ignore"] });
} finally {
  dropProfile(__profile);
}
  fs.closeSync(fd);
  const dump = fs.readFileSync(dumpFile, "utf8");
  const m = dump.match(/<title>PROBE([\s\S]*?)<\/title>/);
  return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
}

/* A script the browser runs: build a big noisy image on a canvas, turn it
   into a File, and push it through the compressor. Noise compresses
   badly, which is the honest worst case. */
const IMAGE_PROBE = `
function makeImageFile(w, h, type, name) {
  var c = document.createElement("canvas");
  c.width = w; c.height = h;
  var ctx = c.getContext("2d");
  var img = ctx.createImageData(w, h);
  for (var i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i * 7) % 256;
    img.data[i+1] = (i * 13) % 256;
    img.data[i+2] = (i * 29) % 256;
    img.data[i+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise(function (resolve) {
    c.toBlob(function (b) {
      resolve(new File([b], name, { type: type }));
    }, type, 0.95);
  });
}
`;

(async function run() {
  try {
    await waitForServer();
    const admin = (await req("POST", "/api/login", { username: "root", password: "rootpassword1" })).cookie;

    console.log("=== a large photo is shrunk ===");
    {
      const r = inBrowser(`
${IMAGE_PROBE}
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
  makeImageFile(4000, 3000, "image/jpeg", "holiday.jpg").then(function (file) {
    var out = { originalBytes: file.size, originalType: file.type };
    return LDImage.compress(file).then(function (res) {
      out.changed = res.changed;
      out.newBytes = res.file.size;
      out.newType = res.file.type;
      out.newName = res.file.name;
      out.from = res.from;
      out.to = res.to;
      out.scaled = res.scaled;
      out.smaller = res.file.size < file.size;
      out.description = LDImage.describe(res);
      document.title = "PROBE" + JSON.stringify(out);
    });
  }).catch(function (e) {
    document.title = "PROBE" + JSON.stringify({ error: String(e.message) });
  });
}, 900);
`, 44000, "big");
      console.log("  " + JSON.stringify(r));
      check("the probe ran", !r.error, r.error);
      check("a large JPEG is compressed", r.changed === true);
      check("the result is smaller", r.smaller === true,
        (r.originalBytes / 1048576).toFixed(1) + " MB -> " + (r.newBytes / 1048576).toFixed(1) + " MB");
      check("it is scaled down to fit", r.scaled === true);
      check("the longest edge is within the limit",
        Math.max(r.to.width, r.to.height) <= 1600,
        r.to.width + "x" + r.to.height);
      check("the aspect ratio is kept",
        Math.abs((r.from.width / r.from.height) - (r.to.width / r.to.height)) < 0.01,
        (r.from.width / r.from.height).toFixed(3) + " vs " + (r.to.width / r.to.height).toFixed(3));
      check("it keeps a sensible type", r.newType === "image/jpeg", r.newType);
      check("the name keeps its extension", /\.jpg$/.test(r.newName || ""), r.newName);
      check("there is a readable description", /shrunk/.test(r.description || ""), r.description);
    }

    console.log("\n=== a small image is left alone ===");
    {
      const r = inBrowser(`
${IMAGE_PROBE}
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
  makeImageFile(300, 200, "image/jpeg", "small.jpg").then(function (file) {
    var out = { originalBytes: file.size, canCompress: LDImage.canCompress(file) };
    return LDImage.compress(file).then(function (res) {
      out.changed = res.changed;
      out.sameSize = res.file.size === file.size;
      out.reason = res.reason;
      document.title = "PROBE" + JSON.stringify(out);
    });
  });
}, 900);
`, 30000, "small");
      console.log("  " + JSON.stringify(r));
      check("a small image is skipped", r.canCompress === false);
      check("and passed through unchanged", r.changed === false);
      check("at its original size", r.sameSize === true);
    }

    console.log("\n=== a non-image is left alone ===");
    {
      const r = inBrowser(`
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;
  var big = new File([new Uint8Array(400000)], "archive.zip", { type: "application/zip" });
  var svg = new File([new Uint8Array(400000)], "drawing.svg", { type: "image/svg+xml" });
  var out = {
    zip: LDImage.canCompress(big),
    svg: LDImage.canCompress(svg)
  };
  LDImage.compress(big).then(function (res) {
    out.zipChanged = res.changed;
    out.zipReason = res.reason;
    document.title = "PROBE" + JSON.stringify(out);
  });
}, 900);
`, 28000, "other");
      console.log("  " + JSON.stringify(r));
      check("a zip is not touched", r.zip === false);
      check("an SVG is not rasterised", r.svg === false);
      check("and passing one through is a no-op", r.zipChanged === false, r.zipReason);
    }

    console.log("\n=== uploading a photo through My Documents shrinks it ===");
    {
      const r = inBrowser(`
${IMAGE_PROBE}
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  LDApps.openSignIn(function () {});
  setTimeout(function () {
    var inputs = document.querySelectorAll(".w98-signin input");
    inputs[0].value = "root";
    inputs[1].value = "rootpassword1";
    document.querySelector(".w98-signin-actions .w98-btn").click();

    setTimeout(function () {
      Array.prototype.forEach.call(document.querySelectorAll(".w98-dialog"), function (d) {
        if (d.hidden) return;
        var ok = Array.prototype.filter.call(d.querySelectorAll(".w98-btn"),
          function (b) { return /OK/i.test(b.textContent); })[0];
        if (ok) ok.click();
      });

      LDApps.openDocuments();
      setTimeout(function () {
        var win = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
          function (w) { return !w.hidden && /Documents/.test(
            w.querySelector(".w98-title-text").textContent); })[0];
        if (!win) { document.title = "PROBE" + JSON.stringify({ noWindow: true }); return; }

        makeImageFile(3000, 2000, "image/jpeg", "big-photo.jpg").then(function (file) {
          // put it in the hidden file input and fire the change event
          var input = win.querySelector(".w98-upload-input");
          var dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));

          setTimeout(function () {
            LD.listFiles().then(function (res) {
              var uploaded = (res.files || []).filter(function (f) {
                return /^big-photo/.test(f.name);
              })[0];
              document.title = "PROBE" + JSON.stringify({
                uploaded: !!uploaded,
                name: uploaded ? uploaded.name : null,
                size: uploaded ? uploaded.size : null,
                originalSize: file.size,
                smaller: uploaded ? uploaded.size < file.size : null,
                status: win.querySelector(".w98-statusbar span").textContent
              });
            });
          }, 9000);
        });
      }, 1800);
    }, 2400);
  }, 400);
}, 900);
`, 60000, "upload");
      console.log("  " + JSON.stringify(r));
      check("the upload landed", r.uploaded === true);
      check("it is stored smaller than the original", r.smaller === true,
        r.originalSize + " -> " + r.size);
      check("with the same base name", /^big-photo\./.test(r.name || ""), r.name);
      check("the status line says it shrank", /[Ss]hrunk/.test(r.status || ""), r.status);
    }

    console.log("\n=== a huge photo can now be used as an avatar ===");
    {
      const r = inBrowser(`
${IMAGE_PROBE}
setTimeout(function () {
  document.getElementById("bios").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("aol").hidden = true;

  LDApps.openSignIn(function () {});
  setTimeout(function () {
    var inputs = document.querySelectorAll(".w98-signin input");
    inputs[0].value = "root";
    inputs[1].value = "rootpassword1";
    document.querySelector(".w98-signin-actions .w98-btn").click();

    setTimeout(function () {
      Array.prototype.forEach.call(document.querySelectorAll(".w98-dialog"), function (d) {
        if (d.hidden) return;
        var ok = Array.prototype.filter.call(d.querySelectorAll(".w98-btn"),
          function (b) { return /OK/i.test(b.textContent); })[0];
        if (ok) ok.click();
      });

      LDApps.openProfile();
      setTimeout(function () {
        var win = Array.prototype.filter.call(document.querySelectorAll(".w98-win"),
          function (w) { return !w.hidden && /Profile/.test(
            w.querySelector(".w98-title-text").textContent); })[0];
        if (!win) { document.title = "PROBE" + JSON.stringify({ noWindow: true }); return; }

        // 3 MB: too big for the avatar limit before shrinking
        makeImageFile(3500, 2500, "image/jpeg", "me.jpg").then(function (file) {
          var out = { originalSize: file.size, overLimit: file.size > 2*1024*1024 };
          var input = win.querySelector('input[type="file"]');
          var dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));

          setTimeout(function () {
            LD.me().then(function (res) {
              out.avatarSet = !!res.user.avatar;
              out.note = win.querySelector(".w98-signin-msg").textContent;
              document.title = "PROBE" + JSON.stringify(out);
            });
          }, 9000);
        });
      }, 1800);
    }, 2400);
  }, 400);
}, 900);
`, 60000, "avatar");
      console.log("  " + JSON.stringify(r));
      check("the photo was over the avatar limit", r.overLimit === true,
        (r.originalSize / 1048576).toFixed(1) + " MB");
      check("it is accepted anyway, because it was shrunk", r.avatarSet === true);
      check("and the message says so", /[Ss]hrunk/.test(r.note || ""), r.note);
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
