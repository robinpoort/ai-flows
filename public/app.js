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
    working: { label: 'Bezig', cls: 'working' },
    permission: { label: 'Toestemming nodig', cls: 'permission' },
    question: { label: 'Wacht op jou', cls: 'question' },
    done: { label: 'Klaar', cls: 'done' },
    idle: { label: 'Gestart', cls: 'idle' },
    interrupted: { label: 'Onderbroken', cls: 'idle' },
    stale: { label: 'Stil', cls: 'stale' },
    error: { label: 'Fout', cls: 'error' },
    ended: { label: 'Afgesloten', cls: 'idle' },
  };

  const QUESTION_KIND = {
    wrap: 'Vraag',
    text: 'Vraag in het antwoord',
    ask: 'Keuzevraag',
    plan: 'Plan goedkeuren',
    permission: 'Toestemming',
    elicitation: 'Invoer gevraagd',
  };

  const TOOL_NAMES = {
    Bash: 'Terminal', Read: 'Lezen', Edit: 'Bewerken', MultiEdit: 'Bewerken', Write: 'Schrijven',
    Grep: 'Zoeken', Glob: 'Bestanden zoeken', WebFetch: 'Webpagina', WebSearch: 'Webzoeken',
    Agent: 'Subagent', Task: 'Subagent', Skill: 'Skill', ToolSearch: 'Tools laden', Monitor: 'Wachten',
    exec: 'Terminal', js: 'Script', apply_patch: 'Bewerken', spawn_agent: 'Subagent', update_plan: 'Plan',
    NotebookEdit: 'Notebook', Artifact: 'Artifact', SendUserFile: 'Bestand sturen', Workflow: 'Workflow',
  };

  let windowMin = store.get('window', 120);
  let tab = store.get('tab', 'questions');
  let state = null;
  let es = null;
  let connected = false;
  let knownQuestions = null;
  let bootBuild = null;
  const expanded = new Set();
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
    if (!tool) return 'Bezig';
    if (TOOL_NAMES[tool]) return TOOL_NAMES[tool];
    if (/^mcp__claude-in-chrome__/.test(tool)) return 'Chrome';
    if (/^mcp__Claude_Browser__/.test(tool)) return 'Browser';
    if (/^mcp__ccd_/.test(tool)) return 'Claude-app';
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
    if (m < 1) return 'zojuist';
    if (m < 60) return `${m} min geleden`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} u${m % 60 ? ' ' + (m % 60) + ' min' : ''} geleden`;
    return `${Math.floor(h / 24)} d geleden`;
  }

  function compact(ts) {
    const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (m < 1) return 'nu';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}u` : `${Math.floor(h / 24)}d`;
  }

  function dur(ts) {
    const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (m < 1) return '<1 min';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} u${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
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
      const title = new Date(ts).toLocaleString('nl-NL');
      if (el.title !== title) el.title = title;
    }
  }

  function statusTime(s) {
    switch (s.status) {
      case 'working': return timeEl(s.since, 'dur', 'al');
      case 'question':
      case 'permission': return timeEl((s.question && s.question.ts) || s.since, 'dur', 'wacht');
      case 'stale': return timeEl(s.lastTs, 'ago', 'stil sinds');
      case 'done': return timeEl(s.since || s.lastTs, 'ago', 'klaar');
      default: return timeEl(s.lastTs, 'ago');
    }
  }

  // ---------------------------------------------------------------- cards

  const ICON_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 10.5V4a1.5 1.5 0 0 1 1.5-1.5H11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function openButton(s, primary) {
    if (s.openUrl) {
      return `<a class="btn ${primary ? 'primary' : ''}" href="${esc(s.openUrl)}" data-act="open" data-sid="${esc(s.id)}">${ICON_OPEN}Open in ${esc(appOf(s))}</a>`;
    }
    if (s.resumeCmd) {
      return `<button type="button" class="btn ${primary ? 'primary' : ''}" data-act="copy" data-text="${esc(s.resumeCmd)}" title="${esc(s.resumeCmd)}">${ICON_COPY}Kopieer resume-commando</button>`;
    }
    return '';
  }

  function optionsHtml(s, options) {
    if (!options || !options.length) return '';
    return `<div class="options">${options.map((o) =>
      `<button type="button" class="option" data-act="answer" data-sid="${esc(s.id)}" data-text="${esc(o.label)}" title="Kopieer en open de sessie">${esc(o.label)}${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</button>`
    ).join('')}</div>`;
  }

  function questionCard(s) {
    const q = s.question;
    const key = 'q:' + s.id;
    const isOpen = expanded.has(key);
    const perm = q.kind === 'permission';
    let body;
    if (q.parts && q.parts.length) {
      body = q.parts.map((p) => `
        <div class="part">
          ${p.header ? `<div class="ph">${esc(p.header)}</div>` : ''}
          <div class="pq">${esc(p.question)}</div>
          ${optionsHtml(s, p.options.map((o) => ({ label: o.label, desc: o.description })))}
        </div>`).join('');
    } else {
      let context = q.context;
      if (!context && q.kind === 'text' && s.last) {
        const full = plain(s.last.text);
        const qi = full.lastIndexOf(q.text.slice(0, 30));
        context = (qi > 0 ? full.slice(0, qi) : full).trim();
      }
      body = `
        <p class="ask">${esc(q.text)}</p>
        ${q.detail ? `<div class="detail mono">${esc(shortPath(q.detail))}</div>` : ''}
        ${context ? `<div class="context">${esc(plain(context))}</div>` : ''}
        ${optionsHtml(s, (q.options || []).map((label) => ({ label })))}`;
    }
    const long = (q.context || (s.last && s.last.text) || '').length > 220;
    return {
      key,
      html: `
      <article class="card qcard ${perm ? 'permission' : ''} ${isOpen ? 'open' : ''}" data-key="${esc(key)}">
        <div class="meta">
          <span class="pill ${perm ? 'permission' : 'question'}"><span class="dot"></span>${esc(QUESTION_KIND[q.kind] || 'Vraag')}</span>
          ${timeEl(q.ts || s.since, 'ago')}
        </div>
        ${body}
        <div class="from"><strong>${esc(s.title)}</strong><span>${esc(s.project)} · ${esc(s.app)}</span></div>
        <div class="actions">
          ${openButton(s, true)}
          <span class="spacer"></span>
          ${long && !q.parts ? `<button type="button" class="btn link" data-act="toggle" data-key="${esc(key)}">${isOpen ? 'Minder' : 'Meer context'}</button>` : ''}
        </div>
      </article>`,
    };
  }

  function flowCard(s) {
    const key = 'f:' + s.id;
    const isOpen = expanded.has(key);
    const st = STATUS[s.status] || STATUS.idle;
    const lines = [];

    if (s.prompt && s.prompt.text) {
      lines.push(`<div class="say you"><span class="who">Jij</span><span class="body">${esc(s.prompt.text)}</span></div>`);
    } else if (s.autoPrompt) {
      lines.push(`<div class="say you"><span class="who">Start</span><span class="body">${esc(s.autoPrompt.text)}</span></div>`);
    }

    if (s.status === 'working' || s.status === 'stale') {
      if (s.activity) {
        lines.push(`<div class="activity"><span class="tool">${esc(toolName(s.activity.tool))}</span><span class="what mono" title="${esc(s.activity.sum)}">${esc(shortPath(s.activity.sum))}</span></div>`);
      }
      if (s.subagents && s.subagents.length) {
        lines.push(`<div class="subs">${s.subagents.length === 1 ? '1 subagent' : s.subagents.length + ' subagents'} aan het werk</div>`);
      }
    } else if (s.status === 'question' || s.status === 'permission') {
      lines.push(`<div class="say claude"><span class="who">Vraag</span><span class="body">${esc(s.question ? s.question.text : '')}</span></div>`);
    } else if (s.status === 'error' && s.error) {
      lines.push(`<div class="say claude"><span class="who">Fout</span><span class="body">${esc(s.error.text)}</span></div>`);
    } else if (s.recap || s.last) {
      lines.push(`<div class="say claude"><span class="who">${esc(appOf(s))}</span><span class="body">${esc(plain(s.recap || s.last.text))}</span></div>`);
    }

    const long = ((s.prompt && s.prompt.text) || '').length > 160 || ((s.recap || (s.last && s.last.text) || '').length > 200);
    return {
      key,
      html: `
      <article class="card flow ${isOpen ? 'open' : ''}" data-key="${esc(key)}">
        <div class="meta">
          <span class="pill ${st.cls}${s.unread ? ' unread' : ''}"${s.unread ? ` title="Nog niet bekeken in ${esc(appOf(s))}"` : ''}><span class="dot"></span>${esc(st.label)}</span>
          <span class="chip-app">${esc(s.app)}</span>
          ${statusTime(s)}
        </div>
        <h3 class="title">${esc(s.title)}</h3>
        <div class="project" title="${esc(s.cwd || '')}">${esc(s.project)}${s.projectDetail && s.projectDetail !== s.project ? ` <span class="sep">·</span> ${esc(s.projectDetail)}` : ''}</div>
        ${lines.join('')}
        <div class="actions">
          ${openButton(s, false)}
          <span class="spacer"></span>
          ${long ? `<button type="button" class="btn link" data-act="toggle" data-key="${esc(key)}">${isOpen ? 'Minder' : 'Meer'}</button>` : ''}
        </div>
      </article>`,
    };
  }

  // Blue means "look at me": an unseen answer, or a question. Both can be
  // marked read, which turns them grey.
  function needsReading(s) { return s.unread || s.status === 'question' || s.status === 'permission'; }

  // ---------------------------------------------------------------- folders

  // Sessions are grouped by the folder they were started in, A to Z, like the
  // Claude app's sidebar. A folder can be folded shut; that is remembered per
  // browser and shared by the full dashboard and the mini view.
  const collapsed = new Set(store.get('collapsed', []));

  function byFolder(sessions) {
    const groups = new Map();
    for (const s of sessions) {
      const f = s.folder || { key: '', name: 'Zonder map', detail: '' };
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

  const ICON_CHEVRON = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function folderSummary(items) {
    const waiting = items.filter((s) => s.status === 'question' || s.status === 'permission').length;
    const working = items.filter((s) => s.status === 'working').length;
    const unseen = items.filter((s) => s.unread).length;
    return [waiting && `${waiting} wacht`, working && `${working} bezig`, unseen && `${unseen} nieuw`].filter(Boolean).join(' · ');
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
      if (open) for (const s of g.items) out.push(card(s));
    }
    return out;
  }

  function toggleFolder(fold) {
    if (collapsed.has(fold)) collapsed.delete(fold); else collapsed.add(fold);
    store.set('collapsed', [...collapsed].slice(-60));
    render();
  }

  // Folding in the mini window shows up in the full dashboard, and back.
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

  // Each mini row names its AI tool (Claude, Codex) when that setting is on.
  let miniTools = false;

  function miniRow(s, withQuestion) {
    const key = 'm:' + s.id;
    const cls = (MINI_CLASS[s.status] || 'done') + (s.unread ? ' unread' : '') + (miniTools ? ' has-tool' : '');
    const st = STATUS[s.status] || STATUS.idle;
    let sub = '';
    if (withQuestion && s.question) {
      const q = s.question;
      sub = q.kind === 'permission' && q.tool
        ? `${toolName(q.tool)}${q.detail ? ': ' + shortPath(q.detail) : ''}`
        : q.text.split('\n')[0];
    }
    const when = (s.question && s.question.ts) || (s.status === 'working' ? s.since : s.lastTs);
    const tip = [s.title, s.project, s.app, s.unread ? 'nog niet bekeken' : st.label, s.question && s.question.text].filter(Boolean).join(' · ');
    const inner = `
      <span class="mdot"></span>
      <span class="mmain"><span class="mtitle">${esc(s.title)}</span>${sub ? `<span class="msub">${esc(sub)}</span>` : ''}</span>
      ${miniTools ? `<span class="mtool">${esc(appOf(s))}</span>` : ''}
      ${timeEl(when, 'compact')}`;
    const html = s.openUrl
      ? `<a class="mrow ${cls}" data-key="${esc(key)}" href="${esc(s.openUrl)}" data-act="open" data-sid="${esc(s.id)}" title="${esc(tip)}">${inner}</a>`
      : `<button type="button" class="mrow ${cls}" data-key="${esc(key)}" data-act="copy" data-text="${esc(s.resumeCmd || '')}" title="${esc(tip)} · klik om het resume-commando te kopiëren">${inner}</button>`;
    return { key, html };
  }

  function renderMini(sessions, questions) {
    miniTools = !!(state && state.toolLabels);
    const working = sessions.filter((s) => s.status === 'working').length;
    const qIds = new Set(questions.map((s) => s.id));
    const flows = sessions.filter((s) => !qIds.has(s.id));

    renderList($('#mini-questions'), grouped('q', questions, (s) => miniRow(s, true), 'mfolder'));
    renderList($('#mini-flows'), grouped('f', flows, (s) => miniRow(s, false), 'mfolder'));
    // No open questions: leave that whole part out.
    setHidden($('#mini-q-label'), questions.length === 0);
    setHidden($('#mini-questions'), questions.length === 0);
    setHidden($('#mini-f-none'), flows.length > 0);

    const parts = [];
    if (questions.length) parts.push(`<span class="hot">${questions.length} ${questions.length === 1 ? 'vraag' : 'vragen'}</span>`);
    if (working) parts.push(`${working} bezig`);
    const unseen = sessions.filter((s) => s.unread).length;
    if (unseen) parts.push(`<span class="new">${unseen} nieuw</span>`);
    setHTML($('#mini-sum'), parts.length ? parts.join(' · ') : 'Alles rustig');
    for (const el of $$('[data-count="working"]')) setText(el, working);
    $('.micro.q').classList.toggle('hot', questions.length > 0);
    $('.micro.w').classList.toggle('hot', working > 0);
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
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!state) return;
    const sessions = state.sessions || [];

    const questions = sessions
      .filter((s) => s.question && (s.status === 'question' || s.status === 'permission'))
      .sort((a, b) => ((a.status === 'permission' ? 0 : 1) - (b.status === 'permission' ? 0 : 1)) || ((b.question.ts || 0) - (a.question.ts || 0)));

    renderList($('#question-list'), grouped('q', questions, questionCard, 'folder'));
    // No open questions: the questions panel (and its tab) steps aside.
    document.body.classList.toggle('no-questions', questions.length === 0);

    renderList($('#flow-grid'), grouped('f', sessions, flowCard, 'folder'));
    setHidden($('#flow-empty'), sessions.length > 0);

    const working = sessions.filter((s) => s.status === 'working').length;
    const unseen = sessions.filter((s) => s.unread).length;
    setText($('#flows-sub'), `${sessions.length} in de laatste ${windowLabel(state.windowMin)}${working ? ` · ${working} bezig` : ''}${unseen ? ` · ${unseen} nieuw` : ''}`);
    for (const el of $$('[data-count="questions"]')) {
      setText(el, questions.length);
      el.classList.toggle('hot', questions.length > 0);
    }
    for (const el of $$('[data-count="flows"]')) setText(el, sessions.length);
    { const t = questions.length ? `(${questions.length}) AI Flows` : 'AI Flows'; if (document.title !== t) document.title = t; }
    renderMini(sessions, questions);
    renderLimits();
    syncBell();

    const notice = $('#notice');
    if (!state.hooksSeen) {
      setHidden(notice, false);
      if (!notice.innerHTML) notice.innerHTML = 'Nog geen hooks gezien, dus de status is een schatting. Installeer ze met <code>node install-hooks.js</code>.';
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
  const LIMIT_PROBLEM = {
    expired: 'login verlopen; die wordt vernieuwd zodra je Claude gebruikt',
    offline: 'niet bereikbaar',
    unknown: 'onbekend antwoord',
  };

  function limitLabel(key) {
    if (key === '5h') return '5 uur';
    if (key === 'week') return 'Week';
    return `${Math.round(parseInt(key, 10) / 60) || 0} uur`;
  }

  function resetText(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? `reset om ${time}`
      : `reset ${d.toLocaleDateString('nl-NL', { weekday: 'short' })} ${time}`;
  }

  const limitLevel = (pct) => (pct >= 90 ? 'high' : pct >= 75 ? 'warn' : '');

  function limitTool(t, label) {
    if (!t.windows.length) {
      const why = `${t.name}: ${LIMIT_PROBLEM[t.error] || 'niet beschikbaar'}`;
      return `<div class="lim-tool off" role="img" aria-label="${esc(why)}" title="${esc(why)}"><span class="lim-name">${esc(label)}</span><span class="lim-off">niet beschikbaar</span></div>`;
    }
    const wins = t.windows.map((w) => ({ ...w, pct: Math.round(w.pct) }));
    const lines = wins.map((w) => `${limitLabel(w.key)}: ${w.pct}% gebruikt${w.resetsAt ? `, ${resetText(w.resetsAt)}` : ''}`);
    if (t.at && Date.now() - t.at > 30 * 60000) lines.push(`Gemeten ${ago(t.at)}`);
    const tracks = wins.map((w) => `<span class="lim-track ${limitLevel(w.pct)}"><span class="lim-fill" data-p="${w.pct}"></span></span>`).join('');
    const nums = wins.map((w) => `<span class="lim-pct ${limitLevel(w.pct)}">${w.pct}%</span>`).join('<span class="lim-sep">/</span>');
    return `<div class="lim-tool" role="img" aria-label="${esc(`${t.name}. ${lines.join('. ')}`)}" title="${esc([t.name, ...lines].join('\n'))}">` +
      `<span class="lim-name">${esc(label)}</span><span class="lim-meter">${tracks}</span><span class="lim-nums">${nums}</span></div>`;
  }

  function renderLimits() {
    const list = state && Array.isArray(state.limits) ? state.limits : [];
    setHTML(limitsEl, list.map((t) => limitTool(t, list.length === 1 ? 'Limiet' : t.name)).join(''));
    // Widths through the style object: the page's CSP blocks style attributes.
    for (const f of $$('.lim-fill', limitsEl)) f.style.width = `${f.dataset.p}%`;
    setHidden(limitsEl, list.length === 0);
    syncLimitsHeight();
  }

  // Room at the bottom of the page for the bar (0 when hidden, also in micro).
  function syncLimitsHeight() {
    const h = limitsEl.hidden ? 0 : limitsEl.offsetHeight;
    const v = `${h}px`;
    if (document.body.style.getPropertyValue('--lim') !== v) document.body.style.setProperty('--lim', v);
  }
  if (window.ResizeObserver) new ResizeObserver(syncLimitsHeight).observe(limitsEl);

  function windowLabel(min) {
    if (min < 60) return `${min} min`;
    if (min === 60) return 'uur';
    return `${Math.round(min / 60)} uur`;
  }

  function announce(questions) {
    const keys = new Map(questions.map((s) => [s.id + ':' + (s.question.ts || ''), s]));
    if (knownQuestions) {
      for (const [k, s] of keys) {
        if (knownQuestions.has(k)) continue;
        const card = $(`#question-list [data-key="q:${CSS.escape(s.id)}"]`);
        if (card) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
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
    setTitle(ml, ok ? 'Live verbonden' : 'Geen verbinding met de server');
    setText($('#live-text'), !ok
      ? 'Geen verbinding met de server'
      : state && state.hooksSeen ? 'Live via hooks' : 'Live · schatting uit transcripts');
  }

  // ---------------------------------------------------------------- actions

  let toastTimer = null;
  const ICON_CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  function hideToast() { clearTimeout(toastTimer); $('#toast').classList.remove('show'); }
  // action: { label, run } adds a button, such as "Ongedaan maken".
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
    close.setAttribute('aria-label', 'Sluiten');
    close.title = 'Sluiten';
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
    const limitsOn = (state && state.limitsOn) || {};
    settingsPanel.querySelector('input[name="limit-claude"]').checked = !!limitsOn.claude;
    settingsPanel.querySelector('input[name="limit-codex"]').checked = !!limitsOn.codex;
  }

  function toggleSettings(open) {
    const mini = document.body.classList.contains('is-mini');
    settingsPanel.hidden = !open;
    settingsButton.setAttribute('aria-expanded', String(open));
    setTitle(settingsButton, open && mini ? 'Sluiten' : 'Instellingen');
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
  document.addEventListener('pointerdown', (e) => {
    if (!settingsPanel.hidden && !e.target.closest('#settings-panel, #settings-button')) toggleSettings(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsPanel.hidden) { toggleSettings(false); settingsButton.focus(); }
  });
  window.addEventListener('resize', () => { if (!settingsPanel.hidden) toggleSettings(true); });

  settingsPanel.addEventListener('change', async (e) => {
    const change = e.target.name === 'open-via' ? { openVia: e.target.value }
      : e.target.name === 'tool-labels' ? { toolLabels: e.target.checked }
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
        state.limitsOn = d.limits;
        // A tool turned off leaves at once; one turned on follows with the
        // next update from the server.
        if (state.limits) state.limits = state.limits.filter((t) => d.limits[t.tool]);
      }
      syncSettings();
      if ('toolLabels' in change) {
        render();
        toast(d.toolLabels ? 'AI-tool zichtbaar.' : 'AI-tool verborgen.');
        return;
      }
      if ('limits' in change) {
        render();
        const [tool] = Object.keys(change.limits);
        toast(`${tool === 'codex' ? 'Codex' : 'Claude'}-limieten ${d.limits[tool] ? 'aan' : 'uit'}.`);
        return;
      }
      toast(d.openVia === 'browser' ? 'Opent via je browser.' : 'Opent zonder vraag.');
    } catch {
      syncSettings();
      toast('Opslaan mislukt.');
    }
  });

  // ---------------------------------------------------------------- right-click menu

  // Right-click a flow (card, question or mini row) to open it, mark it read or
  // unread, or close it. "Unread" lasts until you open the session in its app;
  // "closed" until you send it a new message or it asks something new.
  const ctx = document.getElementById('ctx');
  let ctxSid = null;

  function closeCtx() {
    if (ctx.hidden) return;
    ctx.hidden = true;
    ctxSid = null;
  }

  function openCtx(x, y, s) {
    ctxSid = s.id;
    const open = ctx.querySelector('[data-ctx="open"]');
    open.hidden = !s.openUrl;
    setText(open, `Open in ${appOf(s)}`);
    setText(ctx.querySelector('[data-ctx="mark"]'), needsReading(s) ? 'Markeer als gelezen' : 'Markeer als ongelezen');
    ctx.hidden = false;
    const r = ctx.getBoundingClientRect();
    ctx.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    ctx.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    ctx.querySelector('button:not([hidden])').focus();
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
        toast(`“${s.title}” gesloten.`, { label: 'Ongedaan maken', run: () => markSession(s, 'open') });
        return;
      }
      if (kind === 'open') { toast('Teruggezet.'); return; }
      const unread = kind === 'unread';
      if (!unread && (s.status === 'question' || s.status === 'permission')) { s.status = 'done'; s.question = null; }
      s.unread = unread && !['working', 'permission', 'question'].includes(s.status);
      render();
      toast(unread ? 'Gemarkeerd als ongelezen.' : 'Gemarkeerd als gelezen.');
    } catch {
      toast('Kon de markering niet opslaan.');
    }
  }

  document.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-key]');
    const s = el && /^[fmq]:/.test(el.dataset.key) ? find(el.dataset.key.slice(2)) : null;
    if (!s) { closeCtx(); return; }
    e.preventDefault();
    openCtx(e.clientX, e.clientY, s);
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
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
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
      openSession(find(el.dataset.sid));
    } else if (act === 'answer') {
      const s = find(el.dataset.sid);
      const text = cleanAnswer(el.dataset.text);
      await copy(text);
      if (s && s.openUrl) {
        toast(`“${text}” gekopieerd. Plak met ⌘V.`);
        openSession(s);
      } else {
        toast(`“${text}” gekopieerd.`);
      }
    } else if (act === 'copy') {
      await copy(String(el.dataset.text).replace(INVISIBLE, ''));
      toast('Gekopieerd. Plak in je terminal.');
    } else if (act === 'fold') {
      toggleFolder(el.dataset.fold);
    } else if (act === 'toggle') {
      const key = el.dataset.key;
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      render();
    }
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

  // tabs (narrow screens)
  function syncTabs() {
    document.body.dataset.tab = tab;
    for (const b of $$('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  }
  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    store.set('tab', tab);
    syncTabs();
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
      ? (on ? 'Meldingen staan aan' : 'Meldingen aanzetten')
      : 'Bouw eerst het meldingsappje: notifier/build.sh');
    setText($('#bell-text'), on ? 'Meldingen aan' : 'Meldingen uit');
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
      toast(d.notify ? 'Meldingen aan.' : 'Meldingen uit.');
    } catch {
      toast('Opslaan mislukt.');
    }
  });

  // mini mode: ?mini, or automatically in a window narrower than 600 px. The
  // header's controls move into the mini bar, so they work the same in both.
  //
  // "Volledig dashboard openen" in a narrow window shows the full view for now:
  // kept across reloads of this tab, dropped again as soon as the window
  // crosses 600 px either way, or with the mini button in the header. (It used
  // to load ?full, which locked the page in the full view.) ?full itself still
  // shows the full view, for that one load.
  const params = new URLSearchParams(location.search);
  const narrowQuery = matchMedia('(max-width: 599px)');
  const controls = $('.top .controls');
  const controlsHome = controls.parentNode;
  const openMini = $('#open-mini');
  const session = {
    get() { try { return sessionStorage.getItem('ai-flows:full') === '1'; } catch { return false; } },
    set(on) { try { if (on) sessionStorage.setItem('ai-flows:full', '1'); else sessionStorage.removeItem('ai-flows:full'); } catch {} },
  };
  let showFull = params.has('full') || session.get();
  if (params.has('full')) {
    params.delete('full');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
  function setShowFull(on) { showFull = on; session.set(on); }

  function applyMode() {
    const mini = params.has('mini') || (!showFull && narrowQuery.matches);
    document.body.classList.toggle('is-mini', mini);
    // Mini because the window is narrow: widening it is the way to the full
    // view, so no button for it (the pop-up and ?mini keep theirs).
    document.body.classList.toggle('auto-mini', mini && !params.has('mini'));
    const home = mini ? $('#mini-bar') : controlsHome;
    if (controls.parentNode !== home) {
      if (!settingsPanel.hidden) toggleSettings(false);
      home.appendChild(controls);
    }
    // Full view in a narrow window: the mini button switches back in place.
    const back = !mini && narrowQuery.matches;
    openMini.title = back ? 'Terug naar de mini-weergave' : 'Mini-venster openen';
    openMini.setAttribute('aria-label', back ? 'Terug naar de mini-weergave' : 'Mini-venster');
  }
  narrowQuery.addEventListener('change', () => { setShowFull(false); applyMode(); });

  function openFull() {
    // From the pop-up window, show the full dashboard in a normal tab.
    if (window.opener && !window.opener.closed) { window.opener.focus(); return; }
    if (params.has('mini') && window.name === 'ai-flows-mini') { window.open('/', 'ai-flows-full'); return; }
    setShowFull(true);
    if (params.has('mini')) { location.href = '/'; return; }
    applyMode();
    scrollTo(0, 0);
  }
  $('#mini-expand').addEventListener('click', openFull);
  $('.mini-micro').addEventListener('click', () => { if (params.has('mini')) openFull(); });

  openMini.addEventListener('click', () => {
    if (narrowQuery.matches && !params.has('mini')) { setShowFull(false); applyMode(); scrollTo(0, 0); return; }
    const w = window.open('/?mini', 'ai-flows-mini', 'popup=yes,width=320,height=460');
    if (!w) toast('Venster geblokkeerd. Open 127.0.0.1:4777/?mini.');
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
  syncTabs();
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
