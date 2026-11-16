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

Then open http://localhost:4777. The installer:

1. builds `notifier/AI Flows.app`, the small helper that shows notifications;
2. adds the AI Flows hook to `~/.claude/settings.json` next to any hooks you
   already have (a backup goes to `settings.json.bak-ai-flows`);
3. runs the server as LaunchAgent `local.ai-flows`, which starts at login and
   restarts if it stops.

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

The installer is safe to run again: it rebuilds the helper and restarts the
server. Open dashboards reload themselves when the page files change. Run it
again too after switching Node versions, since the LaunchAgent points at the
node binary that ran the installer.

## Uninstall

```bash
./uninstall.sh
```

Stops the server, removes the hooks and the helper. It lists what is left for
you to delete: the event log in `~/.claude/ai-flows/`, the server log and this
folder. Your Claude sessions and transcripts are not touched.

Moving the folder? Run `./uninstall.sh` first and `./install.sh` from the new
place: the hooks and the LaunchAgent point here by absolute path.

## What it reads and writes

| Where | What |
|---|---|
| `~/.claude/settings.json` | Writes: one hook entry per event (removed by `uninstall.sh`) |
| `~/.claude/ai-flows/` | Writes: daily event logs (7 days kept) and `settings.json` |
| `~/.claude/projects/*/*.jsonl` | Reads: the tail of recent transcripts |
| `~/Library/Application Support/Claude/claude-code-sessions/` | Reads: the desktop app's session titles and ids |
| `~/Library/LaunchAgents/local.ai-flows.plist` | Writes: the LaunchAgent |
| `~/Library/Logs/ai-flows.log` | Writes: server output |

The hook keeps a compact line per event: event name, session id, tool name
with a short summary (a command, a file path), your prompt and Claude's last
message, each clipped. It never stores file contents.

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
  takes ~10 ms and always exits 0, so it never slows down or blocks a session.
- **Desktop app.** Titles and the link that opens a session come from the
  desktop app's session files.
- **Transcripts (fallback).** Sessions without hook events yet are read from
  the tail of their transcript.

A session counts as waiting for you when it asks permission for a tool, shows a
choice (`AskUserQuestion`) or a plan to approve (`ExitPlanMode`), ends its turn
with a question in the desktop app's next-step box, or ends its last message
with a question. The question disappears as soon as you answer.

**Opening sessions.** "Open in Claude", a mini row or an answer button asks the
server to run `open claude://code/continue?session=local_…`, so the browser
never shows its "Open Claude?" prompt. `/api/open` only accepts POST with an
`X-AI-Flows` header (cross-site pages cannot send it without a preflight the
server never answers), and every request must use a localhost host name.

**Notifications.** The server checks every 2 seconds. A question must stay open
for 4 seconds before it is announced (no pop-up while you are already
answering), questions that were open when the server started are skipped, and
the notification is withdrawn once the question is answered. The header button
switches notifications on or off; switching on sends a test. They come from
`notifier/AI Flows.app`, a tiny Swift app using UserNotifications (bundle id
`local.ai-flows.notifier`, ad-hoc signed, no Dock icon). Time-sensitive
notifications, which would break through a Focus, are not possible: that
entitlement needs a developer provisioning profile, and macOS kills an ad-hoc
signed app that carries it. The icon is a blue tile with a white wave; 16 and
32 px are drawn separately, and macOS rounds the corners.

**Mini view.** One row per session: status dot, title and time; questions also
show the question. It switches on in a window narrower than 360 px, with `?mini`
at any size (`?full` forces the normal layout), or via **Mini-venster**, which
opens a 320×460 pop-up. Below 220×160 only two counters remain.

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
| `hook.sh` | Hook command: stdin event → compact JSON line in the daily log |
| `install-hooks.js` | Adds (`--remove`: removes) the hook entries in `~/.claude/settings.json` |
| `install-service.js` | Installs (`--remove`: removes) the LaunchAgent |
| `server.js` | Reads the log, desktop sessions and transcripts; serves the UI, `/api/state`, `/api/stream` (SSE), `/api/open` and `/api/settings` |
| `public/` | Dashboard UI |
| `notifier/` | Swift source, icon SVGs and `build.sh` for `AI Flows.app` |

## Development

`node server.js` runs the server in the foreground (`PORT=…` for another port;
stop the LaunchAgent first or pick another port). `AI_FLOWS_DIR=…` points it at
another event log, and `AI_FLOWS_DRY_OPEN=1` logs sessions it would open and
notifications it would send instead of doing it. `?snapshot` loads the state
once instead of streaming it, for headless screenshots. After changing
`server.js`, run `node install-service.js` to restart the service.
