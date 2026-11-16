#!/bin/sh
# Installs (or updates) AI Flows: builds the notification helper, adds the
# Claude Code hooks and (re)starts the dashboard server. Safe to run again,
# for example after `git pull`.
set -e
cd "$(dirname "$0")"

ok() { echo "✓ $1"; }
fail() { echo "✗ $1"; exit 1; }

[ "$(uname)" = Darwin ] || fail "AI Flows werkt alleen op macOS."
command -v node >/dev/null 2>&1 || fail "Node.js 18 of nieuwer is nodig: https://nodejs.org"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' ||
  fail "Node.js 18 of nieuwer is nodig (nu: $(node -v))."
JQ=$(command -v jq || true)
[ -n "$JQ" ] || for p in /usr/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq; do [ -x "$p" ] && JQ=$p && break; done
[ -n "$JQ" ] || fail "jq ontbreekt. Het zit in macOS 15 en nieuwer; anders: brew install jq"
ok "Node $(node -v) en jq gevonden"

APP_BIN="notifier/AI Flows.app/Contents/MacOS/AI Flows"
if [ -x "$APP_BIN" ] && [ -z "$(find notifier -type f -newer "$APP_BIN" -not -path '*/AI Flows.app/*')" ]; then
  # Unchanged: keep the signed app, and with it the notification permission.
  ok "Meldingsappje is al up-to-date"
elif xcrun --find swiftc >/dev/null 2>&1; then
  ./notifier/build.sh >/dev/null
  ok "Meldingsappje gebouwd (macOS vraagt bij de eerste melding om toestemming)"
else
  echo "! Geen Swift-compiler: Mac-meldingen worden overgeslagen. Installeer hem met"
  echo "  'xcode-select --install' en draai dit script daarna opnieuw."
fi

node install-hooks.js
node install-service.js

echo
ok "Klaar. Open http://localhost:4777"
echo "  Updaten: git pull && ./install.sh    Verwijderen: ./uninstall.sh"
