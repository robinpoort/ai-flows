#!/usr/bin/env node
'use strict';

// Adds the AI Flows hook to ~/.claude/settings.json for every event the
// dashboard needs, next to any hooks that are already there. With Codex on this
// Mac, the same goes for ~/.codex/hooks.json.
//   node install-hooks.js            install or update (safe to run again)
//   node install-hooks.js --remove   take the AI Flows hooks out again
//
// The hook runs from a copy in ~/.claude/ai-flows (owner-only), not from this
// folder: a `git pull` alone never changes what runs in your sessions, and a
// moved or deleted checkout leaves no dangling path behind.

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.claude', 'ai-flows');
const SOURCE = path.join(__dirname, 'hook.sh');
const HOOK = path.join(LOG_DIR, 'hook.sh');
const MARK = '# ai-flows';

// Hooks run through a shell: single quotes keep $, ` and spaces inert. The log
// folder is passed explicitly so a project's environment cannot redirect it.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const CLAUDE = {
  name: 'Claude',
  file: path.join(os.homedir(), '.claude', 'settings.json'),
  events: [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure',
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'PermissionDenied', 'Notification',
    'SubagentStart', 'SubagentStop',
  ],
  command: `${q(HOOK)} ${q(LOG_DIR)} ${MARK}`,
  create: true,
};

// Codex: the rest it reads from its own files; its hooks only add when it asks
// for permission, and what shows that question was answered. Codex runs hooks
// you add yourself only once you trust them (Settings > Hooks in the app,
// /hooks in the CLI).
const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX = {
  name: 'Codex',
  file: path.join(CODEX_DIR, 'hooks.json'),
  events: ['UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'],
  command: `${q(HOOK)} ${q(LOG_DIR)} codex ${MARK}`,
  create: fs.existsSync(CODEX_DIR),
};

// Ours: carries the marker, or is the entry of an older version (which ran
// hook.sh straight from a checkout folder called ai-flows). Matched per hook,
// so a hook of your own in the same group stays.
const isOurHook = (h) => typeof h.command === 'string' &&
  (h.command.includes(MARK) || /\/ai-flows\/hook\.sh["']?$/.test(h.command.trim()));

const remove = process.argv.includes('--remove');

// Returns 'created', 'changed', 'same' or 'skipped'.
function update(tool) {
  const exists = fs.existsSync(tool.file);
  if (!exists && (remove || !tool.create)) return 'skipped';
  const raw = exists ? fs.readFileSync(tool.file, 'utf8') : '{}';
  const settings = JSON.parse(raw.trim() || '{}');
  settings.hooks = settings.hooks || {};

  let changed = false;
  for (const ev of tool.events) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const ours = groups.flatMap((g) => (g.hooks || []).filter(isOurHook));
    const others = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) }))
      .filter((g) => g.hooks.length);
    const current = ours.length === 1 && ours[0].command === tool.command;
    if (remove) {
      if (ours.length) changed = true;
      if (others.length) settings.hooks[ev] = others; else delete settings.hooks[ev];
    } else if (!current) {
      settings.hooks[ev] = [...others, { hooks: [{ type: 'command', command: tool.command, async: true, timeout: 10 }] }];
      changed = true;
    }
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;

  const backup = tool.file + '.bak-ai-flows';
  if (!changed) {
    if (fs.existsSync(backup)) fs.chmodSync(backup, 0o600);
    return 'same';
  }
  // Back up and replace atomically (write a temp file, then rename), keeping
  // the file owner-only: settings.json can hold API keys in its env block.
  const target = exists ? fs.realpathSync(tool.file) : tool.file;
  const mode = exists ? fs.statSync(target).mode & 0o777 & ~0o077 : 0o600;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (exists) {
    fs.writeFileSync(backup, raw, { mode: 0o600 });
    fs.chmodSync(backup, 0o600);
  }
  const tmp = `${target}.ai-flows-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: mode || 0o600 });
  fs.renameSync(tmp, target);
  return exists ? 'changed' : 'created';
}

if (remove) {
  fs.rmSync(HOOK, { force: true });
} else {
  // Always refresh the copy, so `./install.sh` after `git pull` updates it.
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(LOG_DIR, 0o700);
  fs.copyFileSync(SOURCE, HOOK);
  fs.chmodSync(HOOK, 0o700);
}

for (const tool of [CLAUDE, CODEX]) {
  const result = update(tool);
  if (result === 'skipped') continue;
  if (remove) {
    console.log(result === 'changed'
      ? `AI Flows-hooks verwijderd uit ${tool.file}.`
      : `Er stonden geen AI Flows-hooks in ${tool.file}.`);
  } else if (result === 'changed' || result === 'created') {
    console.log(result === 'created'
      ? `AI Flows-hooks gezet in ${tool.file} (nieuw bestand).`
      : `AI Flows-hooks bijgewerkt in ${tool.file} (reservekopie: ${path.basename(tool.file)}.bak-ai-flows).`);
    if (tool === CODEX) {
      console.log('  Codex voert ze pas uit als je ze vertrouwt: Instellingen > Hooks in de app, of /hooks in de CLI.');
    }
  } else {
    console.log(`De AI Flows-hooks voor ${tool.name} staan er al; de hook zelf is ververst.`);
  }
}
