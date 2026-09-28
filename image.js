/* ============================================================
   Letterdrop — image compression

   A photo straight off a phone is several megabytes and thousands of
   pixels wide, which is slow to upload, slow to share and produces a
   share link that takes seconds to load. Downscaling and re-encoding it
   in the browser before it is sent fixes all three, and the original
   never leaves the machine if it cannot be improved.

   Nothing here is lossy for its own sake: a file is only replaced if the
   result is actually smaller, and only for formats a browser can both
   decode and re-encode.
   ============================================================ */

(function (global) {
  "use strict";

  /* The longest edge of a stored image. 1600 is enough for a full-width
     view on any ordinary screen without being wasteful. */
  const MAX_EDGE = 1600;
  const QUALITY = 0.82;

  /* Below this there is nothing worth doing. */
  const MIN_BYTES = 200 * 1024;

  /* Formats we can decode and re-encode. SVG is deliberately excluded:
     rasterising it would throw away the reason to use it. */
  const COMPRESSIBLE = ["image/jpeg", "image/png", "image/webp"];

  function canCompress(file) {
    if (!file || !file.type) return false;
    if (COMPRESSIBLE.indexOf(file.type) === -1) return false;
    if (file.size < MIN_BYTES) return false;
    return true;
  }

  /* Load a File into an <img>. Rejects rather than hanging on a file the
     browser cannot decode. */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("not an image")); };
      img.src = url;
    });
  }

  /* Scale so the longest edge is at most `max`, never scaling up. */
  function fitSize(w, h, max) {
    if (w <= max && h <= max) return { width: w, height: h, scaled: false };
    const ratio = w > h ? max / w : max / h;
    return {
      width: Math.max(1, Math.round(w * ratio)),
      height: Math.max(1, Math.round(h * ratio)),
      scaled: true
    };
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) {
        canvas.toBlob(function (b) { resolve(b); }, type, quality);
        return;
      }
      // very old browsers: fall back to a data URL and convert it
      try {
        const data = canvas.toDataURL(type, quality);
        const bin = atob(data.split(",")[1]);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        resolve(new Blob([buf], { type: type }));
      } catch (e) { resolve(null); }
    });
  }

  /* Shrink one image. Resolves to a File either way: the original when it
     cannot be improved, so the caller never has to handle a failure. */
  function compress(file) {
    if (!canCompress(file)) {
      return Promise.resolve({ file: file, changed: false, reason: "not worth it" });
    }

    return loadImage(file).then(function (img) {
      const size = fitSize(img.naturalWidth, img.naturalHeight, MAX_EDGE);

      /* Re-encode as JPEG unless the source needs transparency, in which
         case keep it as PNG/WebP. */
      const keepAlpha = file.type === "image/png" || file.type === "image/webp";
      const outType = keepAlpha ? file.type : "image/jpeg";

      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");

      if (outType === "image/jpeg") {
        // JPEG has no alpha; a transparent PNG would come out black
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size.width, size.height);
      }
      ctx.drawImage(img, 0, 0, size.width, size.height);

      return toBlob(canvas, outType, QUALITY).then(function (blob) {
        if (!blob) return { file: file, changed: false, reason: "could not re-encode" };

        /* Only keep the result when it genuinely saves space. A small
           already-optimised JPEG can come out larger. */
        if (blob.size >= file.size) {
          return { file: file, changed: false, reason: "already small" };
        }

        const name = renameFor(file.name, outType);
        const out = new File([blob], name, { type: outType, lastModified: Date.now() });
        return {
          file: out,
          changed: true,
          from: { width: img.naturalWidth, height: img.naturalHeight, size: file.size },
          to: { width: size.width, height: size.height, size: blob.size },
          scaled: size.scaled
        };
      });
    }).catch(function () {
      // anything unreadable is passed through untouched
      return { file: file, changed: false, reason: "could not read it" };
    });
  }

  /* Give the file the extension its new type needs, so it is served with
     the right content type later. */
  function renameFor(name, type) {
    const ext = type === "image/jpeg" ? ".jpg"
      : type === "image/webp" ? ".webp"
      : ".png";
    const base = String(name || "image").replace(/\.[^./\\]*$/, "") || "image";
    return base + ext;
  }

  /* Human-readable summary, for the status line. */
  function describe(result) {
    if (!result || !result.changed) return "";
    const before = (result.from.size / 1048576).toFixed(1);
    const after = (result.to.size / 1048576).toFixed(1);
    const pct = Math.round((1 - result.to.size / result.from.size) * 100);
    const dims = result.from.width + "\u00D7" + result.from.height +
      " \u2192 " + result.to.width + "\u00D7" + result.to.height;
    return "shrunk " + before + " MB to " + after + " MB (" + pct + "%), " + dims;
  }

  global.LDImage = {
    compress: compress,
    canCompress: canCompress,
    describe: describe,
    fitSize: fitSize,
    renameFor: renameFor,
    MAX_EDGE: MAX_EDGE,
    QUALITY: QUALITY,
    MIN_BYTES: MIN_BYTES
  };
})(window);
