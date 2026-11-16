#!/usr/bin/env node
'use strict';

// AI Flows: a local dashboard of Claude Code sessions that are working, waiting
// for you, or were active recently. Live status comes from Claude Code hooks
// (hook.sh writes them to a daily log); titles come from the Claude desktop
// app's session files; transcripts fill in sessions from before the hooks.

const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 4777;
const HOST = '127.0.0.1';
const HOME = os.homedir();
const EVENTS_DIR = process.env.AI_FLOWS_DIR || path.join(HOME, '.claude', 'ai-flows');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const DESKTOP_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const KEEP_MS = 26 * HOUR; // forget sessions older than this
const LOG_KEEP_DAYS = 7;
const STALE_MS = 20 * MINUTE; // "working" with no sign of life for this long
const CHECK_INTERRUPT_MS = 45 * 1000;
const TAIL_BYTES = 1500 * 1024;
const MAX_EVENTS_PER_SESSION = 600;

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up';

// ---------------------------------------------------------------- helpers

function clip(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Prompts from transcripts can be huge (pasted files). Only a short bit is
// shown, and the regexes below are not linear on hostile input, so clip first.
const MAX_TEXT = 8000;

function cleanPrompt(text) {
  if (typeof text !== 'string') return '';
  return text.slice(0, MAX_TEXT)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, '[geplakte tekst]')
    .split('\n').map((l) => l.trimEnd()).join('\n')
    .trim();
}

// Every string in a question, clipped: parts and options come from transcripts
// and can be as long as a transcript line.
function clipQuestion(q) {
  if (!q) return null;
  const c = (v, n) => (typeof v === 'string' ? clip(v, n) : v);
  return {
    ...q,
    text: c(q.text, 1500),
    detail: c(q.detail, 400),
    context: c(q.context, 1500),
    options: (q.options || []).slice(0, 8).map((o) => c(String(o), 200)),
    parts: q.parts ? q.parts.slice(0, 4).map((p) => ({
      ...p,
      header: c(p.header, 100),
      question: c(p.question, 600),
      options: (p.options || []).slice(0, 8).map((o) => ({ label: c(o.label, 200), description: c(o.description, 300) })),
    })) : null,
  };
}

// Quote for a POSIX shell: nothing inside single quotes is expanded.
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Messages the app or Claude Code injects as a "user" turn (task notices,
// side-session reports, CI events). They start a turn but are not your words.
function isAutomated(text) {
  return /^<(task-notification|side-sessions-event|ci-monitor-event|local-command|command-|bash-|system)/.test(text || '');
}

function automatedLabel(text) {
  if (/^<task-notification/.test(text)) return 'Achtergrondtaak gemeld';
  if (/^<side-sessions-event/.test(text)) return 'Bericht van een andere sessie';
  if (/^<ci-monitor-event/.test(text)) return 'CI-melding';
  if (/^<bash-/.test(text)) return 'Shell-commando';
  if (/^<(command-|local-command)/.test(text)) return 'Slash-commando';
  return 'Automatisch bericht';
}

// The question a finished turn leaves you with, if any.
function trailingQuestion(text) {
  if (typeof text !== 'string') return null;
  const lines = text.slice(-MAX_TEXT).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const strip = (l) => l.replace(/[*_`>#]+/g, '').replace(/\s+/g, ' ').trim();
  const last = strip(lines[lines.length - 1]);
  if (!/\?\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}]*$/u.test(last)) return null;
  // Keep only the final sentence(s) that hold the question.
  const sentences = last.split(/(?<=[.!])\s+(?=[A-ZÀ-Ý])/);
  const q = sentences.filter((s) => s.includes('?')).join(' ') || last;
  return clip(q, 400);
}

function questionFromTurn(wrap, lastText) {
  if (wrap && typeof wrap.ask === 'string' && wrap.ask.trim()) {
    const options = Array.isArray(wrap.actions)
      ? wrap.actions.map((a) => a && (a.label || a.action)).filter(Boolean)
      : [];
    return { kind: 'wrap', text: wrap.ask.trim(), options, context: wrap.recap || null };
  }
  const q = trailingQuestion(lastText);
  if (q) return { kind: 'text', text: q, options: [], context: null };
  return null;
}

function askFromTool(tool, input) {
  if (tool === 'AskUserQuestion') {
    const qs = Array.isArray(input && input.questions) ? input.questions : [];
    return {
      kind: 'ask',
      text: qs.map((q) => q.question).filter(Boolean).join('\n') || 'Er is een vraag voor je',
      options: qs.length === 1 && Array.isArray(qs[0].options) ? qs[0].options.map((o) => o.label).filter(Boolean) : [],
      parts: qs.map((q) => ({
        header: q.header || null,
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options.map((o) => ({ label: o.label, description: o.description || '' })) : [],
        multi: !!q.multiSelect,
      })),
      context: null,
    };
  }
  if (tool === 'ExitPlanMode') {
    return { kind: 'plan', text: 'Plan klaar: goedkeuren?', options: [], context: clip(input && input.plan, 1200) || null };
  }
  return null;
}

function projectFromCwd(cwd) {
  if (!cwd) return { name: 'onbekend', detail: '' };
  const wt = cwd.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)/);
  if (wt) return { name: path.basename(wt[1]), detail: wt[2] };
  const rel = cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd;
  return { name: path.basename(cwd) || rel, detail: rel };
}

// The folder a session belongs to, the way the Claude app groups its sidebar:
// the folder it was started in, with a worktree counting as its repository. A
// session started from another one sits with that one, as in the app.
function folderOf(desk, cwd) {
  for (let i = 0; i < 5 && desk && desk.parentLocalId; i++) {
    const parent = desktopByLocal.get(desk.parentLocalId);
    if (!parent) break;
    desk = parent;
  }
  let dir = (desk && (desk.originCwd || desk.cwd)) || cwd;
  if (!dir) return { key: '', name: 'Zonder map', detail: '' };
  const wt = dir.match(/^(.*?)\/\.claude\/worktrees\/[^/]+/);
  if (wt) dir = wt[1];
  const rel = dir.startsWith(HOME) ? '~' + dir.slice(HOME.length) : dir;
  return { key: dir, name: path.basename(dir) || rel, detail: rel };
}

// ---------------------------------------------------------------- hook events

const logFiles = new Map(); // file -> { offset, rest }
const eventSessions = new Map(); // sid -> { events: [], tp, cwd, ep }

function ingest(e) {
  if (!e || !e.ts) return;
  if (e.src === 'codex') { ingestCodex(e); return; }
  if (!e.sid) return;
  let s = eventSessions.get(e.sid);
  if (!s) eventSessions.set(e.sid, (s = { events: [], tp: null, cwd: null, ep: null }));
  if (e.tp) s.tp = e.tp;
  if (e.cwd) s.cwd = e.cwd;
  if (e.ep) s.ep = e.ep;
  // Async hooks may land slightly out of order: keep the list sorted.
  let i = s.events.length;
  while (i > 0 && s.events[i - 1].ts > e.ts) i--;
  s.events.splice(i, 0, e);
  if (s.events.length > MAX_EVENTS_PER_SESSION) s.events.splice(0, s.events.length - MAX_EVENTS_PER_SESSION);
}

// Older installs (and hooks from before `umask 077`) left the log readable for
// other users on this Mac; make the folder and its files owner-only.
function restrict(p, mode) {
  try { if ((fs.statSync(p).mode & 0o777) !== mode) fs.chmodSync(p, mode); } catch {}
}

function readHookLog() {
  restrict(EVENTS_DIR, 0o700);
  let names;
  try {
    names = fs.readdirSync(EVENTS_DIR).filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  } catch {
    return false;
  }
  const cutoff = new Date(Date.now() - LOG_KEEP_DAYS * 24 * HOUR).toISOString().slice(0, 10);
  for (const n of names) {
    if (n.slice(7, 17) < cutoff) {
      try { fs.unlinkSync(path.join(EVENTS_DIR, n)); } catch {}
    }
  }
  let changed = false;
  for (const n of names.slice(-2)) {
    const p = path.join(EVENTS_DIR, n);
    const st = safeStat(p);
    if (!st || !st.isFile()) continue;
    if (!logFiles.has(p)) restrict(p, 0o600);
    let f = logFiles.get(p) || { offset: 0, rest: '' };
    if (st.size < f.offset) f = { offset: 0, rest: '' };
    if (st.size > f.offset) {
      const len = st.size - f.offset;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(p, 'r');
      try { fs.readSync(fd, buf, 0, len, f.offset); } finally { fs.closeSync(fd); }
      f.offset = st.size;
      const lines = (f.rest + buf.toString('utf8')).split('\n');
      f.rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try { ingest(JSON.parse(line)); changed = true; } catch {}
      }
    }
    logFiles.set(p, f);
  }
  return changed;
}

function deriveFromEvents(events) {
  const st = {
    status: 'idle', since: null, lastTs: 0, prompt: null, autoPrompt: null, activity: null,
    wrap: null, ask: null, perm: null, last: null, error: null, model: null,
    subagents: new Map(), turnStart: null, sawTurn: false,
  };
  const set = (status, ts) => { if (st.status !== status) { st.status = status; st.since = ts; } };
  // Only these say something about the session's own turn; a session whose
  // hooks only saw a background agent finish is still best read from its
  // transcript.
  const TURN_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'PermissionDenied', 'Stop', 'StopFailure', 'SessionEnd']);

  for (const e of events) {
    st.lastTs = Math.max(st.lastTs, e.ts);
    if (e.aid) {
      if (e.ev === 'SubagentStart') st.subagents.set(e.aid, { type: e.atype || 'agent', ts: e.ts, activity: null });
      else if (e.ev === 'SubagentStop') st.subagents.delete(e.aid);
      else if (e.ev === 'PreToolUse') {
        const a = st.subagents.get(e.aid) || { type: e.atype || 'agent', ts: e.ts };
        a.activity = { tool: e.tool, sum: e.sum || '', ts: e.ts };
        st.subagents.set(e.aid, a);
      }
      continue;
    }
    if (TURN_EVENTS.has(e.ev)) st.sawTurn = true;
    switch (e.ev) {
      case 'SessionStart':
        if (e.model) st.model = e.model;
        if (st.status === 'ended') set('idle', e.ts);
        if (!st.since) st.since = e.ts;
        break;
      case 'UserPromptSubmit': {
        const text = e.prompt || '';
        if (isAutomated(text)) {
          // Only counts as work once Claude actually responds to it.
          st.autoPrompt = { text: automatedLabel(text), ts: e.ts };
          st.autoTurn = true;
          break;
        }
        st.prompt = { text: cleanPrompt(text), ts: e.ts };
        st.autoPrompt = null;
        st.autoTurn = false;
        st.turnStart = e.ts;
        st.wrap = st.ask = st.perm = st.last = st.error = st.activity = null;
        set('working', e.ts);
        break;
      }
      case 'PreToolUse':
        if (st.autoTurn) {
          st.autoTurn = false;
          st.turnStart = e.ts;
          st.wrap = st.ask = st.last = st.error = null;
        }
        if (QUESTION_TOOLS.has(e.tool)) {
          st.ask = { ...askFromTool(e.tool, e.input), tuid: e.tuid, ts: e.ts };
          set('question', e.ts);
        } else if (e.tool === WRAP_TOOL) {
          st.wrap = { ...(e.input || {}), ts: e.ts };
        } else {
          st.activity = { tool: e.tool, sum: e.sum || '', ts: e.ts };
          st.perm = null;
          if (st.status !== 'question' || !st.ask) set('working', e.ts);
        }
        break;
      case 'PermissionRequest':
        st.perm = { tool: e.tool, sum: e.sum || '', ts: e.ts };
        set('permission', e.ts);
        break;
      case 'Notification':
        if (e.ntype === 'permission_prompt') {
          if (!st.perm) st.perm = { tool: null, sum: e.msg || '', ts: e.ts };
          set('permission', e.ts);
        } else if (e.ntype === 'elicitation_dialog') {
          st.ask = { kind: 'elicitation', text: e.msg || 'Een MCP-server vraagt om invoer', options: [], ts: e.ts };
          set('question', e.ts);
        }
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        if (st.ask && st.ask.tuid && st.ask.tuid === e.tuid) st.ask = null;
        st.perm = null;
        if ((st.status === 'question' && !st.ask) || st.status === 'permission') set('working', e.ts);
        break;
      case 'Stop': {
        if (st.autoTurn) { st.autoTurn = false; st.wrap = null; if (st.ask && !st.ask.tuid) st.ask = null; }
        st.last = e.last ? { text: e.last, ts: e.ts } : st.last;
        st.perm = null;
        st.activity = null;
        if (st.ask && st.ask.tuid) { set('question', e.ts); break; }
        const q = questionFromTurn(st.wrap, e.last);
        if (q) { st.ask = { ...q, ts: e.ts }; set('question', e.ts); }
        else { st.ask = null; set('done', e.ts); }
        break;
      }
      case 'StopFailure':
        st.error = { text: e.error || 'Onbekende fout', details: e.details || null, ts: e.ts };
        set('error', e.ts);
        break;
      case 'SessionEnd':
        set('ended', e.ts);
        break;
    }
  }
  return st;
}

// ---------------------------------------------------------------- transcripts

const tailCache = new Map(); // file -> { size, mtimeMs, entries }

function readTail(file) {
  const c = tailCache.get(file);
  if (c && Date.now() - c.checkedAt < 3000) return c;
  const st = safeStat(file);
  if (!st || !st.isFile()) return null;
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) { c.checkedAt = Date.now(); return c; }
  const start = Math.max(0, st.size - TAIL_BYTES);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift();
  const entries = [];
  for (const line of lines) {
    if (!line || line.length > 400000) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  const out = { size: st.size, mtimeMs: st.mtimeMs, checkedAt: Date.now(), entries, derived: null };
  tailCache.set(file, out);
  return out;
}

function userText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return null;
  if (c.some((x) => x && x.type === 'tool_result')) return null;
  const t = c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
  return t || null;
}

function deriveFromTranscript(tail) {
  if (tail.derived) return tail.derived;
  const st = {
    status: 'idle', since: null, lastTs: 0, prompt: null, autoPrompt: null, activity: null,
    wrap: null, ask: null, perm: null, last: null, error: null, model: null,
    title: null, lastPrompt: null, cwd: null, interruptedAt: null, entry: null,
  };
  const set = (status, ts) => { if (st.status !== status) { st.status = status; st.since = ts; } };

  for (const e of tail.entries) {
    if (e.type === 'custom-title' && e.customTitle) st.title = e.customTitle;
    if (e.type === 'last-prompt' && e.lastPrompt) st.lastPrompt = e.lastPrompt;
    if (e.cwd) st.cwd = e.cwd;
    if (e.entrypoint) st.entry = e.entrypoint;
    if (e.isSidechain) continue;
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    if (ts) st.lastTs = Math.max(st.lastTs, ts);

    if (e.type === 'user' && e.message) {
      const text = userText(e.message);
      if (text != null) {
        if (e.isMeta || e.isCompactSummary) continue;
        if (/^\[Request interrupted by user/.test(text)) {
          st.interruptedAt = ts;
          st.activity = null;
          set('interrupted', ts);
          continue;
        }
        if (isAutomated(text)) {
          st.autoPrompt = { text: automatedLabel(text), ts };
          st.autoTurn = true;
          continue;
        }
        st.prompt = { text: cleanPrompt(text), ts };
        st.autoPrompt = null;
        st.autoTurn = false;
        st.wrap = st.ask = st.last = st.error = st.activity = st.interruptedAt = null;
        set('working', ts);
      } else {
        for (const c of e.message.content || []) {
          if (c && c.type === 'tool_result' && st.ask && st.ask.tuid === c.tool_use_id) st.ask = null;
        }
        if (st.status === 'question' && !st.ask) set('working', ts);
      }
    } else if (e.type === 'assistant' && e.message) {
      const m = e.message;
      if (m.model && !st.model) st.model = m.model;
      if (st.autoTurn) {
        st.autoTurn = false;
        st.wrap = st.ask = st.last = st.error = st.interruptedAt = null;
        set('working', ts);
      }
      const texts = [];
      for (const c of m.content || []) {
        if (!c) continue;
        if (c.type === 'text' && c.text) texts.push(c.text);
        if (c.type === 'tool_use') {
          if (QUESTION_TOOLS.has(c.name)) {
            st.ask = { ...askFromTool(c.name, c.input), tuid: c.id, ts };
            set('question', ts);
          } else if (c.name === WRAP_TOOL) {
            st.wrap = { ...(c.input || {}), ts };
          } else {
            const i = c.input || {};
            const sum = i.command || i.description || i.file_path || i.path || i.pattern || i.url || i.query || '';
            st.activity = { tool: c.name, sum: clip(String(sum).replace(/\s+/g, ' '), 160), ts };
            if (st.status !== 'question') set('working', ts);
          }
        }
      }
      if (m.stop_reason === 'end_turn') {
        if (texts.length) st.last = { text: texts.join('\n\n'), ts };
        st.activity = null;
        if (st.ask && st.ask.tuid) set('question', ts);
        else {
          const q = questionFromTurn(st.wrap, st.last && st.last.text);
          if (q) { st.ask = { ...q, ts }; set('question', ts); }
          else set('done', ts);
        }
      }
    } else if (e.type === 'system' && e.subtype === 'api_error') {
      st.error = { text: clip(String(e.content || e.error || 'API-fout'), 300), ts };
    }
  }
  tail.derived = st;
  return st;
}

let transcriptIndex = new Map(); // sid -> { file, mtimeMs }
let transcriptScanAt = 0;

function scanTranscripts() {
  const now = Date.now();
  if (now - transcriptScanAt < 4000) return;
  transcriptScanAt = now;
  const next = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch {}
  for (const d of dirs) {
    const dp = path.join(PROJECTS_DIR, d);
    let files = [];
    try { files = fs.readdirSync(dp); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dp, f);
      const st = safeStat(fp);
      if (!st || !st.isFile() || now - st.mtimeMs > KEEP_MS) continue;
      next.set(f.slice(0, -6), { file: fp, mtimeMs: st.mtimeMs });
    }
  }
  transcriptIndex = next;
}

// ---------------------------------------------------------------- desktop app

const desktopFiles = new Map(); // file -> { mtimeMs, meta }
let desktopByCli = new Map();
let desktopByLocal = new Map();
let desktopScanAt = 0;

function scanDesktop() {
  const now = Date.now();
  if (now - desktopScanAt < 5000) return;
  desktopScanAt = now;
  const seen = new Set();
  let accounts = [];
  try { accounts = fs.readdirSync(DESKTOP_DIR); } catch { return; }
  for (const a of accounts) {
    let orgs = [];
    try { orgs = fs.readdirSync(path.join(DESKTOP_DIR, a)); } catch { continue; }
    for (const o of orgs) {
      const dir = path.join(DESKTOP_DIR, a, o);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!/^local_.*\.json$/.test(f)) continue;
        const fp = path.join(dir, f);
        seen.add(fp);
        const st = safeStat(fp);
        if (!st || !st.isFile()) continue;
        const cached = desktopFiles.get(fp);
        if (cached && cached.mtimeMs === st.mtimeMs) continue;
        try {
          const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
          desktopFiles.set(fp, {
            mtimeMs: st.mtimeMs,
            meta: {
              localId: d.sessionId,
              cliIds: [d.cliSessionId, d.lastAssistantCliSessionId, ...(d.priorCliSessionIds || [])].filter(Boolean),
              title: d.title || null,
              archived: !!d.isArchived,
              cwd: d.cwd || null,
              originCwd: d.originCwd || null,
              parentLocalId: (d.spawnedFrom && typeof d.spawnedFrom.sessionId === 'string' && d.spawnedFrom.sessionId) || null,
              lastActivityAt: d.lastActivityAt || 0,
              lastUserAt: d.latestUserFrameAt || 0,
              lastFocusedAt: d.lastFocusedAt || 0,
              summary: d.postTurnSummary || null,
              model: d.model || null,
            },
          });
        } catch {}
      }
    }
  }
  for (const fp of desktopFiles.keys()) if (!seen.has(fp)) desktopFiles.delete(fp);
  const byCli = new Map();
  for (const { meta } of desktopFiles.values()) {
    for (const id of meta.cliIds) {
      const prev = byCli.get(id);
      if (!prev || prev.lastActivityAt < meta.lastActivityAt) byCli.set(id, meta);
    }
  }
  desktopByCli = byCli;
  desktopByLocal = new Map([...desktopFiles.values()].map(({ meta }) => [meta.localId, meta]));
  // The session you have open in the app is the one you focused last.
  let latest = null;
  for (const { meta } of desktopFiles.values()) if (!latest || meta.lastFocusedAt > latest.lastFocusedAt) latest = meta;
  focusedLocalId = latest ? latest.localId : null;
  checkFront();
}

// Whether the Claude app is the app in front. Together with the session you
// focused last, that says which answer you are looking at right now.
let focusedLocalId = null;
let claudeInFront = false;
function checkFront() {
  execFile('/usr/bin/lsappinfo', ['front'], (err, asn) => {
    if (err || !/^[\w:-]+$/.test(asn.trim())) return;
    execFile('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn.trim()], (err2, out) => {
      if (!err2) claudeInFront = /bundleID="com\.anthropic\.claudefordesktop"/.test(out);
    });
  });
}

// ---------------------------------------------------------------- Codex
//
// OpenAI's Codex, the desktop app and the CLI, keeps its conversations
// ("threads") in ~/.codex: a list in an SQLite database, and one rollout file
// per thread with everything that happened in it. Both are only ever read.
// Codex's hooks add the one thing those files miss, that Codex waits for your
// permission: install-hooks.js adds ours to ~/.codex/hooks.json, and Codex
// runs them once you trust them there (Settings > Hooks).
//
// Another tool fits in the same way: find its conversations, read one into a
// status, and return a session in the shape buildSession returns, with its own
// `tool` and `toolName`.

const CODEX_HOME = process.env.AI_FLOWS_CODEX_HOME || path.join(HOME, '.codex');
const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_ROLLOUT_DIRS = ['sessions', 'archived_sessions'].map((d) => path.join(CODEX_HOME, d) + path.sep);
const codexEvents = new Map(); // thread id -> [hook events]
let codexThreads = new Map(); // thread id -> { id, rollout, cwd, title, name, source, originator, archived, updatedAt }
let codexScanAt = 0;
let codexBusy = false;

function ingestCodex(e) {
  const fromFile = typeof e.tp === 'string' && e.tp.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
  const id = CODEX_ID.test(e.sid || '') ? e.sid : fromFile ? fromFile[1] : null;
  if (!id) return;
  let list = codexEvents.get(id);
  if (!list) codexEvents.set(id, (list = []));
  let i = list.length;
  while (i > 0 && list[i - 1].ts > e.ts) i--;
  list.splice(i, 0, e);
  if (list.length > 200) list.splice(0, list.length - 200);
}

const inCodex = (p) => typeof p === 'string' && p.endsWith('.jsonl') &&
  CODEX_ROLLOUT_DIRS.some((d) => path.resolve(p).startsWith(d));

// The newest state database (its number goes up with Codex versions).
function codexDatabase() {
  let names = [];
  try { names = fs.readdirSync(CODEX_HOME); } catch { return null; }
  const dbs = names.map((n) => n.match(/^state_(\d+)\.sqlite$/)).filter(Boolean).sort((a, b) => b[1] - a[1]);
  return dbs.length ? path.join(CODEX_HOME, dbs[0][0]) : null;
}

// Subagents (source is a JSON object) belong to the thread that started them.
const CODEX_QUERIES = [
  (since) => `select id, rollout_path as rollout, cwd, title, name, source, originator, archived,
    coalesce(updated_at_ms, updated_at * 1000) as updatedAt from threads
    where coalesce(updated_at_ms, updated_at * 1000) > ${since} and source not like '{%'
    order by updatedAt desc limit 100`,
  // Databases from older Codex versions lack some of those columns.
  (since) => `select id, rollout_path as rollout, cwd, title, source, archived, updated_at * 1000 as updatedAt
    from threads where updated_at * 1000 > ${since} and source not like '{%' order by updated_at desc limit 100`,
];

function scanCodex() {
  const now = Date.now();
  if (codexBusy || now - codexScanAt < 4000) return;
  codexScanAt = now;
  const db = codexDatabase();
  if (!db) { codexThreads = scanCodexFiles(now); return; }
  codexBusy = true;
  const since = Math.floor(now - KEEP_MS);
  const finish = (rows) => {
    codexBusy = false;
    codexThreads = rows
      ? new Map(rows.filter((r) => r && CODEX_ID.test(r.id)).map((r) => [r.id, r]))
      : scanCodexFiles(Date.now());
  };
  const attempt = (i) => {
    if (i >= CODEX_QUERIES.length) return finish(null);
    execFile('/usr/bin/sqlite3', ['-readonly', '-json', db, CODEX_QUERIES[i](since)],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) { if (i === CODEX_QUERIES.length - 1) logOnce('codex database', err); return attempt(i + 1); }
        try { finish(out.trim() ? JSON.parse(out) : []); } catch (e) { logOnce('codex database', e); attempt(i + 1); }
      });
  };
  attempt(0);
}

// Without the database (no sqlite3, or a layout we do not know): the rollout
// files changed lately, named rollout-<date>-<thread id>.jsonl.
function scanCodexFiles(now) {
  const out = new Map();
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const fp = path.join(dir, n);
      if (depth < 3 && /^\d+$/.test(n)) { walk(fp, depth + 1); continue; }
      const m = n.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
      if (!m || !CODEX_ID.test(m[1])) continue;
      const st = safeStat(fp);
      if (!st || !st.isFile() || now - st.mtimeMs > KEEP_MS) continue;
      const meta = codexMeta(fp, st.mtimeMs);
      // Subagents (source is an object) belong to the thread that started them.
      if (!meta || (meta.source && typeof meta.source === 'object') || /^\s*\{/.test(meta.source || '')) continue;
      out.set(m[1], {
        id: m[1], rollout: fp, cwd: typeof meta.cwd === 'string' ? meta.cwd : null, title: null, archived: 0,
        source: typeof meta.source === 'string' ? meta.source : null,
        originator: typeof meta.originator === 'string' ? meta.originator : null, updatedAt: st.mtimeMs,
      });
    }
  };
  walk(path.join(CODEX_HOME, 'sessions'), 0);
  return out;
}

// The first line of a rollout says where and how the thread started.
const codexMetaCache = new Map(); // file -> { mtimeMs, meta }
function codexMeta(file, mtimeMs) {
  const c = codexMetaCache.get(file);
  if (c) return c.meta;
  let meta = {};
  try {
    const buf = Buffer.alloc(128 * 1024);
    const fd = fs.openSync(file, 'r');
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8', 0, n);
    const end = text.indexOf('\n');
    const first = JSON.parse(end >= 0 ? text.slice(0, end) : text);
    if (first && first.type === 'session_meta' && first.payload && typeof first.payload === 'object') meta = first.payload;
  } catch {}
  codexMetaCache.set(file, { mtimeMs, meta });
  if (codexMetaCache.size > 500) codexMetaCache.delete(codexMetaCache.keys().next().value);
  return meta;
}

function codexText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

// The app puts attached files above your words, which follow "## My request:".
function codexPrompt(text) {
  const t = String(text || '').slice(0, MAX_TEXT * 4);
  const m = t.match(/^##\s*My request(?: for Codex)?:[ \t]*$/m);
  return cleanPrompt(m ? t.slice(m.index + m[0].length) : t);
}

function codexCommand(cmd) {
  if (Array.isArray(cmd)) cmd = cmd.length >= 3 && /^-l?c$/.test(cmd[1]) ? cmd[2] : cmd.join(' ');
  return clip(String(cmd || '').slice(0, 1000).replace(/\s+/g, ' ').trim(), 160);
}

function parseArgs(a) {
  if (typeof a !== 'string') return a;
  try { return JSON.parse(a); } catch { return a; }
}

// What a finished step did, from an item_completed event.
function codexActivity(it) {
  switch (it.type) {
    case 'CommandExecution': return { tool: 'Bash', sum: codexCommand(it.command) };
    case 'FileChange': {
      const files = it.changes && typeof it.changes === 'object' ? Object.keys(it.changes) : [];
      return { tool: 'Edit', sum: files.length > 1 ? `${files[0]} (+${files.length - 1})` : files[0] || '' };
    }
    case 'McpToolCall': {
      const a = parseArgs(it.arguments) || {};
      const sum = typeof a === 'object' ? a.title || a.description || a.query || a.url || a.path || '' : '';
      return { tool: `mcp__${it.server || 'mcp'}__${it.tool || 'tool'}`, sum: clip(String(sum), 160) };
    }
    case 'Extension':
    case 'WebSearch':
      return { tool: it.kind === 'web.search' || it.type === 'WebSearch' ? 'WebSearch' : String(it.kind || 'Extension'), sum: clip(String(it.query || ''), 160) };
    case 'ImageView': return { tool: 'Read', sum: String(it.path || '').replace(/^file:\/\//, '') };
    default: return null;
  }
}

// What a step that just started does, from its tool call.
function codexCallSummary(args) {
  const a = parseArgs(args);
  if (a && typeof a === 'object') {
    const v = a.title || a.description || (a.cmd && codexCommand(a.cmd)) || (a.command && codexCommand(a.command)) || a.path || a.query || a.url || '';
    return clip(String(v).replace(/\s+/g, ' '), 160);
  }
  const text = String(a || '').slice(0, 2000);
  const cmd = text.match(/cmd:\s*"((?:[^"\\]|\\.){1,400})/);
  return clip((cmd ? cmd[1].replace(/\\"/g, '"') : text.split('\n')[0]).replace(/\s+/g, ' ').trim(), 160);
}

function deriveFromCodex(tail) {
  if (tail.derived) return tail.derived;
  const st = {
    status: 'idle', since: null, lastTs: 0, prompt: null, activity: null, ask: null, last: null,
    error: null, model: null, cwd: null, turnStart: null, progressTs: 0,
  };
  const set = (status, ts) => { if (st.status !== status) { st.status = status; st.since = ts; } };
  let lastMsg = null;
  for (const e of tail.entries) {
    const p = e && e.payload;
    if (!p || typeof p !== 'object') continue;
    const ts = (e.timestamp && Date.parse(e.timestamp)) || 0;
    if (ts) st.lastTs = Math.max(st.lastTs, ts);
    if (e.type === 'session_meta' || e.type === 'turn_context') {
      if (typeof p.cwd === 'string') st.cwd = p.cwd;
      if (typeof p.model === 'string') st.model = p.model;
    } else if (e.type === 'event_msg') {
      switch (p.type) {
        case 'task_started':
          st.turnStart = ts;
          st.progressTs = ts;
          st.ask = st.error = st.activity = null;
          lastMsg = null;
          set('working', ts);
          break;
        case 'user_message': // older Codex versions
          if (typeof p.message === 'string' && p.message.trim()) st.prompt = { text: codexPrompt(p.message), ts };
          break;
        case 'agent_message':
          if (typeof p.message === 'string') lastMsg = p.message;
          break;
        case 'item_completed': {
          const it = p.item || {};
          st.progressTs = ts;
          if (it.type === 'UserMessage') {
            const text = codexPrompt(codexText(it.content));
            if (text) st.prompt = { text, ts };
          } else if (it.type === 'AgentMessage') {
            const text = codexText(it.content);
            if (text) lastMsg = text;
          } else {
            const a = codexActivity(it);
            if (a) st.activity = { ...a, ts };
          }
          break;
        }
        case 'task_complete': {
          st.progressTs = ts;
          const text = typeof p.last_agent_message === 'string' && p.last_agent_message ? p.last_agent_message : lastMsg;
          if (text) st.last = { text, ts };
          st.activity = null;
          if (st.ask && st.ask.tuid) { set('question', ts); break; }
          const q = questionFromTurn(null, text);
          if (q) { st.ask = { ...q, ts }; set('question', ts); } else { st.ask = null; set('done', ts); }
          break;
        }
        case 'turn_aborted':
          st.progressTs = ts;
          st.activity = null;
          st.ask = null;
          set('interrupted', ts);
          break;
        case 'error':
          st.error = { text: clip(String(p.message || 'Onbekende fout'), 300), ts };
          set('error', ts);
          break;
      }
    } else if (e.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        st.progressTs = ts;
        if (p.name === 'request_user_input') {
          const a = parseArgs(p.arguments ?? p.input);
          st.ask = { ...askFromTool('AskUserQuestion', a && typeof a === 'object' ? a : {}), tuid: p.call_id, ts };
          set('question', ts);
        } else if (p.name !== 'wait') {
          st.activity = { tool: String(p.name || 'tool'), sum: codexCallSummary(p.arguments ?? p.input), ts };
          if (st.status !== 'question') set('working', ts);
        }
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        st.progressTs = ts;
        if (st.ask && st.ask.tuid && st.ask.tuid === p.call_id) {
          st.ask = null;
          if (st.status === 'question') set('working', ts);
        }
      }
    }
  }
  if (!st.last && lastMsg && st.status !== 'working') st.last = { text: lastMsg, ts: st.lastTs };
  tail.derived = st;
  return st;
}

// A permission prompt from Codex's hooks is open until something shows it was
// answered: a later hook, or the thread moving on in its rollout file.
const CODEX_ANSWERED = new Set(['PostToolUse', 'Stop', 'Interrupt', 'UserPromptSubmit', 'SessionStart', 'SessionEnd']);
function codexPermission(id, progressTs) {
  let perm = null;
  for (const e of codexEvents.get(id) || []) {
    if (e.ev === 'PermissionRequest') perm = { tool: e.tool || null, sum: e.sum || '', ts: e.ts };
    else if (perm && e.ts >= perm.ts && CODEX_ANSWERED.has(e.ev)) perm = null;
  }
  if (perm && (progressTs > perm.ts || Date.now() - perm.ts > KEEP_MS)) perm = null;
  return perm;
}

function buildCodexSession(t) {
  const sid = 'codex-' + t.id;
  const tail = inCodex(t.rollout) ? readTail(t.rollout) : null;
  const st = tail ? deriveFromCodex(tail) : null;
  // Older rollouts are compressed (.zst): the database still knows the thread.
  const lastTs = Math.max((st && st.lastTs) || 0, 0) || Number(t.updatedAt) || 0;
  let status = st ? st.status : 'done';
  if (status === 'idle') status = 'done';
  let since = (st && st.since) || lastTs;
  if (status === 'working' && st.turnStart) since = st.turnStart;
  if (status === 'working' && Date.now() - lastTs > STALE_MS) status = 'stale';

  let question = null;
  const perm = codexPermission(t.id, (st && st.progressTs) || 0);
  if (perm) {
    status = 'permission';
    question = {
      kind: 'permission', text: perm.tool ? `Mag Codex ${perm.tool} gebruiken?` : 'Codex vraagt toestemming',
      tool: perm.tool, detail: perm.tool ? perm.sum : null, options: [], context: null, ts: perm.ts,
    };
  } else if (status === 'question' && st.ask) {
    question = {
      kind: st.ask.kind, text: st.ask.text, options: st.ask.options || [], parts: st.ask.parts || null,
      context: st.ask.context || null, ts: st.ask.ts || since,
    };
  }

  const mark = marks.get(sid) || {};
  let unread = !!(mark.unread && mark.unread > (mark.read || 0)) && !['working', 'permission', 'question'].includes(status);
  if (question && mark.read && mark.read >= (question.ts || since || 0)) {
    question = null;
    status = 'done';
    unread = false;
  }
  const freshAt = Math.max((st && st.prompt && st.prompt.ts) || 0, (question && question.ts) || 0);
  const closed = !!mark.closed && freshAt <= mark.closed;

  const cwd = (typeof t.cwd === 'string' && t.cwd) || (st && st.cwd) || null;
  const project = projectFromCwd(cwd);
  const promptText = st && st.prompt && st.prompt.text;
  const named = (typeof t.name === 'string' && t.name.trim()) || codexPrompt(t.title || '').split('\n')[0];
  const title = named || (promptText ? clip(promptText.split('\n')[0], 70) : null) || project.name;
  const cli = t.source === 'cli' || t.source === 'exec' || /tui|cli|exec/i.test(t.originator || '');

  return {
    id: sid,
    tool: 'codex',
    toolName: 'Codex',
    localId: null,
    openUrl: cli ? null : `codex://threads/${t.id}`,
    resumeCmd: cli && !/[\p{Cc}\p{Cf}]/u.test(cwd || '') ? `cd ${shellQuote(cwd || HOME)} && codex resume ${shellQuote(t.id)}` : null,
    title: clip(String(title), 200),
    project: project.name,
    projectDetail: project.detail,
    folder: folderOf(null, cwd),
    cwd,
    closed,
    app: cli ? 'Codex CLI' : 'Codex-app',
    archived: !!Number(t.archived),
    unread,
    status,
    since,
    lastTs,
    prompt: st && st.prompt ? { text: clip(st.prompt.text, 600), ts: st.prompt.ts } : null,
    autoPrompt: null,
    activity: (st && st.activity) || null,
    background: false,
    last: st && st.last ? { text: clip(st.last.text, 1500), ts: st.last.ts } : null,
    recap: null,
    question: clipQuestion(question),
    error: (st && st.error) || null,
    model: (st && st.model) || null,
    subagents: [],
    source: tail ? 'rollout' : 'database',
  };
}

// When you last saw each session's answer: the app records when you focused a
// session; this adds "it finished while you were looking at it".
const seenAt = new Map(); // sid -> ms

// Your own marks from the dashboard's right-click menu: { sid: { unread, read,
// closed } } (times in ms). "Unread" lasts until you open the session in
// Claude or mark it read; "read" hides an unseen answer that finished before
// it; "closed" hides the session until you send it a new message or it asks
// something new. Kept in an owner-only file so they survive a restart.
const MARKS_FILE = path.join(EVENTS_DIR, 'marks.json');
let marks = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(MARKS_FILE, 'utf8'));
  if (raw && typeof raw === 'object') marks = new Map(Object.entries(raw));
} catch {}

function saveMarks() {
  const now = Date.now();
  for (const [sid, m] of marks) {
    if (now - Math.max(m.unread || 0, m.read || 0, m.closed || 0) > KEEP_MS) marks.delete(sid);
  }
  fs.mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${MARKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(marks)) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, MARKS_FILE);
}

// ---------------------------------------------------------------- state

const STATUS_RANK = { permission: 0, question: 1, working: 2, error: 3, interrupted: 4, stale: 5, done: 6, idle: 7, ended: 8 };

function buildSession(sid) {
  const ev = eventSessions.get(sid);
  const tr = transcriptIndex.get(sid);
  const desk = desktopByCli.get(sid) || null;
  // Only ever read transcripts where Claude Code keeps them.
  const inProjects = (p) => typeof p === 'string' && path.resolve(p).startsWith(PROJECTS_DIR + path.sep) && p.endsWith('.jsonl');
  const tpFile = [ev && ev.tp, tr && tr.file].find(inProjects) || null;
  const fromHooks = ev && ev.events.length ? deriveFromEvents(ev.events) : null;
  // Hooks that never saw the session's own turn (only, say, a background agent
  // finishing) know its subagents but not its status: read that elsewhere.
  const hookSt = fromHooks && (fromHooks.sawTurn || !tpFile) ? fromHooks : null;
  // A hook session only needs its transcript for what the hooks missed.
  const needTranscript = !hookSt || !hookSt.prompt || !hookSt.last ||
    (hookSt.status === 'working' && Date.now() - hookSt.lastTs > CHECK_INTERRUPT_MS);
  const tail = tpFile && needTranscript ? readTail(tpFile) : null;
  const fromTr = tail ? deriveFromTranscript(tail) : null;

  let st;
  let source;
  if (hookSt) {
    st = hookSt;
    source = 'hooks';
    // Hooks only started at install time: borrow what they missed.
    if (fromTr) {
      if (!st.prompt && fromTr.prompt) st.prompt = fromTr.prompt;
      if (!st.prompt && fromTr.lastPrompt && !isAutomated(fromTr.lastPrompt)) {
        st.prompt = { text: cleanPrompt(fromTr.lastPrompt.slice(0, 2000)), ts: null };
      }
      if (!st.last && fromTr.last) st.last = fromTr.last;
      if (!st.model && fromTr.model) st.model = fromTr.model;
      // Running since before the hooks: the transcript knows when it started.
      if (!st.turnStart && fromTr.status === st.status && fromTr.since) st.since = Math.min(st.since || Infinity, fromTr.since);
      // Escape in the app ends a turn without a Stop hook.
      if (st.status === 'working' && fromTr.interruptedAt && fromTr.interruptedAt >= (st.turnStart || 0)) {
        st.status = 'interrupted';
        st.since = fromTr.interruptedAt;
      }
    }
  } else if (fromTr) {
    st = { ...fromTr };
    if (!st.prompt && fromTr.lastPrompt && !isAutomated(fromTr.lastPrompt)) {
      st.prompt = { text: cleanPrompt(fromTr.lastPrompt.slice(0, 2000)), ts: null };
    }
    if (fromHooks) st.subagents = fromHooks.subagents;
    source = 'transcript';
  } else {
    return null;
  }

  // Real message times only: the app keeps touching transcript files (cost,
  // title) long after the last message, so file dates overstate activity.
  const lastTs = Math.max(st.lastTs || 0, (fromTr && fromTr.lastTs) || 0, (fromHooks && fromHooks.lastTs) || 0) ||
    (tail && tail.mtimeMs) || (tr && tr.mtimeMs) || 0;
  let status = st.status;
  let since = st.since || lastTs;
  // A permission prompt in the middle of a turn should not restart its clock.
  if (status === 'working' && st.turnStart) since = st.turnStart;
  // Turn began before what hooks or the transcript tail can see: the desktop
  // app records when your last message came in.
  if (status === 'working' && !st.turnStart && desk && desk.lastUserAt && desk.lastUserAt < since) since = desk.lastUserAt;
  if (status === 'working' && Date.now() - lastTs > STALE_MS) status = 'stale';

  // Background agents keep a session busy after its own turn ended. Ten
  // minutes without any of their tool calls and we stop counting one (a
  // killed agent never sends SubagentStop).
  const busySubs = st.subagents
    ? [...st.subagents.values()].filter((a) => Date.now() - ((a.activity && a.activity.ts) || a.ts || 0) < 10 * MINUTE)
    : [];
  let activity = st.activity;
  let background = false;
  // A finished answer you have not looked at yet (desktop sessions only: the
  // app is what knows when you focused one).
  let unread = false;
  const mark = marks.get(sid) || {};
  if (desk && claudeInFront && desk.localId === focusedLocalId) seenAt.set(sid, Date.now());
  const opened = desk ? Math.max(desk.lastFocusedAt || 0, seenAt.get(sid) || 0) : 0;
  if (desk) unread = (st.status === 'done' || st.status === 'error') && (since || 0) > Math.max(opened, mark.read || 0);
  if (mark.unread && mark.unread > Math.max(opened, mark.read || 0)) unread = true;

  if (busySubs.length && ['done', 'idle', 'interrupted', 'stale'].includes(status)) {
    status = 'working';
    background = true;
    since = Math.min(...busySubs.map((a) => a.ts || Date.now()));
    activity = busySubs.map((a) => a.activity).filter(Boolean).sort((a, b) => b.ts - a.ts)[0] || null;
  }
  // Busy or waiting for you has its own colour; "unread" is for the rest.
  if (status === 'working' || status === 'permission' || status === 'question') unread = false;
  if (status === 'idle' && !st.prompt && !st.last && source === 'transcript') status = 'done';

  const cwd = (ev && ev.cwd) || (fromTr && fromTr.cwd) || (desk && desk.cwd) || null;
  const project = projectFromCwd(cwd);
  const promptText = st.prompt && st.prompt.text;
  const title = (desk && desk.title) || (fromTr && fromTr.title) ||
    (promptText ? clip(promptText.split('\n')[0], 70) : null) ||
    (fromTr && fromTr.lastPrompt ? clip(fromTr.lastPrompt, 70) : null) || project.name;
  const entry = (ev && ev.ep) || (fromTr && fromTr.entry) || (desk ? 'claude-desktop' : null);
  const isDesktop = !!desk || /desktop/.test(entry || '');

  let question = null;
  if (status === 'question' && st.ask) {
    question = {
      kind: st.ask.kind, text: st.ask.text, options: st.ask.options || [], parts: st.ask.parts || null,
      context: st.ask.context || null, ts: st.ask.ts || st.since,
    };
  } else if (status === 'permission') {
    const p = st.perm || {};
    question = {
      kind: 'permission',
      text: p.tool ? `Mag Claude ${p.tool} gebruiken?` : (p.sum || 'Claude vraagt toestemming'),
      tool: p.tool || null, detail: p.tool ? p.sum : null, options: [], context: null, ts: p.ts || st.since,
    };
  }

  // "Mark as read" on a question you do not need to answer (often a turn that
  // just ends on a question sentence): it goes grey, leaves the questions list
  // and its notification is withdrawn. A newer question shows up again.
  if (question && mark.read && mark.read >= (question.ts || since || 0)) {
    question = null;
    status = 'done';
    unread = false;
  }

  // Closed from the right-click menu: hidden until something new happens that
  // needs you (a message you send, a new question).
  const freshAt = Math.max((st.prompt && st.prompt.ts) || 0, (desk && desk.lastUserAt) || 0, (question && question.ts) || 0);
  const closed = !!mark.closed && freshAt <= mark.closed;

  const recap = st.wrap && st.wrap.recap ? st.wrap.recap : (desk && desk.summary && desk.summary.status_detail) || null;

  return {
    id: sid,
    tool: 'claude',
    toolName: 'Claude',
    localId: desk ? desk.localId : null,
    openUrl: desk ? `claude://code/continue?session=${encodeURIComponent(desk.localId)}&source=ai-flows` : null,
    // Quoting stops the shell, not the terminal: control characters in a folder
    // name (an escape that ends a bracketed paste, say) could still act when
    // pasted. No command to copy for such a path.
    resumeCmd: !isDesktop && !/[\p{Cc}\p{Cf}]/u.test(`${cwd || ''}${sid}`)
      ? `cd ${shellQuote(cwd || HOME)} && claude --resume ${shellQuote(sid)}` : null,
    title: clip(String(title), 200),
    project: project.name,
    projectDetail: project.detail,
    folder: folderOf(desk, cwd),
    cwd,
    closed,
    app: isDesktop ? 'Claude-app' : 'Terminal',
    archived: desk ? desk.archived : false,
    unread,
    status,
    since,
    lastTs,
    prompt: st.prompt ? { text: clip(st.prompt.text, 600), ts: st.prompt.ts } : null,
    autoPrompt: st.autoPrompt || null,
    activity,
    background,
    last: st.last ? { text: clip(st.last.text, 1500), ts: st.last.ts } : null,
    recap: recap ? clip(String(recap), 1500) : null,
    question: clipQuestion(question),
    error: st.error,
    model: st.model || (desk && desk.model) || null,
    subagents: busySubs.map((a) => ({ type: a.type, activity: a.activity || null })),
    source,
  };
}

function computeState(windowMin) {
  readHookLog();
  scanTranscripts();
  scanDesktop();
  scanCodex();
  const now = Date.now();
  const windowMs = Math.max(5, Math.min(windowMin, 24 * 60)) * MINUTE;

  for (const [sid, s] of eventSessions) {
    const last = s.events.length ? s.events[s.events.length - 1].ts : 0;
    if (now - last > KEEP_MS) eventSessions.delete(sid);
  }
  for (const [id, list] of codexEvents) {
    if (!list.length || now - list[list.length - 1].ts > KEEP_MS) codexEvents.delete(id);
  }
  for (const f of tailCache.keys()) {
    if (![...transcriptIndex.values()].some((t) => t.file === f) &&
        ![...eventSessions.values()].some((s) => s.tp === f) &&
        ![...codexThreads.values()].some((t) => t.rollout === f)) tailCache.delete(f);
  }

  const ids = new Set([...eventSessions.keys(), ...transcriptIndex.keys()]);
  const builders = [
    ...[...ids].map((sid) => [sid, () => buildSession(sid)]),
    ...[...codexThreads.values()].map((t) => [`codex ${t.id}`, () => buildCodexSession(t)]),
  ];
  const sessions = [];
  for (const [name, build] of builders) {
    let s;
    try { s = build(); } catch (err) { logOnce(`session ${name}`, err); continue; }
    if (!s) continue;
    const live = s.status === 'working' || s.status === 'permission';
    if (s.archived && !live) continue;
    if (s.closed) continue;
    if (now - s.lastTs > (live ? KEEP_MS : windowMs)) continue;
    sessions.push(s);
  }
  // Order by when a session entered its status, not by its last event: that
  // one changes on every tool call and made busy sessions swap places.
  // Unseen answers first within "done".
  const rank = (s) => STATUS_RANK[s.status] + (s.status === 'done' && !s.unread ? 0.5 : 0);
  sessions.sort((a, b) => (rank(a) - rank(b)) || (b.since - a.since) || a.id.localeCompare(b.id));
  return {
    now,
    // Changes when the page's own files change, so open dashboards reload.
    build: Math.max(...['index.html', 'app.js', 'app.css'].map((f) => (safeStat(path.join(PUBLIC_DIR, f)) || {}).mtimeMs || 0)),
    windowMin: windowMs / MINUTE,
    hooksSeen: eventSessions.size > 0,
    notify: settings.notify,
    openVia: settings.openVia,
    toolLabels: settings.toolLabels,
    notifier: notifierAvailable(),
    sessions,
  };
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// Errors are logged at most once per 10 minutes per kind, so a bad transcript
// cannot grow the log without end.
const logged = new Map();
function logOnce(key, err) {
  const now = Date.now();
  if (now - (logged.get(key) || 0) < 10 * MINUTE) return;
  logged.set(key, now);
  console.error(new Date().toISOString(), key, (err && err.message) || err);
}
process.on('unhandledRejection', (err) => logOnce('unhandled', err));

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// Access key. The checks further down keep websites out; this keeps out other
// programs and accounts on this Mac, which can reach 127.0.0.1 too. Only you
// can read the file, and the page learns the key once from your link.
const TOKEN_FILE = path.join(EVENTS_DIR, 'token');
function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(t)) { restrict(TOKEN_FILE, 0o600); return t; }
  } catch {}
  const t = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}
const TOKEN = Buffer.from(loadToken());

function authorized(req, url) {
  // EventSource cannot send headers, so the stream (and only the stream) may
  // pass the key as ?t=.
  const fromQuery = url.pathname === '/api/stream' ? url.searchParams.get('t') : '';
  const given = Buffer.from(String(req.headers['x-ai-flows-token'] || fromQuery || ''));
  return given.length === TOKEN.length && crypto.timingSafeEqual(given, TOKEN);
}

// The page only offers these periods; anything else is rounded to one of them,
// so odd values cannot each cost a computation per second.
const WINDOWS = [30, 120, 480, 1440];
const windowOf = (v) => WINDOWS.reduce((best, w) => (Math.abs(w - v) < Math.abs(best - v) ? w : best), 120);

const MAX_STREAMS = 16;
const streams = new Set(); // { res, windowMin, lastBody }

function pushStreams() {
  const byWindow = new Map();
  for (const c of streams) {
    // A client that stops reading would make us buffer forever: drop it.
    if (c.res.writableLength > 1024 * 1024) { c.res.destroy(); streams.delete(c); continue; }
    let body = byWindow.get(c.windowMin);
    if (body === undefined) {
      try {
        const { now, ...rest } = computeState(c.windowMin);
        body = JSON.stringify(rest);
      } catch (err) {
        logOnce('state', err);
        return;
      }
      byWindow.set(c.windowMin, body);
    }
    if (body !== c.lastBody) {
      c.lastBody = body;
      c.res.write(`data: ${body}\n\n`);
    }
  }
}

// ---------------------------------------------------------------- notifications

// macOS notifications come from notifier/AI Flows.app (build it with
// notifier/build.sh). A question is announced once it has been open for a few
// seconds, and its notification is withdrawn again once it is answered.
const NOTIFIER_APP = path.join(__dirname, 'notifier', 'AI Flows.app');
const SETTINGS_FILE = path.join(EVENTS_DIR, 'settings.json');
const NOTIFY_GRACE_MS = 4000;
// Clicking a notification for a terminal session opens the dashboard. Always
// 127.0.0.1, never "localhost": that name tries [::1] first, where another
// program could be listening (we take [::1] too, but only while we run).
const DASHBOARD_URL = `http://127.0.0.1:${PORT}/`;
const NOTIFY_DIR = path.join(EVENTS_DIR, 'notify');

// openVia: how "Open in Claude" works from the dashboard.
//   'server'  — the server opens the session: no question asked, but macOS
//               (14+) does not let a background program bring Claude forward.
//   'browser' — your browser or app opens the link: Claude comes forward with
//               the keyboard focus; the browser may ask for permission.
const OPEN_VIA = ['server', 'browser'];
// toolLabels: each mini row names its AI tool (Claude, Codex). Off by default.
const DEFAULT_SETTINGS = { notify: true, openVia: 'server', toolLabels: false };

function loadSettings() {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    if (!OPEN_VIA.includes(s.openVia)) s.openVia = DEFAULT_SETTINGS.openVia;
    if (typeof s.toolLabels !== 'boolean') s.toolLabels = DEFAULT_SETTINGS.toolLabels;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
let settings = loadSettings();
restrict(SETTINGS_FILE, 0o600);

function saveSettings() {
  fs.mkdirSync(EVENTS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

function notifierAvailable() {
  return fs.existsSync(path.join(NOTIFIER_APP, 'Contents', 'MacOS', 'AI Flows'));
}

// payload: { id, title, subtitle, body, url, thread }, or { remove: id }.
// The text goes to the helper in an owner-only file, not as arguments: other
// accounts can read the arguments of running programs.
function runNotifier(payload) {
  const clean = {};
  for (const [k, v] of Object.entries(payload)) clean[k] = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (process.env.AI_FLOWS_DRY_OPEN) { console.log('notify (dry run):', JSON.stringify(clean)); return; }
  try {
    let args;
    if (clean.remove) {
      args = ['--remove', clean.remove];
    } else {
      fs.mkdirSync(NOTIFY_DIR, { recursive: true, mode: 0o700 });
      const file = path.join(NOTIFY_DIR, `${crypto.randomBytes(12).toString('hex')}.json`);
      fs.writeFileSync(file, JSON.stringify(clean), { mode: 0o600 });
      args = ['--payload', file];
    }
    execFile('/usr/bin/open', ['-n', '-g', '-a', NOTIFIER_APP, '--args', ...args], () => {});
  } catch (err) {
    logOnce('notify', err);
  }
}

// The helper deletes a payload once read; sweep up any it never got to.
function sweepPayloads() {
  let names = [];
  try { names = fs.readdirSync(NOTIFY_DIR); } catch { return; }
  for (const n of names) {
    const f = path.join(NOTIFY_DIR, n);
    const st = safeStat(f);
    if (st && Date.now() - st.mtimeMs > 10 * MINUTE) { try { fs.unlinkSync(f); } catch {} }
  }
}
setInterval(sweepPayloads, 5 * MINUTE);

const questionKey = (s) => `${s.id}|${s.question.kind}|${s.question.ts || ''}`;

function announceQuestion(s, key) {
  const q = s.question;
  const id = 'q-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  const perm = q.kind === 'permission';
  const body = perm && q.detail ? `${q.tool ? q.tool + ': ' : ''}${q.detail}` : q.text;
  runNotifier({
    id,
    title: s.title,
    subtitle: `${perm ? 'Toestemming nodig' : 'Vraag'} · ${s.project}`,
    body: clip(String(body).replace(/\s+/g, ' '), 240),
    url: s.openUrl || DASHBOARD_URL,
    thread: s.id,
  });
  return id;
}

const announced = new Map(); // question key -> { firstSeen, sentId, skip }
let notifyPrimed = false;

function checkQuestions() {
  if (!notifierAvailable()) return;
  const state = computeState(120);
  const now = Date.now();
  const open = new Map();
  for (const s of state.sessions) {
    if (s.question && (s.status === 'question' || s.status === 'permission')) open.set(questionKey(s), s);
  }
  // Questions already open when the server starts were seen before: no pop-up.
  if (!notifyPrimed) {
    for (const k of open.keys()) announced.set(k, { firstSeen: now, sentId: null, skip: true });
    notifyPrimed = true;
    return;
  }
  for (const [k, s] of open) {
    let a = announced.get(k);
    if (!a) announced.set(k, (a = { firstSeen: now, sentId: null, skip: false }));
    if (!a.skip && !a.sentId && settings.notify && now - a.firstSeen >= NOTIFY_GRACE_MS) a.sentId = announceQuestion(s, k);
  }
  for (const [k, a] of announced) {
    if (open.has(k)) continue;
    if (a.sentId) runNotifier({ remove: a.sentId });
    announced.delete(k);
  }
}

setInterval(() => { try { checkQuestions(); } catch (err) { logOnce('questions', err); } }, 2000);

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) { resolve({}); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('close', () => resolve({}));
    req.on('error', () => resolve({}));
  });
}

// Actions need a POST with our own header: a cross-site page can only send it
// after a CORS preflight, which this server never grants.
const isAction = (req) => req.method === 'POST' && req.headers['x-ai-flows'] === '1';

async function handleSettings(req, res) {
  if (req.method === 'POST') {
    if (!isAction(req)) { res.writeHead(403); return res.end(); }
    const body = await readJson(req);
    if (body && OPEN_VIA.includes(body.openVia)) {
      settings.openVia = body.openVia;
      saveSettings();
    }
    if (body && typeof body.toolLabels === 'boolean') {
      settings.toolLabels = body.toolLabels;
      saveSettings();
      pushStreams();
    }
    if (body && typeof body.notify === 'boolean') {
      settings.notify = body.notify;
      saveSettings();
      if (body.notify && notifierAvailable()) {
        runNotifier({ id: 'ai-flows-test', title: 'AI Flows', subtitle: 'Meldingen staan aan',
          body: 'Je krijgt hier een melding zodra een sessie iets van je nodig heeft.', url: DASHBOARD_URL });
      }
    }
  }
  sendJson(res, { notify: settings.notify, openVia: settings.openVia, toolLabels: settings.toolLabels, notifier: notifierAvailable() });
}

// One-time code: open.sh writes "<code> <unix time>" to an owner-only file and
// opens the page with #c=<code>; the page trades it here for the key. So the
// key itself is never in a link (history, clipboard, process list). A code
// works once and for two minutes; wrong guesses do not use it up.
const CLAIM_FILE = path.join(EVENTS_DIR, 'claim');
const CLAIM_MAX_AGE_MS = 2 * MINUTE;

async function handleClaim(req, res) {
  if (!isAction(req)) { res.writeHead(403); return res.end(); }
  const body = await readJson(req);
  const code = body && typeof body.code === 'string' ? body.code : '';
  let stored = '';
  let created = 0;
  try {
    const st = fs.statSync(CLAIM_FILE);
    if (st.isFile() && (st.mode & 0o077) === 0) [stored, created] = fs.readFileSync(CLAIM_FILE, 'utf8').trim().split(/\s+/);
  } catch {}
  const fresh = !!stored && Date.now() - Number(created) * 1000 <= CLAIM_MAX_AGE_MS;
  const a = Buffer.from(code);
  const b = Buffer.from(stored);
  const match = fresh && b.length >= 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (match || (stored && !fresh)) { try { fs.unlinkSync(CLAIM_FILE); } catch {} }
  if (!match) return sendJson(res, { error: 'Deze code is ongeldig of verlopen' }, 401);
  sendJson(res, { token: TOKEN.toString() });
}

// Mark a session from the right-click menu: read, unread, closed, or open
// again (the undo of closed).
const MARK_KINDS = ['read', 'unread', 'closed', 'open'];
async function handleMark(req, res) {
  if (!isAction(req)) { res.writeHead(403); return res.end(); }
  const body = await readJson(req);
  const sid = body && typeof body.id === 'string' ? body.id : '';
  // { unread: true/false } is how pages from before "close" ask.
  const kind = body && typeof body.mark === 'string' ? body.mark
    : body && typeof body.unread === 'boolean' ? (body.unread ? 'unread' : 'read') : '';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sid) || !MARK_KINDS.includes(kind)) return sendJson(res, { error: 'Ongeldig' }, 400);
  const m = { ...(marks.get(sid) || {}) };
  const now = Date.now();
  if (kind === 'unread') m.unread = now;
  else if (kind === 'read') { m.read = now; delete m.unread; }
  else if (kind === 'closed') m.closed = now;
  else delete m.closed;
  if (Object.keys(m).length) marks.set(sid, m); else marks.delete(sid);
  saveMarks();
  pushStreams();
  sendJson(res, { ok: true, mark: kind });
}

// "Open in Claude" when openVia is 'server': no browser question, but Claude
// stays behind your current window (see OPEN_VIA).
function openSession(req, res, sid) {
  if (!isAction(req)) { res.writeHead(403); return res.end(); }
  let link;
  const codexId = typeof sid === 'string' && sid.startsWith('codex-') ? sid.slice(6) : null;
  if (codexId) {
    if (!CODEX_ID.test(codexId) || !codexThreads.has(codexId)) return sendJson(res, { ok: false }, 404);
    link = `codex://threads/${codexId}`;
  } else {
    scanDesktop();
    const desk = desktopByCli.get(sid);
    if (!desk || !/^local_[A-Za-z0-9-]{1,64}$/.test(desk.localId || '')) return sendJson(res, { ok: false }, 404);
    link = `claude://code/continue?session=${desk.localId}&source=ai-flows`;
  }
  if (process.env.AI_FLOWS_DRY_OPEN) {
    console.log('open (dry run):', link);
    return sendJson(res, { ok: true, dryRun: true, link });
  }
  execFile('/usr/bin/open', [link], (err) => sendJson(res, { ok: !err }));
}

// Every response: only our own files may load, the page may not be framed by
// another site (clickjacking), and other origins may not embed our responses.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  // Only answer to localhost names: keeps other websites out via DNS rebinding.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) {
    res.writeHead(403);
    return res.end();
  }
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }

  if (url.pathname === '/api/claim') {
    return handleClaim(req, res).catch((err) => {
      logOnce('claim', err);
      if (!res.headersSent) sendJson(res, { error: 'Fout' }, 500);
    });
  }
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(req, url)) return sendJson(res, { error: 'Geen toegang' }, 401);
    const windowMin = windowOf(Number(url.searchParams.get('window')) || 120);
    if (url.pathname === '/api/state') return sendJson(res, computeState(windowMin));
    if (url.pathname === '/api/open') return openSession(req, res, url.searchParams.get('id'));
    if (url.pathname === '/api/mark') {
      return handleMark(req, res).catch((err) => {
        logOnce('mark', err);
        if (!res.headersSent) sendJson(res, { error: 'Fout' }, 500);
      });
    }
    if (url.pathname === '/api/settings') {
      return handleSettings(req, res).catch((err) => {
        logOnce('settings', err);
        if (!res.headersSent) sendJson(res, { error: 'Fout' }, 500);
      });
    }
    if (url.pathname === '/api/stream') {
      if (streams.size >= MAX_STREAMS) return sendJson(res, { error: 'Te veel verbindingen' }, 429);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      const c = { res, windowMin, lastBody: null };
      streams.add(c);
      pushStreams();
      req.on('close', () => streams.delete(c));
      return;
    }
    return sendJson(res, { error: 'Onbekend' }, 404);
  }

  // Pages always live on 127.0.0.1 (see DASHBOARD_URL). Old localhost links
  // land there too; the browser keeps the #fragment across the redirect.
  if (!/^127\.0\.0\.1(:\d+)?$/.test(req.headers.host)) {
    res.writeHead(302, { Location: `http://127.0.0.1:${PORT}${url.pathname}${url.search}` });
    return res.end();
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(PUBLIC_DIR, file);
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Niet gevonden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function onRequest(req, res) {
  try {
    handle(req, res);
  } catch (err) {
    logOnce('request', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

setInterval(() => { if (streams.size) pushStreams(); }, 1000);
setInterval(() => { for (const c of streams) c.res.write(': ping\n\n'); }, 20000);

// Listen on 127.0.0.1 and also take [::1], so nothing else can answer for
// "localhost" on this port while we run. If either is taken, stop: something
// else is squatting the port.
function listen(host, optional) {
  const srv = http.createServer(onRequest);
  srv.on('error', (err) => {
    if (optional && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) return; // no IPv6 here
    console.error(`${new Date().toISOString()} Kan niet luisteren op ${host} poort ${PORT} (${err.code}). Draait daar al iets anders?`);
    process.exit(1);
  });
  srv.listen(PORT, host);
}
listen(HOST, false);
listen('::1', true);
console.log(`AI Flows draait op http://127.0.0.1:${PORT}`);
console.log(`Hook-log: ${EVENTS_DIR}`);
