# AI Flows

A local dashboard of your Claude Code sessions on macOS: what is working right
now, what is waiting for you, and what finished recently (last 30 minutes to
24 hours). Open questions get their own panel, a macOS notification tells you
when a new one comes in, and one click opens the session in the Claude app.

- **Vragen voor jou**: permission prompts, choices, plans to approve and
  questions at the end of a turn, with their answer options.
- **Flows**: every recent session with its status, your last prompt, what it is
  doing right now (tool, subagents) or how it ended.
- **Mini view** for a corner of your screen, and **macOS notifications** that
  are withdrawn again once you answer.

Everything stays on your Mac: the server only listens on 127.0.0.1 and sends
nothing anywhere.

## Install

Needs macOS, [Node.js](https://nodejs.org) 18 or newer, `jq` (part of macOS 15
and newer; otherwise `brew install jq`) and, for notifications, the Swift
compiler from Xcode or its command line tools (`xcode-select --install`). Works
with the Claude desktop app (Code tab) and with Claude Code in a terminal.

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
   to `settings.json.bak-ai-flows`, readable by you only);
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
  accounts could read). On a click it opens only `claude://code/…` and
  `http://127.0.0.1` links.
- Sessions only open as `claude://code/continue?session=local_…`, built by the
  server from the desktop app's session files (`/api/open` runs it through
  `execFile`, no shell).
- Transcripts are only read from `~/.claude/projects`, and only regular files.

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
`claude://code/continue?session=local_…`. How is a setting (**Instellingen**
in the header):
- **Zonder vraag** (default): the server opens the link. Nothing asks you, and
  Claude jumps to the session, but it stays behind your current window: since
  macOS 14 a background program may not bring another app forward.
- **Via je browser**: your browser or app opens the link, which brings Claude
  forward with the keyboard focus. Chrome asks once (tick "Always allow");
  apps that cannot remember the choice ask every time.

A click on a notification always brings Claude forward without asking: the
helper hands over the focus (`yieldActivation`).

**Read and unread.** A finished answer you have not opened in Claude yet gets
a blue dot. Right-click a flow (card, question or mini row) to mark it unread
(it stays blue until you open it in Claude) or read (also for one that stays
blue when it should not). Marks are kept in `~/.claude/ai-flows/marks.json`.

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

**Mini view.** One row per session: status dot, title and time; questions also
show the question. It switches on in a window narrower than 360 px, with `?mini`
at any size (`?full` forces the normal layout), or via **Mini-venster**, which
opens a 320×460 pop-up. In another app, open http://127.0.0.1:4777/?mini. Below 220×160 only two counters remain.

**Steady layout.** Live updates patch cards in place, and sessions keep their
order while they work (sorted by when they entered their status). The header
is solid (no `backdrop-filter`), the only animation is the live dot's opacity,
and `html { scrollbar-gutter: stable }` keeps the width the same whether a
classic scrollbar shows or not. Without that, in a 15 px band of widths where
the card grid gains a column, the scrollbar appearing made the page shorter,
which removed the scrollbar again, and the layout flickered.

## Files

| File | Role |
|---|---|
| `install.sh` / `uninstall.sh` | Install or update everything / remove it again |
| `open.sh` | Open the dashboard with your access key (`--copy`: copy the link) |
| `hook.sh` | Hook command: stdin event → compact JSON line in the daily log |
| `install-hooks.js` | Adds (`--remove`: removes) the hook entries in `~/.claude/settings.json` |
| `install-service.js` | Installs (`--remove`: removes) the LaunchAgent |
| `server.js` | Reads the log, desktop sessions and transcripts; serves the UI, `/api/state`, `/api/stream` (SSE), `/api/open`, `/api/settings`, `/api/mark` and `/api/claim` |
| `public/` | Dashboard UI |
| `notifier/` | Swift source, icon SVGs and `build.sh` for `AI Flows.app` |

## Development

`node server.js` runs the server from the checkout in the foreground (`PORT=…` for another port;
stop the LaunchAgent first or pick another port; the installer reads
`AI_FLOWS_PORT`). `AI_FLOWS_DIR=…` points it at another folder (event log,
settings and its own key), and `AI_FLOWS_DRY_OPEN=1` logs sessions it would
open and notifications it would send instead of doing it. To feed it test
events, pipe JSON into `./hook.sh <folder>`. API calls need the key as
`X-AI-Flows-Token` (or `?t=` for the stream). `?snapshot` loads the state once
instead of streaming it, for headless screenshots. Changes in the checkout
only reach the running dashboard through `./install.sh`, which copies them and
restarts the service.
