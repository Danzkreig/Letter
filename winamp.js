/* ============================================================
   Letterdrop — Winamp

   A media player for the audio and video in your Documents. It uses
   the browser's own <audio>/<video> elements pointed at /api/raw, so
   big files stream and seeking works without loading them into memory.
   ============================================================ */

(function (global) {
  "use strict";

  let UI = null;

  function init(ui) { UI = ui; }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  let player = null;

  function open(fileName) {
    if (player && !player.win.hidden) {
      UI.focusWindow(player.win);
      if (fileName) load(fileName);
      return player;
    }

    const built = UI.makeWindow({
      title: "Winamp",
      icon: "assets/winamp2-32x32.png",
      width: 380, height: 420, x: 200, y: 100
    });

    /* ---------- the screen ---------- */
    const screen = el("div", "wa-screen");
    const video = document.createElement("video");
    video.className = "wa-video";
    video.playsInline = true;
    video.hidden = true;
    const art = el("div", "wa-art", "\u266B");
    screen.appendChild(video);
    screen.appendChild(art);

    const scroller = el("div", "wa-scroller");
    const scrollerText = el("span", null, "Winamp  \u2014  it really whips the llama's ass");
    scroller.appendChild(scrollerText);

    /* ---------- transport ---------- */
    const bar = el("div", "wa-bar");
    const playBtn = el("button", "wa-btn", "\u25B6");
    playBtn.type = "button";
    playBtn.title = "Play";
    const stopBtn = el("button", "wa-btn", "\u25A0");
    stopBtn.type = "button";
    stopBtn.title = "Stop";
    const prevBtn = el("button", "wa-btn", "\u23EE");
    prevBtn.type = "button";
    prevBtn.title = "Previous";
    const nextBtn = el("button", "wa-btn", "\u23ED");
    nextBtn.type = "button";
    nextBtn.title = "Next";
    [prevBtn, playBtn, stopBtn, nextBtn].forEach(function (b) { bar.appendChild(b); });

    const seek = document.createElement("input");
    seek.type = "range";
    seek.className = "wa-seek";
    seek.min = "0";
    seek.max = "1000";
    seek.value = "0";
    seek.setAttribute("aria-label", "Seek");

    const times = el("div", "wa-times");
    const now = el("span", null, "0:00");
    const total = el("span", null, "0:00");
    times.appendChild(now);
    times.appendChild(total);

    const volumeRow = el("div", "wa-volume");
    volumeRow.appendChild(el("span", "wa-vol-label", "VOL"));
    const vol = document.createElement("input");
    vol.type = "range";
    vol.className = "wa-vol";
    vol.min = "0";
    vol.max = "100";
    vol.value = "80";
    vol.setAttribute("aria-label", "Volume");
    volumeRow.appendChild(vol);

    /* ---------- playlist ---------- */
    const listHead = el("div", "wa-listhead", "Playlist");
    const list = el("div", "wa-list");
    const status = el("div", "wa-status", "Double-click a track, or use Open.");
    const openBtn = el("button", "wa-btn wa-open", "Open");
    openBtn.type = "button";

    const head = el("div", "wa-headrow");
    head.appendChild(openBtn);
    head.appendChild(listHead);

    built.body.appendChild(screen);
    built.body.appendChild(scroller);
    built.body.appendChild(bar);
    built.body.appendChild(seek);
    built.body.appendChild(times);
    built.body.appendChild(volumeRow);
    built.body.appendChild(head);
    built.body.appendChild(list);
    built.body.appendChild(status);

    /* ---------- state ---------- */
    let tracks = [];       // [{ name, kind, size }]
    let index = -1;

    player = {
      win: built.win, video: video, load: load, list: list,
      getTracks: function () { return tracks; }
    };

    const audio = document.createElement("audio");
    audio.preload = "metadata";

    let current = audio;

    function pick(kind) {
      const next = kind === "video" ? video : audio;
      if (next === current) return;
      try { current.pause(); } catch (e) {}
      next.currentTime = 0;
      current = next;
      video.hidden = kind !== "video";
      art.hidden = kind === "video";
    }

    /* ---------- loading ---------- */
    function load(name) {
      const track = tracks.filter(function (t) { return t.name === name; })[0];

      if (!name || !track) {
        // no name given: open the picker
        pickTrackDialog();
        return;
      }

      index = tracks.indexOf(track);
      pick(track.kind);

      current.src = LD.rawUrl(track.name);
      current.volume = Number(vol.value) / 100;
      scrollerText.textContent = track.name + "  \u2014  " + fmtSize(track.size);
      status.textContent = track.name;
      UI.setWindowTitle(built.win, track.name + " - Winamp");

      if (!track.kind || (track.kind !== "audio" && track.kind !== "video")) {
        audio.src = "";
        video.src = "";
        status.textContent = track.name + " cannot be played here.";
        return;
      }

      current.play().catch(function () {
        // autoplay can be blocked; the transport still works
        status.textContent = track.name + "  (press play)";
      });
      renderList();
    }

    function playPause() {
      if (!current.src) { pickTrackDialog(); return; }
      if (current.paused) current.play().catch(function () {});
      else current.pause();
    }

    function step(delta) {
      if (!tracks.length) return;
      const playable = tracks.filter(function (t) { return t.kind === "audio" || t.kind === "video"; });
      if (!playable.length) { UI.infoBox("Winamp", "Nothing here can be played."); return; }
      const at = playable.findIndex(function (t) { return t.name === status.textContent; });
      const nextAt = at < 0 ? 0 : (at + delta + playable.length) % playable.length;
      load(playable[nextAt].name);
    }

    /* ---------- the playlist ---------- */
    function renderList() {
      list.textContent = "";
      if (!tracks.length) {
        list.appendChild(el("div", "w98-hint", "Nothing in your Documents yet."));
        return;
      }
      tracks.forEach(function (t) {
        const row = el("div", "wa-row" + (t.name === (index >= 0 && tracks[index] && tracks[index].name) ? " is-current" : ""));
        row.tabIndex = 0;

        const icon = el("span", "wa-rowicon",
          t.kind === "video" ? "\uD83C\uDFA5" : t.kind === "audio" ? "\u266B" : "\u2022");
        row.appendChild(icon);
        row.appendChild(el("span", "wa-rowname", t.name));
        row.appendChild(el("span", "wa-rowsize", fmtSize(t.size)));

        const go = function () { load(t.name); };
        row.addEventListener("dblclick", go);
        row.addEventListener("click", go);
        row.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); go(); }
        });
        list.appendChild(row);
      });
    }

    function refresh() {
      LD.listFiles().then(function (res) {
        tracks = (res.files || []).filter(function (f) {
          return f.kind === "audio" || f.kind === "video";
        });
        renderList();
        status.textContent = tracks.length
          ? tracks.length + " playable file(s) in your Documents."
          : "No audio or video in your Documents yet.";
      }).catch(function (e) { status.textContent = e.message; });
    }

    /* A picker, for when Winamp is opened on its own. */
    let picker = null;
    function pickTrackDialog() {
      if (picker && !picker.win.hidden) { UI.focusWindow(picker.win); return; }

      const built2 = UI.makeWindow({
        title: "Open Media",
        icon: "assets/winamp2-32x32.png",
        width: 420, height: 320, x: 300, y: 180
      });
      picker = built2;

      const box = el("div", "w98-filelist");
      const hint = el("div", "w98-hint",
        "Upload an mp3 or an mp4 from My Documents first.");

      LD.listFiles().then(function (res) {
        const media = (res.files || []).filter(function (f) {
          return f.kind === "audio" || f.kind === "video";
        });
        if (!media.length) {
          box.appendChild(hint);
          return;
        }
        media.forEach(function (f) {
          const row = el("div", "w98-filerow w98-pickrow");
          row.tabIndex = 0;
          const icon = el("img");
          icon.src = "assets/winamp2-32x32.png";
          icon.alt = "";
          row.appendChild(icon);
          row.appendChild(el("span", "w98-filename", f.name));
          row.appendChild(el("span", "w98-filekind", f.kind === "video" ? "Video" : "Audio"));
          row.appendChild(el("span", "w98-filesize", fmtSize(f.size)));

          const go = function () { built2.win.hidden = true; load(f.name); };
          row.addEventListener("dblclick", go);
          row.addEventListener("click", go);
          row.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); go(); }
          });
          box.appendChild(row);
        });
      }).catch(function (e) {
        box.appendChild(el("div", "w98-hint", e.message));
      });

      built2.body.appendChild(box);
    }

    /* ---------- wiring ---------- */
    playBtn.addEventListener("click", playPause);
    stopBtn.addEventListener("click", function () {
      try { current.pause(); current.currentTime = 0; } catch (e) {}
    });
    prevBtn.addEventListener("click", function () { step(-1); });
    nextBtn.addEventListener("click", function () { step(1); });
    openBtn.addEventListener("click", function () { refresh(); pickTrackDialog(); });

    vol.addEventListener("input", function () {
      audio.volume = Number(vol.value) / 100;
      video.volume = Number(vol.value) / 100;
    });

    let seeking = false;
    seek.addEventListener("input", function () { seeking = true; });
    seek.addEventListener("change", function () {
      if (isFinite(current.duration) && current.duration > 0) {
        current.currentTime = (Number(seek.value) / 1000) * current.duration;
      }
      seeking = false;
    });

    function onTime() {
      now.textContent = fmtTime(current.currentTime);
      total.textContent = fmtTime(current.duration);
      if (!seeking && isFinite(current.duration) && current.duration > 0) {
        seek.value = String(Math.round((current.currentTime / current.duration) * 1000));
      }
    }

    [audio, video].forEach(function (m) {
      m.addEventListener("timeupdate", onTime);
      m.addEventListener("loadedmetadata", onTime);
      m.addEventListener("play", function () { playBtn.textContent = "\u23F8"; });
      m.addEventListener("pause", function () { playBtn.textContent = "\u25B6"; });
      m.addEventListener("ended", function () { step(1); });
      m.addEventListener("error", function () {
        if (m.src) status.textContent = "That file could not be played.";
      });
    });

    UI.on("files-changed", refresh);

    refresh();
    if (fileName) load(fileName);
    return player;
  }

  global.LDWinamp = { init: init, open: open };
})(window);
