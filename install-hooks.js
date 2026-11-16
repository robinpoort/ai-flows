#!/usr/bin/env node
'use strict';

// Adds the AI Flows hook to ~/.claude/settings.json for every event the
// dashboard needs, next to any hooks that are already there.
//   node install-hooks.js            install (safe to run again)
//   node install-hooks.js --remove   take the AI Flows hooks out again

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.join(__dirname, 'hook.sh');
const MARK = 'ai-flows/hook.sh';
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'Notification',
  'SubagentStart', 'SubagentStop',
];

const remove = process.argv.includes('--remove');
const raw = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
const settings = JSON.parse(raw);
settings.hooks = settings.hooks || {};

const isOurs = (group) => (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARK));

let changed = 0;
for (const ev of EVENTS) {
  const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
  const others = groups.filter((g) => !isOurs(g));
  if (remove) {
    if (others.length !== groups.length) changed++;
    if (others.length) settings.hooks[ev] = others; else delete settings.hooks[ev];
    continue;
  }
  if (groups.some(isOurs)) continue;
  others.push({ hooks: [{ type: 'command', command: JSON.stringify(HOOK), async: true, timeout: 10 }] });
  settings.hooks[ev] = others;
  changed++;
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

if (!changed) {
  console.log(remove ? 'Er stonden geen AI Flows-hooks in de instellingen.' : 'De AI Flows-hooks staan er al.');
  process.exit(0);
}

fs.chmodSync(HOOK, 0o755);
fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS + '.bak-ai-flows', raw);
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(remove
  ? `AI Flows-hooks verwijderd uit ${SETTINGS} (${changed} events).`
  : `AI Flows-hooks toegevoegd aan ${SETTINGS} (${changed} events). Reservekopie: settings.json.bak-ai-flows`);
