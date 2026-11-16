#!/usr/bin/env node
'use strict';

// Adds the AI Flows hook to ~/.claude/settings.json for every event the
// dashboard needs, next to any hooks that are already there.
//   node install-hooks.js            install or update (safe to run again)
//   node install-hooks.js --remove   take the AI Flows hooks out again
//
// The hook runs from a copy in ~/.claude/ai-flows (owner-only), not from this
// folder: a `git pull` alone never changes what runs in your sessions, and a
// moved or deleted checkout leaves no dangling path behind.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP = SETTINGS + '.bak-ai-flows';
const LOG_DIR = path.join(os.homedir(), '.claude', 'ai-flows');
const SOURCE = path.join(__dirname, 'hook.sh');
const HOOK = path.join(LOG_DIR, 'hook.sh');
const MARK = '# ai-flows';
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'Notification',
  'SubagentStart', 'SubagentStop',
];

// Hooks run through a shell: single quotes keep $, ` and spaces inert. The log
// folder is passed explicitly so a project's environment cannot redirect it.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const COMMAND = `${q(HOOK)} ${q(LOG_DIR)} ${MARK}`;

// Ours: carries the marker, or is the entry of an older version (which ran
// hook.sh straight from a checkout folder called ai-flows). Matched per hook,
// so a hook of your own in the same group stays.
const isOurHook = (h) => typeof h.command === 'string' &&
  (h.command.includes(MARK) || /\/ai-flows\/hook\.sh["']?$/.test(h.command.trim()));

const remove = process.argv.includes('--remove');
const exists = fs.existsSync(SETTINGS);
const raw = exists ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
const settings = JSON.parse(raw);
settings.hooks = settings.hooks || {};

let changed = false;
for (const ev of EVENTS) {
  const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
  const ours = groups.flatMap((g) => (g.hooks || []).filter(isOurHook));
  const others = groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) }))
    .filter((g) => g.hooks.length);
  const current = ours.length === 1 && ours[0].command === COMMAND;
  if (remove) {
    if (ours.length) changed = true;
    if (others.length) settings.hooks[ev] = others; else delete settings.hooks[ev];
  } else if (!current) {
    settings.hooks[ev] = [...others, { hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 10 }] }];
    changed = true;
  }
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

if (remove) {
  fs.rmSync(HOOK, { force: true });
} else {
  // Always refresh the copy, so `./install.sh` after `git pull` updates it.
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(LOG_DIR, 0o700);
  fs.copyFileSync(SOURCE, HOOK);
  fs.chmodSync(HOOK, 0o700);
}

if (changed) {
  // Back up and replace atomically (write a temp file, then rename), keeping
  // the file owner-only: settings.json can hold API keys in its env block.
  const target = exists ? fs.realpathSync(SETTINGS) : SETTINGS;
  const mode = exists ? fs.statSync(target).mode & 0o777 & ~0o077 : 0o600;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(BACKUP, raw, { mode: 0o600 });
  fs.chmodSync(BACKUP, 0o600);
  const tmp = `${target}.ai-flows-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: mode || 0o600 });
  fs.renameSync(tmp, target);
} else if (fs.existsSync(BACKUP)) {
  fs.chmodSync(BACKUP, 0o600);
}

console.log(remove
  ? (changed ? `AI Flows-hooks verwijderd uit ${SETTINGS}.` : 'Er stonden geen AI Flows-hooks in de instellingen.')
  : (changed ? `AI Flows-hooks bijgewerkt in ${SETTINGS} (reservekopie: settings.json.bak-ai-flows).`
             : 'De AI Flows-hooks staan er al; de hook zelf is ververst.'));
