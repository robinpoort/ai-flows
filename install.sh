#!/bin/sh
# Installs (or updates) AI Flows. It copies what runs into a private folder,
# ~/.claude/ai-flows/app, so nothing in this checkout runs by itself: not after
# a `git pull`, and not if someone else can write to the folders it sits in.
# Safe to run again, for example after `git pull`.
set -e
cd "$(dirname "$0")"

ok() { echo "✓ $1"; }
warn() { echo "! $1"; }
fail() { echo "✗ $1"; exit 1; }

[ "$(uname)" = Darwin ] || fail "AI Flows werkt alleen op macOS."
command -v node >/dev/null 2>&1 || fail "Node.js 18 of nieuwer is nodig: https://nodejs.org"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' ||
  fail "Node.js 18 of nieuwer is nodig (nu: $(node -v))."
JQ=$(command -v jq || true)
[ -n "$JQ" ] || for p in /usr/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq; do [ -x "$p" ] && JQ=$p && break; done
[ -n "$JQ" ] || fail "jq ontbreekt. Het zit in macOS 15 en nieuwer; anders: brew install jq"
ok "Node $(node -v) en jq gevonden"

# Folders others may write to (without the sticky bit) let them swap this
# checkout. What runs is a private copy, but say so: install.sh itself runs
# from here.
d=$(pwd -P)
while [ "$d" != "/" ]; do
  perms=$(/usr/bin/stat -f %Sp "$d")
  case "$perms" in
    d???????w[!tT]) warn "$d is schrijfbaar voor iedereen. Zet hem op 755 als niets anders dat nodig heeft." ;;
    d????w????) warn "$d is schrijfbaar voor de groep. Zet hem op 755 als niets anders dat nodig heeft." ;;
  esac
  d=$(dirname "$d")
done

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
APP_DIR="$HOME/.claude/ai-flows/app"
/bin/mkdir -p "$APP_DIR/notifier"
/bin/chmod 700 "$HOME/.claude/ai-flows" "$APP_DIR"

# Notification helper: built into the private folder, again only when its
# source changed (a rebuild means a new signature).
HASH=$(cat notifier/main.swift notifier/build.sh notifier/*.svg | /usr/bin/shasum -a 256 | cut -d' ' -f1)
APP_BIN="$APP_DIR/notifier/AI Flows.app/Contents/MacOS/AI Flows"
if [ -x "$APP_BIN" ] && [ "$(cat "$APP_DIR/notifier/.source-hash" 2>/dev/null)" = "$HASH" ]; then
  ok "Meldingsappje is al up-to-date"
elif xcrun --find swiftc >/dev/null 2>&1; then
  ./notifier/build.sh "$APP_DIR/notifier" >/dev/null
  echo "$HASH" > "$APP_DIR/notifier/.source-hash"
  ok "Meldingsappje gebouwd (macOS vraagt bij de eerste melding om toestemming)"
else
  warn "Geen Swift-compiler: Mac-meldingen worden overgeslagen. Installeer hem met"
  warn "'xcode-select --install' en draai dit script daarna opnieuw."
fi
# Older versions built the app inside the checkout. Unregister and remove it,
# so a click on a notification can never start that copy.
if [ -d "notifier/AI Flows.app" ]; then
  "$LSREGISTER" -u "notifier/AI Flows.app" 2>/dev/null || true
  rm -rf "notifier/AI Flows.app"
fi

# Server and page.
rm -rf "$APP_DIR/public.new"
cp -R public "$APP_DIR/public.new"
rm -rf "$APP_DIR/public"
mv "$APP_DIR/public.new" "$APP_DIR/public"
cp server.js "$APP_DIR/server.js"
/bin/chmod -R go-rwx "$APP_DIR"
ok "Server en pagina gekopieerd naar $APP_DIR"

node install-hooks.js
node install-service.js

echo
ok "Klaar. Open het dashboard met ./open.sh"
echo "  Dat is eenmalig per browser nodig: de pagina onthoudt daarna je toegangssleutel."
echo "  Updaten: git pull && ./install.sh    Verwijderen: ./uninstall.sh"
