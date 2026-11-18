#!/bin/sh
# Opens the dashboard and lets the page pick up your access key. The link holds
# a one-time code (single use, two minutes) that the page trades for the key,
# so the key itself never sits in a link, browser history or the clipboard.
# Needed once per browser: the page remembers the key afterwards.
#
#   ./open.sh            open the dashboard in your default browser
#   ./open.sh --copy     copy the link instead, to paste into another browser or
#                        app (its address bar, or the field on the AI Flows page)
#   ./open.sh --new-key  make a new access key first (every browser has to open
#                        AI Flows through this script again)
set -e
PATH=/usr/bin:/bin
umask 077
DIR="$HOME/.claude/ai-flows"
PORT="${AI_FLOWS_PORT:-4777}"
case "$PORT" in ''|*[!0-9]*) echo "AI_FLOWS_PORT must be a number."; exit 1 ;; esac

if [ "$1" = "--new-key" ]; then
  shift
  rm -f "$DIR/token"
  if ! launchctl kickstart -k "gui/$(id -u)/local.ai-flows" >/dev/null 2>&1; then
    echo "Could not restart the server. Run ./install.sh"
    exit 1
  fi
  echo "New key made: open AI Flows again in every browser with this script."
fi

# The server creates the key on its first start; give it a moment.
i=0
while [ ! -s "$DIR/token" ] && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
if [ ! -s "$DIR/token" ]; then
  echo "No key found in $DIR. Is the server running? Start it with ./install.sh"
  exit 1
fi

CODE=$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
printf '%s %s\n' "$CODE" "$(date +%s)" > "$DIR/claim"
LINK="http://127.0.0.1:$PORT/#c=$CODE"

case "$1" in
  --copy)
    printf '%s' "$LINK" | pbcopy
    echo "The link is on your clipboard (valid for two minutes, for one use)."
    echo "Paste it in the address bar, or in the field on the AI Flows page."
    ;;
  --print)
    echo "$LINK"
    ;;
  *)
    # Through stdin, so the link never shows up in a process list.
    printf 'open location "%s"\n' "$LINK" | osascript
    ;;
esac
