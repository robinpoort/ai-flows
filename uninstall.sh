#!/bin/sh
# Removes AI Flows from this Mac: stops the server, takes the hooks out of
# ~/.claude/settings.json (and ~/.codex/hooks.json) and removes the private
# copy with the notification helper. Your Claude and Codex sessions are not
# touched.
cd "$(dirname "$0")" || exit 1

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
APP_DIR="$HOME/.claude/ai-flows/app"

node install-service.js --remove
node install-hooks.js --remove
for app in "$APP_DIR/notifier/AI Flows.app" "notifier/AI Flows.app"; do
  [ -d "$app" ] && "$LSREGISTER" -u "$app" 2>/dev/null
done
rm -rf "$APP_DIR" "notifier/AI Flows.app"
echo "Server, page and notifier removed."

echo
echo "AI Flows is removed. What is left, you can delete yourself:"
echo "  ~/.claude/ai-flows/                     (event log of the last 7 days, settings and access key)"
echo "  ~/.claude/settings.json.bak-ai-flows    (backup of your Claude settings from before the last change)"
[ -f "$HOME/.codex/hooks.json.bak-ai-flows" ] && echo "  ~/.codex/hooks.json.bak-ai-flows        (backup of your Codex hooks from before the last change)"
echo "  ~/Library/Logs/ai-flows.log             (serverlog)"
echo "  this folder                             ($(pwd))"
