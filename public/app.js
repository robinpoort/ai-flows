(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Write only when the value changed, so idle updates leave the page alone.
  const setText = (el, v) => { v = String(v); if (el.textContent !== v) el.textContent = v; };
  const setHTML = (el, v) => { if (el.dataset.html !== v) { el.dataset.html = v; el.innerHTML = v; } };
  const setHidden = (el, v) => { if (el.hidden !== v) el.hidden = v; };
  const setTitle = (el, v) => { if (el.title !== v) el.title = v; };

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('ai-flows:' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('ai-flows:' + key, JSON.stringify(value)); } catch {}
    },
  };

  // Access: the page trades a one-time code from ./open.sh (#c=…) for the key,
  // which then lives in this browser's storage. The key itself never travels
  // in a link, and the code leaves the address bar straight away. A link that
  // carries a key (#t=…) is ignored, so no website can swap the stored key.
  let token = store.get('token', '');
  const CODE_RE = /(?:^|[#&?])c=([A-Za-z0-9_-]{32,})/;
  const KEY_RE = /^[A-Za-z0-9_-]{32,}$/;

  function codeFromLink() {
    const m = location.hash.match(CODE_RE);
    if (!m) {
      // A link with a key in it is not used, but it should not linger either.
      if (/(?:^#|&)t=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
      return '';
    }
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }

  async function claim(code) {
    try {
      const r = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'X-AI-Flows': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) return false;
      const d = await r.json();
      if (!d || typeof d.token !== 'string' || !KEY_RE.test(d.token)) return false;
      token = d.token;
      store.set('token', token);
      return true;
    } catch {
      return false;
    }
  }

  async function keyWorks(candidate) {
    try { return (await fetch('/api/settings', { headers: { 'X-AI-Flows-Token': candidate } })).ok; } catch { return false; }
  }

  function unlock() {
    document.body.classList.remove('locked');
    document.getElementById('locked').hidden = true;
    connect();
  }
  const showUnlockError = (show) => { document.getElementById('unlock-error').hidden = !show; };

  // A link opened or pasted into a tab that is already open does not reload it.
  window.addEventListener('hashchange', async () => {
    const code = codeFromLink();
    if (!code) return;
    if (await claim(code)) { showUnlockError(false); unlock(); } else { showLocked(); showUnlockError(true); }
  });

  // For apps and browsers without an address bar: paste the link from
  // `./open.sh --copy`, or the bare key. Both are checked before anything is kept.
  async function unlockFromField() {
    const input = document.getElementById('unlock-input');
    const value = input.value.trim();
    const m = value.match(CODE_RE);
    let ok = false;
    if (m) {
      ok = await claim(m[1]);
    } else if (KEY_RE.test(value) && await keyWorks(value)) {
      token = value;
      store.set('token', token);
      ok = true;
    }
    if (!ok) { showUnlockError(true); input.select(); return; }
    input.value = '';
    showUnlockError(false);
    unlock();
  }
  document.getElementById('unlock-button').addEventListener('click', unlockFromField);
  document.getElementById('unlock-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockFromField(); });
  const apiHeaders = (extra = {}) => ({ 'X-AI-Flows-Token': token, ...extra });

  function showLocked() {
    document.body.classList.add('locked');
    document.getElementById('locked').hidden = false;
    if (es) { es.close(); es = null; }
  }

  // Text from the model that ends up on your clipboard (an answer you paste as
  // your own message, a command): strip control and invisible characters —
  // zero-width, bidi, Unicode tags, variation selectors, fillers, private-use
  // and unassigned code points — and keep answers short.
  const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u034F\u115F\u1160\u3164\uFFA0\u2800\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
  const cleanAnswer = (s) => Array.from(String(s).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()).slice(0, 300).join('');

  const STATUS = {
    working: { label: 'Working', cls: 'working' },
    permission: { label: 'Needs permission', cls: 'permission' },
    question: { label: 'Waiting for you', cls: 'question' },
    done: { label: 'Done', cls: 'done' },
    idle: { label: 'Started', cls: 'idle' },
    interrupted: { label: 'Interrupted', cls: 'idle' },
    stale: { label: 'Quiet', cls: 'stale' },
    error: { label: 'Error', cls: 'error' },
    ended: { label: 'Ended', cls: 'idle' },
  };

  const QUESTION_KIND = {
    wrap: 'Question',
    text: 'Question in the reply',
    ask: 'Choice',
    plan: 'Approve the plan',
    permission: 'Permission',
    elicitation: 'Input requested',
  };

  const TOOL_NAMES = {
    Bash: 'Terminal', Read: 'Read', Edit: 'Edit', MultiEdit: 'Edit', Write: 'Write',
    Grep: 'Search', Glob: 'Find files', WebFetch: 'Web page', WebSearch: 'Web search',
    Agent: 'Subagent', Task: 'Subagent', Skill: 'Skill', ToolSearch: 'Loading tools', Monitor: 'Waiting',
    exec: 'Terminal', js: 'Script', apply_patch: 'Edit', spawn_agent: 'Subagent', update_plan: 'Plan',
    NotebookEdit: 'Notebook', Artifact: 'Artifact', SendUserFile: 'Sending a file', Workflow: 'Workflow',
  };

  let windowMin = store.get('window', 120);
  let state = null;
  let es = null;
  let connected = false;
  let knownQuestions = null;
  let bootBuild = null;
  const htmlCache = new Map();

  // ---------------------------------------------------------------- text

  function plain(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, '[code]')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/^\|.*\|\s*$/gm, (l) => (/^\|[\s:|-]+\|$/.test(l) ? '' : l.replace(/^\||\|$/g, '').replace(/\s*\|\s*/g, ' · ').trim()))
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function toolName(tool) {
    if (!tool) return 'Working';
    if (TOOL_NAMES[tool]) return TOOL_NAMES[tool];
    if (/^mcp__claude-in-chrome__/.test(tool)) return 'Chrome';
    if (/^mcp__Claude_Browser__/.test(tool)) return 'Browser';
    if (/^mcp__ccd_/.test(tool)) return 'Claude app';
    const m = tool.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
    return m ? m[1].replace(/_/g, ' ') : tool;
  }

  // The AI tool a session runs in: Claude, Codex, …
  function appOf(s) { return (s && s.toolName) || 'Claude'; }

  function shortPath(s) {
    return String(s || '').replace(/\/Users\/[^/\s]+/g, '~');
  }

  function ago(ts) {
    const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h${m % 60 ? ' ' + (m % 60) + ' min' : ''} ago`;
    return `${Math.floor(h / 24)} d ago`;
  }

  function compact(ts) {
    const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
  }

  function dur(ts) {
    const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (m < 1) return '<1 min';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
  }

  // Time labels are filled in after render so cached card HTML stays stable.
  function timeEl(ts, mode, prefix = '') {
    return `<span class="time" data-ts="${Number(ts) || 0}" data-mode="${mode}" data-prefix="${esc(prefix)}"></span>`;
  }

  function updateTimes(root = document) {
    for (const el of $$('[data-ts]', root)) {
      const ts = Number(el.dataset.ts);
      if (!ts) { setText(el, ''); continue; }
      const text = el.dataset.mode === 'dur' ? dur(ts) : el.dataset.mode === 'compact' ? compact(ts) : ago(ts);
      setText(el, (el.dataset.prefix ? el.dataset.prefix + ' ' : '') + text);
      const title = new Date(ts).toLocaleString('en-GB');
      if (el.title !== title) el.title = title;
    }
  }

  function statusTime(s) {
    switch (s.status) {
      case 'working': return timeEl(s.since, 'dur', 'for');
      case 'question':
      case 'permission': return timeEl((s.question && s.question.ts) || s.since, 'dur', 'waiting');
      case 'stale': return timeEl(s.lastTs, 'ago', 'last active');
      case 'done': return timeEl(s.since || s.lastTs, 'ago', 'done');
      default: return timeEl(s.lastTs, 'ago');
    }
  }

  // ---------------------------------------------------------------- buttons

  const ICON_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 10.5V4a1.5 1.5 0 0 1 1.5-1.5H11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function openButton(s, primary) {
    if (s.openUrl) {
      return `<a class="btn ${primary ? 'primary' : ''}" href="${esc(s.openUrl)}" data-act="open" data-sid="${esc(s.id)}">${ICON_OPEN}Open in ${esc(appOf(s))}</a>`;
    }
    if (s.resumeCmd) {
      return `<button type="button" class="btn ${primary ? 'primary' : ''}" data-act="copy" data-text="${esc(s.resumeCmd)}" title="${esc(s.resumeCmd)}">${ICON_COPY}Copy resume command</button>`;
    }
    return '';
  }

  function optionsHtml(s, options) {
    if (!options || !options.length) return '';
    return `<div class="options">${options.map((o) =>
      `<button type="button" class="option" data-act="answer" data-sid="${esc(s.id)}" data-text="${esc(o.label)}" title="Copy and open the session">${esc(o.label)}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</button>`
    ).join('')}</div>`;
  }

  const ICON_SUB = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v5.5a2.5 2.5 0 0 0 2.5 2.5H13M10.5 8 13 10.5 10.5 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  // ---------------------------------------------------------------- full view

  // Every session in a list by status, beside the whole of the one you pick:
  // its question with the answers, what it is doing, your prompt and the full
  // reply. Each row also has its own button to open the session straight away.
  const SECTIONS = [
    { key: 'you', label: 'Waiting for you' },
    { key: 'busy', label: 'Working' },
    { key: 'done', label: 'Done' },
  ];
  const asks = (s) => !!s.question && (s.status === 'question' || s.status === 'permission');
  const sectionOf = (s) => (asks(s) ? 'you' : s.status === 'working' || s.status === 'stale' ? 'busy' : 'done');
  const folderName = (s) => (s.folder && s.folder.name) || s.project || '';

  // The session a sub-task came from, when it is in the list.
  const parentOf = (s) => (s.parentLocalId && ((state && state.sessions) || []).find((x) => x.localId === s.parentLocalId && x.id !== s.id)) || null;

  // The picked session is kept per tab, across reloads.
  const picked = {
    get() { try { return sessionStorage.getItem('ai-flows:selected'); } catch { return null; } },
    set(id) { try { sessionStorage.setItem('ai-flows:selected', id); } catch {} },
  };
  let selectedId = picked.get();
  let selectedIndex = 0;

  // One line under the title: what the session needs from you or is doing.
  function rowLine(s) {
    const q = s.question;
    if (asks(s)) {
      return q.kind === 'permission' && q.tool
        ? `${toolName(q.tool)}${q.detail ? ': ' + shortPath(q.detail) : ''}`
        : q.text.split('\n')[0];
    }
    const prompt = (s.prompt && s.prompt.text) || (s.autoPrompt && s.autoPrompt.text) || '';
    if (s.status === 'working' || s.status === 'stale') {
      const doing = s.activity ? [toolName(s.activity.tool), shortPath(s.activity.sum)].filter(Boolean).join(' · ') : prompt;
      return s.status === 'stale' ? `Quiet · ${doing}` : doing || 'Working';
    }
    if (s.status === 'error' && s.error) return s.error.text;
    const text = plain(s.recap || (s.last && s.last.text) || '');
    return text.split('\n').find((l) => l.trim()) || prompt;
  }

  function sideRow(s, r = {}) {
    const key = 's:' + s.id;
    const sel = s.id === selectedId;
    const cls = (MINI_CLASS[s.status] || 'done') + (s.unread ? ' unread' : '') + (sel ? ' sel' : '') + (r.tree || '');
    const when = (s.question && s.question.ts) || (s.status === 'working' ? s.since : s.lastTs);
    const app = appOf(s);
    const from = !(r.tree || '').split(' ').includes('sub') && parentOf(s);
    const open = s.openUrl
      ? `<a class="srow-open" href="${esc(s.openUrl)}" data-act="open" data-sid="${esc(s.id)}" title="Open in ${esc(app)}" aria-label="${esc(`Open ${s.title} in ${app}`)}">${ICON_OPEN}</a>`
      : s.resumeCmd
        ? `<button type="button" class="srow-open" data-act="copy" data-text="${esc(s.resumeCmd)}" title="Copy resume command" aria-label="${esc(`Copy the resume command of ${s.title}`)}">${ICON_COPY}</button>`
        // Nothing to open: keep its place, so the times stay in one column.
        : '<span class="srow-open none" aria-hidden="true"></span>';
    return {
      key,
      html: `
      <div class="srow ${cls}" data-key="${esc(key)}">
        <button type="button" class="srow-main" data-act="select" data-sid="${esc(s.id)}" aria-current="${sel}"${subsAttr(r)}>
          <span class="sdot"></span>
          <span class="stitle-line"><span class="stitle">${esc(s.title)}</span>${subToggle(r)}</span>
          ${timeEl(when, 'compact')}
          <span class="sline">${esc(rowLine(s))}</span>
          <span class="smeta">${miniTools ? `<span class="stool">${esc(app)}</span>` : ''}${esc(folderName(s))} · ${esc(s.app)}${from ? ` · subtask of ${esc(from.title)}` : ''}</span>
        </button>
        ${open}
      </div>`,
    };
  }

  function renderSide(sessions, questions) {
    const groups = { you: questions, busy: [], done: [] };
    for (const s of sessions) if (!asks(s)) groups[sectionOf(s)].push(s);
    const rows = {};
    const folded = new Map();
    for (const sec of SECTIONS) {
      rows[sec.key] = nest(groups[sec.key]);
      for (const r of rows[sec.key]) if (r.sum) for (const k of r.subs) folded.set(k.id, r.sum.id);
    }
    // A folded sub-task cannot stay picked: its session takes its place.
    if (folded.has(selectedId)) {
      selectedId = folded.get(selectedId);
      picked.set(selectedId);
    }
    const order = [...rows.you, ...rows.busy, ...rows.done].filter((r) => r.s).map((r) => r.s);
    // Keep the picked session; when it is gone, take the one now in its place.
    let i = order.findIndex((s) => s.id === selectedId);
    if (i < 0 && order.length) {
      i = Math.min(selectedIndex, order.length - 1);
      selectedId = order[i].id;
    }
    selectedIndex = Math.max(0, i);

    const items = [];
    for (const sec of SECTIONS) {
      const list = groups[sec.key];
      if (!list.length) continue;
      items.push({
        key: 'h:' + sec.key,
        html: `<div class="shead ${sec.key}" data-key="h:${sec.key}">${sec.label}<span class="count">${list.length}</span></div>`,
      });
      for (const r of rows[sec.key]) items.push(r.sum ? subSummary(r, 'srow') : sideRow(r.s, r));
    }
    renderList($('#side-list'), items);
    setHidden($('#flow-empty'), sessions.length > 0);
    document.body.classList.toggle('no-sessions', sessions.length === 0);
    renderDetail(order.length ? find(selectedId) : null);
  }

  function questionBlock(s) {
    const q = s.question;
    const perm = q.kind === 'permission';
    let inner;
    if (q.parts && q.parts.length) {
      inner = q.parts.map((p) => `
        <div class="part">
          ${p.header ? `<div class="ph">${esc(p.header)}</div>` : ''}
          <p class="ask-q">${esc(p.question)}</p>
          ${optionsHtml(s, p.options.map((o) => ({ label: o.label, desc: o.description })))}
        </div>`).join('');
    } else {
      inner = `
        <p class="ask-q">${esc(q.text)}</p>
        ${q.detail ? `<div class="ask-detail mono">${esc(shortPath(q.detail))}</div>` : ''}
        ${q.context ? `<p class="d-text muted">${esc(plain(q.context))}</p>` : ''}
        ${optionsHtml(s, (q.options || []).map((label) => ({ label })))}`;
    }
    return `<section class="d-card ${perm ? 'permission' : 'ask'}"><div class="d-label">${esc(QUESTION_KIND[q.kind] || 'Question')}</div>${inner}</section>`;
  }

  function detailHtml(s) {
    const st = STATUS[s.status] || STATUS.idle;
    const app = appOf(s);
    const out = [];
    out.push(`
      <div class="d-meta">
        <span class="pill ${st.cls}${s.unread ? ' unread' : ''}"><span class="dot"></span>${esc(s.unread ? 'New' : st.label)}</span>
        <span class="chip-app">${esc(s.app)}</span>
        ${miniTools ? `<span class="chip-app">${esc(app)}</span>` : ''}
        <span class="spacer"></span>
        ${statusTime(s)}
      </div>
      <h2 class="d-title">${esc(s.title)}</h2>
      <div class="d-path" title="${esc(s.cwd || '')}">${ICON_FOLDER}<span>${esc(s.project)}${s.cwd ? ` · ${esc(shortPath(s.cwd))}` : ''}</span></div>`);
    const parent = parentOf(s);
    if (parent) {
      out.push(`<div class="d-parent">${ICON_SUB}<span>Subtask of</span><button type="button" class="link" data-act="select" data-sid="${esc(parent.id)}">${esc(parent.title)}</button></div>`);
    }

    if (asks(s)) out.push(questionBlock(s));

    if (s.status === 'working' || s.status === 'stale') {
      const rows = [];
      if (s.activity) rows.push(`<div class="act-row"><span class="tool">${esc(toolName(s.activity.tool))}</span><span class="what mono">${esc(shortPath(s.activity.sum))}</span></div>`);
      for (const a of s.subagents || []) {
        rows.push(`<div class="act-row"><span class="tool">Subagent</span><span class="what">${esc(a.type || '')}${a.activity ? ` · ${esc(toolName(a.activity.tool))} <span class="mono">${esc(shortPath(a.activity.sum || ''))}</span>` : ''}</span></div>`);
      }
      if (rows.length) out.push(`<section class="d-card act ${s.status}"><div class="d-label">${s.status === 'stale' ? 'Last seen' : 'Doing now'}</div>${rows.join('')}</section>`);
    }

    if (s.status === 'error' && s.error) {
      out.push(`<section class="d-card error"><div class="d-label">Error</div><p class="d-text">${esc(s.error.text)}</p></section>`);
    }

    const last = s.last && s.last.text ? plain(s.last.text) : '';
    const recap = s.recap ? plain(s.recap) : '';
    if (recap && !asks(s) && !last.includes(recap)) {
      out.push(`<section class="d-card"><div class="d-label">Summary</div><p class="d-text">${esc(recap)}</p></section>`);
    }

    const msgs = [];
    if (s.prompt && s.prompt.text) msgs.push(`<div class="msg you"><span class="who">You</span><div class="body">${esc(s.prompt.text)}</div></div>`);
    else if (s.autoPrompt) msgs.push(`<div class="msg you"><span class="who">Start</span><div class="body">${esc(s.autoPrompt.text)}</div></div>`);
    if (last) msgs.push(`<div class="msg"><span class="who">${esc(app)}</span><div class="body">${esc(last)}</div></div>`);
    if (msgs.length) out.push(`<div class="convo">${msgs.join('')}</div>`);
    return out.join('');
  }

  function detailActions(s) {
    return `${openButton(s, true)}
      <button type="button" class="btn" data-act="mark" data-sid="${esc(s.id)}">${needsReading(s) ? 'Mark as read' : 'Mark as unread'}</button>
      <span class="spacer"></span>
      <button type="button" class="btn link" data-act="close" data-sid="${esc(s.id)}">Hide session</button>`;
  }

  // Patch the children of a container to new HTML, so a session at work
  // updates in place: scroll position and any text you selected stay.
  function patch(container, html) {
    if (container.dataset.html === html) return;
    container.dataset.html = html;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const fresh = [...tmp.childNodes];
    const live = [...container.childNodes];
    fresh.forEach((n, i) => { if (i < live.length) morph(live[i], n, 1); else container.appendChild(n); });
    for (let i = fresh.length; i < live.length; i++) live[i].remove();
  }

  let shownId = null;
  function renderDetail(s) {
    const body = $('#d-body');
    if (s && s.id !== shownId) $('#d-scroll').scrollTop = 0;
    shownId = s ? s.id : null;
    patch(body, s ? detailHtml(s) : '');
    patch($('#d-actions'), s ? detailActions(s) : '');
    updateTimes($('#detail'));
  }

  function select(id, show) {
    if (id !== selectedId) {
      selectedId = id;
      picked.set(id);
    }
    // A narrow window shows the list or the session: this one now.
    if (show) document.body.classList.add('show-detail');
    render();
  }

  // Blue means "look at me": an unseen answer, or a question. Both can be
  // marked read, which turns them grey.
  function needsReading(s) { return s.unread || s.status === 'question' || s.status === 'permission'; }

  // ---------------------------------------------------------------- folders

  // In the mini view sessions are grouped by the folder they were started in,
  // A to Z, like the Claude app's sidebar. A folder can be folded shut; that
  // is remembered per browser.
  const collapsed = new Set(store.get('collapsed', []));

  function byFolder(sessions) {
    const groups = new Map();
    for (const s of sessions) {
      const f = s.folder || { key: '', name: 'No folder', detail: '' };
      let g = groups.get(f.key);
      if (!g) groups.set(f.key, (g = { key: f.key, name: f.name, detail: f.detail, items: [] }));
      g.items.push(s);
    }
    const list = [...groups.values()];
    // Two folders with the same name: add the folder above to tell them apart.
    const seen = new Map();
    for (const g of list) seen.set(g.name, (seen.get(g.name) || 0) + 1);
    for (const g of list) if (seen.get(g.name) > 1 && g.detail) g.name = g.detail.split('/').slice(-2).join('/');
    return list.sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base', numeric: true }) || a.key.localeCompare(b.key));
  }

  // Sub-tasks (a session started from another one) sit right under the
  // session they came from, as in the Claude app's sidebar, with a line from
  // it. Only within one list: a sub-task whose session is elsewhere (another
  // status, or out of the period) keeps its own place. Deeper sub-tasks stay
  // one step in, right after the one they came from, so the line runs on.
  // Folded, they make way for one line that says how many there are and what
  // they hold, as in the app; that is remembered per browser, like folders.
  function nest(list) {
    const byLocal = new Map();
    for (const s of list) if (s.localId && !byLocal.has(s.localId)) byLocal.set(s.localId, s);
    const kids = new Map();
    const roots = [];
    for (const s of list) {
      const p = s.parentLocalId && s.parentLocalId !== s.localId ? byLocal.get(s.parentLocalId) : null;
      if (p) {
        if (!kids.has(p.id)) kids.set(p.id, []);
        kids.get(p.id).push(s);
      } else roots.push(s);
    }
    const out = [];
    const seen = new Set();
    const below = (s, into) => {
      for (const k of kids.get(s.id) || []) {
        if (seen.has(k.id)) continue;
        seen.add(k.id);
        into.push(k);
        below(k, into);
      }
    };
    for (const s of roots) {
      seen.add(s.id);
      const subs = [];
      below(s, subs);
      if (!subs.length) { out.push({ s, tree: '' }); continue; }
      const open = !collapsed.has('sub:' + s.id);
      out.push({ s, tree: ' has-sub', subs, open });
      if (open) subs.forEach((k, i) => out.push({ s: k, tree: i === subs.length - 1 ? ' sub last' : ' sub' }));
      else out.push({ sum: s, subs });
    }
    // Sessions that only point at each other: keep them, as they are.
    for (const s of list) if (!seen.has(s.id)) out.push({ s, tree: '' });
    return out;
  }

  const ICON_CHEVRON = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // The arrow after the title of a session with sub-tasks: folds them away.
  // The row itself stays a link to the session; the arrow is for the mouse,
  // the arrow keys (left folds, right unfolds) and the summary line for the
  // keyboard.
  const subsAttr = (r) => (r.subs ? ` data-subs="${esc(r.s.id)}" aria-expanded="${r.open}"` : '');
  const subToggle = (r) => (r.subs
    ? `<span class="subchev${r.open ? ' open' : ''}" data-act="subfold" data-sub="${esc(r.s.id)}" title="${r.open ? 'Hide subtasks' : 'Show subtasks'}">${ICON_CHEVRON}</span>`
    : '');

  // The line a folded session shows instead of its sub-tasks. Blue when one
  // of them needs you, as a folded folder does.
  function subSummary(r, cls) {
    const n = r.subs.length;
    const sum = folderSummary(r.subs);
    const hot = r.subs.some(needsReading);
    const key = 'x:' + r.sum.id;
    return {
      key,
      html: `<button type="button" class="${cls} sub last subsum${hot ? ' hot' : ''}" data-key="${esc(key)}" data-act="subfold" data-sub="${esc(r.sum.id)}" aria-expanded="false"><span class="subn">${n} ${n === 1 ? 'subtask' : 'subtasks'}</span>${sum ? `<span class="subsum-what">· ${esc(sum)}</span>` : ''}</button>`,
    };
  }

  function toggleSub(id) {
    const k = 'sub:' + id;
    if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
    store.set('collapsed', [...collapsed].slice(-120));
    render();
  }

  function folderSummary(items) {
    const waiting = items.filter((s) => s.status === 'question' || s.status === 'permission').length;
    const working = items.filter((s) => s.status === 'working').length;
    const unseen = items.filter((s) => s.unread).length;
    return [waiting && `${waiting} waiting`, working && `${working} working`, unseen && `${unseen} new`].filter(Boolean).join(' · ');
  }

  // Folder headers and cards in one flat list, so renderList keeps patching
  // cards in place. A shut folder shows what it holds in its header, and turns
  // its count blue when something in it needs you.
  function grouped(list, sessions, card, cls) {
    const out = [];
    for (const g of byFolder(sessions)) {
      const fold = `${list}:${g.key}`;
      const open = !collapsed.has(fold);
      const hot = !open && g.items.some(needsReading);
      const sum = open ? '' : folderSummary(g.items);
      const key = `g:${list}:${g.key}`;
      out.push({
        key,
        html: `<button type="button" class="${cls}${hot ? ' hot' : ''}" data-key="${esc(key)}" data-act="fold" data-fold="${esc(fold)}" aria-expanded="${open}" title="${esc(g.detail || g.name)}">${ICON_CHEVRON}<span class="fname">${esc(g.name)}</span><span class="count">${g.items.length}</span>${sum ? `<span class="fsum">${esc(sum)}</span>` : ''}</button>`,
      });
      if (open) for (const r of nest(g.items)) out.push(r.sum ? subSummary(r, 'mrow') : card(r.s, r));
    }
    return out;
  }

  function toggleFolder(fold) {
    if (collapsed.has(fold)) collapsed.delete(fold); else collapsed.add(fold);
    store.set('collapsed', [...collapsed].slice(-120));
    render();
  }

  // Folding in one mini window shows up in another one.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'ai-flows:collapsed') return;
    collapsed.clear();
    for (const k of store.get('collapsed', [])) collapsed.add(k);
    render();
  });

  // ---------------------------------------------------------------- mini rows

  const MINI_CLASS = {
    question: 'question', permission: 'permission', working: 'working', stale: 'attention',
    interrupted: 'attention', error: 'error', done: 'done', idle: 'done', ended: 'done',
  };

  // Each session names its AI tool (Claude, Codex) when that setting is on:
  // in the list, the open session, the mini view and the pick window.
  let miniTools = false;

  function miniRow(s, withQuestion, r = {}) {
    const key = 'm:' + s.id;
    const cls = (MINI_CLASS[s.status] || 'done') + (s.unread ? ' unread' : '') + (miniTools ? ' has-tool' : '') + (r.tree || '');
    const st = STATUS[s.status] || STATUS.idle;
    let sub = '';
    if (withQuestion && s.question) {
      const q = s.question;
      sub = q.kind === 'permission' && q.tool
        ? `${toolName(q.tool)}${q.detail ? ': ' + shortPath(q.detail) : ''}`
        : q.text.split('\n')[0];
    }
    const when = (s.question && s.question.ts) || (s.status === 'working' ? s.since : s.lastTs);
    const tip = [s.title, s.project, s.app, s.unread ? 'not looked at yet' : st.label, s.question && s.question.text].filter(Boolean).join(' · ');
    const inner = `
      <span class="mdot"></span>
      <span class="mmain"><span class="mhead"><span class="mtitle">${esc(s.title)}</span>${subToggle(r)}</span>${sub ? `<span class="msub">${esc(sub)}</span>` : ''}</span>
      ${miniTools ? `<span class="mtool">${esc(appOf(s))}</span>` : ''}
      ${timeEl(when, 'compact')}`;
    const html = s.openUrl
      ? `<a class="mrow ${cls}" data-key="${esc(key)}" href="${esc(s.openUrl)}" data-act="open" data-sid="${esc(s.id)}"${subsAttr(r)} title="${esc(tip)}">${inner}</a>`
      : `<button type="button" class="mrow ${cls}" data-key="${esc(key)}" data-act="copy" data-text="${esc(s.resumeCmd || '')}"${subsAttr(r)} title="${esc(tip)} · click to copy the resume command">${inner}</button>`;
    return { key, html };
  }

  // The micro view's counters. A counter with one session opens it (or
  // copies its resume command); one with more opens a small window with
  // those sessions to pick from (?pick=q|w|d).
  const microPick = { q: null, w: null, d: null };
  const microCount = { q: 0, w: 0, d: 0 };
  const microFolders = { q: 0, w: 0, d: 0 };
  const MICRO_WORD = { q: (n) => (n === 1 ? 'question' : 'questions'), w: () => 'working', d: () => 'done' };
  const PICK = ((k) => (k in MICRO_WORD ? k : null))(new URLSearchParams(location.search).get('pick'));

  function renderMicro(lists) {
    const word = MICRO_WORD;
    for (const k of Object.keys(lists)) {
      const list = lists[k];
      const one = list.length === 1 && (list[0].openUrl || list[0].resumeCmd) ? list[0] : null;
      microPick[k] = one;
      microCount[k] = list.length;
      microFolders[k] = list.length > 1 ? byFolder(list).length : 0;
      const tile = $(`.micro[data-micro="${k}"]`);
      setText($('.what', tile), word[k](list.length));
      tile.classList.toggle('hot', list.length > 0);
      tile.classList.toggle('one', !!one);
      tile.classList.toggle('many', list.length > 1);
      const what = `${list.length} ${word[k](list.length)}`;
      const how = one ? (one.openUrl ? `Open “${one.title}”` : `Copy the resume command of “${one.title}”`)
        : list.length > 1 ? 'Pick the one to open' : '';
      // Also the word, for a strip that shows only the numbers.
      setTitle(tile, how ? `${what}. ${how}` : what);
      const label = how ? `${what}. ${how}` : what;
      if (tile.getAttribute('aria-label') !== label) tile.setAttribute('aria-label', label);
    }
  }

  // The pick window: the sessions of one counter, kept live.
  const PICK_NONE = { q: 'No open questions left.', w: 'Nothing is working any more.', d: 'Nothing left to look at.' };
  function renderPick(list) {
    const what = `${list.length} ${MICRO_WORD[PICK](list.length)}`;
    setText($('#pick-label'), what);
    // By folder, as in the mini view, and folded the same way (questions as
    // under Vragen there, the rest as under Flows).
    renderList($('#pick-list'), grouped(PICK === 'q' ? 'q' : 'f', list, (s, r) => miniRow(s, PICK === 'q', r), 'mfolder'));
    setText($('#pick-none'), PICK_NONE[PICK]);
    setHidden($('#pick-none'), list.length > 0);
    const t = `${what} · AI Flows`;
    if (document.title !== t) document.title = t;
  }

  function renderMini(sessions, questions) {
    miniTools = !!(state && state.toolLabels);
    const busy = sessions.filter((s) => s.status === 'working');
    const working = busy.length;
    // Klaar: finished and not looked at yet (the blue ones).
    const done = sessions.filter((s) => s.unread && sectionOf(s) === 'done');
    renderMicro({ q: questions, w: busy, d: done });
    if (PICK) renderPick({ q: questions, w: busy, d: done }[PICK]);
    for (const el of $$('[data-count="done"]')) setText(el, done.length);
    const qIds = new Set(questions.map((s) => s.id));
    const flows = sessions.filter((s) => !qIds.has(s.id));

    renderList($('#mini-questions'), grouped('q', questions, (s, r) => miniRow(s, true, r), 'mfolder'));
    renderList($('#mini-flows'), grouped('f', flows, (s, r) => miniRow(s, false, r), 'mfolder'));
    // No open questions: leave that whole part out.
    setHidden($('#mini-q-label'), questions.length === 0);
    setHidden($('#mini-questions'), questions.length === 0);
    setHidden($('#mini-f-none'), flows.length > 0);

    const parts = [];
    if (questions.length) parts.push(`<span class="hot">${questions.length} ${questions.length === 1 ? 'question' : 'questions'}</span>`);
    if (working) parts.push(`${working} working`);
    const unseen = sessions.filter((s) => s.unread).length;
    if (unseen) parts.push(`<span class="new">${unseen} new</span>`);
    setHTML($('#mini-sum'), parts.length ? parts.join(' · ') : 'All quiet');
    for (const el of $$('[data-count="working"]')) setText(el, working);
  }

  // Patch a live node into the shape of a fresh one, touching only what differs.
  // Unchanged elements stay put, so animations, hover and selection survive.
  function morph(live, fresh, depth = 0) {
    // Below the card itself, an element whose class changed is a different
    // thing (a dot is not a chip): swap it rather than repurpose it.
    if (live.nodeType !== fresh.nodeType || live.nodeName !== fresh.nodeName ||
        (depth > 0 && live.nodeType === 1 && live.getAttribute('class') !== fresh.getAttribute('class'))) {
      live.replaceWith(fresh);
      return fresh;
    }
    if (live.nodeType !== 1) {
      if (live.nodeValue !== fresh.nodeValue) live.nodeValue = fresh.nodeValue;
      return live;
    }
    for (const { name } of [...live.attributes]) {
      if (!fresh.hasAttribute(name)) live.removeAttribute(name);
    }
    for (const { name, value } of [...fresh.attributes]) {
      let v = value;
      if (name === 'class' && live.classList.contains('flash')) v += ' flash';
      if (live.getAttribute(name) !== v) live.setAttribute(name, v);
    }
    if (live.hasAttribute('data-ts')) return live; // updateTimes owns the text
    const a = [...live.childNodes];
    const b = [...fresh.childNodes];
    b.forEach((node, i) => { if (i < a.length) morph(a[i], node, depth + 1); else live.appendChild(node); });
    for (let i = b.length; i < a.length; i++) a[i].remove();
    return live;
  }

  // Add, patch, reorder and remove cards so the list matches the new state.
  function renderList(container, items) {
    const existing = new Map($$(':scope > [data-key]', container).map((el) => [el.dataset.key, el]));
    // Moving a row takes its focus away: give it back afterwards.
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    let prev = null;
    for (const item of items) {
      let el = existing.get(item.key);
      const cacheKey = container.id + '|' + item.key;
      if (!el || htmlCache.get(cacheKey) !== item.html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = item.html.trim();
        const fresh = tmp.firstElementChild;
        el = el ? morph(el, fresh) : fresh;
        htmlCache.set(cacheKey, item.html);
        updateTimes(el);
      }
      existing.delete(item.key);
      const want = prev ? prev.nextElementSibling : container.firstElementChild;
      if (want !== el) container.insertBefore(el, want);
      prev = el;
    }
    for (const [key, el] of existing) {
      el.remove();
      htmlCache.delete(container.id + '|' + key);
    }
    if (focused && focused !== document.activeElement && container.contains(focused)) focused.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!state) return;
    const sessions = state.sessions || [];
    miniTools = !!state.toolLabels;

    const questions = sessions
      .filter((s) => s.question && (s.status === 'question' || s.status === 'permission'))
      .sort((a, b) => ((a.status === 'permission' ? 0 : 1) - (b.status === 'permission' ? 0 : 1)) || ((b.question.ts || 0) - (a.question.ts || 0)));

    renderSide(sessions, questions);
    for (const el of $$('[data-count="questions"]')) {
      setText(el, questions.length);
      el.classList.toggle('hot', questions.length > 0);
    }
    if (!PICK) { const t = questions.length ? `(${questions.length}) AI Flows` : 'AI Flows'; if (document.title !== t) document.title = t; }
    renderMini(sessions, questions);
    renderLimits();
    syncBell();

    const notice = $('#notice');
    if (!state.hooksSeen) {
      setHidden(notice, false);
      if (!notice.innerHTML) notice.innerHTML = 'No hooks seen yet, so the status is an estimate. Install them with <code>node install-hooks.js</code>.';
    } else {
      setHidden(notice, true);
    }
    setLive(connected);
    announce(questions);
  }

  // ---------------------------------------------------------------- limits

  // Per AI tool one small meter fixed to the bottom: the bar for the 5-hour
  // limit over the one for the week, and both percentages. With one tool on,
  // it says "Limiet" instead of the tool's name. Reset times and how old the
  // numbers are sit in the tooltip.
  const limitsEl = $('#limits');
  // The micro view has the same meters on a line of its own.
  const microLimEl = $('#micro-lim');
  // No numbers: what the bar says, and on hover why and what helps. An
  // expired login is renewed by itself; only an ended sign-in needs you.
  const LIMIT_PROBLEM = {
    renewing: ['renewing login…', 'Claude Code’s login had expired and is being renewed now.'],
    signin: ['sign in again', 'Your Claude Code sign-in has ended. Sign in again with claude auth login in a terminal.'],
    expired: ['login expired', 'Claude Code’s login has expired. Start claude in a terminal to renew it.'],
    offline: ['unreachable', 'The limits cannot be fetched right now. It will try again shortly.'],
    busy: ['hold on', 'Claude is not giving out the limits for a moment, as they were asked for often. It will try again later by itself.'],
    unknown: ['unavailable', 'The answer with the limits was not recognised.'],
  };
  const limitProblem = (t) => (t.error === 'expired'
    ? (t.renew === 'busy' ? 'renewing' : t.renew === 'failed' ? 'signin' : 'expired')
    : t.error);

  function limitLabel(key) {
    if (key === '5h') return '5 hours';
    if (key === 'week') return 'Week';
    return `${Math.round(parseInt(key, 10) / 60) || 0} hours`;
  }

  function resetText(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? `resets at ${time}`
      : `resets ${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
  }

  const limitLevel = (pct) => (pct >= 90 ? 'high' : pct >= 75 ? 'warn' : '');

  function limitTool(t, label) {
    if (!t.windows.length) {
      const kind = limitProblem(t);
      const [short, long] = LIMIT_PROBLEM[kind] || ['unavailable', 'No numbers yet.'];
      const why = `${t.name}: ${long}`;
      // Named after its tool here, so it is clear whose login it is.
      return `<div class="lim-tool off" role="img" aria-label="${esc(why)}" title="${esc(why)}"><span class="lim-name">${esc(t.name)}</span><span class="lim-off ${kind || ''}">${esc(short)}</span></div>`;
    }
    const wins = t.windows.map((w) => ({ ...w, pct: Math.round(w.pct) }));
    const lines = wins.map((w) => `${limitLabel(w.key)}: ${w.pct}% used${w.resetsAt ? `, ${resetText(w.resetsAt)}` : ''}`);
    if (t.at && Date.now() - t.at > 30 * 60000) lines.push(`Measured ${ago(t.at)}`);
    const tracks = wins.map((w) => `<span class="lim-track ${limitLevel(w.pct)}"><span class="lim-fill" data-p="${w.pct}"></span></span>`).join('');
    const nums = wins.map((w) => `<span class="lim-pct ${limitLevel(w.pct)}">${w.pct}%</span>`).join('<span class="lim-sep">/</span>');
    // The full view has room to spell it out: per limit its name, when it
    // resets, a bigger bar and the percentage (see app.css).
    const cards = wins.map((w) => `<span class="lim-win"><span class="lim-wtop"><span class="lim-wname">${esc(limitLabel(w.key))}</span>` +
      `${w.resetsAt ? `<span class="lim-reset">${esc(resetText(w.resetsAt))}</span>` : ''}<span class="lim-wpct ${limitLevel(w.pct)}">${w.pct}%</span></span>` +
      `<span class="lim-track ${limitLevel(w.pct)}"><span class="lim-fill" data-p="${w.pct}"></span></span></span>`).join('');
    return `<div class="lim-tool" role="img" aria-label="${esc(`${t.name}. ${lines.join('. ')}`)}" title="${esc([t.name, ...lines].join('\n'))}">` +
      `<span class="lim-name">${esc(label)}</span><span class="lim-meter">${tracks}</span><span class="lim-nums">${nums}</span><span class="lim-wins">${cards}</span></div>`;
  }

  function renderLimits() {
    const list = state && Array.isArray(state.limits) ? state.limits : [];
    const html = list.map((t) => limitTool(t, list.length === 1 ? 'Limits' : t.name)).join('');
    for (const el of [limitsEl, microLimEl]) {
      setHTML(el, html);
      // Widths through the style object: the page's CSP blocks style attributes.
      for (const f of $$('.lim-fill', el)) f.style.width = `${f.dataset.p}%`;
      setHidden(el, list.length === 0);
    }
    syncLimitsHeight();
  }

  // Room at the bottom of the page for the bar (0 when hidden, also in micro).
  function syncLimitsHeight() {
    const h = limitsEl.hidden ? 0 : limitsEl.offsetHeight;
    const v = `${h}px`;
    if (document.body.style.getPropertyValue('--lim') !== v) document.body.style.setProperty('--lim', v);
  }
  if (window.ResizeObserver) new ResizeObserver(syncLimitsHeight).observe(limitsEl);

  function announce(questions) {
    const keys = new Map(questions.map((s) => [s.id + ':' + (s.question.ts || ''), s]));
    if (knownQuestions) {
      for (const [k, s] of keys) {
        if (knownQuestions.has(k)) continue;
        const row = $(`#side-list [data-key="s:${CSS.escape(s.id)}"]`);
        if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
      }
    }
    knownQuestions = new Set(keys.keys());
  }

  function setLive(ok) {
    const live = $('#live');
    live.classList.toggle('ok', ok);
    live.classList.toggle('bad', !ok);
    const ml = $('#mini-live');
    ml.classList.toggle('ok', ok);
    ml.classList.toggle('bad', !ok);
    setTitle(ml, ok ? 'Live, connected' : 'No connection to the server');
    setText($('#live-text'), !ok
      ? 'No connection to the server'
      : state && state.hooksSeen ? 'Live via hooks' : 'Live · estimated from transcripts');
  }

  // ---------------------------------------------------------------- actions

  let toastTimer = null;
  const ICON_CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  function hideToast() { clearTimeout(toastTimer); $('#toast').classList.remove('show'); }
  // action: { label, run } adds a button, such as "Undo".
  function toast(text, action) {
    const t = $('#toast');
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-act';
      b.textContent = action.label;
      b.addEventListener('click', () => { hideToast(); action.run(); }, { once: true });
      msg.append(' ', b);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close';
    close.innerHTML = ICON_CLOSE;
    close.addEventListener('click', hideToast, { once: true });
    t.replaceChildren(msg, close);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), action ? 7000 : 3200);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  function openUrl(url) {
    const a = document.createElement('a');
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function find(sid) {
    return state && state.sessions.find((s) => s.id === sid);
  }

  // How a session opens follows the setting (see OPEN_VIA in server.js):
  // 'server' (default) asks nothing but leaves the app behind your window;
  // 'browser' lets your browser or app open the link, which brings the app
  // forward with the focus (since macOS 14 only the app you click in may do
  // that) but may ask for permission. If the server cannot, the link is used.
  async function openSession(s) {
    if (!s || !s.openUrl) return;
    if (state && state.openVia === 'browser') { openUrl(s.openUrl); return; }
    try {
      const r = await fetch('/api/open?id=' + encodeURIComponent(s.id), { method: 'POST', headers: apiHeaders({ 'X-AI-Flows': '1' }) });
      if (r.status === 401) { showLocked(); return; }
      if (r.ok && (await r.json()).ok) return;
    } catch {}
    openUrl(s.openUrl);
  }

  // ---------------------------------------------------------------- settings panel

  const settingsButton = $('#settings-button');
  const settingsPanel = $('#settings-panel');

  function syncSettings() {
    const via = (state && state.openVia) || 'server';
    for (const r of settingsPanel.querySelectorAll('input[name="open-via"]')) r.checked = r.value === via;
    settingsPanel.querySelector('input[name="tool-labels"]').checked = !!(state && state.toolLabels);
    settingsPanel.querySelector('input[name="mini-on-top"]').checked = !state || state.miniOnTop !== false;
    const limitsOn = (state && state.limitsOn) || {};
    settingsPanel.querySelector('input[name="limit-claude"]').checked = !!limitsOn.claude;
    settingsPanel.querySelector('input[name="limit-codex"]').checked = !!limitsOn.codex;
  }

  // While the settings fill the mini view only they scroll, not the page under
  // them as well. The page's classic scrollbar goes away then; the mini head
  // gets its width as extra padding (--sb), so its buttons stay in place.
  function lockPage(on) {
    const body = document.body;
    body.classList.remove('settings-open');
    if (!on) return;
    body.style.setProperty('--sb', `${innerWidth - document.documentElement.clientWidth}px`);
    body.classList.add('settings-open');
  }

  function toggleSettings(open) {
    const mini = document.body.classList.contains('is-mini');
    lockPage(open && mini);
    settingsPanel.hidden = !open;
    settingsButton.setAttribute('aria-expanded', String(open));
    setTitle(settingsButton, open && mini ? 'Close' : 'Settings');
    if (!open) return;
    syncSettings();
    if (mini) {
      // The mini view has no room for a pop-over: the panel fills the window
      // under the mini head (see app.css), where the settings button, now an
      // X, closes it again.
      settingsPanel.style.right = settingsPanel.style.maxHeight = '';
      settingsPanel.style.top = `${Math.round($('.mini-head').getBoundingClientRect().bottom)}px`;
    } else {
      const r = settingsButton.getBoundingClientRect();
      // clientWidth leaves out a classic scrollbar, as fixed positioning does.
      const vw = document.documentElement.clientWidth;
      settingsPanel.style.top = `${r.bottom + 8}px`;
      settingsPanel.style.right = `${Math.max(16, vw - r.right)}px`;
      // A low window: scroll inside the panel instead of past the edge.
      settingsPanel.style.maxHeight = `${Math.max(160, innerHeight - r.bottom - 16)}px`;
    }
    const checked = settingsPanel.querySelector('input:checked') || settingsPanel.querySelector('input');
    if (checked) checked.focus();
  }

  settingsButton.addEventListener('click', () => toggleSettings(settingsPanel.hidden));
  // A click outside closes the settings, but not one on the toast: that
  // answers a change made in the settings, which should stay open for it.
  document.addEventListener('pointerdown', (e) => {
    if (!settingsPanel.hidden && !e.target.closest('#settings-panel, #settings-button, #toast')) toggleSettings(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsPanel.hidden) { toggleSettings(false); settingsButton.focus(); }
  });
  window.addEventListener('resize', () => { if (!settingsPanel.hidden) toggleSettings(true); });

  settingsPanel.addEventListener('change', async (e) => {
    const change = e.target.name === 'open-via' ? { openVia: e.target.value }
      : e.target.name === 'tool-labels' ? { toolLabels: e.target.checked }
      : e.target.name === 'mini-on-top' ? { miniOnTop: e.target.checked }
      : e.target.name === 'limit-claude' ? { limits: { claude: e.target.checked } }
      : e.target.name === 'limit-codex' ? { limits: { codex: e.target.checked } } : null;
    if (!change) return;
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: apiHeaders({ 'X-AI-Flows': '1', 'Content-Type': 'application/json' }),
        body: JSON.stringify(change),
      });
      if (r.status === 401) { showLocked(); return; }
      const d = await r.json();
      if (state) {
        state.openVia = d.openVia;
        state.toolLabels = d.toolLabels;
        state.miniOnTop = d.miniOnTop;
        state.limitsOn = d.limits;
        // A tool turned off leaves at once; one turned on follows with the
        // next update from the server.
        if (state.limits) state.limits = state.limits.filter((t) => d.limits[t.tool]);
      }
      syncSettings();
      if ('toolLabels' in change) {
        render();
        toast(d.toolLabels ? 'AI tool shown.' : 'AI tool hidden.');
        return;
      }
      if ('miniOnTop' in change) {
        toast(d.miniOnTop ? 'Mini window stays on top.' : 'Mini window becomes an ordinary window.');
        return;
      }
      if ('limits' in change) {
        render();
        const [tool] = Object.keys(change.limits);
        toast(`${tool === 'codex' ? 'Codex' : 'Claude'} limits ${d.limits[tool] ? 'on' : 'off'}.`);
        return;
      }
      toast(d.openVia === 'browser' ? 'Opens through your browser.' : 'Opens without asking.');
    } catch {
      syncSettings();
      toast('Could not save.');
    }
  });

  // ---------------------------------------------------------------- right-click menu

  // Right-click a flow (card, question or mini row) to open it, mark it read or
  // unread, or hide it. "Unread" lasts until you open the session in its app;
  // hidden ("closed" in the API) until you send it a new message or it asks
  // something new.
  const ctx = document.getElementById('ctx');
  let ctxSid = null;

  function closeCtx() {
    if (ctx.hidden) return;
    ctx.hidden = true;
    ctxSid = null;
  }

  function openCtx(x, y, s, byKey) {
    ctxSid = s.id;
    const open = ctx.querySelector('[data-ctx="open"]');
    open.hidden = !s.openUrl;
    setText(open, `Open in ${appOf(s)}`);
    setText(ctx.querySelector('[data-ctx="mark"]'), needsReading(s) ? 'Mark as read' : 'Mark as unread');
    ctx.hidden = false;
    const r = ctx.getBoundingClientRect();
    ctx.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    ctx.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    // From the keyboard the first item is lit; from a click none is yet.
    (byKey ? ctx.querySelector('button:not([hidden])') : ctx).focus({ preventScroll: true });
  }

  // kind: 'read', 'unread', 'closed' or 'open' (the undo of 'closed').
  async function markSession(s, kind) {
    try {
      const r = await fetch('/api/mark', {
        method: 'POST',
        headers: apiHeaders({ 'X-AI-Flows': '1', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id: s.id, mark: kind }),
      });
      if (r.status === 401) { showLocked(); return; }
      if (!r.ok) throw new Error(String(r.status));
      // Show it straight away; the next update from the server confirms it.
      if (kind === 'closed') {
        if (state) state.sessions = (state.sessions || []).filter((x) => x.id !== s.id);
        render();
        toast(`“${s.title}” hidden.`, { label: 'Undo', run: () => markSession(s, 'open') });
        return;
      }
      if (kind === 'open') { toast('Restored.'); return; }
      const unread = kind === 'unread';
      if (!unread && (s.status === 'question' || s.status === 'permission')) { s.status = 'done'; s.question = null; }
      s.unread = unread && !['working', 'permission', 'question'].includes(s.status);
      render();
      toast(unread ? 'Marked as unread.' : 'Marked as read.');
    } catch {
      toast('Could not save the mark.');
    }
  }

  document.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-key]');
    const s = el && /^[ms]:/.test(el.dataset.key) ? find(el.dataset.key.slice(2)) : null;
    if (!s) { closeCtx(); return; }
    e.preventDefault();
    openCtx(e.clientX, e.clientY, s, e.pointerType === '');
  });

  ctx.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ctx]');
    if (!b) return;
    const s = find(ctxSid);
    closeCtx();
    if (!s) return;
    if (b.dataset.ctx === 'open') openSession(s);
    else if (b.dataset.ctx === 'close') markSession(s, 'closed');
    else markSession(s, needsReading(s) ? 'read' : 'unread');
  });

  ctx.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = $$('button:not([hidden])', ctx);
    const i = items.indexOf(document.activeElement);
    const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1)
      : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next].focus();
  });
  // The lit item follows the mouse, and goes out when the mouse leaves.
  ctx.addEventListener('pointermove', (e) => {
    const b = e.target.closest('button');
    if (b && document.activeElement !== b) b.focus({ preventScroll: true });
  });
  ctx.addEventListener('pointerleave', () => {
    if (ctx.contains(document.activeElement) && document.activeElement !== ctx) ctx.focus({ preventScroll: true });
  });

  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctx')) closeCtx(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
  document.addEventListener('scroll', closeCtx, true);
  window.addEventListener('resize', closeCtx);
  window.addEventListener('blur', closeCtx);

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'open') {
      e.preventDefault();
      await openSession(find(el.dataset.sid));
      // Picked from the pick window: done with it.
      if (PICK) setTimeout(() => window.close(), 300);
    } else if (act === 'answer') {
      const s = find(el.dataset.sid);
      const text = cleanAnswer(el.dataset.text);
      await copy(text);
      if (s && s.openUrl) {
        toast(`“${text}” copied. Paste with ⌘V.`);
        openSession(s);
      } else {
        toast(`“${text}” copied.`);
      }
    } else if (act === 'copy') {
      await copy(String(el.dataset.text).replace(INVISIBLE, ''));
      toast('Copied. Paste it in your terminal.');
      if (PICK && el.closest('#pick-list')) setTimeout(() => window.close(), 1200);
    } else if (act === 'fold') {
      toggleFolder(el.dataset.fold);
    } else if (act === 'subfold') {
      e.preventDefault();
      e.stopPropagation();
      const list = el.closest('.mini-list, #side-list');
      const fromSummary = el.classList.contains('subsum');
      toggleSub(el.dataset.sub);
      if (fromSummary && list) {
        const row = list.querySelector(`[data-subs="${CSS.escape(el.dataset.sub)}"]`);
        if (row) row.focus();
      }
    } else if (act === 'select') {
      select(el.dataset.sid, true);
      // From the open session's "Subtask of" line: bring that row in view.
      if (el.closest('#detail')) {
        const row = document.querySelector(`#side-list [data-key="s:${CSS.escape(el.dataset.sid)}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      }
    } else if (act === 'mark') {
      const s = find(el.dataset.sid);
      if (s) markSession(s, needsReading(s) ? 'read' : 'unread');
    } else if (act === 'close') {
      const s = find(el.dataset.sid);
      if (s) markSession(s, 'closed');
    }
  });

  // Left folds a session's sub-tasks away, right shows them, as in a tree.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const el = document.activeElement;
    if (!el || !el.dataset || !el.dataset.subs) return;
    const open = el.getAttribute('aria-expanded') === 'true';
    if (open !== (e.key === 'ArrowLeft')) return;
    e.preventDefault();
    toggleSub(el.dataset.subs);
  });

  // Up and down walk the list, picking each session on the way.
  $('#side-list').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = $$('.srow-main', $('#side-list'));
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    select(next.dataset.sid, false);
  });

  $('#d-back').addEventListener('click', () => {
    document.body.classList.remove('show-detail');
    const row = $(`#side-list [data-key="s:${CSS.escape(selectedId || '')}"] .srow-main`);
    if (row) row.focus();
  });

  // window selector
  function syncWindowButtons() {
    for (const b of $$('#window button')) b.setAttribute('aria-checked', String(Number(b.dataset.min) === windowMin));
  }
  $('#window').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-min]');
    if (!b) return;
    windowMin = Number(b.dataset.min);
    store.set('window', windowMin);
    syncWindowButtons();
    connect();
  });

  // macOS notifications: the server sends them (also with no dashboard open);
  // this button only switches them on or off.
  function syncBell() {
    const bell = $('#bell');
    const available = !state || state.notifier !== false;
    const on = !!(state && state.notify && available);
    bell.setAttribute('aria-pressed', String(on));
    bell.disabled = !available;
    setTitle(bell, available
      ? (on ? 'Notifications are on' : 'Turn notifications on')
      : 'Build the notifier first: notifier/build.sh');
    setText($('#bell-text'), on ? 'Notifications on' : 'Notifications off');
  }
  $('#bell').addEventListener('click', async () => {
    if (!state) return;
    const notify = !state.notify;
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: apiHeaders({ 'X-AI-Flows': '1', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ notify }),
      });
      const d = await r.json();
      state.notify = d.notify;
      syncBell();
      toast(d.notify ? 'Notifications on.' : 'Notifications off.');
    } catch {
      toast('Could not save.');
    }
  });

  // mini mode: in a window narrower than 760 px, where the list and a session
  // no longer fit side by side; the Mini-venster pop-up is just such a window.
  // The header's controls move into the mini bar, so they work the same in
  // both. (There used to be a ?mini; it is dropped from old links.)
  //
  // "Volledig dashboard openen" in a narrow window shows the full view for now:
  // kept across reloads of this tab, dropped again as soon as the window
  // crosses 760 px either way, or with the mini button in the header. (It used
  // to load ?full, which locked the page in the full view.) ?full itself still
  // shows the full view, for that one load.
  const params = new URLSearchParams(location.search);
  const narrowQuery = matchMedia('(max-width: 759px)');
  const controls = $('.top .controls');
  const controlsHome = controls.parentNode;
  const openMini = $('#open-mini');
  const session = {
    get() { try { return sessionStorage.getItem('ai-flows:full') === '1'; } catch { return false; } },
    set(on) { try { if (on) sessionStorage.setItem('ai-flows:full', '1'); else sessionStorage.removeItem('ai-flows:full'); } catch {} },
  };
  // The Mini-venster pop-up (by its window name, which stays across reloads).
  // In the window that stays on top the dashboard sits in a frame; Chrome's
  // own "back to the tab" button there does what Volledig dashboard openen does.
  const POPUP = window.name === 'ai-flows-mini';
  let showFull = params.has('full') || session.get();
  if (params.has('full') || params.has('mini')) {
    params.delete('full');
    params.delete('mini');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
  function setShowFull(on) { showFull = on; session.set(on); }

  function applyMode() {
    const mini = !PICK && !showFull && narrowQuery.matches;
    document.body.classList.toggle('is-mini', mini);
    document.body.classList.toggle('is-pick', !!PICK);
    // In a narrow window widening it is the way to the full view, so no button
    // for it; the pop-up keeps its button, which goes to the dashboard tab.
    document.body.classList.toggle('auto-mini', mini && !POPUP);
    syncMicro();
    const home = mini ? $('#mini-bar') : controlsHome;
    if (controls.parentNode !== home) {
      if (!settingsPanel.hidden) toggleSettings(false);
      home.appendChild(controls);
    }
    // Full view in a narrow window: the mini button switches back in place.
    const back = !mini && narrowQuery.matches;
    openMini.title = back ? 'Back to the mini view' : 'Open the mini window';
    openMini.setAttribute('aria-label', back ? 'Back to the mini view' : 'Mini window');
  }
  narrowQuery.addEventListener('change', () => { setShowFull(false); applyMode(); });

  // The micro view (app.css): a low window, or one too narrow for the list.
  // Measured on the window itself, whose size includes a scrollbar in every
  // browser; a media query in WebKit leaves a classic scrollbar out, so the
  // list's scrollbar would flip it to the micro view and back, over and over.
  function syncMicro() {
    const micro = document.body.classList.contains('is-mini') && (innerHeight < 160 || innerWidth < 190);
    if (document.body.classList.contains('is-micro') !== micro) document.body.classList.toggle('is-micro', micro);
  }
  window.addEventListener('resize', syncMicro);

  function openFull() {
    // From the pop-up window, show the full dashboard in a normal tab.
    if (window.opener && !window.opener.closed) { window.opener.focus(); return; }
    if (POPUP) { window.open('/', 'ai-flows-full'); return; }
    setShowFull(true);
    applyMode();
    scrollTo(0, 0);
  }
  $('#mini-expand').addEventListener('click', openFull);

  // A counter with more sessions opens the pick window next to this one:
  // under it, or above it when there is no room (it then fits itself to its
  // rows). A second click on the same counter closes it again.
  let pickWin = null;
  let pickWinKey = null;
  let pickWasOpen = false;
  function openPick(k) {
    if (pickWin && !pickWin.closed) pickWin.close();
    const w = 300;
    const h = Math.min(420, 44 + microCount[k] * (k === 'q' ? 50 : 36) + microFolders[k] * 36);
    const sTop = screen.availTop || 0;
    const sLeft = screen.availLeft || 0;
    let top = window.screenY + window.outerHeight + 6;
    if (top + h + 60 > sTop + screen.availHeight) top = Math.max(sTop, window.screenY - h - 72);
    const left = Math.max(sLeft, Math.min(window.screenX, sLeft + screen.availWidth - w));
    const win = window.open(`/?pick=${k}`, 'ai-flows-pick', `popup=yes,width=${w},height=${h},left=${Math.round(left)},top=${Math.round(top)}`);
    if (!win) return false;
    pickWin = win;
    pickWinKey = k;
    return true;
  }
  $('.mini-micro').addEventListener('pointerdown', (e) => {
    const tile = e.target.closest('.micro');
    pickWasOpen = !!(tile && pickWin && !pickWin.closed && pickWinKey === tile.dataset.micro);
  });
  $('.mini-micro').addEventListener('click', async (e) => {
    const tile = e.target.closest('.micro');
    const k = tile && tile.dataset.micro;
    const s = tile && microPick[k];
    // Its pick window is open (also when it is down to one): close it.
    if (tile && pickWasOpen) {
      pickWasOpen = false;
      if (pickWin && !pickWin.closed) pickWin.close();
      return;
    }
    if (s && s.openUrl) { openSession(s); return; }
    if (s && s.resumeCmd) {
      await copy(String(s.resumeCmd).replace(INVISIBLE, ''));
      toast('Copied. Paste it in your terminal.');
      return;
    }
    if (tile && microCount[k] > 1 && openPick(k)) return;
    if (POPUP) openFull();
  });

  // The pick window stays until you are done with it: after picking (see the
  // click handler), with Escape, or a second click on its counter; never by
  // itself, also not when fewer sessions are left. It keeps to the height of
  // its rows; one that opened above the micro window keeps its bottom edge
  // where it is, and it stays on the screen.
  if (PICK) {
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#ctx').hidden) window.close(); }, true);
    const pickEl = $('#pick');
    const fitPick = () => {
      const want = Math.ceil(pickEl.offsetTop + pickEl.offsetHeight);
      const max = Math.max(120, Math.min(560, screen.availHeight - 120));
      document.documentElement.classList.toggle('pick-scroll', want > max);
      const dh = Math.min(want, max) - window.innerHeight;
      if (Math.abs(dh) < 2) return;
      let above = false;
      try { above = !!(window.opener && !window.opener.closed && window.screenY < window.opener.screenY); } catch {}
      // Taken before resizing: the window takes its new size a moment later.
      const top0 = window.screenY;
      const outer0 = window.outerHeight;
      window.resizeBy(0, dh);
      if (above) { window.moveBy(0, -dh); return; }
      const over = top0 + outer0 + dh - ((screen.availTop || 0) + screen.availHeight);
      if (over > 0) window.moveBy(0, -over);
    };
    if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(fitPick)).observe(pickEl);
  }

  // Mini-venster. In Chrome and Edge a window that stays above all others,
  // also above other apps, without an address bar (Document Picture-in-
  // Picture), with the dashboard in it: small, so the mini view. It goes when
  // this tab closes. Elsewhere, or when that fails, an ordinary pop-up.
  function openTopMini() {
    const api = window.documentPictureInPicture;
    if (!api || (state && state.miniOnTop === false)) return null;
    if (api.window) { api.window.focus(); return Promise.resolve(true); }
    return api.requestWindow({ width: 320, height: 460 }).then((pip) => {
      const d = pip.document;
      d.title = 'AI Flows';
      // Styles through the style object: the page's CSP blocks style elements.
      for (const el of [d.documentElement, d.body]) Object.assign(el.style, { height: '100%', margin: '0', overflow: 'hidden' });
      const frame = d.createElement('iframe');
      frame.title = 'AI Flows';
      frame.src = new URL('/', location.href).href;
      Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0' });
      // Chrome tells pages in such a window they are dark, whatever your Mac
      // says. A frame follows its element's color-scheme instead, so this tab's
      // light or dark goes along, also when it changes.
      const dark = matchMedia('(prefers-color-scheme: dark)');
      const follow = () => {
        frame.style.colorScheme = dark.matches ? 'dark' : 'light';
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
        for (const el of [d.documentElement, d.body]) el.style.background = bg;
      };
      follow();
      dark.addEventListener('change', follow);
      pip.addEventListener('pagehide', () => dark.removeEventListener('change', follow), { once: true });
      d.body.append(frame);
      return true;
    }, () => false);
  }

  openMini.addEventListener('click', async () => {
    if (narrowQuery.matches) { setShowFull(false); applyMode(); scrollTo(0, 0); return; }
    // Asked for at once: the browser only allows it straight after a click.
    const top = openTopMini();
    if (top && await top) return;
    // An ordinary dashboard window, only small: that makes it the mini view.
    const w = window.open('/', 'ai-flows-mini', 'popup=yes,width=320,height=460');
    if (!w) toast('Window blocked. Allow pop-ups for 127.0.0.1:4777.');
  });

  // ---------------------------------------------------------------- data

  function connect() {
    if (es) es.close();
    // ?snapshot loads the state once (for headless screenshots).
    if (new URLSearchParams(location.search).has('snapshot')) {
      fetch('/api/state?window=' + windowMin, { headers: apiHeaders() })
        .then((r) => { if (r.status === 401) throw new Error('locked'); return r.json(); })
        .then((d) => { connected = true; state = d; render(); })
        .catch(showLocked);
      return;
    }
    if (!token) { showLocked(); return; }
    // EventSource cannot send headers, so the key goes along as ?t=.
    es = new EventSource('/api/stream?window=' + windowMin + '&t=' + encodeURIComponent(token));
    es.onmessage = (e) => {
      connected = true;
      try { state = JSON.parse(e.data); } catch { return; }
      // New page code on the server: pick it up without a manual reload.
      if (bootBuild == null) bootBuild = state.build;
      else if (state.build && state.build !== bootBuild) { location.reload(); return; }
      render();
    };
    es.onopen = () => { connected = true; setLive(true); };
    es.onerror = () => {
      connected = false;
      setLive(false);
      // A refused key looks like any other error to EventSource: ask once.
      fetch('/api/settings', { headers: apiHeaders() }).then((r) => { if (r.status === 401) showLocked(); }).catch(() => {});
    };
  }

  applyMode();
  syncWindowButtons();
  syncBell();
  (async () => {
    const code = codeFromLink();
    if (!code) return connect();
    if (await claim(code)) return connect();
    showLocked();
    showUnlockError(true);
  })();
  setInterval(() => updateTimes(), 15000);
})();
