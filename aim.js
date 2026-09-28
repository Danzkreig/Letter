/* ============================================================
   Letterdrop — AIM

   A real chat client over the WebSocket at /ws. The socket is
   authenticated by the same session cookie the site uses, so no
   credentials travel in the URL.

   Reconnects automatically with a backoff, and falls back to the
   HTTP history route if the socket cannot be reached.
   ============================================================ */

(function (global) {
  "use strict";

  let UI = null;
  let socket = null;
  let connected = false;
  let me = null;
  let buddies = [];
  let online = [];
  let reconnectDelay = 800;
  let reconnectTimer = null;
  let intentionallyClosed = false;

  const conversations = {};   // userId -> window handle
  let buddyWindow = null;

  function init(ui) {
    UI = ui;
    if (UI.on) {
      UI.on("session", function (user) {
        me = user || null;
        if (!me) disconnect();
      });
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  /* ============================================================
     The socket
     ============================================================ */

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    intentionallyClosed = false;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      socket = new WebSocket(proto + "//" + location.host + "/ws");
    } catch (e) {
      scheduleReconnect();
      return;
    }

    socket.onopen = function () {
      connected = true;
      reconnectDelay = 800;
      setStatus(true);
    };

    socket.onmessage = function (ev) {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };

    socket.onclose = function () {
      connected = false;
      setStatus(false);
      if (!intentionallyClosed) scheduleReconnect();
    };

    socket.onerror = function () {
      connected = false;
      setStatus(false);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
      if (me) connect();
    }, reconnectDelay);
  }

  function disconnect() {
    intentionallyClosed = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) { try { socket.close(); } catch (e) {} }
    socket = null;
    connected = false;
    setStatus(false);
  }

  function send(obj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  function setStatus(isOn) {
    if (buddyWindow && buddyWindow.statusEl) {
      buddyWindow.statusEl.textContent = isOn ? "Online" : "Connecting...";
      buddyWindow.statusEl.className = "aim-status" + (isOn ? " is-on" : "");
    }
  }

  /* ============================================================
     Incoming
     ============================================================ */

  function handle(msg) {
    switch (msg.type) {
      case "hello":
        me = msg.you;
        break;
      case "roster":
        buddies = msg.buddies || [];
        renderBuddies();
        break;
      case "history":
        setHistory(msg);
        break;
      case "presence":
        online = msg.online || [];
        renderBuddies();
        break;
      case "message":
        onIncoming(msg);
        break;
      case "read":
        markConversationRead(msg.by);
        break;
      case "typing":
        showTyping(msg);
        break;
      case "cleared":
        if (conversations[msg.with]) refreshConversation(msg.with);
        break;
      case "error":
        UI.errorBox("AIM", msg.error || "Something went wrong.");
        break;
    }
  }

  function onIncoming(msg) {
    // if the window is open, append; otherwise note it and offer to open
    const myId = me && me.id;
    const otherId = msg.from === myId ? msg.to : msg.from;
    const convo = conversations[otherId];

    if (convo) {
      appendMessage(convo, msg);
      // the window is on screen, so it counts as read
      send({ type: "read", with: msg.from });
    } else {
      UI.broadcast("im-changed");
      // a message with no window open is worth a quiet noise
      if (window.LDSound) LDSound.play("im");

      /* And a notification, so a message that arrives while you are busy
         elsewhere is actually visible rather than just counted. This is
         the whole point of an instant message. */
      if (msg.from !== myId && UI.notify) {
        const who = msg.fromName || "someone";
        UI.notify({
          title: "Instant Message",
          heading: who + " says:",
          body: msg.text,
          icon: "assets/aim.png",
          onClick: function () {
            // take them straight to the conversation
            const buddy = buddies.filter(function (b) { return b.id === msg.from; })[0] ||
              { id: msg.from, username: who };
            if (!buddyWindow) open();
            else UI.focusWindow(buddyWindow.win);
            openConversation(buddy);
          }
        });
      }
    }

    // keep the buddy list unread counts fresh
    send({ type: "roster" });
  }

  function showTyping(msg) {
    const convo = conversations[msg.from];
    if (!convo || !convo.typingEl) return;
    convo.typingEl.textContent = msg.on ? (msg.fromName + " is typing...") : "";
    clearTimeout(convo.typingTimer);
    if (msg.on) {
      convo.typingTimer = setTimeout(function () {
        if (convo.typingEl) convo.typingEl.textContent = "";
      }, 4000);
    }
  }

  /* ============================================================
     The buddy list
     ============================================================ */

  function open() {
    if (!me) { if (UI.requireSignIn) UI.requireSignIn(); return null; }

    if (buddyWindow && !buddyWindow.win.hidden) {
      UI.focusWindow(buddyWindow.win);
      send({ type: "roster" });
      return buddyWindow;
    }

    const built = UI.makeWindow({
      title: "AIM — Buddy List",
      icon: "assets/aim.png",
      width: 280, height: 420, x: 60, y: 120
    });

    const head = el("div", "aim-head");
    head.appendChild(el("div", "aim-me", me.username));
    const status = el("div", "aim-status", connected ? "Online" : "Connecting...");
    if (connected) status.classList.add("is-on");
    head.appendChild(status);
    built.body.appendChild(head);

    const list = el("div", "aim-buddies");
    built.body.appendChild(list);

    const foot = el("div", "aim-foot");
    const hint = el("div", "aim-hint", "Double-click a buddy to chat.");
    foot.appendChild(hint);
    built.body.appendChild(foot);

    buddyWindow = { win: built.win, list: list, statusEl: status };
    // render whatever we already know, then ask for the current roster
    renderBuddies();
    connect();
    send({ type: "roster" });

    /* The socket may still be connecting, in which case the roster request
       above goes nowhere. Fetching over HTTP as well means the list is
       populated immediately rather than after a reconnect. */
    LD.imBuddies().then(function (res) {
      if (!buddies.length && res.buddies) {
        buddies = res.buddies;
        online = res.online || [];
        renderBuddies();
      }
    }).catch(function () {});

    return built;
  }

  function renderBuddies() {
    if (!buddyWindow || !buddyWindow.list) return;
    buddyWindow.list.textContent = "";

    const onlineSet = {};
    online.forEach(function (id) { onlineSet[id] = true; });

    if (!buddies.length) {
      buddyWindow.list.appendChild(el("div", "w98-hint", "Nobody else has an account yet."));
      return;
    }

    buddies
      .slice()
      .sort(function (a, b) {
        const ao = onlineSet[a.id] || a.online, bo = onlineSet[b.id] || b.online;
        if (ao !== bo) return ao ? -1 : 1;
        return a.username.localeCompare(b.username);
      })
      .forEach(function (b) {
        const isOn = onlineSet[b.id] || b.online;
        const row = el("div", "aim-buddy" + (isOn ? " is-on" : ""));
        row.tabIndex = 0;
        row.setAttribute("role", "button");

        const dot = el("span", "aim-dot");
        const name = el("span", "aim-name", b.username);
        row.appendChild(dot);
        row.appendChild(name);

        if (b.unread) {
          const badge = el("span", "aim-badge", String(b.unread));
          row.appendChild(badge);
        }

        const openIt = function () { openConversation(b); };
        row.addEventListener("dblclick", openIt);
        row.addEventListener("click", openIt);
        row.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); openIt(); }
        });

        buddyWindow.list.appendChild(row);
      });
  }

  /* ============================================================
     A conversation window
     ============================================================ */

  function openConversation(buddy) {
    if (conversations[buddy.id] && !conversations[buddy.id].win.hidden) {
      UI.focusWindow(conversations[buddy.id].win);
      return conversations[buddy.id];
    }

    const built = UI.makeWindow({
      title: "Instant Message — " + buddy.username,
      icon: "assets/aim.png",
      width: 420, height: 340, x: 360, y: 150
    });

    const log = el("div", "aim-log");
    log.setAttribute("role", "log");

    const typing = el("div", "aim-typing", "");

    const form = el("div", "aim-compose");
    const input = el("textarea", "aim-input");
    input.rows = 2;
    input.placeholder = "Type a message and press Enter";
    input.setAttribute("aria-label", "Message");
    form.appendChild(input);

    const actions = el("div", "aim-actions");
    const sendBtn = el("button", "w98-btn ld-small", "Send");
    sendBtn.type = "button";
    actions.appendChild(sendBtn);
    form.appendChild(actions);

    built.body.appendChild(log);
    built.body.appendChild(typing);
    built.body.appendChild(form);

    const convo = { win: built.win, log: log, input: input, typingEl: typing, buddy: buddy };
    conversations[buddy.id] = convo;

    /* send on Enter, newline on Shift+Enter */
    let typingSent = false;
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    input.addEventListener("input", function () {
      if (!typingSent) {
        typingSent = true;
        send({ type: "typing", with: buddy.id, on: true });
        setTimeout(function () {
          typingSent = false;
          send({ type: "typing", with: buddy.id, on: false });
        }, 2500);
      }
    });

    function doSend() {
      const text = input.value.trim();
      if (!text) return;
      if (!send({ type: "send", to: buddy.id, text: text })) {
        // the socket is down: fall back to HTTP so the message is not lost
        LD.imSend(buddy.id, text).then(function () {
          refreshConversation(buddy.id);
        }).catch(function (e) { UI.errorBox("AIM", e.message); });
      }
      input.value = "";
      input.focus();
    }
    sendBtn.addEventListener("click", doSend);

    loadHistory(buddy.id);
    send({ type: "read", with: buddy.id });
    setTimeout(function () { input.focus(); }, 60);
    return built;
  }

  function loadHistory(buddyId) {
    if (send({ type: "history", with: buddyId })) return;

    // no socket: ask over HTTP instead
    LD.imHistory(buddyId).then(function (res) {
      const convo = conversations[buddyId];
      if (!convo) return;
      convo.log.textContent = "";
      (res.messages || []).forEach(function (m) { appendMessage(convo, m); });
    }).catch(function (e) { UI.errorBox("AIM", e.message); });
  }

  function refreshConversation(buddyId) {
    LD.imHistory(buddyId).then(function (res) {
      const convo = conversations[buddyId];
      if (!convo) return;
      convo.log.textContent = "";
      (res.messages || []).forEach(function (m) { appendMessage(convo, m); });
    }).catch(function () {});
  }

  function appendMessage(convo, m) {
    const mine = me && m.from === me.id;

    const row = el("div", "aim-msg" + (mine ? " is-mine" : ""));
    const who = el("span", "aim-who", mine ? "You" : (m.fromName || "them"));
    const time = el("span", "aim-time", fmtTime(m.sent));
    const text = el("div", "aim-text", m.text);

    const head = el("div", "aim-msghead");
    head.appendChild(who);
    head.appendChild(time);

    row.appendChild(head);
    row.appendChild(text);
    convo.log.appendChild(row);
    convo.log.scrollTop = convo.log.scrollHeight;
  }

  function markConversationRead(buddyId) {
    // the other side read our messages; nothing to render, but the
    // roster may have changed
    send({ type: "roster" });
  }

  /* Called by the history handler in the hub. */
  function setHistory(payload) {
    const convo = conversations[payload.with && payload.with.id];
    if (!convo) return;
    convo.log.textContent = "";
    (payload.messages || []).forEach(function (m) { appendMessage(convo, m); });
  }

  global.LDAim = {
    init: init,
    open: open,
    setHistory: setHistory,
    isConnected: function () { return connected; },
    reconnectNow: connect
  };
})(window);
