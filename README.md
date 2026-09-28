# 💌 Letterdrop — A 2000s AOL Mixtape E-Card

A little Node app for sending a letter and a mixtape. The recipient doesn't get a
letter — they get an old PC.

They switch it on and it boots, dials up to AOL, and signs them in. On the desktop
there's one unread message. Almost everything else on the machine is a decoy: open
Minesweeper, My Computer or the Recycle Bin and Windows 98 throws the classic
*"This program has performed an illegal operation and will be shut down."*

The recipient's desktop is deliberately functionless — just the letter. **Your own
machine is the one that works**, and it's behind a password: sign in and you get
Notepad, My Documents (a real note and image store, one folder per user), the
Letterdrop composer itself, and — if you're an admin — user account management.

## One machine

The desktop is the whole site. Open it and you get Windows 98:

| URL | What you get |
| --- | --- |
| `/` | The desktop. Sign in to use the programs. |
| `/<token>` | A shared file, straight to the bytes |
| `/s/<token>` | The share page for a link preview |

There used to be a second, separate compose page, and letters used to be encoded
into the URL. Both are gone: mail between accounts replaced them.

## Signing in

On first run the server creates an admin account and prints its password **once**:

```
node server.js
```

That generated password is **temporary**. The first time you sign in, a Change Your
Password window opens and the rest of the desktop stays locked until you have picked
your own — the server refuses every route except the handful needed to change it.

Set `ADMIN_USER` to choose the account name. Set `ADMIN_PASS` too and that password
is treated as **yours**, not as a temporary one, so no forced change is applied.
Useful for a scripted install or a container.

### Password rules

Changing a password requires the current one, at least 8 characters, and that the
new one differs from the old. Changing it **signs out every other session**, so a
password change is also a way to eject someone who should not still be signed in.

If an admin sets your password from User Accounts, it is treated as temporary in
exactly the same way as the generated one: you will be asked to choose your own at
next sign-in.

### Sessions

**Start → My Profile** lists where you are signed in — device, address, and when —
and lets you end any of them individually, or sign out every other device at once.
You cannot end someone else's session.

Sessions lapse after 12 hours of inactivity and are renewed as you use the site, up
to an absolute limit of 14 days. The server prunes expired ones on a timer and
whenever a new session is created.

### Failed sign-ins

Sign-ins are throttled per account and client address. The first three failures are
free; after that each attempt waits longer, and after six the account is locked for
15 minutes. The lockout applies to the *right* password too, so a bot cannot simply
keep guessing.

The throttle key is the account plus the client address. `X-Forwarded-For` is
**ignored unless `TRUST_PROXY=1`** — otherwise it would be trivial to spoof a new
address and dodge the lockout. Set `TRUST_PROXY=1` only when you are behind a
reverse proxy you control.

## Storage and quotas

Each account can have a storage cap, set in the Control Panel. **0 means no limit**,
which is the default so an existing install is not retroactively capped. The cap
applies to everyone, admins included.

My Documents shows a usage bar, turning amber at 80% and red at 95%. An upload that
would go over is refused **before the bytes are written** where the length is known,
and mid-stream where it is not, so a large file cannot overshoot the cap and then be
discovered afterwards. The check is enforced in the store as well as the route, so no
call path can skip it.

Uploads never overwrite: giving a file an existing name stores it as `name (2).ext`
instead. The base64 path used by Paint does write in place, and nets off the size of
what it replaces.

### Images are shrunk before they are stored

A photo straight off a phone is several megabytes and thousands of pixels wide. Each
one is downscaled in the browser before it is sent — longest edge capped at **1600
px**, re-encoded at quality 0.82 — which is the difference between a slow upload and
a fast one, and between a share link that takes seconds to load and one that does not.

In practice that is about **6.7 MB → 0.2 MB**. The saving is reported rather than
silent: the status line says `Shrunk images by 4.6 MB.`

A file is only replaced if the result is genuinely smaller, and only for formats the
browser can both decode and re-encode. A small already-optimised JPEG is passed
through untouched, an SVG is never rasterised (that would defeat the point of it),
and anything unreadable is left alone. This also means a photo too large for the
2 MB avatar limit is shrunk to fit rather than simply refused.

## The file manager

**My Documents** is a real file manager:

- **Folders**, nested as deep as you like. Double-click to open, and a breadcrumb bar
  shows where you are with an **Up** button to climb back out.
- **Rename** any file or folder. Renaming a file that has been shared **carries the
  share link across**, so the link you sent keeps working. Renaming a folder moves its
  contents and drops the old one.
- **Move** by renaming into a folder, or by uploading while inside one.
- Files inside folders are addressed by their path throughout — reading, deleting,
  sharing and rendering all understand `Holiday/Photos/beach.jpg`.

Everything is contained to your own folder. A destination like `../../elsewhere` is
stripped component by component and then re-checked after resolution, and there is a
dedicated suite that attacks every entry point with nine different traversal shapes.

## Find

**Start → Find...** searches everything you can see, in one box:

- **Files** — by name, by the folder they are in, and by the text inside notes.
  Binary files are matched on name only, and only the first 256 kB of a note is read,
  so searching never drags a huge file off disk.
- **Mail** — subject, body, and the names of anything enclosed, so you can find a file
  somebody once sent you.
- **People** — other accounts, ready to write to.

Results are grouped and show *why* they matched, with a snippet of the surrounding
text. The tabs narrow to one kind. Searching is scoped to the caller on the server:
root searching for a word in alice's private note finds nothing.

## Accounts and privileges

Two roles, enforced on the server rather than in the browser:

| | user | admin |
| --- | --- | --- |
| Own notes and images | read / write / delete | read / write / delete |
| Other people's files | ✗ | read / write / delete |
| Create accounts | ✗ | ✓ |
| Delete accounts, reset passwords, change roles | ✗ | ✓ |

Each user's files live in `data/files/<userId>/`, and every request is checked
against the session — passing someone else's id returns **403**, not their data.

An admin can set someone else's password, but cannot read it, and doing so forces
that person to choose a new one.

## Features

- **Full boot sequence** — the BIOS posts its messages one line at a time, then the
  Windows 98 splash, then a dial-up modem handshake to AOL (with the modem noise).
- **Windows 98 desktop** — clouds wallpaper, draggable windows with working
  minimise / maximise / close, a taskbar, a system tray clock, and a Start menu.
- **Notepad that saves** — write a note, press Save (or `Ctrl+S`), and it lands in
  your own folder. Reopen it from My Documents and the text comes back.
- **My Documents as a file manager** — folders, rename, move, delete, and uploads of
  any type up to a configurable size. Per-user, on disk. See *The file manager* below.
- **A storage quota per account** — with a usage bar, and uploads refused before they
  can overshoot. See *Storage and quotas* below.
- **Find** — one search across your files, the text inside your notes, your mail and
  letters, and the other accounts. See *Find* below.
- **Public sharing** — share any file and get an unguessable link that anyone can
  open, with Open Graph tags so Discord and Slack render a real image embed.
  Revoke it at any time. See *Sharing* below.
- **Internal mail** — send messages to other accounts on this machine. Inbox, Sent
  and Deleted Items, unread counts in the system tray, replies, and attachments
  drawn from your own Documents.
- **AIM, for real** — instant messaging between accounts over a WebSocket, with a
  buddy list, online/offline presence, typing indicators, read receipts and stored
  history. See *AIM* below.
- **User Accounts (admins)** — create and delete accounts, reset passwords, promote
  and demote, and browse any user's folder.
- **The composer, in the desktop** — Letterdrop itself runs as a Win98 window, so
  writing a letter never leaves the machine.
- **Working programs** — Calculator, MS-DOS Prompt, Paint, Minesweeper, My
  Computer, the Recycle Bin and Network Neighbourhood all do real work.
- **Everything else fails** — the remaining programs raise an illegal-operation
  dialog. Five messages rotate, dialogs stack and cascade, and the icon varies.
- **A real file host** — upload anything up to your configured limit (1 GB by
  default), share it with a six-character link, and play audio and video right
  in the desktop.
- **Letters** — messages with an animated shape and enclosed images and songs the
  reader plays in place. Shareable as a read-only page. See *Letters* below.
- **Invitations** — admins issue one-use links that create an account and deliver
  the letter into the new Inbox.
- **Profile pictures** — everyone can set their own.

## Winamp

Winamp plays the audio and video in your Documents. Open it from the Start menu or
the desktop, and it lists every playable file with a transport bar, a seek bar and
a volume control.

**Nothing is base64'd or buffered.** The player points an `<audio>` or `<video>`
element straight at `/api/raw`, which supports **HTTP range requests** — that is
what makes seeking work in a large mp4 without loading the whole thing first.

Opening an mp3 or mp4 from **My Documents** hands it to Winamp directly. Files that
are neither are listed as downloads rather than pretending to play.

## Sharing

In **My Documents**, the **Share** button on any file turns it into **Link** and
opens a dialog with the public URL, a Copy button and a Stop sharing button.

The link is **six characters**, from an alphabet with no look-alikes — no `0`/`O`
or `1`/`l` to mistype:

```
http://your-host/alb5fz.jpg
```

A bare token serves the file itself, which is what a browser wants when you have
asked for an image. A link-preview crawler asking for the same URL also gets the
bytes, so the embed still works. `/s/<token>` serves the HTML page, which carries
the Open Graph tags:

```
og:title        screenshot.png
og:image        https://your-host/s/<token>/raw
og:url          https://your-host/s/<token>
twitter:card    summary_large_image
```

**The viewer page is deliberately bare:** the image, the video, the audio player,
your note, or a download link — and nothing else. No headings, no toolbar, no
chrome around it.

Audio and video also honour **range requests**, so seeking works.

**Things worth knowing:**

- **Discord has to be able to reach the URL.** On `127.0.0.1` the embed will only
  resolve for you — Discord cannot fetch localhost. Use a tunnel (`ngrok`,
  `cloudflared`) or a real host. That is also the only way to get a link that looks
  like `files.example.com/alb5fz.jpg` rather than `127.0.0.1:8000/alb5fz.jpg`: the
  short host needs a domain.
- **Discord caches embeds hard.** Revoking stops the link working immediately, but a
  preview already cached may linger. Re-sharing mints a *new* token, so the old
  cached preview will not update.
- **Only the owner can share.** An admin browsing someone else's folder can read it
  but cannot publish it on their behalf.
- Deleting a file, or the whole account, kills its links immediately.
- A share is genuinely public: anyone with the token can view the file. There is no
  expiry — revoke it when you are done.

## Internal mail

**Start → Inbox**, or the Inbox icon. This is mail between accounts on this server,
not real email — nothing leaves the machine.

- **New Message** composes. The **To** field autocompletes as you type: names that
  *start* with what you typed come first, then names that merely contain it. Arrow
  keys move, Enter takes the highlighted one, Escape closes.
- **Several recipients.** Separate names with commas or semicolons — "alice, bob" —
  and the autocomplete fills in the one you are typing without disturbing the rest.
  **CC** works the same way: each recipient gets their own copy, so one person
  reading or deleting theirs leaves the others untouched. A reader who was copied
  rather than addressed is told so in the header.
- **Drafts.** A half-written message is saved to the server as you type, so closing
  the window or reloading the page does not lose it. Reopening the composer brings
  it back with a note saying when it was saved. Sending clears it; closing keeps it.
- **Reply** quotes the original with an attribution line and `>` prefixes, and adds
  `Re:` without stacking it if the subject already has one.
- **Attach from Documents** picks a file you own. The recipient can open it even
  though it lives in your folder.
- **Inbox / Sent Items / Deleted Items.** Deleting is per-side: removing a message
  from your Inbox leaves the sender's copy of it alone.
- Unread counts appear in the system tray, and update when you send or read. New
  mail *dings* — only when the count rises, so reading your post is silent.

## Keyboard shortcuts

The desktop behaves like the machine it is imitating:

| Keys | What it does |
| --- | --- |
| `Ctrl+Tab` / `Alt+Tab` | Cycle between open windows (`Shift` to go back) |
| `Ctrl+A` | Select every row in the list in front |
| `Ctrl` / `Shift` + click | Toggle one row, or extend a selection over a range |
| `Delete` | Delete the selected rows, after one confirmation |
| `Ctrl+N` | New item in whatever is in front — a message, a folder |
| `F5` | Refresh the front window |
| `Ctrl+M` / `Ctrl+W` | Minimise / close the front window |
| `Escape` | Close the front window |

Each one stands aside when it would get in the way: `Tab` still means "next field"
while you are typing, `Escape` leaves an open dialog to handle its own, and `Ctrl+A`
still selects text inside a text box.

## Letters

A letter is a message with more to it: an animated shape and files the reader can
look at and listen to without leaving the window.

Write one from **Start → Write a Letter**. A letter has a subject, a body, one of
five shape choices (or none), and any number of files enclosed from your Documents.
Images appear inline; **mp3s play right there in the letter**, with seeking; videos
play in place; anything else offers a download.

The shape is the real renderer, turning in the letter window:

| Shape | What it is |
| --- | --- |
| **Heart (text)** | `LOVE.TXT` — revealed a line at a time, then held |
| **Donut (text)** | `DONUT.TXT` — the same, a ring |
| **Heart (3D)** | A solid, shaded heart that yaws so you can see it has depth |
| **Donut (3D)** | The classic spinning torus, z-buffered and lit |

All four are drawn in `ascii.js` with no dependencies. The 3D pair use the
[Andy Sloane](https://www.a1k0n.net/2011/07/20/donut-math.html) technique:
sample a surface, project it orthographically, z-buffer it so nearer points occlude
farther ones, and shade onto a luminance ramp.

The picker shows a real frame of each, and **each preview is scaled to its own
width**. The 2D shapes are 23 columns across and the 3D ones 78, so a single font
size cannot fit both: at the size that suits the 2D pair, three quarters of the 3D
render was cut off and the shape was unrecognisable. The font size is now worked out
per shape from the room the button gives it.

The heart is not a surface of revolution — revolving a profile destroys the two
lobes and the notch between them. Instead the implicit curve
`(x² + y² − 1)³ − x²y³ = 0` is the outline, and the solid is built by giving it
thickness in z, deepest in the middle. It yaws rather than spinning, because a full
turn would present it edge-on, where a heart is a featureless slab.

### Sharing a letter

Any letter except an invitation can be shared. The link is a **read-only page**:
the letter, its shape and everything enclosed, and nothing else about the machine.
No account needed.

### Invitation letters

Admins only. An invitation is a letter whose link **creates the account**:

1. The admin writes it and gets a one-use link.
2. The recipient opens the link and lands on a **Windows 98 sign-up window** — the
   same desktop, the same bevels, and the same Letterdrop Network banner as the
   logon dialog inside the app, with the letter laid out behind the window.
3. Choosing a user name and password creates the account, and **the letter is
   delivered into that new Inbox** and opens itself on their desktop.

The link is single-use and **expires after a week**, and admins can revoke an unused
one from **Start → Invitations**. Redemption is atomic: the token is checked and
consumed in one synchronous pass, so two people racing the same link cannot both
succeed. It is also refused outright if sign-ups are switched off in the Control
Panel, and a weak password is rejected *without* burning the invitation.

The page is a real desktop rather than a bare form, so the first thing a new person
sees is the machine their letter lives on. Every outcome — an unknown link, an
already-used one, an expired one — stays inside that same environment.

## Profile pictures

**Start → My Profile.** Any user can set their own picture, or remove it. You can
also change your password there, and see and end your active sessions.

Pictures live in your own folder as a hidden file, so the existing ownership and
cleanup rules apply unchanged — and it never shows up in My Documents. They are
served from `/avatar/<name>`, which is public, because an avatar appears next to a
name on shared letters where there is no session.

## The programs

Most things on the desktop are decoys — open Solitaire or 3D Pinball and Windows 98
throws the classic *"This program has performed an illegal operation."* These are the
ones that actually work:

| Program | What it does |
| --- | --- |
| **Calculator** | Four-function arithmetic with memory, `sqrt`, sign flip and a working keyboard |
| **MS-DOS Prompt** | A real shell over your file store: `DIR`, `TYPE`, `DEL`, `VER`, `DATE`, `ECHO`, `CLS` |
| **Notepad** | Opens and saves `.txt` notes, with a folder browser on Save As |
| **Paint** | Canvas drawing — 20 colours, 4 brush sizes, eraser, plus open and save to your Documents |
| **Minesweeper** | The actual game: 9×9 with 10 mines, flood reveal, right-click flags, and a first click that is never a mine |
| **Pipes** | Turn pipe pieces until the water reaches every outlet |
| **My Computer** | Drives and folders; C: is your own file store |
| **Recycle Bin** | Honest about being empty — deleted files are gone, not recoverable |
| **Network Neighbourhood** | The other accounts on this machine; open one and browse their folder |
| **Winamp** | Plays the mp3s and mp4s in your Documents, with seeking |
| **Control Panel** | Admins: site settings, per-program switches, storage, and the destructive actions |

Minesweeper places its mines *after* your first click, and never under it or its
neighbours, so the first move always opens something — the same trick the original
used to avoid instant losses.

### Saving a note

**Save As** opens a folder browser rather than asking for a bare name, so a note can
be filed where it belongs. Double-click a folder to descend, **↑ Up** or the
breadcrumbs to climb back, and the name box gets whatever you type.

Nothing is ever overwritten by accident. Saving over a name that already exists asks
first, and offers three answers rather than two:

- **Replace** — overwrite it
- **Keep Both** — save alongside as `note (2).txt`
- **Cancel** — go back and pick another name

Plain **Save** on a note you opened writes straight back to it, because that is the
file you meant; the question is only for names you typed. A note saved into a folder
shows the path in its title bar, and the folder is created if it does not exist yet.

### Pipes

A grid of pipe pieces. **Click** one to turn it clockwise, **right-click** to turn it
the other way. Water starts at the tap and spreads through anything joined to it;
get it to every outlet to win, in as few turns as you can.

Three board sizes, from 5×5 up. The tap and the outlets never turn, and a piece that
is a cross is refused outright rather than silently costing you a move — a cross
looks identical in all four orientations, which is also why the generator never hands
one out.

Three details make the generator produce playable boards rather than random noise:

- the tap always opens **into** the board, never into the wall;
- at least one neighbour is turned to face it, so a board never starts with the water
  sealed off — which it did, about one time in three, before this was handled;
- the scramble re-checks that the board is not already solved.

**Every window can be resized.** Drag any edge or corner; the bottom-right corner
has the ridged grip Windows 98 drew. Windows keep a sensible minimum size, cannot
be dragged off the top-left of the screen, and anything inside them re-measures
when they change.

## Sound

Eight sounds, all **synthesised with the Web Audio API** rather than shipped as
files: a startup chime, a mail ding, a softer AIM tone, the illegal-operation thunk,
a confirmation note, a notify pair, a shutdown figure and a click. A few oscillator
envelopes each is smaller and clearer than five more mp3s, and it keeps the project
free of assets it does not need. The dial-up handshake is still a recording and is
played from `desktop.js`.

The tray speaker doubles as a **mute switch**, and the choice is remembered.

Browsers refuse to start audio until the page has been interacted with, so the sounds
unlock on the first click or keypress — which is the BIOS screen being dismissed.

## The Control Panel

Admins only, from the Start menu or the desktop. Four tabs:

- **General** — the site name, a message of the day, the upload limit, **storage per
  account**, and whether new accounts can be created.
- **Programs** — switch any program on or off. A disabled program disappears from
  the desktop *and* the Start menu, and the server refuses to launch it, so a stale
  shortcut cannot get round it. The Control Panel and User Accounts stay reachable
  whatever you do, or you would lock yourself out.
- **Storage** — total bytes and files, public links, mail and message counts, and a
  per-account breakdown.
- **Danger** — three destructive actions: delete every uploaded file, delete all
  mail and messages, or delete every account except your own. Each one makes you
  **type the action name** before the button works, and the server re-checks that
  confirmation rather than trusting the UI.

## AIM

**Start → Programs**, or the AIM desktop icon. Instant messaging between accounts
on this server, over a WebSocket.

- **Buddy list** with live online/offline dots and unread badges.
- **Conversations** in their own windows: history loads on open, new messages appear
  the moment they are sent, and the other side sees a *typing…* line.
- **Read receipts**, so the sender knows a message was seen.
- **A notification when someone messages you.** If the conversation window is not
  open — you are in another program, or the buddy list is behind something — a panel
  slides out above the system tray with who it is from and what they said. Clicking it
  opens the conversation. It fades on its own after a few seconds, waits while you
  hover, and stacks up to four deep so a burst does not paper over the screen.
- **Stored history** — the conversation survives a reload, and is readable over HTTP
  if the socket drops.

**The WebSocket is hand-written.** `lib/ws.js` implements RFC 6455 directly on
Node's `upgrade` event — the handshake, text/close/ping frames, fragmentation, and
16- and 64-bit payload lengths — so the project still installs nothing. It is
verified against the accept-key vector from the spec itself.

**Sockets are authenticated by the session cookie.** There is no token in the URL.
A connection without a valid session is sent an error and closed immediately.

A ping every 20 seconds clears out sockets that vanished without a close (a killed
tab, a dropped connection), so the roster cannot fill up with ghosts.

## Files

### Server

| File | Purpose |
| --- | --- |
| `server.js` | HTTP server: static files, the JSON API, streamed uploads, share pages |
| `lib/auth.js` | scrypt password hashing and session tokens |
| `lib/store.js` | Accounts, sessions, files, shares, mail, messages and settings on disk |
| `lib/ws.js` | A minimal RFC 6455 WebSocket server, written by hand |
| `lib/chat.js` | The AIM hub: presence, relay, read receipts |
| `data/` | Created on first run. Accounts plus one folder per user |

### Front end

| File | Purpose |
| --- | --- |
| `card.html` | The whole site: the desktop, its boot sequence, and the shell |
| `desktop.css` | All the Windows 98 chrome: bevels, windows, taskbar, dialogs |
| `desktop.js` | Boot sequence, window manager, resizing, session, decoy errors |
| `apps.js` | Notepad, the file manager, uploads, the image viewer, sign-in, accounts |
| `mail.js` | Outlook Express: folders, compose, reading, attachments, autocomplete |
| `letter.js` | Writing, reading, sharing and inviting: the letter system |
| `find.js` | Find: one search across files, mail and people |
| `image.js` | Downscaling and re-encoding images in the browser before upload |
| `sounds.js` | The eight synthesised sounds, and the mute switch |
| `ascii.js` | The four spinning shapes, including the two 3D renders |
| `aim.js` | AIM: buddy list and conversations over the WebSocket |
| `programs.js` | Calculator, MS-DOS Prompt, Paint, Minesweeper, the file-system browsers |
| `winamp.js` | The audio and video player |
| `control.js` | The Control Panel: settings, quotas and the destructive actions |
| `api.js` | Thin wrapper over the JSON API |
| `assets/` | Icons, AOL screens, clouds wallpaper, sounds |

## Running it

There is no build step and no npm install — the server uses only Node's standard
library. You do need Node, because accounts and file storage live on the server:

```bash
node server.js
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000/).

Set `PORT` or `HOST` to change where it listens. The server binds to `127.0.0.1` by
default, so it is not reachable from your network unless you ask for it.

> **Using it for real letters?** Put it behind HTTPS. Session cookies are marked
> `HttpOnly` and `SameSite=Strict`, but without TLS the cookie still travels in the
> clear.

Then open [http://localhost:8000](http://localhost:8000/).

## Customising

- **Which programs fail** — the `ICONS` array in `desktop.js`. Each entry has a label,
  an icon and the message shown in its error dialog. Set `mail: true` to make one
  actually open the letter.
- **The error messages** — `ILLEGAL_MESSAGES` in `desktop.js`. Five rotate by default.
- **The Start menu** — `START_ITEMS` in `desktop.js`, same shape as `ICONS`.
- **The dial-up log** — `DIAL_LOG` in `desktop.js` is the text that types out in the
  modem status box. The connected / dialling artwork swaps via `data-phase`.
- **The modem sound** — `DIAL_SOUND_MS` in `desktop.js` caps playback (the supplied
  clip runs nearly 19 seconds, which outstays the sequence it accompanies) and
  `DIAL_FADE_MS` fades the tail before it stops. Shortening the mp3 itself would be
  better still.
- **BIOS speed** — `BIOS_LINES` holds the POST text and `BIOS_LINE_MS` the delay
  between lines (85ms, so the whole screen lands in about a second).
- **Window chrome colours** — the `--w-*` custom properties at the top of `desktop.css`.
- **Window minimum size** — `makeResizable` in `desktop.js`; each window keeps its
  own floor so a small dialog cannot be squeezed into nothing.
- **Fonts** — the desktop deliberately uses the system `MS Sans Serif` stack, which
  is what makes it read as period-correct.
- **Password hashing cost** — `PARAMS` in `lib/auth.js`. `N=32768` takes about 130ms
  per hash here. Raise it if you have CPU to spare; the cost is stored with each
  password, so raising it does not invalidate existing ones.
- **Session lifetime and throttling** — the constants at the top of `lib/auth.js`:
  `SESSION_TTL_MS`, `SESSION_ABSOLUTE_MS`, `FREE_ATTEMPTS`, `LOCKOUT_AFTER` and
  `LOCKOUT_MS`.
- **The storage cap** — the Control Panel's General tab. Code-side it is
  `quotaMB` in `DEFAULT_SETTINGS` in `lib/store.js`, and `quotaFor` /
  `quotaAllows` are what everything else asks.
- **How much of a note search reads** — `NOTE_SCAN_BYTES` in `lib/store.js`.
- **Search result cap** — `MAX_SEARCH_RESULTS` in `lib/store.js`.
- **Upload limit and note size** — the limit is a setting, changeable in the Control
  Panel. `MAX_NOTE_BYTES` is in `lib/store.js`.
- **Which programs exist** — also a setting, and `PROGRAM_LIST` in `control.js` is
  what the panel offers.

## Accessibility

- The BIOS screen advances on `Enter` or `Space` as well as a click.
- Desktop icons, file rows, buddies and tracks are focusable and activate on `Enter`.
- Dialogs are `role="alertdialog"` and take focus when they open.
- `prefers-reduced-motion: reduce` skips the boot and dial-up animations entirely.
- The chat log is `role="log"`, and the calculator screen is `aria-live="polite"`.
- Resize grips are `aria-hidden`: every window is still usable without a mouse.
- All user-supplied text is inserted via `textContent`, never `innerHTML`.

## License

MIT — do whatever you like with it.
