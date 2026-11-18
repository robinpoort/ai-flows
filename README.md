# AI Flows

A local dashboard of your AI coding sessions on macOS, Claude Code and OpenAI
Codex side by side: what is working right now, what is waiting for you, and
what finished recently (last 30 minutes to 24 hours). A macOS notification
tells you when a new question comes in, and one click opens the session in its
app.

- **A list by status**: **Wacht op jou** (permission prompts, choices, plans to
  approve and questions at the end of a turn), **Bezig** and **Klaar**, one row
  per session with what it needs or is doing, and its own button to open it.
- **The session you pick, in full** beside it: the question with its answer
  options, what it is doing right now (tool, subagents), your last prompt and
  the whole reply.
- **Mini view** for a corner of your screen, grouped by folder like the Claude
  app's sidebar, and **macOS notifications** that are withdrawn again once you
  answer.

Everything stays on your Mac: the server only listens on 127.0.0.1 and sends
nothing anywhere.

## Install

Needs macOS, [Node.js](https://nodejs.org) 18 or newer, `jq` (part of macOS 15
and newer; otherwise `brew install jq`) and, for notifications, the Swift
compiler from Xcode or its command line tools (`xcode-select --install`). Works
with the Claude desktop app (Code tab), Claude Code in a terminal, and the
Codex app and CLI (see [Codex](#codex)).

```bash
git clone https://github.com/robinpoort/ai-flows.git
cd ai-flows
./install.sh
```

Then open the dashboard with `./open.sh`. It opens http://127.0.0.1:4777 with
a one-time code in the link (single use, two minutes); the page trades it for
your access key and keeps that. You need this once per browser. For another
browser or an app with a web view (no address bar), run `./open.sh --copy` and
paste the link into its address bar or into the field the locked page shows.
`./open.sh --new-key` makes a new key, which signs out every browser.

The installer:

1. copies what runs into a private folder, `~/.claude/ai-flows/app` (owner
   only): the server, the page and the notification helper, which it builds
   there (`AI Flows.app`). Nothing runs from the checkout itself, so neither a
   `git pull` nor someone who can write to the folders it sits in can change
   what runs. It warns when one of those folders is writable for others;
2. copies the hook to `~/.claude/ai-flows/hook.sh` and adds it to
   `~/.claude/settings.json` next to any hooks you already have (a backup goes
   to `settings.json.bak-ai-flows`, readable by you only). With Codex on this
   Mac (`~/.codex` exists) it does the same in `~/.codex/hooks.json`;
3. runs the server as LaunchAgent `local.ai-flows`, which starts at login and
   restarts if it stops. On its first start the server creates the access key
   in `~/.claude/ai-flows/token`.

Use http://127.0.0.1:4777, not `localhost`: that name tries the IPv6 address
first. The server takes both, but only while it runs.

Running Claude sessions pick up the hooks by themselves. Until a session sends
its first event, the dashboard reads its state from the transcript.

The first notification makes macOS ask whether AI Flows may send
notifications. If they then only show up in Notification Center without a
banner, set AI Flows to **Banners** or **Alerts** in System Settings →
Notifications, and allow it in any Focus you use.

## Update

```bash
git pull && ./install.sh
```

The installer is safe to run again: it refreshes the private copy and the
hook, rebuilds the helper when its source changed and restarts the server.
Open dashboards reload themselves once the new page is installed. Run it again too after switching Node
versions, since the LaunchAgent points at the node binary that ran the
installer.

The hook runs in every Claude session, so treat an update like any code you
run: `git fetch && git log -p HEAD..@{u}` shows what changed before you merge.
A `git pull` on its own changes nothing that runs: the hook, the server, the
page and the helper all run from the copies `install.sh` makes.

## Uninstall

```bash
./uninstall.sh
```

Stops the server, removes the hooks and the helper. It lists what is left for
you to delete: `~/.claude/ai-flows/` (event log, settings, access key), the
settings backup, the server log and this folder. Your Claude sessions and
transcripts are not touched.

Moving the folder? Run `./install.sh` again from the new place: it replaces
the hook entries and the LaunchAgent, which point at the folder by absolute
path.

## What it reads and writes

| Where | What |
|---|---|
| `~/.claude/settings.json` | Writes: one hook entry per event, marked `# ai-flows` (removed by `uninstall.sh`) |
| `~/.codex/hooks.json` | Writes (if `~/.codex` exists): the same, for Codex's permission and turn events |
| `~/.codex/state_*.sqlite`, `~/.codex/sessions/` | Reads (read-only): Codex's thread list and the tail of recent rollout files (also for its limits) |
| macOS keychain, item `Claude Code-credentials` | Reads, while **Limieten → Claude** is on (the default): Claude Code's login, to fetch your 5-hour and weekly limits (see [Limits](#limits)) |
| `claude` (Claude Code's command) | Runs, while **Limieten → Claude** is on and that login has expired: `claude -p /usage`, at most every 15 minutes, so Claude Code renews it (see Security) |
| `~/.claude/ai-flows/` | Writes: `app/` (server, page, helper), `hook.sh`, daily event logs (7 days kept), `settings.json`, `token`, `marks.json`, one-time `claim` codes, `notify/` payloads |
| `~/.claude/projects/*/*.jsonl` | Reads: the tail of recent transcripts |
| `~/Library/Application Support/Claude/claude-code-sessions/` | Reads: the desktop app's session titles and ids |
| `~/Library/LaunchAgents/local.ai-flows.plist` | Writes: the LaunchAgent |
| `~/Library/Logs/ai-flows.log` | Writes: server output |

The hook keeps a compact line per event: event name, session id, tool name
with a short summary, your prompt (600 characters) and Claude's last message
(1,500), plus the text of questions and plans. The summary is the first 160
characters of a command or a file path, so the start of a long command, a
heredoc included, can end up in it; file contents read or written by tools do
not. The folder and its files are readable by you only (700/600), like
Claude's own transcripts.

## Security

**Who can get in.** Every `/api/` call needs the access key from
`~/.claude/ai-flows/token` (32 random bytes, readable by you only), compared in
constant time. Other accounts on the Mac, containers and other programs can
reach 127.0.0.1:4777 but get `401` without the key. The page itself holds no
data. The key is sent as a header (the live stream alone takes it as `?t=`,
since EventSource cannot set headers), and it never appears in a link, a
notification, a process list or a log: `open.sh` passes a one-time code (single
use, two minutes, owner-only file) that the page trades for the key, and opens
the link through `osascript`'s stdin. A link that carries a key is ignored, so
a website cannot swap the stored one.

**Who answers.** The page lives on `127.0.0.1`, never `localhost`: that name
tries `[::1]` first, where another program could otherwise listen and pose as
the dashboard. The server also takes `[::1]` on its port and stops if either
address is taken; `localhost` requests are redirected to `127.0.0.1`.

**What runs.** The server, page and helper run from `~/.claude/ai-flows/app`
and the hook from `~/.claude/ai-flows/hook.sh` (owner-only), not from the
checkout.

**Websites.**
- The server listens on 127.0.0.1 only and answers only requests whose Host is
  `localhost`, `127.0.0.1` or `[::1]` (no DNS rebinding). It sends no CORS
  headers, so other sites cannot read its responses.
- Actions (`/api/open`, `/api/settings`, `/api/mark`, `/api/claim`) also need a POST with an `X-AI-Flows`
  header, which a cross-site page can only send after a preflight that this
  server refuses.
- Every response carries a Content Security Policy (own files only,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`.

**Content from sessions** (prompts, questions, answers, folder names, commands)
is treated as hostile:
- Everything shown in the page is escaped. Long texts are clipped before any
  regex runs, in the server and in the hook (jq's `gsub` is quadratic).
- Commands the page offers to copy quote paths and ids for the shell.
- Answer buttons strip control and invisible characters (zero-width, bidi,
  Unicode tags, variation selectors, fillers, private-use and unassigned code
  points) before the text reaches your clipboard. No resume command is offered
  for a folder name with control characters (they could act on your terminal
  when pasted).
- Notification texts lose control characters and reach the helper in an
  owner-only file it deletes after reading, not as arguments (which other
  accounts could read). On a click it opens only `claude://code/…`,
  `codex://threads/…` and `http://127.0.0.1` links.
- Sessions only open as `claude://code/continue?session=local_…`, built by the
  server from the desktop app's session files, or `codex://threads/<uuid>` for a
  thread Codex's own list holds (`/api/open` runs it through `execFile`, no
  shell).
- Transcripts are only read from `~/.claude/projects`, rollouts only from
  `~/.codex/sessions` and `~/.codex/archived_sessions`, and only regular files.
  Codex's database is opened read-only with `/usr/bin/sqlite3`.

**The hook** runs with `PATH=/usr/bin:/bin`, absolute program paths, a jq
owned by root or you and `HOME=/var/empty` for jq (no `~/.jq`). It writes to
the folder passed in its command line (not one from the environment) under a
lock, so lines of concurrent hooks never interleave. It clips before
processing (a 125 KB command takes under 0.1 s) and always exits 0. Its
entry in `settings.json` single-quotes the paths, so odd folder names stay
inert. `settings.json` is rewritten atomically and stays owner-only.

**The server** survives malformed requests, `null` bodies and odd question
texts; only the four offered periods are computed, live connections are capped
at 16 and slow readers are dropped; errors are logged at most once per 10
minutes per kind.

**Limits.** While **Limieten → Claude** is on (the default), the server reads
Claude Code's login from the keychain (`/usr/bin/security`, item
`Claude Code-credentials`) every few minutes while a dashboard is open, and
sends only its access token, only to `https://api.anthropic.com/api/oauth/usage`.
The token is not stored, logged or passed to the page, which gets percentages
and reset times only. The server never refreshes the login itself: that hands
out a new refresh token and voids the old one, which could sign Claude Code
out. The Claude app keeps a login of its own and lets this one expire, so when
it has, the server has Claude Code renew it: it runs `claude -p /usage` (found
in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` or `/usr/local/bin`),
at most every 15 minutes while a dashboard is open, with a bare environment,
hooks, the session log and memory off, and without reading its output (it names
the account). `/usage` runs in Claude Code itself; it asks the model nothing.
Meanwhile the bar says "login vernieuwen…". Still expired after that means the
sign-in itself has ended: the bar says "opnieuw inloggen", which takes
`claude auth login` in a terminal. With the setting off the keychain is not
read and nothing is run, and without a Claude Code login the Claude meter is
left out.

**Not covered.**
- A program running as you can read the key, just as it can read `~/.claude`
  itself. So can a browser extension that may read pages on 127.0.0.1.
- While the server is down (before login, after `uninstall.sh`), another
  program could take the port; your browser would then send it nothing but
  what you type.
- Notification banners show question texts; check System Settings →
  Notifications → AI Flows → Show previews if others can see your screen.
- A website can find out that something listens on port 4777, not what.

## Good to know

- The desktop app's session files and the `claude://code/continue?session=…`
  link are not documented by Anthropic. A Claude app update can change them;
  the dashboard then still works, but without titles or "Open in Claude".
- Codex's database, rollout files and `codex://threads/…` link are not
  documented by OpenAI either. Without the database (no `sqlite3`, or a layout
  this version does not know) threads are found from their rollout files.
- The endpoint behind the Claude limits is the one Claude Code's `/usage`
  uses. It is not documented and can change; the bar then shows "niet
  beschikbaar" for Claude.
- The interface is in Dutch.
- Answering happens in Claude itself: an answer button copies the answer and
  opens the session, where you paste it with ⌘V. Terminal sessions get a
  `claude --resume` command to copy instead.

## How it works

- **Hooks (live).** `hook.sh` is a Claude Code hook for the session, prompt,
  tool, permission, notification, subagent and stop events. It runs async,
  takes a few milliseconds and always exits 0, so it never slows down or
  blocks a session.
- **Desktop app.** Titles and the link that opens a session come from the
  desktop app's session files.
- **Transcripts (fallback).** Sessions without hook events yet are read from
  the tail of their transcript.

A session counts as waiting for you when it asks permission for a tool, shows a
choice (`AskUserQuestion`) or a plan to approve (`ExitPlanMode`), ends its turn
with a question in the desktop app's next-step box, or ends its last message
with a question. The question disappears as soon as you answer.

**Opening sessions.** "Open in Claude", a mini row or an answer button opens
`claude://code/continue?session=local_…` ("Open in Codex": `codex://threads/…`).
How is a setting (**Instellingen** in the header):
- **Zonder vraag** (default): the server opens the link. Nothing asks you, and
  Claude jumps to the session, but it stays behind your current window: since
  macOS 14 a background program may not bring another app forward.
- **Via je browser**: your browser or app opens the link, which brings Claude
  forward with the keyboard focus. Chrome asks once (tick "Always allow");
  apps that cannot remember the choice ask every time.

A click on a notification always brings Claude forward without asking: the
helper hands over the focus (`yieldActivation`).

**Read and unread.** A finished answer you have not opened in Claude yet gets
a blue dot. Right-click a session (in the list or a mini row), or use the
button under the open session, to mark it unread
(it stays blue until you open it in Claude) or read (also for one that stays
blue when it should not). Marks are kept in `~/.claude/ai-flows/marks.json`.

**Folders and closing.** Every session names the folder it was started in
(for the Claude app its `originCwd`; a worktree counts as its repository, and a
session started from another one sits with that one, as in the app's sidebar).
Such a sub-task sits right under the session it came from, one step in with a
line from it, in the list and in the mini view; the open sub-task names that
session, and a click on the name picks it. The arrow after that session's title
folds its sub-tasks into one line ("4 sub-taken · 1 nieuw", blue when one needs
you) that unfolds them again; the left and right arrow keys do the same. This is
remembered per browser. A sub-task in another group than its session (still
busy while that one is done, say) names it on its row.
The mini view groups by it, A to Z; click a folder to fold it shut. A shut
folder shows what it holds ("1 wacht · 2 bezig") and turns its count blue when
something in it needs you. Folding is remembered per browser. **Sluit sessie**
(under the open session, or right-click) drops one you are done with, even
inside the time window: it stays away until you send it a new message or it
asks you something new, and the toast offers **Ongedaan maken**. Closing only
hides it here; the session itself is untouched.

**Full view.** The list on the left keeps the session you picked (per tab,
across reloads); when that one leaves the period, the one now in its place is
picked. Click a row or walk the list with the arrow keys; the button at the end
of a row opens that session straight away (or copies its resume command).
Answer buttons copy the answer and open the session, so you paste it with ⌘V.
What a session says can be selected and copied. Narrower than 760 px it is the
mini view.

**Notifications.** The server checks every 2 seconds. A question must stay open
for 4 seconds before it is announced (no pop-up while you are already
answering), questions that were open when the server started are skipped, and
the notification is withdrawn once the question is answered. The header button
switches notifications on or off; switching on sends a test. They come from
`notifier/AI Flows.app`, a tiny Swift app using UserNotifications (bundle id
`local.ai-flows.notifier`, ad-hoc signed, no Dock icon). Time-sensitive
notifications, which would break through a Focus, are not possible: that
entitlement needs a developer provisioning profile, and macOS kills an ad-hoc
signed app that carries it. The icon follows the RP plugin and extension icon
system: on the `#0042FF` tile a white speech bubble (the question) with a blue
wave (the flow), in front of a 33% white card (another session), all inside the
192 square keyline. 16 px (white only) and 32 px (one tint) are drawn
separately, and macOS rounds the corners.

**Mini view.** One row per session under its folder: status dot, title and
time; questions also show the question, and without open questions that part
is left out. It switches on in a window narrower than 760 px (where the list
and a session no longer fit side by side), with `?mini`
at any size, or via **Mini-venster**, which opens a 320×460 pop-up. Mini
because the window is narrow: widen it for the full view (no button for it).
The pop-up and `?mini` have **Volledig dashboard openen**; `?full` shows the
full view for one load, until the window crosses 760 px or you press the mini
button in the header. Without a scrollbar the mini view keeps no room free for one. Its mini bar holds the same controls as the header,
compact: the period (30m, 2u, 8u, 24u), notifications and settings. The
settings open over the window under that bar, and the settings button, now
an X, closes them from the same spot. In another app, open http://127.0.0.1:4777/?mini. Below 220×160 only three counters remain: **vragen**, **bezig** and **klaar** (finished
and not looked at yet). A counter with exactly one session opens it with a click
(or copies its resume command), shown by a small arrow; with more it cannot tell
which one you mean. The limits sit on a line under the counters. Each counter
fits its number and word to the room it has: number over word, then on one
line, then the number only (the word is in the tooltip). Lower than 72 px the
counters become a strip with the limits at its end, down to a sliver of about
20 px; as it narrows the limits drop the meter, then the weekly percentage.

**Steady layout.** Live updates patch rows and the open session in place
(scroll position and selected text stay), and sessions keep their order while
they work (sorted by when they entered their status). The header is solid (no
`backdrop-filter`) and the only animation is the live dot's opacity. The full
view does not scroll as a page: the list and the session each scroll on their
own.

## Codex

OpenAI's Codex, the desktop app and the CLI, keeps its conversations
("threads") in `~/.codex`. The server reads them from there, read-only, every
few seconds:

- **Which threads**: the thread list in Codex's database (`state_*.sqlite`):
  title, folder, app or CLI, archived. Subagent threads stay with the thread
  that started them, archived ones are left out.
- **Status**: the tail of each recent thread's rollout file: your last message
  (without the attached-files list the app puts above it), the step it is on,
  how its turn ended (done, interrupted, an error) and its last answer. A
  choice it asks you (`request_user_input`) or an answer that ends on a question
  counts as waiting for you.
- **Permission prompts** are not in those files. They come from Codex's hooks:
  the installer adds the same `hook.sh` to `~/.codex/hooks.json` for the prompt,
  permission, tool, stop and interrupt events. Codex only runs hooks you added
  yourself once you trust them: open **Settings → Hooks** in the Codex app (or
  `/hooks` in the CLI) and trust the AI Flows entries. Until then everything
  else works; a permission prompt just shows as "Bezig".

Codex sessions show **Codex-app** or **Codex CLI** with their name and
**Open in Codex**, which opens `codex://threads/<id>` in the app; CLI threads
offer a `codex resume` command to copy instead. **Instellingen → Mini-venster →
Toon de AI-tool** (off by default) adds a Claude or Codex label to each row of
the mini view. Read and unread work
through the right-click menu, as for terminal sessions: Codex records no
"seen" moment the dashboard can read.

Another tool fits in the same way: a scan that finds its conversations, a
reader that turns one into a status, and a session in the shape the server
already sends, with its own `tool` and `toolName`.

## Limits

A bar fixed to the bottom of the dashboard and the mini view shows, per AI
tool, how much of its 5-hour and weekly limit you have used: one small meter
with a thick bar for the 5 hours over a thin one for the week, and both
percentages (`21% / 45%`). A bar turns orange from 75% and red from 90%; hover
a meter for the reset times. In a narrow mini view the meters go one per row;
the micro view has them on a line of their own, or at the end of its strip. Each tool has its own switch under
**Instellingen → Limieten** (both on by default).

- **Claude**: the endpoint behind Claude Code's `/usage`, with the login
  Claude Code keeps in the keychain, every 3 minutes while a dashboard is
  open. See Security for how the login is handled.
- **Codex**: every Codex turn writes its limits into the thread's rollout
  file, so the bar shows them as of your last Codex turn. A window whose reset
  time has passed shows 0%.

## Files

| File | Role |
|---|---|
| `install.sh` / `uninstall.sh` | Install or update everything / remove it again |
| `open.sh` | Open the dashboard with your access key (`--copy`: copy the link) |
| `hook.sh` | Hook command: stdin event → compact JSON line in the daily log |
| `install-hooks.js` | Adds (`--remove`: removes) the hook entries in `~/.claude/settings.json` and `~/.codex/hooks.json` |
| `install-service.js` | Installs (`--remove`: removes) the LaunchAgent |
| `server.js` | Reads the log, desktop sessions, transcripts, Codex threads and usage limits; serves the UI, `/api/state`, `/api/stream` (SSE), `/api/open`, `/api/settings`, `/api/mark` and `/api/claim` |
| `public/` | Dashboard UI |
| `notifier/` | Swift source, icon SVGs and `build.sh` for `AI Flows.app` |

## Development

`node server.js` runs the server from the checkout in the foreground (`PORT=…` for another port;
stop the LaunchAgent first or pick another port; the installer reads
`AI_FLOWS_PORT`). `AI_FLOWS_DIR=…` points it at another folder (event log,
settings and its own key), and `AI_FLOWS_DRY_OPEN=1` logs sessions it would
open and notifications it would send instead of doing it.
`AI_FLOWS_CODEX_HOME=…` reads Codex threads from another folder than `~/.codex`, and
`AI_FLOWS_CLAUDE_USAGE=<file>` reads a usage response from a file instead of the
keychain and the network (`{"error": "expired"}` stands for an expired login),
and `AI_FLOWS_CLAUDE_BIN=<file>` is run in place of `claude` to renew it. To feed it test
events, pipe JSON into `./hook.sh <folder>` (`./hook.sh <folder> codex` for a Codex event). API calls need the key as
`X-AI-Flows-Token` (or `?t=` for the stream). `?snapshot` loads the state once
instead of streaming it, for headless screenshots. Changes in the checkout
only reach the running dashboard through `./install.sh`, which copies them and
restarts the service.
