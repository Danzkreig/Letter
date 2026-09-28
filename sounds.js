/* ============================================================
   Letterdrop — sounds

   Everything here is synthesised with the Web Audio API rather than
   shipped as files: a chime, a ding and a couple of error tones are a
   few oscillator envelopes each, which is smaller and clearer than four
   more mp3s, and it keeps the project free of assets it does not need.

   The one sound that *is* a file — the dial-up handshake — is played
   from desktop.js, because it is a recording and cannot be synthesised.

   Browsers refuse to start audio until the user has interacted with the
   page. The BIOS screen is dismissed by a key or a click, which gives us
   that gesture, so sounds are unlocked from there.
   ============================================================ */

(function (global) {
  "use strict";

  let ctx = null;
  let master = null;
  let enabled = true;
  let unlocked = false;

  function supported() {
    return Boolean(global.AudioContext || global.webkitAudioContext);
  }

  /* Create (or resume) the context. Must be called from a user gesture
     the first time or the browser will leave it suspended. */
  function ensureContext() {
    if (!supported()) return null;
    if (!ctx) {
      const Ctor = global.AudioContext || global.webkitAudioContext;
      try { ctx = new Ctor(); } catch (e) { return null; }
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended" && ctx.resume) ctx.resume().catch(function () {});
    return ctx;
  }

  /* Called from the first click or keypress, so later sounds are allowed. */
  function unlock() {
    if (unlocked) return;
    const c = ensureContext();
    if (!c) return;
    unlocked = true;
  }

  function setEnabled(on) {
    enabled = Boolean(on);
  }

  function isEnabled() {
    return enabled;
  }

  /* ---------- the building blocks ---------- */

  /* One tone: an oscillator through a gain envelope. A short attack and a
     longer decay is what makes it read as a chime rather than a click. */
  function tone(opts) {
    if (!enabled) return;
    const c = ensureContext();
    if (!c || !unlocked) return;

    const at = c.currentTime + (opts.delay || 0);
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = opts.type || "sine";
    osc.frequency.setValueAtTime(opts.freq, at);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, at + opts.duration);

    const peak = Math.max(0.0001, opts.gain == null ? 0.25 : opts.gain);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + (opts.attack || 0.012));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + opts.duration);

    osc.connect(gain);
    gain.connect(master);
    osc.start(at);
    osc.stop(at + opts.duration + 0.03);
  }

  /* A filtered burst of noise, for the harsher error tones. */
  function noise(opts) {
    if (!enabled) return;
    const c = ensureContext();
    if (!c || !unlocked) return;

    const at = c.currentTime + (opts.delay || 0);
    const frames = Math.floor(c.sampleRate * opts.duration);
    const buffer = c.createBuffer(1, frames, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // fade the noise out so it does not click at the end
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    const src = c.createBufferSource();
    src.buffer = buffer;

    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = opts.freq || 900;
    filter.Q.value = opts.q || 1.2;

    const gain = c.createGain();
    gain.gain.value = opts.gain == null ? 0.12 : opts.gain;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(at);
  }

  /* ---------- the sounds ---------- */

  const SOUNDS = {
    /* Starting up: a rising major triad, the shape of every startup
       jingle ever written. */
    startup: function () {
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        tone({ freq: f, duration: 0.5 - i * 0.06, gain: 0.16, delay: i * 0.11, type: "triangle" });
      });
      // a low bed underneath, so it has some weight
      tone({ freq: 130.81, duration: 0.9, gain: 0.1, type: "sine", delay: 0.02 });
    },

    /* New mail: two quick notes, which is the whole idea of a "ding". */
    mail: function () {
      tone({ freq: 880, duration: 0.16, gain: 0.2, type: "sine" });
      tone({ freq: 1174.66, duration: 0.28, gain: 0.18, type: "sine", delay: 0.11 });
    },

    /* A message arriving in AIM: a soft two-note rise, quieter than mail
       so a busy conversation is not unbearable. */
    im: function () {
      tone({ freq: 659.25, duration: 0.1, gain: 0.1, type: "sine" });
      tone({ freq: 987.77, duration: 0.14, gain: 0.09, type: "sine", delay: 0.07 });
    },

    /* The illegal-operation thunk: two low square tones and a scrape. */
    error: function () {
      tone({ freq: 220, duration: 0.16, gain: 0.22, type: "square" });
      tone({ freq: 164.81, duration: 0.3, gain: 0.2, type: "square", delay: 0.12 });
      noise({ freq: 500, duration: 0.18, gain: 0.07, delay: 0.02 });
    },

    /* Something worked: a single clean note. */
    ok: function () {
      tone({ freq: 1046.5, duration: 0.16, gain: 0.14, type: "sine" });
    },

    /* The dialog every one of these computers made when it wanted
       attention. */
    notify: function () {
      tone({ freq: 587.33, duration: 0.2, gain: 0.16, type: "triangle" });
      tone({ freq: 440, duration: 0.26, gain: 0.14, type: "triangle", delay: 0.14 });
    },

    /* Shutting down: the startup figure, falling. */
    shutdown: function () {
      [783.99, 659.25, 523.25, 392].forEach(function (f, i) {
        tone({ freq: f, duration: 0.42 - i * 0.05, gain: 0.15, delay: i * 0.13, type: "triangle" });
      });
    },

    /* A click, for buttons that would have made one. */
    click: function () {
      tone({ freq: 1400, duration: 0.035, gain: 0.06, type: "square" });
    }
  };

  function play(name) {
    const fn = SOUNDS[name];
    if (!fn) return false;
    if (!enabled) return false;
    fn();
    return true;
  }

  global.LDSound = {
    play: play,
    unlock: unlock,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    supported: supported,
    names: Object.keys(SOUNDS)
  };
})(window);
