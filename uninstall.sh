#!/bin/sh
# Removes AI Flows from this Mac: stops the server, takes the hooks out of
# ~/.claude/settings.json and unregisters the notification helper. Your
# Claude sessions and transcripts are not touched.
cd "$(dirname "$0")"

node install-service.js --remove
node install-hooks.js --remove
if [ -d "notifier/AI Flows.app" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "notifier/AI Flows.app" 2>/dev/null
  rm -rf "notifier/AI Flows.app"
  echo "Meldingsappje verwijderd."
fi

echo
echo "AI Flows is verwijderd. Wat er nog staat, kun je zelf weggooien:"
echo "  ~/.claude/ai-flows/          (event-log van de laatste 7 dagen en je instellingen)"
echo "  ~/Library/Logs/ai-flows.log  (serverlog)"
echo "  deze map                     ($(pwd))"
