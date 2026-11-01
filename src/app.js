/* OpenFGA Visual Playground — application layer (stores, editors, graph, query lab, inspector). */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; return d; };
  const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const ago = (iso) => { const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`; };
  const shortId = (id) => (id ? id.slice(0, 6) + '…' + id.slice(-4) : '');
  const pretty = (o) => JSON.stringify(o, null, 2);

  const STARTER_DSL = `model
  schema 1.1

type user

type document
  relations
    define owner: [user]
    define viewer: [user, user:*] or owner
`;
  const STARTER_TUPLES = `user:anne owner document:readme
user:* viewer document:readme
`;

  // ───────────────────────── state & persistence ─────────────────────────
  const LS_KEY = 'openfga-visual-playground-v1';
  const S = {
    stores: [], activeStoreId: null,
    ui: { editorTab: 'dsl', graphMode: 'schema', inspTab: 'tuples', inspOpen: true, mobileView: 'editor', live: true, leftW: 360, rightW: 390, editorOpen: true, queryOpen: true, focus: false },
    parsed: null, model: null, lastGoodModel: null, effectiveModel: null,
    tuplesParsed: { tuples: [], errors: [], rejected: [] }, ctxTuples: { tuples: [], errors: [], rejected: [] }, store: null,
    result: null, step: 0, playing: null, summaryHl: null,
  };
  function loadState() {
    try { const s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && Array.isArray(s.stores) && s.stores.length) return s; } catch (e) { /* storage unavailable */ }
    return null;
  }
  const persist = debounce(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ stores: S.stores, activeStoreId: S.activeStoreId, ui: S.ui })); } catch (e) { /* ignore */ }
  }, 350);
  const activeStore = () => S.stores.find((s) => s.id === S.activeStoreId) || null;

  function writeModelVersion(st, dsl, opts = {}) {
    const parsed = FGA.parseDSL(dsl);
    if (parsed.errors.length) { if (!opts.silent) toast(`Model has ${parsed.errors.length} error${parsed.errors.length > 1 ? 's' : ''} — fix them before writing`); return null; }
    const latest = st.models[st.models.length - 1];
    if (latest && latest.dsl.trim() === dsl.trim()) { if (!opts.silent) toast(`Nothing changed since model ${shortId(latest.id)}`); return latest; }
    const now = new Date().toISOString();
    const json = FGA.modelToJSON(parsed.model);
    const v = { id: FGA.ulid(JSON.stringify(json) + now + st.id), dsl, created_at: now, types: parsed.model.types.length, relations: parsed.model.types.reduce((n, t) => n + t.relations.length, 0) };
    st.models.push(v);
    st.updated_at = now;
    return v;
  }
  function makeStore(name, seed = {}) {
    const now = new Date().toISOString();
    const st = {
      id: FGA.ulid(name + now + Math.random()), name, created_at: now, updated_at: now,
      draftDsl: seed.dsl || STARTER_DSL, tuplesText: seed.tuples ?? STARTER_TUPLES, models: [], changes: [], tupleKeys: [],
      assertions: (seed.assertions || []).map((a) => Object.assign({}, a)), queries: seed.queries || [], exampleId: seed.exampleId || null,
      query: null, pins: { schema: {}, model: {}, data: {} }, collapsed: [],
    };
    writeModelVersion(st, st.draftDsl, { silent: true });
    const model = FGA.parseDSL(st.draftDsl).model;
    const tp = FGA.parseTuples(st.tuplesText, model);
    st.tupleKeys = tp.tuples.map(FGA.tupleKey);
    st.changes = tp.tuples.map((t) => ({ op: 'write', tuple: tupleJSON(t), at: now }));
    return st;
  }
  function tupleJSON(t) {
    const o = { user: t.user.raw, relation: t.relation, object: t.object.raw };
    if (t.condition) o.condition = { name: t.condition.name, context: t.condition.context || {} };
    return o;
  }
  function tupleLine(o) {
    let s = `${o.user} ${o.relation} ${o.object}`;
    if (o.condition) s += ` with ${o.condition.name}` + (o.condition.context && Object.keys(o.condition.context).length ? ' ' + JSON.stringify(o.condition.context) : '');
    return s;
  }

  // ───────────────────────── toast ─────────────────────────
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }
  function copyText(text, label) {
    const done = () => toast(`${label || 'Copied'} to clipboard`);
    const fallback = () => {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy is not available here — select the text and copy it'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  // ───────────────────────── code editor ─────────────────────────
  function makeEditor({ ta, pre, gutter, highlight, onChange }) {
    const glow = document.createElement('div'); glow.className = 'gl'; gutter.appendChild(glow);
    let marks = { err: new Set(), warn: new Set() };
    const render = () => {
      const text = ta.value;
      const lines = text.split('\n');
      pre.innerHTML = highlight(text, marks) + '\n';
      glow.innerHTML = lines.map((_, i) => `<div class="ln${marks.err.has(i + 1) ? ' err' : marks.warn.has(i + 1) ? ' warn' : ''}">${i + 1}</div>`).join('');
      sync();
    };
    const sync = () => { pre.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`; glow.style.transform = `translateY(${-ta.scrollTop}px)`; };
    ta.addEventListener('input', () => { render(); onChange(ta.value); });
    ta.addEventListener('scroll', sync);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.setRangeText('  ', s, en, 'end');
        render(); onChange(ta.value);
      } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        const s = ta.selectionStart;
        const before = ta.value.slice(0, s);
        const line = before.slice(before.lastIndexOf('\n') + 1);
        const indent = (/^\s*/.exec(line) || [''])[0];
        const extra = /^(\s*)(type\b|relations\b|condition\b.*\{\s*$)/.test(line) ? '  ' : '';
        e.preventDefault();
        ta.setRangeText('\n' + indent + extra, s, ta.selectionEnd, 'end');
        render(); onChange(ta.value);
      }
    });
    return {
      get value() { return ta.value; },
      set value(v) { if (ta.value !== v) { ta.value = v; } render(); },
      setMarks(err, warn) { marks = { err: new Set(err), warn: new Set(warn) }; render(); },
      scrollToLine(n, keepSelection) {
        const lh = 20; ta.scrollTop = Math.max(0, (n - 1) * lh - ta.clientHeight / 2 + lh);
        if (!keepSelection) { const pos = ta.value.split('\n').slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0); ta.focus(); ta.setSelectionRange(pos, pos); }
        sync(); this.flashLine(n);
      },
      revealLine(n) { const lh = 20; const top = (n - 1) * lh; if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lh) ta.scrollTop = Math.max(0, top - ta.clientHeight / 2 + lh); sync(); this.flashLine(n); },
      flashLine(n) { const row = glow.children[n - 1]; if (!row) return; row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1200); },
      refresh: render,
    };
  }
  const wrapLine = (html, lineNo, marks) => marks.err.has(lineNo) ? `<span class="line-err">${html}</span>` : marks.warn.has(lineNo) ? `<span class="line-warn">${html}</span>` : html;

  function hlExprTokens(src) {
    return esc(src).replace(/(\[|\]|\(|\))|(\bor\b|\band\b|\bbut not\b|\bfrom\b)|(\bwith\b)\s+([\w-]+)|([\w-]+):\*|([\w-]+)#([\w-]+)|([\w-]+)/g,
      (m, br, op, withKw, cond, wildT, usT, usR, id) => {
        if (br) return `<span class="br">${br}</span>`;
        if (op) return `<span class="op">${op}</span>`;
        if (withKw) return `<span class="kw">with</span> <span class="cond">${cond}</span>`;
        if (wildT) return `<span class="ty">${wildT}</span><span class="op">:*</span>`;
        if (usT) return `<span class="ty">${usT}</span><span class="br">#</span><span class="rel">${usR}</span>`;
        return `<span class="rel">${id}</span>`;
      });
  }
  function hlExprInside(src) {
    // inside [...] identifiers are types
    return esc(src).replace(/(\bwith\b)\s+([\w-]+)|([\w-]+):\*|([\w-]+)#([\w-]+)|([\w-]+)|(,)/g, (m, w, cond, wt, ut, ur, id, comma) => {
      if (w) return `<span class="kw">with</span> <span class="cond">${cond}</span>`;
      if (wt) return `<span class="ty">${wt}</span><span class="op">:*</span>`;
      if (ut) return `<span class="ty">${ut}</span><span class="br">#</span><span class="rel">${ur}</span>`;
      if (comma) return `<span class="br">,</span>`;
      return `<span class="ty">${id}</span>`;
    });
  }
  function highlightDSL(text, marks) {
    let inCond = false;
    return text.split('\n').map((line, i) => {
      const n = i + 1;
      let html;
      const cmIdx = line.search(/(^|\s)#/);
      let code = line, comment = '';
      if (cmIdx >= 0) { const at = line[cmIdx] === '#' ? cmIdx : cmIdx + 1; code = line.slice(0, at); comment = line.slice(at); }
      const t = code.trim();
      let m;
      if (inCond) {
        html = hlCondBody(code);
        if (/\}/.test(code)) inCond = false;
      } else if (!t) html = esc(code);
      else if ((m = /^(\s*)(model)\s*$/.exec(code))) html = `${m[1]}<span class="kw">${m[2]}</span>`;
      else if ((m = /^(\s*)(schema)\s+(\S+)\s*$/.exec(code))) html = `${m[1]}<span class="kw">schema</span> <span class="num">${esc(m[3])}</span>`;
      else if ((m = /^(\s*)(type)\s+([\w-]+)(.*)$/.exec(code))) html = `${m[1]}<span class="kw">type</span> <span class="ty">${esc(m[3])}</span>${esc(m[4])}`;
      else if ((m = /^(\s*)(relations)\s*$/.exec(code))) html = `${m[1]}<span class="kw">relations</span>`;
      else if ((m = /^(\s*)(define)\s+([\w-]+)\s*(:)?(.*)$/.exec(code))) {
        const expr = m[5].replace(/\[[^\]]*\]?/g, (seg) => '\u0000' + seg + '\u0000');
        const parts = expr.split('\u0000').map((seg, k) => (k % 2 === 1 ? `<span class="br">[</span>${hlExprInside(seg.replace(/^\[/, '').replace(/\]$/, ''))}${/\]$/.test(seg) ? '<span class="br">]</span>' : ''}` : hlExprTokens(seg)));
        html = `${m[1]}<span class="kw">define</span> <span class="rel">${esc(m[3])}</span>${m[4] ? '<span class="br">:</span>' : ''}${parts.join('')}`;
      } else if ((m = /^(\s*)(condition)\s+([\w-]+)\s*(\([^)]*\))?\s*(\{)?(.*)$/.exec(code))) {
        const params = (m[4] || '').replace(/([\w-]+)\s*:\s*([\w<>, ]+)/g, '<span class="rel">$1</span>: <span class="ty">$2</span>');
        html = `${m[1]}<span class="kw">condition</span> <span class="cond">${esc(m[3])}</span>${params}${m[5] ? ' <span class="br">{</span>' : ''}${hlCondBody(m[6] || '')}`;
        if (m[5] && !/\}/.test(m[6] || '')) inCond = true;
      } else html = esc(code);
      if (comment) html += `<span class="cm">${esc(comment)}</span>`;
      return wrapLine(html, n, marks);
    }).join('\n');
  }
  function hlCondBody(src) {
    return esc(src).replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(&&|\|\||==|!=|<=|>=|<|>|\bin\b|!)|(\b(?:timestamp|duration|ipaddress|size|has)\b)|(\})/g,
      (m, str, numv, op, fn, close) => str ? `<span class="str">${str}</span>` : numv ? `<span class="num">${numv}</span>` : op ? `<span class="op">${op}</span>` : fn ? `<span class="cond">${fn}</span>` : `<span class="br">}</span>`);
  }
  function highlightTuples(text, marks) {
    return text.split('\n').map((line, i) => {
      const n = i + 1;
      let code = line, comment = '';
      const cmIdx = line.search(/(^|\s)#/);
      if (cmIdx >= 0) { const at = line[cmIdx] === '#' ? cmIdx : cmIdx + 1; code = line.slice(0, at); comment = line.slice(at); }
      let html;
      const m = /^(\s*)([^\s,]+)(\s*[,\s]\s*)([^\s,]+)(\s*[,\s]\s*)([^\s,]+)(.*)$/.exec(code);
      if (m) {
        const user = esc(m[2]).replace(/^([\w-]+):(\*)$/, '<span class="ty">$1</span><span class="op">:*</span>').replace(/^([\w-]+):([^#]+)#([\w-]+)$/, '<span class="ty">$1</span>:$2<span class="br">#</span><span class="rel">$3</span>').replace(/^([\w-]+):([^#<]+)$/, '<span class="ty">$1</span>:$2');
        const obj = esc(m[6]).replace(/^([\w-]+):(.+)$/, '<span class="obj">$1</span>:$2');
        const rest = esc(m[7]).replace(/\bwith\s+([\w-]+)/, '<span class="kw">with</span> <span class="cond">$1</span>').replace(/("(?:[^"\\]|\\.)*")/g, '<span class="str">$1</span>').replace(/\b(\d+(?:\.\d+)?)\b(?![^<]*>)/g, '<span class="num">$1</span>');
        html = `${m[1]}<span class="usr">${user}</span>${esc(m[3])}<span class="rel">${esc(m[4])}</span>${esc(m[5])}${obj}${rest}`;
      } else html = esc(code);
      if (comment) html += `<span class="cm">${esc(comment)}</span>`;
      return wrapLine(html, n, marks);
    }).join('\n');
  }

/*__GRAPH__*/

  // ───────────────────────── recompute pipeline ─────────────────────────
  const dslEditor = makeEditor({ ta: $('#dsl-ta'), pre: $('#dsl-pre'), gutter: $('#dsl-gutter'), highlight: highlightDSL, onChange: (v) => { const st = activeStore(); if (st) { st.draftDsl = v; recomputeSoon(); } } });
  const tuplesEditor = makeEditor({ ta: $('#tuples-ta'), pre: $('#tuples-pre'), gutter: $('#tuples-gutter'), highlight: highlightTuples, onChange: (v) => { const st = activeStore(); if (st) { st.tuplesText = v; recomputeSoon(); } } });
  const recomputeSoon = debounce(() => recompute(), 140);
  const changesSoon = debounce(() => diffChanges(), 1600);

  function recompute() {
    const st = activeStore();
    if (!st) return;
    S.parsed = FGA.parseDSL(st.draftDsl);
    S.model = S.parsed.model;
    if (!S.parsed.errors.length && S.model.types.length) S.lastGoodModel = S.model;
    S.effectiveModel = S.parsed.errors.length || !S.model.types.length ? S.lastGoodModel : S.model;
    dslEditor.setMarks(S.parsed.errors.map((e) => e.line), S.parsed.warnings.map((w) => w.line));
    renderDiags($('#dsl-diags'), S.parsed.errors, S.parsed.warnings, dslEditor, S.model.types.length ? `Model OK — ${S.model.types.length} type${S.model.types.length === 1 ? '' : 's'}, ${S.model.types.reduce((n, t) => n + t.relations.length, 0)} relations${S.model.conditions.length ? ', ' + S.model.conditions.length + ' condition' + (S.model.conditions.length === 1 ? '' : 's') : ''}` : '');
    $('#dsl-meta').textContent = `schema ${S.model.schema || '1.1'} · ${st.draftDsl.split('\n').length} lines`;

    S.tuplesParsed = FGA.parseTuples(S.timeTravel ? S.timeTravel.text : st.tuplesText, S.effectiveModel);
    S.ctxTuples = FGA.parseTuples(Query.getCtxTuplesText(), S.effectiveModel, { contextual: true });
    const all = S.tuplesParsed.tuples.concat(S.ctxTuples.tuples);
    S.store = FGA.buildStore(all);
    NodeMenu.close();
    tuplesEditor.setMarks(S.tuplesParsed.errors.map((e) => e.line), S.tuplesParsed.rejected.map((r) => r.line));
    renderDiags($('#tuples-diags'), S.tuplesParsed.errors, S.tuplesParsed.rejected.map((r) => ({ line: r.line, message: `rejected: ${r.message}` })), tuplesEditor, '');
    const n = S.tuplesParsed.tuples.length;
    $('#tuple-count').textContent = n;
    $('#tuples-status').innerHTML = `<span><b>${n}</b> tuple${n === 1 ? '' : 's'} in the store</span>` + (S.tuplesParsed.rejected.length ? `<span class="rej">${S.tuplesParsed.rejected.length} rejected by type restrictions (OpenFGA would refuse the write)</span>` : '') + (S.tuplesParsed.errors.length ? `<span class="rej">${S.tuplesParsed.errors.length} unparsable line${S.tuplesParsed.errors.length === 1 ? '' : 's'}</span>` : '') + `<span>format: <code>user relation object [with condition {json}]</code></span>`;
    $('#q-ctx-tuples-status').textContent = S.ctxTuples.tuples.length ? `${S.ctxTuples.tuples.length} contextual tuple${S.ctxTuples.tuples.length === 1 ? '' : 's'} applied to this query only` : (S.ctxTuples.errors.length || S.ctxTuples.rejected.length ? `${[...S.ctxTuples.errors, ...S.ctxTuples.rejected].map((e) => 'line ' + e.line + ': ' + e.message).join(' · ')}` : '');

    const types = S.effectiveModel ? S.effectiveModel.types.map((t) => t.name) : [];
    const relations = S.effectiveModel ? Array.from(new Set(S.effectiveModel.types.flatMap((t) => t.relations.map((r) => r.name)))) : [];
    const baseModel = compareBase(st);
    Graph.setPins(st.pins); Graph.setCollapsed(st.collapsed);
    Graph.setData({ schema: S.effectiveModel ? buildSchemaGraph(S.effectiveModel, baseModel) : null, model: S.effectiveModel ? FGA.buildModelGraph(S.effectiveModel) : null, data: FGA.buildDataGraph(S.store), types, relations, modelObj: S.effectiveModel, store: S.store, derived: S.ui.derived ? computeDerived() : null });
    renderCompareSelect(st);
    renderResSelect();
    renderTimeTravelBanner(st);
    refreshDatalists();
    updateModelBadge();
    renderGraphStatus();
    Query.onModelChanged();
    Assertions.runAll();
    Inspector.refresh();
    if (S.ui.live && S.result) Query.run({ auto: true }); else if (S.result && !S.ui.live) { /* keep stale result */ }
    if (!S.timeTravel) changesSoon();
    persist();
  }
  // compare the draft against a written model version (schema diff overlay)
  function compareBase(st) {
    if (!S.ui.compareId || !st) return null;
    const v = st.models.find((m) => m.id === S.ui.compareId);
    if (!v) { S.ui.compareId = null; return null; }
    const parsed = FGA.parseDSL(v.dsl);
    return parsed.errors.length ? null : parsed.model;
  }
  function renderCompareSelect(st) {
    const sel = $('#compare-select');
    const cur = S.ui.compareId || '';
    sel.innerHTML = `<option value="">no diff</option>` + st.models.slice().reverse().map((m, i) => `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}>v${st.models.length - i} · ${esc(shortId(m.id))}</option>`).join('');
    $('#compare-wrap').hidden = !(Graph.mode === 'schema' || Graph.mode === 'matrix') || !st.models.length;
    $('#legend-diff').hidden = !cur;
    const lmd = $('#legend-mx-diff'); if (lmd) lmd.hidden = !cur;
  }
  $('#compare-select').addEventListener('change', () => { S.ui.compareId = $('#compare-select').value || null; persist(); recompute(); });
  // resolution view: which relation's tree is shown (empty = follow the query)
  function renderResSelect() {
    const sel = $('#res-select');
    const m = S.effectiveModel;
    const cur = Graph.resolutionRoot || '';
    const groups = m ? m.types.filter((t) => t.relations.length).map((t) => `<optgroup label="${esc(t.name)}">${t.relations.map((r) => { const k = `${t.name}#${r.name}`; return `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(k)}</option>`; }).join('')}</optgroup>`).join('') : '';
    sel.innerHTML = `<option value=""${cur ? '' : ' selected'}>follow the query${!cur && Graph.resolutionKey ? ` · ${esc(Graph.resolutionKey)}` : ''}</option>` + groups;
    $('#res-wrap').hidden = Graph.mode !== 'model' || !m;
  }
  $('#res-select').addEventListener('change', () => { Graph.setResolutionRoot($('#res-select').value || null); });
  // time travel over the change log
  function tuplesTextAt(st, upto) {
    const keys = new Map();
    st.changes.slice(0, upto).forEach((c) => { const line = tupleLine(c.tuple); if (c.op === 'write') keys.set(line, true); else keys.delete(line); });
    return Array.from(keys.keys()).join('\n') + '\n';
  }
  function setTimeTravel(idx) {
    const st = activeStore(); if (!st) return;
    if (idx == null || idx >= st.changes.length) S.timeTravel = null;
    else S.timeTravel = { idx, text: tuplesTextAt(st, idx), at: st.changes[Math.max(0, idx - 1)] ? st.changes[Math.max(0, idx - 1)].at : st.created_at };
    recompute();
  }
  function renderTimeTravelBanner(st) {
    const b = $('#tt-banner');
    if (!S.timeTravel) { b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = `<span>Viewing the store as of <b>${esc(fmtTime(S.timeTravel.at))}</b> · ${S.timeTravel.idx} of ${st.changes.length} changes replayed · ${S.tuplesParsed.tuples.length} tuples</span><span class="tt-ctl"><input type="range" id="tt-range" min="0" max="${st.changes.length}" value="${S.timeTravel.idx}" aria-label="Replay position"><button class="btn sm" id="tt-now">Back to now</button></span>`;
    $('#tt-range').addEventListener('input', (e) => setTimeTravel(+e.target.value));
    $('#tt-now').addEventListener('click', () => setTimeTravel(null));
  }
  function renderDiags(el, errors, warnings, editor, okText) {
    const items = [...errors.map((e) => ({ ...e, kind: 'err' })), ...warnings.map((w) => ({ ...w, kind: 'warn' }))].sort((a, b) => a.line - b.line);
    el.innerHTML = items.map((d) => `<div class="diag ${d.kind}" data-line="${d.line}"><span class="ln">L${d.line}</span><span>${esc(d.message)}</span></div>`).join('') + (okText && !items.length ? `<div class="diag ok"><span class="ln">✓</span><span>${esc(okText)}</span></div>` : '');
    $$('.diag[data-line]', el).forEach((d) => d.addEventListener('click', () => editor.scrollToLine(+d.dataset.line)));
  }
  function refreshDatalists() {
    const users = new Set(S.store.allUsers());
    const objects = S.store.allObjects();
    objects.forEach((o) => users.add(o));
    if (S.effectiveModel) for (const t of S.effectiveModel.types) for (const r of t.relations) for (const o of S.store.objectsOfType(t.name)) users.add(`${o}#${r.name}`);
    $('#dl-users').innerHTML = Array.from(users).sort().map((u) => `<option value="${esc(u)}">`).join('');
    $('#dl-objects').innerHTML = objects.map((o) => `<option value="${esc(o)}">`).join('');
    const rels = new Set();
    if (S.effectiveModel) for (const t of S.effectiveModel.types) for (const r of t.relations) rels.add(r.name);
    $('#dl-relations').innerHTML = Array.from(rels).sort().map((r) => `<option value="${esc(r)}">`).join('');
  }
  function latestModel(st) { return st.models[st.models.length - 1] || null; }
  function draftMatchesLatest(st) { const l = latestModel(st); return !!l && l.dsl.trim() === st.draftDsl.trim(); }
  function updateModelBadge() {
    const st = activeStore(); if (!st) return;
    const badge = $('#model-badge'), l = latestModel(st);
    const same = draftMatchesLatest(st);
    badge.classList.toggle('draft', !same);
    $('#model-badge-text').textContent = same ? `Model v${st.models.length}` : (l ? `Draft · unwritten changes (latest v${st.models.length})` : 'Draft · no model written yet');
    $('#model-badge-id').textContent = same ? l.id : '';
    badge.title = same ? `authorization_model_id ${l.id} · written ${fmtTime(l.created_at)}` : 'The editor differs from the last written model. Queries here run against the live draft; write it to get an immutable model id.';
    $('#btn-write-model').disabled = same || !!S.parsed.errors.length;
  }
  function renderGraphStatus() {
    const st = activeStore(); if (!st) return;
    const m = S.effectiveModel;
    const types = m ? m.types.length : 0, rels = m ? m.types.reduce((n, t) => n + t.relations.length, 0) : 0;
    const stale = S.parsed.errors.length && S.lastGoodModel ? '<span class="rej" style="color:var(--warn)">showing the last valid model while the draft has errors</span>' : '';
    $('#graph-status').innerHTML = `<span><b>${types}</b> types</span><span><b>${rels}</b> relations</span><span><b>${S.tuplesParsed.tuples.length}</b> tuples</span>${S.ctxTuples.tuples.length ? `<span><b>${S.ctxTuples.tuples.length}</b> contextual</span>` : ''}<span class="live">live</span>${stale}`;
  }
  function diffChanges() {
    const st = activeStore(); if (!st) return;
    const keys = S.tuplesParsed.tuples.map(FGA.tupleKey);
    const prev = new Set(st.tupleKeys || []), now = new Set(keys);
    const at = new Date().toISOString();
    const byKey = new Map(S.tuplesParsed.tuples.map((t) => [FGA.tupleKey(t), t]));
    let changed = false;
    for (const k of now) if (!prev.has(k)) { st.changes.push({ op: 'write', tuple: tupleJSON(byKey.get(k)), at }); changed = true; }
    for (const k of prev) if (!now.has(k)) { const parts = k.split('|'); st.changes.push({ op: 'delete', tuple: { user: parts[0], relation: parts[1], object: parts[2] }, at }); changed = true; }
    if (changed) { st.tupleKeys = keys; st.updated_at = at; if (st.changes.length > 400) st.changes.splice(0, st.changes.length - 400); if (S.ui.inspTab === 'changes') Inspector.refresh(); persist(); }
  }

  // ───────────────────────── query lab ─────────────────────────
  const Query = (() => {
    const fieldsEl = $('#q-fields');
    const q = { type: 'check', user: '', relation: '', object: '', objectType: '', userType: '', userRelation: '', context: '', ctxTuples: '' };
    const DEF = {
      check: [{ id: 'user', label: 'user', list: 'dl-users', ph: 'user:anne' }, { id: 'relation', label: 'relation', list: 'dl-relations', ph: 'viewer' }, { id: 'object', label: 'object', list: 'dl-objects', ph: 'doc:roadmap' }],
      listObjects: [{ id: 'user', label: 'user', list: 'dl-users', ph: 'user:anne' }, { id: 'relation', label: 'relation', list: 'dl-relations', ph: 'viewer' }, { id: 'objectType', label: 'object type', select: 'types' }],
      listUsers: [{ id: 'object', label: 'object', list: 'dl-objects', ph: 'doc:roadmap' }, { id: 'relation', label: 'relation', list: 'dl-relations', ph: 'viewer' }, { id: 'userType', label: 'user type', select: 'types' }, { id: 'userRelation', label: 'userset relation', list: 'dl-relations', ph: 'relation', optional: true }],
      expand: [{ id: 'object', label: 'object', list: 'dl-objects', ph: 'doc:roadmap' }, { id: 'relation', label: 'relation', list: 'dl-relations', ph: 'viewer' }],
    };
    // the query reads as the question it asks; fields are inline tokens
    const SENTENCE = {
      check: ['Is ', 'user', ' a ', 'relation', ' of ', 'object', '?'],
      listObjects: ['Which ', 'objectType', ' is ', 'user', ' a ', 'relation', ' of?'],
      listUsers: ['Who holds ', 'relation', ' on ', 'object', '? ', { note: 'filter' }, 'userType', { optional: 'userRelation', prefix: '#' }],
      expand: ['Expand ', 'object', '#', 'relation'],
    };
    const runSoon = debounce(() => run({ auto: true }), 260);
    const sizeTok = (el) => { const n = Math.max((el.value || '').length, (el.placeholder || '').length, 3); el.style.width = `calc(${n + 1}ch + 22px)`; };
    function renderFields() {
      const types = S.effectiveModel ? S.effectiveModel.types.map((t) => t.name) : [];
      const defs = Object.fromEntries(DEF[q.type].map((f) => [f.id, f]));
      const tok = (f) => f.select
        ? `<select class="tok" id="qf-${f.id}" aria-label="${f.label}">${types.map((t) => `<option value="${esc(t)}"${q[f.id] === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`
        : `<input class="tok" id="qf-${f.id}" list="${f.list}" placeholder="${f.ph}" value="${esc(q[f.id])}" aria-label="${f.label}" autocomplete="off" spellcheck="false">`;
      const parts = SENTENCE[q.type].map((part) => {
        if (typeof part === 'string') return defs[part] ? { tok: tok(defs[part]) } : { w: part };
        if (part.note) return { html: `<span class="w note">${esc(part.note)}</span>` };
        if (part.optional) { const f = defs[part.optional]; return { html: `<span class="opt${q[f.id] ? ' on' : ''}" id="opt-${f.id}"><span class="w">${esc(part.prefix)}</span>${tok(f)}</span>` }; }
        return { html: '' };
      });
      // keep trailing punctuation glued to its token so the question never wraps to a lone "?"
      let html = '';
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.tok) { const nxt = parts[i + 1]; if (nxt && nxt.w && /^[?.!#]/.test(nxt.w) && nxt.w.trim().length <= 3) { html += `<span class="nw">${p.tok}<span class="w">${esc(nxt.w)}</span></span>`; i++; } else html += p.tok; }
        else if (p.w != null) html += `<span class="w">${esc(p.w)}</span>`;
        else html += p.html;
      }
      fieldsEl.innerHTML = html;
      DEF[q.type].forEach((f) => {
        const el = $(`#qf-${f.id}`);
        if (!el) return;
        if (f.select && !types.includes(q[f.id])) q[f.id] = types[0] || '';
        if (!f.select) sizeTok(el);
        const upd = () => { q[f.id] = el.value.trim(); if (!f.select) sizeTok(el); const opt = $(`#opt-${f.id}`); if (opt) opt.classList.toggle('on', !!q[f.id]); saveQuery(); if (S.ui.live) runSoon(); };
        el.addEventListener('input', upd); el.addEventListener('change', upd);
        el.addEventListener('focus', () => { const opt = $(`#opt-${f.id}`); if (opt) opt.classList.add('on'); });
      });
    }
    function saveQuery() { const st = activeStore(); if (st) { st.query = Object.assign({}, q); persist(); } }
    function syncAdv() {
      const n = (q.context && q.context.trim() ? 1 : 0) + (S.ctxTuples.tuples.length ? 1 : 0);
      $('#q-adv-badge').textContent = n ? '●' : '';
      $('#q-adv-toggle').classList.toggle('has', n > 0);
    }
    function load(query) {
      Object.assign(q, { type: 'check', user: '', relation: '', object: '', objectType: '', userType: '', userRelation: '', context: '', ctxTuples: '' }, query || {});
      $$('#q-type button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === q.type)));
      $('#q-context').value = q.context || '';
      $('#q-ctx-tuples').value = q.ctxTuples || '';
      renderFields(); syncAdv();
    }
    function subjectType() { const m = S.effectiveModel; if (!m) return ''; const s = m.types.find((t) => !t.relations.length) || m.types.find((t) => t.name === 'user') || m.types[0]; return s ? s.name : ''; }
    function objectTypeFor(relation, hint) { const m = S.effectiveModel; if (!m) return ''; if (hint && m.typeMap.has(hint) && (!relation || m.typeMap.get(hint).relMap.has(relation))) return hint; const t = m.types.find((x) => relation && x.relMap.has(relation)) || m.types.find((x) => x.relations.length); return t ? t.name : ''; }
    function setType(t) {
      const prev = q.type;
      q.type = t;
      if (t === 'listObjects') { if (!q.objectType || !(S.effectiveModel && S.effectiveModel.typeMap.has(q.objectType) && S.effectiveModel.typeMap.get(q.objectType).relMap.has(q.relation))) q.objectType = objectTypeFor(q.relation, (q.object || '').split(':')[0]); }
      if (t === 'listUsers') { if (!q.userType) q.userType = (q.user && !q.user.includes('#') && q.user.split(':')[0]) || subjectType(); if (!q.object) { const ot = objectTypeFor(q.relation, ''); const o = ot && S.store.objectsOfType(ot)[0]; if (o) q.object = o; } }
      if ((t === 'expand' || t === 'check') && !q.object) { const ot = objectTypeFor(q.relation, q.objectType); const o = ot && S.store.objectsOfType(ot)[0]; if (o) q.object = o; }
      if (t === 'check' && !q.user && prev === 'listUsers') { const u = S.store.usersOfType(q.userType || subjectType())[0]; if (u) q.user = u; }
      $$('#q-type button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === t)));
      renderFields(); saveQuery(); if (S.ui.live) run({ auto: true });
    }
    function onModelChanged() { DEF[q.type].filter((f) => f.select).forEach((f) => { const el = $(`#qf-${f.id}`); const types = S.effectiveModel ? S.effectiveModel.types.map((t) => t.name) : []; if (el && Array.from(el.options).map((o) => o.value).join('|') !== types.join('|')) renderFields(); }); syncAdv(); }
    function parseContext() {
      const txt = (q.context || '').trim();
      if (!txt) return { ok: true, value: {} };
      try { const v = JSON.parse(txt); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('context must be a JSON object'); return { ok: true, value: v }; } catch (e) { return { ok: false, error: e.message }; }
    }
    const explainEl = $('#explain');
    function clearExplain() { $('#stepper').hidden = true; $('#trace').innerHTML = ''; explainEl.hidden = true; $('#explain-hint').textContent = ''; }
    function run({ auto } = {}) {
      stopPlay();
      const model = S.effectiveModel;
      const resultEl = $('#result');
      if (!model) { S.result = null; resultEl.innerHTML = `<div class="answer warn"><div class="ans-head"><span class="ans-verdict">No model</span><span class="ans-text">Write a valid model first.</span></div></div>`; clearExplain(); return; }
      const ctx = parseContext();
      if (!ctx.ok) { resultEl.innerHTML = `<div class="answer warn"><div class="ans-head"><span class="ans-verdict">Context</span><span class="ans-text">${esc(ctx.error)}</span></div></div>`; return; }
      const store = S.store;
      // the resolution view follows the relation being queried
      const qType = q.type === 'listObjects' ? q.objectType : (q.object || '').split(':')[0];
      Graph.setQueryRelation(qType && q.relation ? `${qType}#${q.relation}` : null);
      const t0 = performance.now();
      let res, missing = [];
      const need = (ids) => ids.filter((id) => !q[id]).map((id) => DEF[q.type].find((f) => f.id === id).label);
      if (q.type === 'check') { missing = need(['user', 'relation', 'object']); if (!missing.length) res = FGA.check(model, store, { user: q.user, relation: q.relation, object: q.object, context: ctx.value }); }
      else if (q.type === 'listObjects') { missing = need(['user', 'relation', 'objectType']); if (!missing.length) res = FGA.listObjects(model, store, { user: q.user, relation: q.relation, type: q.objectType, context: ctx.value }); }
      else if (q.type === 'listUsers') { missing = need(['object', 'relation', 'userType']); if (!missing.length) res = FGA.listUsers(model, store, { object: q.object, relation: q.relation, userType: q.userType, userRelation: q.userRelation || null, context: ctx.value }); }
      else { missing = need(['object', 'relation']); if (!missing.length) res = FGA.expand(model, store, { object: q.object, relation: q.relation }); }
      if (missing.length) {
        if (!auto) toast(`Fill in the ${missing.join(' and ')} first`);
        S.result = null; Graph.highlight(null); Graph.setPathObjects(q.object ? [q.object] : []);
        resultEl.innerHTML = `<div class="empty">Fill in the ${esc(missing.join(' and '))} to run. Click a node in the graph, or pick a suggestion.</div>`;
        clearExplain(); $('#try-chips').hidden = !$('#try-chips').children.length;
        return;
      }
      const ms = performance.now() - t0;
      S.result = { type: q.type, q: Object.assign({}, q, { contextObj: ctx.value }), res, ms };
      S.summaryHl = res.trace && res.trace.events.length ? FGA.summaryHighlight(res.trace) : null;
      if (q.type === 'check' && res.root) { S.result.chains = FGA.proofChains(res.root.proof); S.result.proofHl = proofHighlight(S.result.chains); }
      // the instance graph opens the objects this query walked as cards
      Graph.setPathObjects(Object.keys(S.summaryHl ? S.summaryHl.dataNodes : {}).filter((k) => !k.includes('#')).concat(q.object && !q.object.endsWith(':?') ? [q.object] : [], res.objects || []));
      renderResult();
      if (res.trace && res.trace.events.length) {
        buildTraceTree(res.trace);
        explainEl.hidden = false;
        $('#stepper').hidden = false;
        $('#explain-hint').textContent = `${res.trace.events.length} steps · ${res.trace.reads} tuple reads`;
        goto(res.trace.events.length - 1, { scroll: false });
      } else {
        clearExplain();
        const hl = { modelNodes: {}, dataNodes: {}, dataEdges: {}, modelEdges: {} };
        if (res.tree) { hl.modelNodes[`${q.object.split(':')[0]}#${q.relation}`] = 'active'; hl.dataNodes[q.object] = 'active'; (res.reads || []).forEach((id) => { hl.dataEdges[`t${id}`] = 'read'; }); }
        Graph.highlight(hl);
      }
      Inspector.refreshIf('api', 'cli', 'tuples');
    }
    function proofHighlight(chains) {
      const hl = { modelNodes: {}, modelEdges: {}, dataNodes: {}, dataEdges: {}, tupleIds: [] };
      chains.forEach((c) => c.segments.forEach((sg) => { hl.dataEdges[`t${sg.tupleId}`] = 'ok'; hl.dataNodes[sg.from] = 'ok'; hl.dataNodes[sg.to] = 'ok'; hl.tupleIds.push(sg.tupleId); }));
      if (S.summaryHl) {
        hl.modelNodes = S.summaryHl.modelNodes; hl.modelEdges = S.summaryHl.modelEdges; hl.rewrites = S.summaryHl.rewrites;
        Object.entries(S.summaryHl.dataNodes || {}).forEach(([k, v]) => { if (k.includes('#') && !hl.dataNodes[k]) hl.dataNodes[k] = v; });
        // branches the resolver tried and rejected stay visible as ghosts
        Object.entries(S.summaryHl.dataEdges || {}).forEach(([k, v]) => { if (!hl.dataEdges[k]) hl.dataEdges[k] = 'ghost'; });
        Object.entries(S.summaryHl.dataNodes || {}).forEach(([k, v]) => { if (!hl.dataNodes[k]) hl.dataNodes[k] = v === 'fail' ? 'ghost' : 'read'; });
      }
      return hl;
    }
    function chainHtml(c, i, total) {
      const node = (id) => `<button class="pn" data-node="${esc(id)}" title="Focus ${esc(id)} in the data graph">${esc(id)}</button>`;
      const parts = [];
      c.segments.forEach((sg, k) => {
        if (k === 0) parts.push(node(sg.from));
        parts.push(`<button class="pe" data-edge="t${sg.tupleId}" title="${esc(sg.relation + (sg.via ? ' through the userset ' + sg.via : '') + (sg.condition ? ', if ' + sg.condition : ''))}"><i>─</i><span>${esc(sg.relation)}${sg.via ? `<small>${esc(sg.via)}</small>` : ''}${sg.condition ? '<small>⚡</small>' : ''}</span><i>→</i></button>`);
        parts.push(node(sg.to));
      });
      const derived = c.conjunct ? [] : c.derived.filter((x) => !x.viaTupleset).map((x) => `${esc(x.from)} ⇒ ${esc(x.to)}`);
      return `<div class="chain">${total > 1 ? `<span class="conj">${i === 0 ? 'both' : 'and'}</span>` : ''}${parts.join('')}${derived.length ? `<span class="derived" title="Computed usersets: holding the first relation implies the next">${derived.join(' · ')}</span>` : ''}${c.notExcluded ? `<span class="derived not">and not ${esc(c.notExcluded)}</span>` : ''}</div>`;
    }
    function renderResult() {
      const r = S.result, res = r.res, el = $('#result');
      const meta = res.trace ? `<div class="ans-meta"><span>${res.trace.reads} tuple reads</span><span>${res.trace.frames.length} ${r.type === 'check' ? 'checks' : 'expansions'}</span><span>depth ${res.trace.maxDepth}</span><span>${r.ms.toFixed(1)} ms</span></div>` : '';
      if (res.error) { el.innerHTML = `<div class="answer warn"><div class="ans-head"><span class="ans-verdict">Error</span><span class="ans-text">${esc(res.error)}</span></div></div>`; return; }
      const rel = `<code>${esc(r.q.relation)}</code>`;
      if (r.type === 'check') {
        const chains = r.chains || [];
        const why = res.allowed ? '' : (res.root && res.root.reason ? res.root.reason.replace(/^.*?( — )/, '') : '');
        el.innerHTML = `<div class="answer ${res.allowed ? 'ok' : 'fail'}">
          <div class="ans-head"><span class="ans-verdict">${res.allowed ? 'Allowed' : 'Denied'}</span><span class="ans-text"><code>${esc(r.q.user)}</code> ${res.allowed ? 'is' : 'is not'} ${article(r.q.relation)} ${rel} of <code>${esc(r.q.object)}</code></span></div>
          ${res.allowed ? `<div class="proof">${chains.map((c, i) => chainHtml(c, i, chains.length)).join('')}</div>` : why ? `<div class="ans-why">${esc(why)}</div>` : ''}
          ${meta}
          <div class="ans-actions"><button class="btn sm" id="res-step">Explain step by step</button><button class="btn sm ghost" id="res-assert">+ Assertion</button>${res.allowed && chains.length ? '<button class="btn sm ghost" id="res-copy">Copy proof</button><button class="btn sm ghost" id="res-zoom" title="Frame the proof path in the data graph">Zoom to path</button>' : ''}</div>
        </div>`;
        $('#res-assert').addEventListener('click', () => Assertions.add({ user: r.q.user, relation: r.q.relation, object: r.q.object, context: Object.keys(r.q.contextObj).length ? r.q.contextObj : undefined, expected: res.allowed }));
        const zp = $('#res-zoom'); if (zp) zp.addEventListener('click', () => { if (Graph.mode !== 'data') setGraphMode('data'); Graph.clearFocus(); setTimeout(() => Graph.fitToHighlighted(true), 60); });
        const cp = $('#res-copy'); if (cp) cp.addEventListener('click', () => copyText(`${r.q.user} ${r.q.relation} ${r.q.object}: ALLOWED\n` + chains.map((c) => (c.conjunct ? '• ' : '') + FGA.chainText(c)).join('\n'), 'Proof'));
        $$('.pn', el).forEach((b) => b.addEventListener('click', () => { if (Graph.mode !== 'data') setGraphMode('data'); Graph.focusNode(b.dataset.node); }));
        $$('.pe', el).forEach((b) => b.addEventListener('click', () => { if (Graph.mode !== 'data') setGraphMode('data'); Graph.clearFocus(); Graph.highlight({ dataEdges: { [b.dataset.edge]: 'ok' }, dataNodes: {} }, { stepping: true }); }));
      } else if (r.type === 'listObjects') {
        const n = res.objects.length;
        const verified = res.candidates.filter((c) => c.needsCheck).length;
        el.innerHTML = `<div class="answer ${n ? 'ok' : 'fail'}">
          <div class="ans-head"><span class="ans-verdict">${n} object${n === 1 ? '' : 's'}</span><span class="ans-text"><code>${esc(r.q.user)}</code> is ${article(r.q.relation)} ${rel} of ${n ? 'these' : 'no'} <code>${esc(r.q.objectType)}</code></span></div>
          <div class="result-list">${res.objects.map((o) => `<button class="chip ok" data-obj="${esc(o)}" title="Hover for the proof · click to open this Check">${esc(o)}</button>`).join('')}</div>
          <div class="ans-why">${verified ? `${res.candidates.length} candidate${res.candidates.length === 1 ? '' : 's'} from reverse expansion, ${verified} verified with Check` : n ? 'found by reverse expansion alone, no Check needed' : 'no path from this user to any such object'}</div>
          ${meta}
          <div class="ans-actions"><button class="btn sm" id="res-step">Explain step by step</button></div></div>`;
        $$('.chip[data-obj]', el).forEach((c) => { c.addEventListener('click', () => { load({ type: 'check', user: r.q.user, relation: r.q.relation, object: c.dataset.obj, context: r.q.context }); run({}); }); c.addEventListener('mouseenter', () => { if (c.dataset.proofed) return; c.dataset.proofed = '1'; const chk = FGA.check(S.effectiveModel, S.store, { user: r.q.user, relation: r.q.relation, object: c.dataset.obj, context: r.q.contextObj }); c.title = FGA.proofChains(chk.root && chk.root.proof).map(FGA.chainText).join('\n') || c.title; }); });
      } else if (r.type === 'listUsers') {
        const n = res.users.length + (res.wildcard ? 1 : 0);
        const chips = (res.wildcard ? [`<button class="chip wild" data-user="${esc(r.q.userType)}:*">${esc(r.q.userType)}:*${res.excluded.length ? ' except ' + esc(res.excluded.join(', ')) : ''}</button>`] : []).concat(res.users.map((u) => `<button class="chip ok" data-user="${esc(u)}" title="Hover for the proof · click to open this Check">${esc(u)}</button>`));
        el.innerHTML = `<div class="answer ${n ? 'ok' : 'fail'}">
          <div class="ans-head"><span class="ans-verdict">${res.wildcard ? 'Everyone' : n + (n === 1 ? ' user' : ' users')}</span><span class="ans-text">${res.wildcard ? `every <code>${esc(r.q.userType)}</code>${res.excluded.length ? ' except ' + res.excluded.length : ''} holds` : n ? `<code>${esc(r.q.userType)}${r.q.userRelation ? '#' + esc(r.q.userRelation) : ''}</code> subjects holding` : `no <code>${esc(r.q.userType)}${r.q.userRelation ? '#' + esc(r.q.userRelation) : ''}</code> holds`} ${rel} on <code>${esc(r.q.object)}</code></span></div>
          <div class="result-list">${chips.join('')}</div>
          ${meta}
          <div class="ans-actions"><button class="btn sm" id="res-step">Explain step by step</button></div></div>`;
        $$('.chip[data-user]', el).forEach((c) => { c.addEventListener('click', () => { load({ type: 'check', user: c.dataset.user, relation: r.q.relation, object: r.q.object, context: r.q.context }); run({}); }); c.addEventListener('mouseenter', () => { if (c.dataset.proofed || c.dataset.user.endsWith(':*')) return; c.dataset.proofed = '1'; const chk = FGA.check(S.effectiveModel, S.store, { user: c.dataset.user, relation: r.q.relation, object: r.q.object, context: r.q.contextObj }); c.title = FGA.proofChains(chk.root && chk.root.proof).map(FGA.chainText).join('\n') || c.title; }); });
      } else {
        el.innerHTML = `<div class="answer ok"><div class="ans-head"><span class="ans-verdict">Expand</span><span class="ans-text"><code>${esc(res.name)}</code></span></div><div class="ans-why">${esc(res.definition)} · one level of the userset tree; click a userset to expand it further</div><div class="expand-tree" id="expand-tree"></div></div>`;
        $('#expand-tree').appendChild(renderExpandNode(res.tree, 0));
      }
      const stepBtn = $('#res-step');
      if (stepBtn) stepBtn.addEventListener('click', () => { explainEl.open = true; goto(0, { scroll: true }); $('#st-play').focus(); });
    }
    function renderExpandNode(n, depth) {
      const box = document.createElement('div'); box.className = 'xt';
      const head = document.createElement('div'); head.className = 'xt-head';
      const kids = document.createElement('div'); kids.className = 'xt-kids';
      const kind = `<span class="k ${n.kind}">${n.kind === 'leaf' ? 'direct' : n.kind === 'ttu' ? 'tuple-to-userset' : n.kind}</span>`;
      const usersetBtn = (us) => { const b = document.createElement('button'); b.className = 'us'; b.textContent = us; b.title = 'Expand this userset'; b.addEventListener('click', () => { const [obj, rel] = us.split('#'); const sub = FGA.expand(S.effectiveModel, S.store, { object: obj, relation: rel }); const holder = b.parentElement; if (sub.error) { toast(sub.error); return; } const child = renderExpandNode(sub.tree, depth + 1); holder.replaceWith(child); }); return b; };
      if (n.kind === 'leaf') {
        head.innerHTML = kind;
        const list = document.createElement('div'); list.className = 'leaf-users';
        if (!n.users.length) list.innerHTML = '<span class="dim">no tuples</span>';
        n.users.forEach((u) => { const s = document.createElement('span'); if (u.userset) { s.appendChild(usersetBtn(u.user)); } else s.textContent = u.user; if (u.condition) s.append(` ⚡${u.condition}`); list.appendChild(s); });
        box.append(head, list);
        return box;
      }
      if (n.kind === 'computed') { head.innerHTML = kind; const w = document.createElement('span'); w.appendChild(usersetBtn(n.userset)); head.appendChild(w); box.appendChild(head); return box; }
      if (n.kind === 'ttu') {
        head.innerHTML = `${kind}<span class="dim">tupleset</span> <span class="us">${esc(n.tupleset)}</span> <span class="dim">→ computed</span>`;
        box.appendChild(head);
        if (!n.computed.length) { kids.innerHTML = '<span class="dim">no tupleset tuples</span>'; }
        n.computed.forEach((c) => { const w = document.createElement('div'); w.appendChild(usersetBtn(c.userset)); kids.appendChild(w); });
        box.appendChild(kids);
        return box;
      }
      head.innerHTML = kind + `<span class="dim">${esc(n.name)}</span>`;
      box.appendChild(head);
      if (n.kind === 'difference') { const b = document.createElement('div'); b.innerHTML = '<span class="dim">base</span>'; b.appendChild(renderExpandNode(n.base, depth + 1)); const s = document.createElement('div'); s.innerHTML = '<span class="dim">but not</span>'; s.appendChild(renderExpandNode(n.subtract, depth + 1)); kids.append(b, s); }
      else n.nodes.forEach((c) => kids.appendChild(renderExpandNode(c, depth + 1)));
      box.appendChild(kids);
      return box;
    }
    // ── trace tree & stepper
    const KIND_LABEL = { check: 'check', expand: 'reverse', users: 'expand', listobjects: 'ListObjects', listusers: 'ListUsers' };
    function frameLabelHtml(f) {
      return f.kind === 'check' ? `${esc(f.user)} <span class="r">${esc(f.relation)}</span> ${esc(f.object)}` : f.kind === 'listobjects' ? `${esc(f.user)} <span class="r">${esc(f.relation)}</span> ${esc(f.object.replace(':?', ''))}` : f.kind === 'listusers' ? `${esc(f.object)}#<span class="r">${esc(f.relation)}</span> → ${esc(f.user)}` : f.kind === 'users' ? `${esc(f.object)}#<span class="r">${esc(f.relation)}</span>` : esc(f.label).replace(/#([\w-]+)$/, '#<span class="r">$1</span>');
    }
    function buildTraceTree(trace) {
      const el = $('#trace');
      const ICON = { ok: '✓', fail: '✗', read: '⌕', warn: '!', skip: '–', info: '·' };
      const frameHtml = (f) => {
        const label = frameLabelHtml(f);
        const pill = f.kind === 'check' ? (f.result === true ? '<span class="pill ok">allowed</span>' : f.result === false ? `<span class="pill ${f.cycle ? 'warn' : 'fail'}">${f.cycle ? 'cycle' : f.cached ? 'cached · denied' : 'denied'}</span>` : '')
          : f.kind === 'expand' ? (f.result === true ? '<span class="pill ok">result</span>' : f.result === false ? '<span class="pill fail">dropped</span>' : '<span class="pill">expanded</span>')
          : f.kind === 'users' ? (f.result ? `<span class="pill ${f.result.users.size || f.result.wildcard ? 'ok' : 'fail'}">${f.result.wildcard ? 'everyone' : f.result.users.size + ' user' + (f.result.users.size === 1 ? '' : 's')}</span>` : '')
          : f.kind === 'listobjects' ? `<span class="pill ${f.result && f.result.length ? 'ok' : 'fail'}">${f.result ? f.result.length + ' objects' : ''}</span>`
          : f.kind === 'listusers' ? '' : '';
        const kindLabel = KIND_LABEL[f.kind] || f.kind;
        const reason = f.reason ? esc(f.reason.replace(/^(ALLOWED|DENIED) — /, '').replace(/^.*? (via|—) /, '')) : '';
        return `<div class="frame${f.parent ? '' : ' root'}" data-fid="${f.id}" data-start="${f.startIdx ?? 0}"><div class="frame-head"><span class="caret">▾</span><span class="kind">${kindLabel}</span><code>${label}</code>${pill}${reason && f.kind === 'check' ? `<span class="why">${reason}</span>` : ''}</div><div class="frame-items">${f.items.map((it) => it.event ? evHtml(it.event) : frameHtml(it.frame)).join('')}</div></div>`;
      };
      const evHtml = (e) => `<div class="ev ${e.status}${e.minor ? ' minor' : ''}" data-ei="${e.idx}"><span class="ic">${ICON[e.status] || '·'}</span><span class="t">${esc(e.text)}</span></div>`;
      const roots = trace.frames.filter((f) => !f.parent);
      el.innerHTML = `<div class="trace-head"><h3>Checks &amp; reads</h3><span class="hint"><button class="btn sm ghost toggle" id="st-detail" aria-pressed="${!!S.ui.allSteps}" title="Show every read, match and skip line, not just the checks">all steps</button><button class="btn sm ghost" id="tr-collapse">collapse sub-checks</button></span></div>` + roots.map(frameHtml).join('');
      el.classList.toggle('detailed', !!S.ui.allSteps);
      $('#st-detail').addEventListener('click', () => { S.ui.allSteps = !S.ui.allSteps; $('#st-detail').setAttribute('aria-pressed', String(S.ui.allSteps)); el.classList.toggle('detailed', S.ui.allSteps); persist(); goto(S.step, { scroll: false }); });
      $$('.frame-head', el).forEach((h) => h.addEventListener('click', (ev) => { if (ev.target.closest('code')) { const f = h.parentElement; goto(+f.dataset.start, { scroll: false }); } h.parentElement.classList.toggle('collapsed'); }));
      $$('.ev', el).forEach((e) => e.addEventListener('click', () => goto(+e.dataset.ei, { scroll: false })));
      $('#tr-collapse').addEventListener('click', () => { const fr = $$('.frame', el).filter((f) => f.querySelector('.frame')); const anyOpen = fr.some((f) => !f.classList.contains('collapsed')); $$('.frame:not(.root)', el).forEach((f) => f.classList.toggle('collapsed', anyOpen)); $('#tr-collapse').textContent = anyOpen ? 'expand sub-checks' : 'collapse sub-checks'; });
    }
    function goto(i, { scroll } = {}) {
      const r = S.result; if (!r || !r.res.trace) return;
      const evs = r.res.trace.events;
      i = Math.max(0, Math.min(evs.length - 1, i));
      S.step = i;
      const e = evs[i];
      const last = i === evs.length - 1;
      $('#st-pos').textContent = `step ${i + 1} / ${evs.length}`;
      $('#st-bar').style.width = `${((i + 1) / evs.length) * 100}%`;
      const now = $('#st-now');
      now.className = `step-now ${e.status}`;
      const ICON = { ok: '✓', fail: '✗', read: '⌕', warn: '!', skip: '–', info: '·' };
      now.innerHTML = `<span class="ic">${ICON[e.status] || '·'}</span><span class="txt">${esc(e.text)}<span class="frame-of">${esc(KIND_LABEL[e.frame.kind] || e.frame.kind)}: ${frameLabelHtml(e.frame)}${e.frame.depth ? `  (depth ${e.frame.depth})` : ''}</span>${e.detail ? `<span class="detail">${esc(e.detail)}</span>` : ''}</span>`;
      $('#st-prev').disabled = i === 0; $('#st-first').disabled = i === 0;
      $('#st-next').disabled = last; $('#st-last').disabled = last;
      const traceEl = $('#trace');
      $$('.ev', traceEl).forEach((el) => { const k = +el.dataset.ei; el.classList.toggle('future', k > i); el.classList.toggle('current', k === i); });
      $$('.frame', traceEl).forEach((el) => { el.classList.toggle('future', +el.dataset.start > i); el.classList.toggle('current-frame', +el.dataset.fid === e.frame.id); });
      const cur = traceEl.querySelector('.ev.current');
      if (cur) { let p = cur.parentElement; while (p && p !== traceEl) { if (p.classList.contains('frame')) p.classList.remove('collapsed'); p = p.parentElement; } if (scroll !== false) cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      if (last) Graph.highlight(r.type === 'check' && r.res.allowed && r.proofHl && !S.ui.allSteps ? r.proofHl : S.summaryHl, { stepping: false });
      else {
        const hl = { modelNodes: Object.assign({}, e.hl.modelNodes || {}), modelEdges: Object.assign({}, e.hl.modelEdges || {}), dataNodes: Object.assign({}, e.hl.dataNodes || {}), dataEdges: Object.assign({}, e.hl.dataEdges || {}), rewrites: e.hl.rewrites || null };
        if (e.frame.modelNode && !hl.modelNodes[e.frame.modelNode]) hl.modelNodes[e.frame.modelNode] = 'active';
        if (e.frame.object && !e.frame.object.endsWith(':?') && !hl.dataNodes[e.frame.object]) hl.dataNodes[e.frame.object] = 'active';
        const slotOf = (f) => (f.modelNode && f.object && !f.object.endsWith(':?') ? `${f.object}#${f.modelNode.split('#')[1]}` : null);
        const slot = slotOf(e.frame);
        if (slot && !hl.dataNodes[slot]) hl.dataNodes[slot] = e.type === 'exit' ? (e.status === 'ok' ? 'ok' : e.status === 'fail' ? 'fail' : 'read') : 'active';
        let p = e.frame.parent; while (p) { if (p.modelNode && !hl.modelNodes[p.modelNode]) hl.modelNodes[p.modelNode] = 'read'; if (p.object && !p.object.endsWith(':?') && !hl.dataNodes[p.object]) hl.dataNodes[p.object] = 'read'; const ps = slotOf(p); if (ps && !hl.dataNodes[ps]) hl.dataNodes[ps] = 'read'; p = p.parent; }
        Graph.highlight(hl, { stepping: true });
      }
      Inspector.highlightTuples(last ? (r.type === 'check' && r.res.allowed && r.proofHl ? r.proofHl.tupleIds : S.summaryHl.tupleIds) : (e.hl.tupleIds || []), last);
      $('#trace').classList.toggle('stepping', !last);
    }
    function stopPlay() { if (S.playing) { clearInterval(S.playing); S.playing = null; $('#st-play').textContent = '▶ Play'; } }
    function play() {
      if (S.playing) { stopPlay(); return; }
      const r = S.result; if (!r || !r.res.trace) return;
      explainEl.open = true;
      if (S.step >= r.res.trace.events.length - 1) goto(0, { scroll: true });
      $('#st-play').textContent = '⏸ Pause';
      const tick = () => { if (!S.result || S.step >= S.result.res.trace.events.length - 1) { stopPlay(); return; } goto(S.step + 1, { scroll: true }); };
      S.playing = setInterval(tick, +$('#st-speed').value);
    }
    $('#st-speed').addEventListener('change', () => { if (S.playing) { stopPlay(); play(); } });
    $('#st-first').addEventListener('click', () => { stopPlay(); goto(0, { scroll: true }); });
    $('#st-prev').addEventListener('click', () => { stopPlay(); goto(S.step - 1, { scroll: true }); });
    $('#st-next').addEventListener('click', () => { stopPlay(); goto(S.step + 1, { scroll: true }); });
    $('#st-last').addEventListener('click', () => { stopPlay(); goto(1e9, { scroll: true }); });
    $('#st-play').addEventListener('click', play);
    $$('#q-type button').forEach((b) => b.addEventListener('click', () => setType(b.dataset.q)));
    $('#q-form').addEventListener('submit', (e) => { e.preventDefault(); run({}); });
    $('#q-context').addEventListener('input', () => { q.context = $('#q-context').value; saveQuery(); if (S.ui.live) runSoon(); });
    $('#q-ctx-tuples').addEventListener('input', () => { q.ctxTuples = $('#q-ctx-tuples').value; saveQuery(); recomputeSoon(); });
    $('#q-live').addEventListener('click', () => { S.ui.live = !S.ui.live; $('#q-live').setAttribute('aria-pressed', String(S.ui.live)); persist(); if (S.ui.live) run({ auto: true }); });
    $('#q-adv-toggle').addEventListener('click', () => { const adv = $('#q-adv'); adv.hidden = !adv.hidden; $('#q-adv-toggle').setAttribute('aria-expanded', String(!adv.hidden)); if (!adv.hidden) $('#q-context').focus(); });
    explainEl.addEventListener('toggle', () => { if (!explainEl.open) { stopPlay(); if (S.result && S.result.res.trace) goto(1e9, { scroll: false }); } });
    function prefill(partial) { Object.assign(q, partial); load(q); saveQuery(); run({ auto: true }); }
    function renderTryChips(st) {
      const el = $('#try-chips');
      const qs = st.queries || [];
      if (!qs.length) { el.hidden = true; el.innerHTML = ''; return; }
      el.hidden = false;
      el.innerHTML = `<span class="lbl">Try</span>` + qs.map((x, i) => `<button class="chip" data-i="${i}" title="${esc(x.note || '')}"><span class="k">${{ check: 'Check', listObjects: 'ListObjects', listUsers: 'ListUsers', expand: 'Expand' }[x.type]}</span>${esc(x.type === 'listObjects' ? `${x.user} ${x.relation} ${x.objectType}` : x.type === 'listUsers' ? `${x.object}#${x.relation} → ${x.userType}` : x.type === 'expand' ? `${x.object}#${x.relation}` : `${x.user} ${x.relation} ${x.object}`)}</button>`).join('');
      $$('.chip', el).forEach((c) => c.addEventListener('click', () => { const x = qs[+c.dataset.i]; load(Object.assign({}, x, { context: x.context ? JSON.stringify(x.context) : '' })); saveQuery(); run({}); if (x.note) toast(x.note); }));
    }
    return { load, run, prefill, goto, play, stopPlay, renderTryChips, onModelChanged, getCtxTuplesText: () => q.ctxTuples || '', contextObj: () => { const c = parseContext(); return c.ok ? c.value : {}; }, get q() { return q; } };
  })();

  // ───────────────────────── assertions ─────────────────────────
  const Assertions = (() => {
    let results = [];
    function render() {
      const st = activeStore(); if (!st) return;
      const list = $('#assert-list');
      $('#assert-count').textContent = st.assertions.length || '';
      if (!st.assertions.length) { list.innerHTML = '<div class="insp-note" style="padding:12px">No assertions yet. Assertions are Check expectations stored with a model (OpenFGA: Write Assertions). Add one above, or use “+ Add as assertion” after running a Check.</div>'; }
      else list.innerHTML = st.assertions.map((a, i) => { const r = results[i]; return `<div class="assert-row"><span class="st ${r ? (r.pass ? 'pass' : 'fail') : ''}" title="${r ? (r.pass ? 'passes' : 'fails: got ' + r.actual) : ''}">${r ? (r.pass ? '✓' : '✗') : '·'}</span><code title="${esc(a.user + ' ' + a.relation + ' ' + a.object)}">${esc(a.user)} <span style="color:var(--rel)">${esc(a.relation)}</span> ${esc(a.object)}${a.context ? ' <span style="color:var(--fg-3)">⚡' + esc(JSON.stringify(a.context)) + '</span>' : ''}</code><button class="btn sm ghost exp" data-i="${i}" title="Toggle expectation">expect ${a.expected ? '✓ allowed' : '✗ denied'}</button><span style="display:flex;gap:4px"><button class="btn sm" data-run="${i}" title="Load into the query lab">▶</button><button class="btn sm ghost danger" data-del="${i}" title="Remove">✕</button></span></div>`; }).join('');
      $$('[data-run]', list).forEach((b) => b.addEventListener('click', () => { const a = st.assertions[+b.dataset.run]; Query.load({ type: 'check', user: a.user, relation: a.relation, object: a.object, context: a.context ? JSON.stringify(a.context) : '' }); Query.run({}); setEditorTab('dsl'); }));
      $$('[data-del]', list).forEach((b) => b.addEventListener('click', () => { st.assertions.splice(+b.dataset.del, 1); runAll(); persist(); }));
      $$('.exp', list).forEach((b) => b.addEventListener('click', () => { const a = st.assertions[+b.dataset.i]; a.expected = !a.expected; runAll(); persist(); }));
      const pass = results.filter((r) => r && r.pass).length, fail = results.filter((r) => r && !r.pass).length;
      $('#assert-summary').innerHTML = st.assertions.length ? `<span class="pass">${pass} pass</span><span class="fail">${fail} fail</span><span style="color:var(--fg-3)">· re-run automatically on every edit · tied to ${draftMatchesLatest(st) ? 'model ' + shortId(latestModel(st).id) : 'the live draft'}</span><span style="margin-left:auto;display:flex;gap:6px"><button class="btn sm" id="as-copy-yaml">Copy as .fga.yaml tests</button></span>` : '';
      const cp = $('#as-copy-yaml'); if (cp) cp.addEventListener('click', () => copyText(Inspector.testsYaml(), 'Test file'));
    }
    function runAll() {
      const st = activeStore(); if (!st) return;
      results = st.assertions.map((a) => { if (!S.effectiveModel) return null; const r = FGA.check(S.effectiveModel, S.store, { user: a.user, relation: a.relation, object: a.object, context: a.context || {} }); return { pass: r.allowed === !!a.expected, actual: r.allowed }; });
      render();
    }
    function add(a) {
      const st = activeStore(); if (!st) return;
      if (st.assertions.some((x) => x.user === a.user && x.relation === a.relation && x.object === a.object && JSON.stringify(x.context || null) === JSON.stringify(a.context || null))) { toast('That assertion already exists'); setEditorTab('assertions'); return; }
      st.assertions.push(a); runAll(); persist(); setEditorTab('assertions'); toast('Assertion added');
    }
    $('#as-add').addEventListener('click', () => {
      const user = $('#as-user').value.trim(), relation = $('#as-rel').value.trim(), object = $('#as-obj').value.trim();
      if (!user || !relation || !object) { toast('Fill in user, relation and object'); return; }
      try { FGA.parseUserRef(user); FGA.parseObjectRef(object); } catch (e) { toast(e.message); return; }
      add({ user, relation, object, expected: $('#as-exp').value === 'true' });
      $('#as-user').value = ''; $('#as-rel').value = ''; $('#as-obj').value = '';
    });
    return { runAll, add, render };
  })();

  // ───────────────────────── store inspector ─────────────────────────
  const Inspector = (() => {
    const body = $('#insp-body');
    const filter = { user: '', relation: '', object: '' };
    const modelJson = () => { const st = activeStore(); const l = st && latestModel(st); return FGA.modelToJSON(S.effectiveModel || S.model, l && draftMatchesLatest(st) ? l.id : undefined); };
    const modelIdForApi = () => { const st = activeStore(); const l = latestModel(st); return draftMatchesLatest(st) ? l.id : (l ? l.id + '  // ⚠ draft differs from this written model' : '(write a model first)'); };
    function refresh() {
      const st = activeStore(); if (!st) return;
      $('#insp-store-id').textContent = st.id;
      $('#insp-store-id').title = `store id ${st.id} · created ${fmtTime(st.created_at)}`;
      $('#insp-meta').innerHTML = `<span>${S.tuplesParsed.tuples.length} tuples</span><span>${st.models.length} model version${st.models.length === 1 ? '' : 's'}</span><span>updated ${ago(st.updated_at)}</span><button class="btn sm ghost danger" id="store-delete">Delete store</button>`;
      $('#store-delete').addEventListener('click', confirmDeleteStore);
      $$('#insp-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.itab === S.ui.inspTab)));
      const fn = { tuples, models, types, json, changes, api, cli }[S.ui.inspTab] || tuples;
      body.innerHTML = '';
      body.appendChild(fn(st));
    }
    function refreshIf(...tabs) { if (tabs.includes(S.ui.inspTab)) refresh(); }
    function el(html) { const d = document.createElement('div'); d.className = 'insp-pane'; d.innerHTML = html; return d; }
    function codeBlock(title, meta, text, copyLabel) {
      const id = 'cb' + Math.random().toString(36).slice(2, 8);
      return `<div class="api-item"><div class="code-title"><span>${esc(title)} ${meta ? `<span class="m">${esc(meta)}</span>` : ''}</span><button class="btn sm ghost" data-copy="${id}">Copy</button></div><div class="code-block"><pre class="code" id="${id}">${esc(text)}</pre></div></div>`;
    }
    function wireCopies(root) { $$('[data-copy]', root).forEach((b) => b.addEventListener('click', () => copyText($('#' + b.dataset.copy).textContent, 'Copied'))); }
    function tuples(st) {
      const rows = S.store.tuples.filter((t) => !t.contextual).filter((t) => (!filter.user || t.user.raw.includes(filter.user)) && (!filter.relation || t.relation === filter.relation || t.relation.includes(filter.relation)) && (!filter.object || t.object.raw.includes(filter.object)));
      const readBody = { tuple_key: Object.fromEntries(Object.entries(filter).filter(([, v]) => v)) };
      const d = el(`<div class="filter-row"><input class="ctl" id="f-user" placeholder="user (e.g. user:anne or group:eng#member)" value="${esc(filter.user)}"><input class="ctl" id="f-rel" placeholder="relation" value="${esc(filter.relation)}"><input class="ctl" id="f-obj" placeholder="object (e.g. doc:roadmap)" value="${esc(filter.object)}"><span class="insp-note" style="white-space:nowrap">Read API filter · ${rows.length}/${S.tuplesParsed.tuples.length}</span></div>
        ${Object.keys(readBody.tuple_key).length ? `<div class="insp-note mono">POST /stores/${esc(st.id)}/read  ${esc(JSON.stringify(readBody))}</div>` : ''}
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>user</th><th>relation</th><th>object</th><th>condition</th><th></th></tr></thead><tbody>
        ${rows.map((t) => `<tr data-tid="${t.id}"><td class="muted">${t.id + 1}</td><td>${esc(t.user.raw)}</td><td>${esc(t.relation)}</td><td>${esc(t.object.raw)}</td><td class="muted">${t.condition ? esc(t.condition.name + ' ' + JSON.stringify(t.condition.context || {})) : ''}</td><td><button class="btn ghost danger" data-del-line="${t.line}" title="Delete this tuple (removes the line)">delete</button></td></tr>`).join('')}
        ${S.store.tuples.filter((t) => t.contextual).map((t) => `<tr data-tid="${t.id}"><td class="muted">ctx</td><td>${esc(t.user.raw)}</td><td>${esc(t.relation)}</td><td>${esc(t.object.raw)}</td><td class="muted">contextual (this query only)</td><td></td></tr>`).join('')}
        ${S.tuplesParsed.rejected.map((r) => `<tr class="rej"><td class="muted">L${r.line}</td><td>${esc(r.tuple.user.raw)}</td><td>${esc(r.tuple.relation)}</td><td>${esc(r.tuple.object.raw)}</td><td colspan="2">rejected — ${esc(r.message)}</td></tr>`).join('')}
        </tbody></table></div>${!S.tuplesParsed.tuples.length ? '<div class="insp-note">No tuples. Write some in the Tuples tab.</div>' : ''}`);
      [['f-user', 'user'], ['f-rel', 'relation'], ['f-obj', 'object']].forEach(([id, k]) => $('#' + id, d).addEventListener('input', debounce((e) => { filter[k] = e.target.value.trim(); const pos = e.target.selectionStart; refresh(); const again = $('#' + id); if (again) { again.focus(); again.setSelectionRange(pos, pos); } }, 200)));
      $$('tr[data-tid]', d).forEach((tr) => tr.addEventListener('click', (ev) => { if (ev.target.closest('button')) return; const id = +tr.dataset.tid; const t = S.store.byId(id); if (Graph.mode !== 'data') setGraphMode('data'); if (t) Graph.focusNode(t.object.raw); $$('tr.hl-ok', d).forEach((x) => x.classList.remove('hl-ok')); tr.classList.add('hl-ok'); }));
      $$('[data-del-line]', d).forEach((b) => b.addEventListener('click', () => { const line = +b.dataset.delLine; const lines = st.tuplesText.split('\n'); lines.splice(line - 1, 1); st.tuplesText = lines.join('\n'); tuplesEditor.value = st.tuplesText; recompute(); toast('Tuple deleted'); }));
      return d;
    }
    function models(st) {
      const d = el(`<div class="insp-note">Authorization models are immutable: every <b>Write model</b> creates a new version with its own id, and older versions stay queryable. OpenFGA resolves queries against the latest model unless <code>authorization_model_id</code> is passed.</div>
        <div class="model-list">${st.models.slice().reverse().map((m, i) => `<div class="model-row"><code>${esc(m.id)}</code>${i === 0 ? '<span class="latest">latest</span>' : ''}<span class="when">v${st.models.length - i} · ${fmtTime(m.created_at)} · ${m.types} types, ${m.relations} relations</span><span class="acts"><button class="btn sm" data-load="${esc(m.id)}">Load into editor</button><button class="btn sm ghost" data-diff="${esc(m.id)}">Diff vs draft</button><button class="btn sm ghost" data-copyid="${esc(m.id)}">Copy id</button></span></div>`).join('')}</div>
        <div class="insp-note" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px"><span>Move this store to another browser or share it:</span><button class="btn sm" id="st-export">Copy store as JSON</button><button class="btn sm ghost" id="st-import">Import store from JSON…</button></div>
        <div id="st-import-box" hidden><textarea class="ctl" id="st-import-text" style="width:100%;min-height:90px;font-family:var(--font-mono);font-size:11.5px" placeholder='paste a store JSON copied from this playground'></textarea><div style="display:flex;gap:6px;margin-top:6px"><button class="btn sm primary" id="st-import-ok">Create store</button><button class="btn sm ghost" id="st-import-cancel">Cancel</button></div></div>`);
      $$('[data-diff]', d).forEach((b) => b.addEventListener('click', () => { S.ui.compareId = b.dataset.diff; setGraphMode('schema'); persist(); recompute(); toast(`Schema view shows the draft vs model ${shortId(b.dataset.diff)}`); }));
      $('#st-export', d).addEventListener('click', () => copyText(JSON.stringify({ playground: 'openfga-visual-playground', version: 1, store: { name: st.name, draftDsl: st.draftDsl, tuplesText: st.tuplesText, models: st.models, assertions: st.assertions, queries: st.queries, changes: st.changes, pins: st.pins, collapsed: st.collapsed } }, null, 2), 'Store JSON'));
      $('#st-import', d).addEventListener('click', () => { $('#st-import-box').hidden = false; $('#st-import-text').focus(); });
      $('#st-import-cancel', d).addEventListener('click', () => { $('#st-import-box').hidden = true; });
      $('#st-import-ok', d).addEventListener('click', () => {
        try {
          const j = JSON.parse($('#st-import-text').value); const src = j.store || j;
          if (!src || typeof src.draftDsl !== 'string') throw new Error('not a store export');
          const ns = makeStore((src.name || 'Imported store') + '', { dsl: src.draftDsl, tuples: src.tuplesText || '', assertions: src.assertions || [], queries: src.queries || [] });
          if (Array.isArray(src.models) && src.models.length) ns.models = src.models.map((m) => Object.assign({}, m));
          if (Array.isArray(src.changes) && src.changes.length) ns.changes = src.changes;
          if (src.pins) ns.pins = src.pins; if (src.collapsed) ns.collapsed = src.collapsed;
          S.stores.push(ns); switchStore(ns.id); toast(`Imported store “${ns.name}”`);
        } catch (e) { toast(`Could not import: ${e.message}`); }
      });
      $$('[data-load]', d).forEach((b) => b.addEventListener('click', () => { const m = st.models.find((x) => x.id === b.dataset.load); st.draftDsl = m.dsl; dslEditor.value = m.dsl; recompute(); setEditorTab('dsl'); toast(`Loaded model ${shortId(m.id)} into the editor`); }));
      $$('[data-copyid]', d).forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copyid, 'Model id copied')));
      return d;
    }
    function types() {
      const m = S.effectiveModel;
      if (!m) return el('<div class="insp-note">No valid model.</div>');
      const d = el(`<div class="types-grid">${m.types.map((t) => `<div class="type-card" style="--c:${Graph.colorOf(t.name)}"><div class="tc-head"><i></i>type ${esc(t.name)}<span style="margin-left:auto;font-family:var(--font-body);font-weight:400;font-size:11.5px;color:var(--fg-3)">${S.store.objectsOfType(t.name).length} objects in store</span></div>${t.relations.length ? t.relations.map((r) => `<div class="tc-rel"><span class="n">${esc(r.name)}</span><span class="d">${esc(FGA.describeRewrite(r.rewrite))}${r.directTypes.length ? '' : '  <em style="color:var(--fg-3)">(computed only)</em>'}</span></div>`).join('') : '<div class="tc-rel"><span class="d" style="grid-column:1/-1;color:var(--fg-3)">no relations — a subject type</span></div>'}</div>`).join('')}
        ${m.conditions.length ? `<div class="type-card"><div class="tc-head">conditions</div>${m.conditions.map((c) => `<div class="tc-rel"><span class="n">${esc(c.name)}</span><span class="d">(${esc(c.params.map((p) => p.name + ': ' + p.type).join(', '))}) → ${esc(c.expression)}</span></div>`).join('')}</div>` : ''}</div>`);
      return d;
    }
    function json() { const d = el(codeBlock('Authorization model (API JSON)', 'GET /stores/{store_id}/authorization-models/{id}', pretty({ authorization_model: modelJson() }))); wireCopies(d); return d; }
    function changes(st) {
      const n = st.changes.length;
      const pos = S.timeTravel ? S.timeTravel.idx : n;
      const d = el(`<div class="insp-note" style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><span>Tuple change log (OpenFGA: <code>GET /stores/{id}/changes</code>). Newest first.</span><span style="display:flex;gap:6px"><button class="btn sm ghost" id="ch-clear">Clear log</button></span></div>
        ${n ? `<div class="replay"><span class="lbl">Replay</span><input type="range" id="ch-range" min="0" max="${n}" value="${pos}" aria-label="Replay the change log up to this point"><span class="pos">${pos} / ${n}</span><button class="btn sm" id="ch-now" ${S.timeTravel ? '' : 'disabled'}>Back to now</button><span class="hint">drag to see the graph and the current query at any point in the log</span></div>` : ''}
        <div>${st.changes.map((c, i) => ({ c, i })).reverse().map(({ c, i }) => `<div class="changes-row${i >= pos ? ' future' : ''}" data-i="${i}"><span class="op ${c.op}">${c.op.toUpperCase()}</span><span>${esc(tupleLine(c.tuple))}</span><span class="when">${fmtTime(c.at)}</span></div>`).join('') || '<div class="insp-note">No changes recorded yet.</div>'}</div>`);
      $('#ch-clear', d).addEventListener('click', () => { st.changes = []; S.timeTravel = null; persist(); recompute(); });
      const r = $('#ch-range', d); if (r) r.addEventListener('input', (e) => setTimeTravel(+e.target.value));
      const now = $('#ch-now', d); if (now) now.addEventListener('click', () => setTimeTravel(null));
      $$('.changes-row', d).forEach((row) => row.addEventListener('click', () => setTimeTravel(+row.dataset.i + 1)));
      return d;
    }
    function tupleKeys() { return S.tuplesParsed.tuples.map(tupleJSON); }
    function lastQueryCall(st) {
      const r = S.result; if (!r) return null;
      const mid = modelIdForApi();
      const ctxT = S.ctxTuples.tuples.length ? { contextual_tuples: { tuple_keys: S.ctxTuples.tuples.map(tupleJSON) } } : {};
      const context = Object.keys(r.q.contextObj || {}).length ? { context: r.q.contextObj } : {};
      if (r.type === 'check') return { title: 'Check', path: `POST /stores/${st.id}/check`, body: Object.assign({ tuple_key: { user: r.q.user, relation: r.q.relation, object: r.q.object } }, ctxT, context, { authorization_model_id: mid }), response: r.res.error ? { code: 'validation_error', message: r.res.error } : { allowed: r.res.allowed, resolution: '' } };
      if (r.type === 'listObjects') return { title: 'ListObjects', path: `POST /stores/${st.id}/list-objects`, body: Object.assign({ type: r.q.objectType, relation: r.q.relation, user: r.q.user }, ctxT, context, { authorization_model_id: mid }), response: r.res.error ? { code: 'validation_error', message: r.res.error } : { objects: r.res.objects } };
      if (r.type === 'listUsers') {
        const [type, id] = r.q.object.split(/:(.+)/);
        const users = (r.res.users || []).map((u) => { if (u.includes('#')) { const [obj, rel] = u.split('#'); const [t, i] = obj.split(/:(.+)/); return { userset: { type: t, id: i, relation: rel } }; } const [t, i] = u.split(/:(.+)/); return { object: { type: t, id: i } }; });
        if (r.res.wildcard) users.unshift({ wildcard: { type: r.q.userType } });
        return { title: 'ListUsers', path: `POST /stores/${st.id}/list-users`, body: Object.assign({ object: { type, id }, relation: r.q.relation, user_filters: [r.q.userRelation ? { type: r.q.userType, relation: r.q.userRelation } : { type: r.q.userType }] }, ctxT, context, { authorization_model_id: mid }), response: r.res.error ? { code: 'validation_error', message: r.res.error } : Object.assign({ users }, r.res.excluded && r.res.excluded.length ? { excluded_users: r.res.excluded.map((u) => { const [t, i] = u.split(/:(.+)/); return { object: { type: t, id: i } }; }) } : {}) };
      }
      return { title: 'Expand', path: `POST /stores/${st.id}/expand`, body: { tuple_key: { object: r.q.object, relation: r.q.relation }, authorization_model_id: mid }, response: r.res.error ? { code: 'validation_error', message: r.res.error } : FGA.expandTreeToJSON(r.res.tree) };
    }
    function api(st) {
      const l = latestModel(st);
      const mid = modelIdForApi();
      const lq = lastQueryCall(st);
      const d = el(`<div class="insp-note">The HTTP calls that would reproduce this store on an OpenFGA server (<code>/stores/{store_id}/…</code>). Bodies are built from the current state.</div><div class="api-list">
        ${codeBlock('1 · Create store', 'POST /stores', `${pretty({ name: st.name })}\n\n→ 201\n${pretty({ id: st.id, name: st.name, created_at: st.created_at, updated_at: st.updated_at })}`)}
        ${codeBlock('2 · Write authorization model', `POST /stores/${st.id}/authorization-models`, `${pretty(FGA.modelToJSON(S.effectiveModel || S.model))}\n\n→ 201\n${pretty({ authorization_model_id: l ? l.id : '(not written yet)' })}`)}
        ${codeBlock('3 · Write relationship tuples', `POST /stores/${st.id}/write`, `${pretty({ writes: { tuple_keys: tupleKeys() }, authorization_model_id: mid })}\n\n→ 200\n{}`)}
        ${st.assertions.length ? codeBlock('4 · Write assertions', `PUT /stores/${st.id}/assertions/${l ? l.id : '{model_id}'}`, `${pretty({ assertions: st.assertions.map((a) => Object.assign({ tuple_key: { user: a.user, relation: a.relation, object: a.object }, expectation: !!a.expected }, a.context ? { context: a.context } : {})) })}\n\n→ 204`) : ''}
        ${lq ? codeBlock(`${st.assertions.length ? 5 : 4} · Last query: ${lq.title}`, lq.path, `${pretty(lq.body)}\n\n→ 200\n${pretty(lq.response)}`) : '<div class="insp-note">Run a query to see its request and response here.</div>'}
      </div>`);
      wireCopies(d);
      return d;
    }
    function testsYaml() {
      const st = activeStore();
      const y = [];
      y.push(`# OpenFGA CLI test file — run with: fga model test --tests store.fga.yaml`);
      y.push(`name: ${st.name}`);
      y.push(`model: |`);
      st.draftDsl.trimEnd().split('\n').forEach((l) => y.push(`  ${l}`));
      y.push(`tuples:`);
      S.tuplesParsed.tuples.forEach((t) => { y.push(`  - user: ${t.user.raw}`); y.push(`    relation: ${t.relation}`); y.push(`    object: ${t.object.raw}`); if (t.condition) { y.push(`    condition:`); y.push(`      name: ${t.condition.name}`); if (t.condition.context && Object.keys(t.condition.context).length) { y.push(`      context:`); Object.entries(t.condition.context).forEach(([k, v]) => y.push(`        ${k}: ${JSON.stringify(v)}`)); } } });
      y.push(`tests:`);
      y.push(`  - name: assertions`);
      y.push(`    check:`);
      const groups = new Map();
      st.assertions.forEach((a) => { const k = `${a.user}|${a.object}|${JSON.stringify(a.context || null)}`; if (!groups.has(k)) groups.set(k, { a, rels: {} }); groups.get(k).rels[a.relation] = !!a.expected; });
      groups.forEach(({ a, rels }) => { y.push(`      - user: ${a.user}`); y.push(`        object: ${a.object}`); if (a.context) { y.push(`        context:`); Object.entries(a.context).forEach(([k, v]) => y.push(`          ${k}: ${JSON.stringify(v)}`)); } y.push(`        assertions:`); Object.entries(rels).forEach(([r, v]) => y.push(`          ${r}: ${v}`)); });
      if (!groups.size) y.push(`      [] # add assertions in the Assertions tab`);
      return y.join('\n');
    }
    function cli(st) {
      const r = S.result;
      let qcmd = '';
      if (r) {
        const ctx = Object.keys(r.q.contextObj || {}).length ? ` --context '${JSON.stringify(r.q.contextObj)}'` : '';
        qcmd = r.type === 'check' ? `fga query check ${r.q.user} ${r.q.relation} ${r.q.object}${ctx}`
          : r.type === 'listObjects' ? `fga query list-objects ${r.q.user} ${r.q.relation} ${r.q.objectType}${ctx}`
          : r.type === 'listUsers' ? `fga query list-users --object ${r.q.object} --relation ${r.q.relation} --user-filter ${r.q.userType}${r.q.userRelation ? '#' + r.q.userRelation : ''}${ctx}`
          : `fga query expand ${r.q.relation} ${r.q.object}`;
      }
      const d = el(`<div class="insp-note">Equivalent <code>fga</code> CLI session (OpenFGA CLI). Save the DSL as <code>model.fga</code> and the tuples as <code>tuples.yaml</code> or write them one by one.</div><div class="api-list">
        ${codeBlock('Shell', 'fga', [`fga store create --name "${st.name}"`, `export FGA_STORE_ID=${st.id}`, ``, `fga model write --store-id $FGA_STORE_ID --file model.fga`, `# → authorization_model_id ${latestModel(st) ? latestModel(st).id : '…'}`, ``, ...S.tuplesParsed.tuples.slice(0, 12).map((t) => `fga tuple write --store-id $FGA_STORE_ID ${t.user.raw} ${t.relation} ${t.object.raw}${t.condition ? ` --condition-name ${t.condition.name}${t.condition.context && Object.keys(t.condition.context).length ? ` --condition-context '${JSON.stringify(t.condition.context)}'` : ''}` : ''}`), ...(S.tuplesParsed.tuples.length > 12 ? [`# … ${S.tuplesParsed.tuples.length - 12} more (or: fga tuple write --store-id $FGA_STORE_ID --file tuples.yaml)`] : []), ``, qcmd ? `${qcmd} --store-id $FGA_STORE_ID` : `# run a query in the Query lab to see its CLI form`, ``, `fga model test --tests store.fga.yaml`].join('\n'))}
        ${codeBlock('store.fga.yaml', 'fga model test', testsYaml())}
      </div>`);
      wireCopies(d);
      return d;
    }
    function highlightTuples(ids, ok) {
      if (S.ui.inspTab !== 'tuples') return;
      const set = new Set((ids || []).map(Number));
      $$('tr[data-tid]', body).forEach((tr) => { const on = set.has(+tr.dataset.tid); tr.classList.toggle('hl', on && !ok); tr.classList.toggle('hl-ok', on && !!ok); });
    }
    $$('#insp-tabs button').forEach((b) => b.addEventListener('click', () => { S.ui.inspTab = b.dataset.itab; persist(); refresh(); }));
    return { refresh, refreshIf, highlightTuples, testsYaml };
  })();

  // ───────────────────────── examples ─────────────────────────
  function renderExamples() {
    const wrap = $('#examples');
    $$('.example-card', wrap).forEach((c) => c.remove());
    FGA_EXAMPLES.forEach((ex) => {
      const existing = S.stores.find((s) => s.exampleId === ex.id);
      const card = document.createElement('div');
      card.className = 'example-card' + (existing && existing.id === S.activeStoreId ? ' active' : '');
      card.innerHTML = `<h3>${esc(ex.name)}${existing && existing.id === S.activeStoreId ? '<span class="tag" style="color:var(--ok);border-color:var(--ok)">open</span>' : ''}</h3><p>${esc(ex.blurb)}</p><div class="tags">${ex.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div><div class="row"><span class="hint">${ex.dsl.split('\n').filter((l) => /^\s*define/.test(l)).length} relations · ${ex.tuples.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length} tuples · ${ex.assertions.length} assertions</span><span style="display:flex;gap:6px">${existing ? `<button class="btn sm" data-open="${ex.id}">Open store</button><button class="btn sm ghost" data-fresh="${ex.id}" title="Create a new store from the original example">Fresh copy</button>` : `<button class="btn sm primary" data-fresh="${ex.id}">Create store</button>`}</span></div>`;
      wrap.appendChild(card);
    });
    $$('[data-open]', wrap).forEach((b) => b.addEventListener('click', () => { const st = S.stores.find((s) => s.exampleId === b.dataset.open); switchStore(st.id); setEditorTab('dsl'); }));
    $$('[data-fresh]', wrap).forEach((b) => b.addEventListener('click', () => { const ex = FGA_EXAMPLES.find((x) => x.id === b.dataset.fresh); const n = S.stores.filter((s) => s.exampleId === ex.id).length; const st = makeStore(n ? `${ex.name} (${n + 1})` : ex.name, { dsl: ex.dsl, tuples: ex.tuples, assertions: ex.assertions, queries: ex.queries, exampleId: ex.id }); S.stores.push(st); switchStore(st.id); setEditorTab('dsl'); toast(`Created store “${st.name}” with model v1 written`); }));
  }

  // ───────────────────────── stores UI ─────────────────────────
  function renderStoreSelect() {
    const sel = $('#store-select');
    sel.innerHTML = S.stores.map((s) => `<option value="${esc(s.id)}"${s.id === S.activeStoreId ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  }
  function switchStore(id) {
    Query.stopPlay();
    S.timeTravel = null;
    S.activeStoreId = id;
    const st = activeStore();
    S.lastGoodModel = null; S.result = null; S.summaryHl = null;
    // Make the new store's model current before the query fields are rendered, so a saved
    // ListObjects/ListUsers type survives the switch (its <select> is filled from the model).
    const pre = FGA.parseDSL(st.draftDsl);
    if (!pre.errors.length && pre.model.types.length) { S.model = pre.model; S.lastGoodModel = pre.model; S.effectiveModel = pre.model; }
    renderStoreSelect();
    dslEditor.value = st.draftDsl;
    tuplesEditor.value = st.tuplesText;
    Query.load(st.query || defaultQuery(st));
    Query.renderTryChips(st);
    $('#result').innerHTML = ''; $('#stepper').hidden = true; $('#trace').innerHTML = '';
    recompute();
    Query.run({ auto: true });
    renderExamples();
    persist();
  }
  function defaultQuery(st) {
    const q0 = (st.queries || [])[0];
    if (q0) return Object.assign({}, q0, { context: q0.context ? JSON.stringify(q0.context) : '' });
    const tp = FGA.parseTuples(st.tuplesText, FGA.parseDSL(st.draftDsl).model).tuples;
    const t = tp.find((x) => !x.user.relation && !x.user.wildcard) || tp[0];
    return t ? { type: 'check', user: t.user.raw, relation: t.relation, object: t.object.raw } : { type: 'check' };
  }
  function confirmDeleteStore() {
    const st = activeStore(); if (!st) return;
    const meta = $('#insp-meta');
    meta.innerHTML = `<span class="inline-confirm">Delete “${esc(st.name)}” and its ${S.tuplesParsed.tuples.length} tuples? <button class="btn sm danger" id="del-yes">Delete</button><button class="btn sm ghost" id="del-no">Keep</button></span>`;
    $('#del-no').addEventListener('click', () => Inspector.refresh());
    $('#del-yes').addEventListener('click', () => {
      S.stores = S.stores.filter((s) => s.id !== st.id);
      if (!S.stores.length) S.stores.push(makeStore('My store'));
      switchStore(S.stores[S.stores.length - 1].id);
      toast(`Deleted store “${st.name}”`);
    });
  }
  $('#store-select').addEventListener('change', (e) => switchStore(e.target.value));
  $('#btn-new-store').addEventListener('click', () => { $('#store-new').classList.add('open'); $('#btn-new-store').hidden = true; $('#store-new-name').value = ''; $('#store-new-name').focus(); });
  const closeNew = () => { $('#store-new').classList.remove('open'); $('#btn-new-store').hidden = false; };
  $('#store-new-cancel').addEventListener('click', closeNew);
  const createNew = () => { const name = $('#store-new-name').value.trim() || `Store ${S.stores.length + 1}`; const st = makeStore(name); S.stores.push(st); closeNew(); switchStore(st.id); toast(`Created store “${name}” (id ${shortId(st.id)})`); };
  $('#store-new-ok').addEventListener('click', createNew);
  $('#store-new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createNew(); } if (e.key === 'Escape') closeNew(); });
  $('#btn-write-model').addEventListener('click', () => { const st = activeStore(); const v = writeModelVersion(st, st.draftDsl); if (v) { toast(`Wrote model v${st.models.length} · ${shortId(v.id)}`); updateModelBadge(); Inspector.refreshIf('models', 'api', 'json', 'cli'); Assertions.render(); persist(); } });

  // ───────────────────────── tabs, panes, misc wiring ─────────────────────────
  function setEditorTab(tab) {
    S.ui.editorTab = tab;
    $$('#pane-editor .pane-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    ['dsl', 'tuples', 'assertions', 'examples'].forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
    if (tab === 'dsl') dslEditor.refresh(); if (tab === 'tuples') tuplesEditor.refresh();
    persist();
  }
  $$('#pane-editor .pane-tabs button').forEach((b) => b.addEventListener('click', () => setEditorTab(b.dataset.tab)));
  // Materialised access for the data view: every (user, relation, object) that Check would allow but
  // no tuple states directly — one ListUsers per userset slot per plain subject type.
  function computeDerived() {
    const m = S.effectiveModel, st = S.store; if (!m || !st) return [];
    const userTypes = new Set();
    m.types.forEach((t) => t.relations.forEach((r) => r.directTypes.forEach((e) => { if (!e.relation) userTypes.add(e.type); })));
    const direct = new Set(st.tuples.map((t) => `${t.user.raw}|${t.relation}|${t.object.raw}`));
    const out = [];
    let calls = 0;
    for (const obj of st.allObjects()) {
      const t = m.typeMap.get(obj.split(':')[0]); if (!t) continue;
      for (const r of t.relations) for (const ut of userTypes) {
        if (++calls > 1500) { toast('Derived access: the store is too large to materialise everything, showing a partial view'); return out; }
        const res = FGA.listUsers(m, st, { object: obj, relation: r.name, userType: ut, context: {} });
        if (res.error) continue;
        res.users.forEach((u) => { if (!direct.has(`${u}|${r.name}|${obj}`)) out.push({ user: u, relation: r.name, object: obj }); });
        if (res.wildcard && !direct.has(`${ut}:*|${r.name}|${obj}`)) out.push({ user: `${ut}:*`, relation: r.name, object: obj, wildcard: true });
      }
    }
    return out;
  }
  // ── access matrix: subjects × objects for one relation, direct vs derived, diffed against a written model
  const Matrix = (() => {
    const el = $('#matrix'), tip = $('#graph-tip'), stage = $('#graph-stage');
    const sel = () => (S.ui.matrix = S.ui.matrix || { type: null, relation: null });
    function subjectTypes(m) { const out = new Set(); m.types.forEach((t) => t.relations.forEach((r) => r.directTypes.forEach((e) => { if (!e.relation) out.add(e.type); }))); return Array.from(out); }
    // one cell state per (subject, object): direct | derived | public | excluded | ''
    function compute(m, st, type, relation) {
      const objects = st.objectsOfType(type);
      const uts = subjectTypes(m);
      const direct = new Set(st.tuples.map((t) => `${t.user.raw}|${t.relation}|${t.object.raw}`));
      const cells = new Map(), wild = new Map();
      for (const obj of objects) for (const ut of uts) {
        const res = FGA.listUsers(m, st, { object: obj, relation, userType: ut, context: {} });
        if (res.error) continue;
        res.users.forEach((u) => cells.set(`${u}|${obj}`, direct.has(`${u}|${relation}|${obj}`) ? 'direct' : 'derived'));
        res.excluded.forEach((u) => { if (!cells.has(`${u}|${obj}`)) cells.set(`${u}|${obj}`, 'excluded'); });
        if (res.wildcard) { wild.set(`${ut}|${obj}`, direct.has(`${ut}:*|${relation}|${obj}`) ? 'direct' : 'derived'); }
      }
      // rows: plain subjects of every subject type, plus a wildcard row per type that is public somewhere
      const rows = [];
      uts.forEach((ut) => {
        const tdef = m.typeMap.get(ut);
        const pure = !tdef || !tdef.relations.length; // a pure subject type (user) is always listed in full
        st.usersOfType(ut).forEach((u) => { if (u.split(':')[0] !== ut) return; const any = objects.some((o) => cells.has(`${u}|${o}`) || wild.has(`${ut}|${o}`)); if (pure || any) rows.push({ id: u, type: ut }); });
        if (objects.some((o) => wild.has(`${ut}|${o}`))) rows.push({ id: `${ut}:*`, type: ut, wildcard: true });
      });
      const state = (row, obj) => {
        if (row.wildcard) return wild.get(`${row.type}|${obj}`) || '';
        const c = cells.get(`${row.id}|${obj}`);
        if (c) return c;
        return wild.has(`${row.type}|${obj}`) ? 'public' : '';
      };
      return { objects, rows, state };
    }
    function render() {
      const m = S.effectiveModel, st = S.store, store = activeStore();
      if (!m || !st) { el.innerHTML = `<div class="mx-empty">Write a valid model and some tuples to see who can do what.</div>`; return; }
      const types = m.types.filter((t) => t.relations.length);
      if (!types.length) { el.innerHTML = `<div class="mx-empty">No relations in the model yet.</div>`; return; }
      const cur = sel();
      let t = types.find((x) => x.name === cur.type); if (!t) { const qt = (Query.q.object || '').split(':')[0]; t = types.find((x) => x.name === (Query.q.type === 'listObjects' ? Query.q.objectType : qt)) || types[0]; }
      let r = t.relations.find((x) => x.name === cur.relation); if (!r) r = t.relations.find((x) => x.name === Query.q.relation) || t.relations[0];
      cur.type = t.name; cur.relation = r.name;
      const now = compute(m, st, t.name, r.name);
      const base = compareBase(store);
      const before = base && base.typeMap.get(t.name) && base.typeMap.get(t.name).relMap.has(r.name) ? compute(base, st, t.name, r.name) : null;
      const has = (x) => x === 'direct' || x === 'derived' || x === 'public';
      let nDirect = 0, nDerived = 0, nGained = 0, nLost = 0;
      const head = `<div class="mx-head"><span class="lbl">object type</span><div class="seg xs" id="mx-types">${types.map((x) => `<button data-t="${esc(x.name)}" aria-pressed="${x.name === t.name}">${esc(x.name)}<span class="n">${st.objectsOfType(x.name).length}</span></button>`).join('')}</div><span class="lbl">relation</span><div class="seg xs" id="mx-rels">${t.relations.map((x) => `<button data-r="${esc(x.name)}" aria-pressed="${x.name === r.name}" style="--e:${Graph.relColor(x.name)}">${esc(x.name)}</button>`).join('')}</div><span class="mx-sum" id="mx-sum"></span></div>`;
      if (!now.objects.length) { el.innerHTML = head + `<div class="mx-empty">No ${esc(t.name)} objects in the store yet — write a tuple whose object is a ${esc(t.name)}.</div>`; wire(); return; }
      const q = Query.q;
      const body = now.rows.map((row, i) => {
        const sep = i > 0 && now.rows[i - 1].type !== row.type;
        const cellsHtml = now.objects.map((obj) => {
          const stNow = now.state(row, obj);
          const stBefore = before ? before.state(row, obj) : null;
          let diff = '';
          if (before) { if (has(stNow) && !has(stBefore)) { diff = ' added'; nGained++; } else if (!has(stNow) && has(stBefore)) { diff = ' removed'; nLost++; } }
          if (stNow === 'direct') nDirect++; else if (stNow === 'derived' || stNow === 'public') nDerived++;
          const curCell = q.type === 'check' && q.user === row.id && q.relation === r.name && q.object === obj ? ' cur' : '';
          const glyph = stNow === 'excluded' ? '✕' : stNow ? '<i></i>' : (stBefore && has(stBefore) ? '<i></i>' : '·');
          return `<td class="c ${stNow || 'none'}${diff}${curCell}" data-u="${esc(row.id)}" data-o="${esc(obj)}" data-s="${stNow}" data-b="${stBefore || ''}" style="--e:${Graph.relColor(r.name)}">${glyph}</td>`;
        }).join('');
        return `<tr class="${sep ? 'sep' : ''}" data-u="${esc(row.id)}"><th>${esc(row.id)}<span class="t">${esc(row.type)}</span></th>${cellsHtml}</tr>`;
      }).join('');
      const thead = `<thead><tr><th class="corner"></th>${now.objects.map((o) => `<th class="obj" data-o="${esc(o)}"><div>${esc(o)}</div></th>`).join('')}</tr></thead>`;
      el.innerHTML = head + `<table class="mx">${thead}<tbody>${body}</tbody></table>`;
      $('#mx-sum').textContent = `${now.rows.length} subject${now.rows.length === 1 ? '' : 's'} × ${now.objects.length} object${now.objects.length === 1 ? '' : 's'} · ${nDirect} direct · ${nDerived} derived${before ? ` · vs compared model: ${nGained} gained, ${nLost} lost` : ''}`;
      wire();
    }
    function wire() {
      $$('#mx-types button', el).forEach((b) => b.addEventListener('click', () => { sel().type = b.dataset.t; sel().relation = null; persist(); render(); }));
      $$('#mx-rels button', el).forEach((b) => b.addEventListener('click', () => { sel().relation = b.dataset.r; persist(); render(); }));
      $$('td.c', el).forEach((td) => {
        td.addEventListener('click', () => { Query.load(Object.assign({}, Query.q, { type: 'check', user: td.dataset.u, relation: sel().relation, object: td.dataset.o })); Query.run({}); $$('td.c.cur', el).forEach((x) => x.classList.remove('cur')); td.classList.add('cur'); if (mq.matches) { S.ui.mobileView = 'query'; applyMobile(); } });
        td.addEventListener('mouseenter', (ev) => { showTip(ev, tipFor(td)); hot(td, true); });
        td.addEventListener('mousemove', moveTip);
        td.addEventListener('mouseleave', () => { tip.hidden = true; hot(td, false); });
      });
    }
    function hot(td, on) { const o = td.dataset.o; const th = el.querySelector(`th.obj[data-o="${CSS.escape(o)}"]`); if (th) th.classList.toggle('hot', on); const rh = td.parentElement.querySelector('th'); if (rh) rh.classList.toggle('hot', on); }
    function tipFor(td) {
      const u = td.dataset.u, o = td.dataset.o, rel = sel().relation, stNow = td.dataset.s, stBefore = td.dataset.b;
      const m = S.effectiveModel, st = S.store;
      let why = '';
      if (stNow === 'direct') why = 'a tuple says so';
      else if (stNow === 'public') why = `every ${esc(u.split(':')[0])} holds it through a public wildcard grant`;
      else if (stNow === 'excluded') why = 'removed by a "but not" exclusion';
      else if (stNow === 'derived' || stNow === 'wild') {
        try { const res = FGA.check(m, st, { user: u, relation: rel, object: o, context: {} }); const chains = res.root ? FGA.proofChains(res.root.proof) : []; why = chains.length ? `<code>${esc(chains.map((c) => FGA.chainText(c)).join('\n'))}</code>` : (res.allowed ? 'allowed' : 'not allowed'); } catch (e) { why = esc(e.message); }
      } else why = 'no path grants it';
      const diff = stBefore !== undefined && stBefore !== null && td.dataset.b !== stNow && (td.classList.contains('added') || td.classList.contains('removed')) ? `<div class="sub">${td.classList.contains('added') ? 'gained' : 'lost'} compared with the selected model version (was: ${esc(stBefore || 'none')})</div>` : '';
      return `<code>${esc(u)} ${esc(rel)} ${esc(o)}</code><div class="sub">${stNow ? esc(stNow) + ' — ' : ''}${why}</div>${diff}<div class="sub">click to run this Check</div>`;
    }
    function showTip(ev, html) { tip.innerHTML = html; tip.hidden = false; moveTip(ev); }
    function moveTip(ev) {
      const r = stage.getBoundingClientRect();
      let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
      if (x + tip.offsetWidth > r.width - 8) x = Math.max(8, ev.clientX - r.left - tip.offsetWidth - 10);
      if (y + tip.offsetHeight > r.height - 8) y = Math.max(8, ev.clientY - r.top - tip.offsetHeight - 10);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    return { render };
  })();
  Graph.on('renderMatrix', () => Matrix.render());
  const GRAPH_HINTS = { schema: 'schema: one card per type, derived relations read inline, only cross-type links are edges', model: 'resolution: how one relation is computed, as the tree Check walks — the trace lights up its branches', data: 'data: tuples as edges into object#relation slots — objects the query walked open as cards', matrix: 'matrix: who holds which relation on which object — direct tuples, derived access, public grants and exclusions; click a cell to Check it' };
  function syncGraphToolbar() {
    const m = Graph.mode;
    $$('#graph-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('#graph-hint').textContent = GRAPH_HINTS[m] || '';
    $('#btn-connect').hidden = m !== 'data';
    const st = activeStore(); if (st) $('#compare-wrap').hidden = !(m === 'schema' || m === 'matrix') || !st.models.length;
    $('#res-wrap').hidden = m !== 'model' || !S.effectiveModel;
    if (m === 'model') renderResSelect();
    $('#cards-wrap').hidden = m !== 'data';
    $('#cards-select').value = Graph.cardsMode;
    $('#btn-derived').hidden = m !== 'data';
    $('#btn-derived').setAttribute('aria-pressed', String(!!S.ui.derived));
    $$('#layout-seg button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.l === Graph.layout)); b.disabled = m === 'matrix' || ((b.dataset.l === 'lanes' || b.dataset.l === 'force') && m !== 'data') || (b.dataset.l === 'radial' && m === 'model'); });
    $('#find-wrap').hidden = m === 'matrix';
  }
  function setGraphMode(m) { if (!GRAPH_HINTS[m]) m = 'schema'; S.ui.graphMode = m; Graph.setMode(m); syncGraphToolbar(); persist(); }
  Graph.on('modeChanged', (m) => { S.ui.graphMode = m; syncGraphToolbar(); persist(); });
  Graph.on('rootChanged', () => renderResSelect());
  $('#cards-select').addEventListener('change', () => { S.ui.cards = $('#cards-select').value; Graph.setCardsMode(S.ui.cards); persist(); });
  $('#btn-derived').addEventListener('click', () => {
    S.ui.derived = !S.ui.derived;
    $('#btn-derived').setAttribute('aria-pressed', String(!!S.ui.derived));
    const list = S.ui.derived ? computeDerived() : null;
    Graph.setDerived(list);
    if (S.ui.derived) toast(list.length ? `${list.length} derived grant${list.length === 1 ? '' : 's'}: dashed edges, hover for the proof` : 'No derived access: every grant in this store is a direct tuple');
    persist();
  });
  Graph.on('runCheck', ({ user, relation, object }) => { Query.load(Object.assign({}, Query.q, { type: 'check', user, relation, object })); Query.run({}); if (mq.matches) { S.ui.mobileView = 'query'; applyMobile(); } });
  $('#btn-connect').addEventListener('click', () => { const on = !Graph.connectMode; Graph.setConnectMode(on); $('#btn-connect').setAttribute('aria-pressed', String(on)); if (on) toast('Connect mode: drag from a user to an object to write a tuple'); });
  // layout & export menu
  const gmenu = $('#gmenu');
  $('#btn-gmenu').addEventListener('click', (ev) => { ev.stopPropagation(); gmenu.hidden = !gmenu.hidden; $('#btn-gmenu').setAttribute('aria-expanded', String(!gmenu.hidden)); });
  document.addEventListener('click', (ev) => { if (!gmenu.hidden && !ev.target.closest('.menu-wrap')) { gmenu.hidden = true; $('#btn-gmenu').setAttribute('aria-expanded', 'false'); } });
  $$('#layout-seg button').forEach((b) => b.addEventListener('click', () => { S.ui.layout = b.dataset.l; Graph.setLayout(b.dataset.l); syncGraphToolbar(); persist(); }));
  $('#gm-reset').addEventListener('click', () => { Graph.resetLayout(); toast('Moved nodes reset for this view'); });
  $('#gm-minimap').addEventListener('click', () => Graph.toggleMinimap());
  $('#gm-svg').addEventListener('click', () => copyText(Graph.svgMarkup(), 'SVG'));
  $('#gm-png').addEventListener('click', async () => {
    try { const blob = await Graph.pngBlob(2); if (navigator.clipboard && window.ClipboardItem) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('PNG copied to clipboard'); } else toast('PNG copy is not supported in this browser — use Copy as SVG'); }
    catch (e) { toast(`Could not copy PNG: ${e.message}`); }
  });
  Graph.on('positions', (pins) => { const st = activeStore(); if (st) { st.pins = pins; persist(); } });
  Graph.on('collapsed', (list) => { const st = activeStore(); if (st) { st.collapsed = list; persist(); } });
  // find & jump (⌘K)
  (function wireFind() {
    const input = $('#graph-find'), list = $('#find-list');
    let items = [], sel = 0;
    const render = () => {
      items = Graph.candidates(input.value);
      sel = 0;
      list.hidden = !items.length;
      list.innerHTML = items.map((it, i) => `<button class="find-item${i === sel ? ' on' : ''}" data-i="${i}"><span class="k">${esc(it.kind)}</span><code>${esc(it.label)}</code>${it.mode !== Graph.mode ? `<span class="m">in ${esc(it.mode === 'model' ? 'resolution' : it.mode)} view</span>` : ''}</button>`).join('');
      $$('.find-item', list).forEach((b) => b.addEventListener('mousedown', (ev) => { ev.preventDefault(); go(+b.dataset.i); }));
    };
    const go = (i) => { const it = items[i]; if (!it) return; Graph.jumpTo(it); list.hidden = true; input.value = ''; input.blur(); };
    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(items.length - 1, sel + 1); $$('.find-item', list).forEach((b, i) => b.classList.toggle('on', i === sel)); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(0, sel - 1); $$('.find-item', list).forEach((b, i) => b.classList.toggle('on', i === sel)); }
      else if (ev.key === 'Enter') { ev.preventDefault(); go(sel); }
      else if (ev.key === 'Escape') { input.value = ''; list.hidden = true; input.blur(); }
    });
  })();
  Graph.on('nodeHover', (id) => { $$('#result .pn').forEach((b) => b.classList.toggle('lit', !!id && b.dataset.node === id)); });
  Graph.on('reveal', (r) => { if (r && r.line) dslEditor.revealLine(r.line); });
  Graph.on('condInfo', (tuples) => tuples.map((t) => { const r = FGA.evaluateCondition(S.effectiveModel, t, Query.contextObj()); const def = S.effectiveModel.condMap.get(t.condition.name); return `<div class="sub">⚡ ${esc(t.condition.name)}: <code style="display:inline">${esc(def ? def.expression : '?')}</code> → ${r.error ? '<span style="color:var(--warn)">' + esc(r.error) + '</span>' : r.ok ? '<span style="color:var(--ok)">true</span>' : '<span style="color:var(--bad)">false</span>'} with the current query context</div>`; }).join(''));
  // connect: drag from one node to another writes a tuple
  Graph.on('connect', (from, to, ev, slots = {}) => {
    const m = S.effectiveModel; if (!m) return;
    const toType = m.typeMap.get(to.type); if (!toType || !toType.relations.length) { toast(`${to.id} is a subject type; drag onto an object instead`); return; }
    const fromType = m.typeMap.get(from.type);
    const fromRel = slots.fromSlot ? slots.fromSlot.split('#')[1] : null, toRel = slots.toSlot ? slots.toSlot.split('#')[1] : null;
    const options = [];
    for (const r of toType.relations) for (const e of r.directTypes) {
      if (e.type !== from.type) continue;
      if (toRel && r.name !== toRel) continue;
      if (e.wildcard) { if (from.kind === 'wildcard') options.push({ rel: r.name, user: `${from.type}:*`, cond: e.condition }); continue; }
      if (from.kind === 'wildcard') continue;
      if (e.relation) { if (fromType && fromType.relMap.has(e.relation) && (!fromRel || fromRel === e.relation)) options.push({ rel: r.name, user: `${from.id}#${e.relation}`, cond: e.condition }); }
      else if (!fromRel) options.push({ rel: r.name, user: from.id, cond: e.condition });
    }
    if (!options.length) { toast(toRel ? `${toRel} on ${to.type} does not accept ${from.id}${fromRel ? '#' + fromRel : ''} directly` : `No relation on ${to.type} accepts ${from.type}${from.kind === 'wildcard' ? ':*' : ''}${fromRel ? '#' + fromRel : ''} directly`); return; }
    if (options.length === 1 && (toRel || fromRel)) { const o = options[0]; writeTupleLine(`${o.user} ${o.rel} ${to.id}${o.cond ? ' with ' + o.cond + ' {}' : ''}`); return; }
    CtxMenu.open(ev, `${esc(from.id)} → ${esc(to.id)}`, 'write a tuple', options.map((o) => ({ label: `${o.user} ${o.rel} ${to.id}${o.cond ? ' with ' + o.cond : ''}`, run: () => writeTupleLine(`${o.user} ${o.rel} ${to.id}${o.cond ? ' with ' + o.cond + ' {}' : ''}`) })));
  });
  function writeTupleLine(line) {
    const st = activeStore(); if (!st) return;
    if (st.tuplesText.split('\n').some((l) => l.trim() === line.trim())) { toast('That tuple already exists'); return; }
    st.tuplesText = st.tuplesText.replace(/\s*$/, '') + (st.tuplesText.trim() ? '\n' : '') + line + '\n';
    tuplesEditor.value = st.tuplesText; recompute(); changesSoon.flush(); toast(`Wrote ${line}`);
  }
  function deleteTupleLines(lines) {
    const st = activeStore(); if (!st) return;
    const set = new Set(lines);
    const all = st.tuplesText.split('\n');
    st.tuplesText = all.filter((l, i) => !set.has(i + 1)).join('\n');
    tuplesEditor.value = st.tuplesText; recompute(); changesSoon.flush();
    toast(`Deleted ${lines.length} tuple${lines.length === 1 ? '' : 's'}`);
  }
  // right-click menus
  const CtxMenu = (() => {
    const el = $('#ctx-menu'), stage = $('#graph-stage');
    function close() { el.hidden = true; }
    function open(ev, title, sub, items) {
      el.innerHTML = `<div class="nm-head"><code>${title}</code><span>${esc(sub || '')}</span></div>${items.map((it, i) => `<button class="nm${it.danger ? ' danger' : ''}" data-i="${i}"${it.disabled ? ' disabled' : ''}>${it.k ? `<span class="k">${esc(it.k)}</span>` : '<span class="k"></span>'}<span class="q">${esc(it.label)}</span></button>`).join('')}<button class="nm close">close (Esc)</button>`;
      el.hidden = false;
      const r = stage.getBoundingClientRect();
      let x = ev.clientX - r.left + 6, y = ev.clientY - r.top + 6;
      if (x + el.offsetWidth > r.width - 8) x = Math.max(8, r.width - el.offsetWidth - 8);
      if (y + el.offsetHeight > r.height - 8) y = Math.max(8, r.height - el.offsetHeight - 8);
      el.style.left = x + 'px'; el.style.top = y + 'px';
      $$('button.nm[data-i]', el).forEach((b) => b.addEventListener('click', () => { const it = items[+b.dataset.i]; close(); it.run(); }));
      $('button.nm.close', el).addEventListener('click', close);
    }
    return { open, close, get isOpen() { return !el.hidden; } };
  })();
  Graph.on('context', ({ kind, datum, mode }, ev) => {
    NodeMenu.close();
    if (kind === 'edge' && mode === 'data' && datum.derived) {
      const t = S.store.byId(datum.tupleId);
      CtxMenu.open(ev, `${esc(datum.fromSlot || datum.from)} → ${esc(datum.toSlot)}`, 'derived', [
        { k: 'why', label: `${datum.computed} from ${datum.tupleset}: whoever is ${datum.computed} of ${datum.from} is ${datum.rel} of ${datum.to}`, run: () => { Graph.setResolutionRoot(`${datum.to.split(':')[0]}#${datum.rel}`); setGraphMode('model'); } },
        ...(t ? [{ k: 'delete', label: `delete the tuple behind it: ${FGA.formatTuple(t, { plain: true })}`, danger: true, disabled: !!t.contextual || !!S.timeTravel, run: () => deleteTupleLines([t.line]) }] : []),
        { k: 'focus', label: `focus ${datum.to}`, run: () => Graph.focusNode(datum.to) },
      ]);
      return;
    }
    if (kind === 'edge' && mode === 'data') {
      const tuples = datum.tupleIds.map((id) => S.store.byId(id)).filter(Boolean);
      CtxMenu.open(ev, `${esc(datum.from)} → ${esc(datum.to)}`, 'tuples', tuples.map((t) => ({ k: 'delete', label: FGA.formatTuple(t, { plain: true }), danger: true, disabled: !!t.contextual || !!S.timeTravel, run: () => deleteTupleLines([t.line]) })).concat([{ k: 'focus', label: `focus ${datum.to}`, run: () => Graph.focusNode(datum.to) }]));
      return;
    }
    if (kind === 'slot' && mode === 'data') {
      const tuples = S.store.tuples.filter((t) => !t.contextual && t.object.raw === datum.object && t.relation === datum.rel);
      CtxMenu.open(ev, esc(datum.id), 'userset', [
        { k: 'queries', label: 'open the query menu', run: () => NodeMenu.open(datum, 'data', ev) },
        { k: 'resolve', label: `show how ${datum.type}#${datum.rel} resolves`, run: () => { Graph.setResolutionRoot(`${datum.type}#${datum.rel}`); setGraphMode('model'); } },
        ...(datum.line ? [{ k: 'go to', label: `line ${datum.line} in the model`, run: () => { dslEditor.scrollToLine(datum.line); setEditorTab('dsl'); } }] : []),
        { k: 'delete', label: `delete the ${tuples.length} tuple${tuples.length === 1 ? '' : 's'} into this slot`, danger: true, disabled: !tuples.length || !!S.timeTravel, run: () => deleteTupleLines(tuples.map((t) => t.line)) },
      ]);
      return;
    }
    if (kind === 'node' && mode === 'data') {
      const tuples = S.store.tuples.filter((t) => !t.contextual && (t.object.raw === datum.id || `${t.user.type}:${t.user.id}` === datum.id || (t.user.wildcard && `${t.user.type}:*` === datum.id)));
      const hasRels = datum.kind === 'object' && S.effectiveModel && S.effectiveModel.typeMap.get(datum.type) && S.effectiveModel.typeMap.get(datum.type).relations.length;
      CtxMenu.open(ev, esc(datum.id), 'node', [
        { k: 'queries', label: 'open the query menu', run: () => NodeMenu.open(datum, 'data', ev) },
        ...(hasRels ? [{ k: 'card', label: datum.card ? 'collapse to a plain node' : 'open as a card: one slot per relation', run: () => Graph.toggleCard(datum.id, !datum.card) }] : []),
        { k: 'focus', label: 'focus · in · all hops', run: () => { Graph.focusNode(datum.id); } },
        { k: 'write', label: 'drag to another node with Alt held, or turn on connect mode', run: () => { Graph.setConnectMode(true); $('#btn-connect').setAttribute('aria-pressed', 'true'); toast('Connect mode on'); } },
        { k: 'delete', label: `delete all ${tuples.length} tuple${tuples.length === 1 ? '' : 's'} touching this node`, danger: true, disabled: !tuples.length || !!S.timeTravel, run: () => deleteTupleLines(tuples.map((t) => t.line)) },
      ]);
      return;
    }
    if (kind === 'node' && mode === 'model') {
      const rel = datum.kind === 'rel' && S.effectiveModel.typeMap.get(datum.type) && S.effectiveModel.typeMap.get(datum.type).relMap.get(datum.rel);
      CtxMenu.open(ev, esc(datum.id || datum.type), datum.kind === 'rel' ? 'relation' : 'type', [
        { k: 'queries', label: 'open the query menu', run: () => NodeMenu.open(datum, 'model', ev) },
        ...(rel ? [{ k: 'go to', label: `line ${rel.line} in the model`, run: () => { dslEditor.scrollToLine(rel.line); setEditorTab('dsl'); } }] : []),
        ...(rel && Graph.resolutionKey !== datum.id ? [{ k: 'resolve', label: `make ${datum.id} the root of this view`, run: () => Graph.setResolutionRoot(datum.id) }] : []),
        ...(Graph.resolutionRoot ? [{ k: 'follow', label: 'follow the query again', run: () => Graph.setResolutionRoot(null) }] : []),
      ]);
      return;
    }
    if (kind === 'row') {
      const rel = S.effectiveModel.typeMap.get(datum.type) && S.effectiveModel.typeMap.get(datum.type).relMap.get(datum.rel);
      CtxMenu.open(ev, esc(datum.id), 'relation', [
        { k: 'queries', label: 'open the query menu', run: () => NodeMenu.open(datum, 'model', ev) },
        ...(rel ? [{ k: 'go to', label: `line ${rel.line} in the model`, run: () => { dslEditor.scrollToLine(rel.line); setEditorTab('dsl'); } }] : []),
        ...(rel ? [{ k: 'resolve', label: `show how ${datum.id} resolves`, run: () => { Graph.setResolutionRoot(datum.id); setGraphMode('model'); } }] : []),
      ]);
      return;
    }
    if (kind === 'card') {
      const t = S.effectiveModel.typeMap.get(datum.id);
      CtxMenu.open(ev, `type ${esc(datum.id)}`, 'type', [
        { k: 'queries', label: 'open the query menu', run: () => NodeMenu.open({ kind: 'type', type: datum.id, label: datum.id }, 'model', ev) },
        ...(t ? [{ k: 'go to', label: `line ${t.line} in the model`, run: () => { dslEditor.scrollToLine(t.line); setEditorTab('dsl'); } }] : []),
        ...(t ? [{ k: 'add', label: 'add a relation to this type', run: () => addRelationTo(datum.id) }] : []),
        { k: 'collapse', label: datum.collapsed ? 'expand the card' : 'collapse the card', run: () => { const st = activeStore(); const set = new Set(st.collapsed || []); if (set.has(datum.id)) set.delete(datum.id); else set.add(datum.id); st.collapsed = Array.from(set); Graph.setCollapsed(st.collapsed); Graph.setMode(Graph.mode); persist(); } },
        { k: 'data', label: `show ${datum.id} objects in the data view`, run: () => { setGraphMode('data'); const o = S.store.objectsOfType(datum.id)[0]; if (o) setTimeout(() => { Graph.focusNode(o); Graph.panTo(o); }, 50); } },
      ]);
      return;
    }
    if (kind === 'blank') CtxMenu.open(ev, 'graph', '', [
      { k: 'fit', label: 'fit to view', run: () => Graph.fit(true) },
      { k: 'layout', label: 'reset moved nodes', run: () => Graph.resetLayout() },
      { k: 'export', label: 'copy as SVG', run: () => copyText(Graph.svgMarkup(), 'SVG') },
      { k: 'view', label: Graph.mode === 'data' ? 'show the schema' : 'show the data', run: () => setGraphMode(Graph.mode === 'data' ? 'schema' : 'data') },
    ]);
  });
  function addRelationTo(typeName) {
    const st = activeStore(); if (!st) return;
    const lines = st.draftDsl.split('\n');
    const t = S.effectiveModel.typeMap.get(typeName);
    let insertAt = lines.length;
    if (t) {
      const last = t.relations.length ? Math.max(...t.relations.map((r) => r.line)) : t.line;
      insertAt = last;
      if (!t.relations.length) { lines.splice(t.line, 0, '  relations'); insertAt = t.line + 1; }
    }
    const ins = '    define new_relation: [user]';
    lines.splice(insertAt, 0, ins);
    st.draftDsl = lines.join('\n'); dslEditor.value = st.draftDsl; recompute(); setEditorTab('dsl');
    const pos = lines.slice(0, insertAt).join('\n').length + 1 + ins.indexOf('new_relation');
    const ta = $('#dsl-ta'); ta.focus(); ta.setSelectionRange(pos, pos + 'new_relation'.length); dslEditor.scrollToLine(insertAt + 1, true);
  }
  $('#btn-subjects').addEventListener('click', () => { S.ui.subjectEdges = !S.ui.subjectEdges; $('#btn-subjects').setAttribute('aria-pressed', String(!!S.ui.subjectEdges)); Graph.setSubjects(S.ui.subjectEdges); persist(); });
  // editor → graph: the caret's line lights the matching node
  (function wireEditorSync() {
    const ta = $('#dsl-ta'), tta = $('#tuples-ta');
    let lastDsl = -1, lastTup = -1;
    const lineAt = (el) => el.value.slice(0, el.selectionStart).split('\n').length;
    const dsl = () => {
      const ln = lineAt(ta); if (ln === lastDsl) return; lastDsl = ln;
      const m = S.effectiveModel; if (!m) return;
      for (const t of m.types) { if (t.line === ln) { Graph.flash([t.name, `${t.name}@self`]); return; } for (const r of t.relations) if (r.line === ln) { Graph.flash([`${t.name}#${r.name}`]); return; } }
    };
    const tup = () => {
      const ln = lineAt(tta); if (ln === lastTup) return; lastTup = ln;
      const t = S.store && S.store.tuples.find((x) => !x.contextual && x.line === ln);
      if (t) Graph.flash([`t${t.id}`, t.object.raw, t.user.wildcard ? `${t.user.type}:*` : `${t.user.type}:${t.user.id}`]);
    };
    ['keyup', 'click', 'focus'].forEach((evn) => { ta.addEventListener(evn, dsl); tta.addEventListener(evn, tup); });
  })();
  $$('#graph-mode button').forEach((b) => b.addEventListener('click', () => setGraphMode(b.dataset.mode)));
  $('#zoom-in').addEventListener('click', () => Graph.zoomBy(1.3));
  $('#zoom-out').addEventListener('click', () => Graph.zoomBy(1 / 1.3));
  $('#zoom-fit').addEventListener('click', () => Graph.fit(true));
  // ── node menu: every node offers the queries that make sense for it
  const NodeMenu = (() => {
    const el = $('#node-menu'), stage = $('#graph-stage');
    function close() { el.hidden = true; }
    function labelFor(t) { return { check: 'Check', listObjects: 'ListObjects', listUsers: 'ListUsers', expand: 'Expand' }[t]; }
    function queryText(x) { return x.type === 'listObjects' ? `${x.user} ${x.relation} ${x.objectType}` : x.type === 'listUsers' ? `${x.object}#${x.relation} → ${x.userType}` : x.type === 'expand' ? `${x.object}#${x.relation}` : `${x.user} ${x.relation} ${x.object}`; }
    function actionsFor(n, mode) {
      const q = Query.q, m = S.effectiveModel, st = S.store;
      const acts = [];
      const subjectTypes = m.types.filter((t) => !t.relations.length).map((t) => t.name);
      const firstUser = () => (q.user && !q.user.includes('#') ? q.user : null) || st.usersOfType(subjectTypes[0] || 'user')[0] || st.allUsers().find((u) => !u.includes('#') && !u.endsWith(':*')) || 'user:anne';
      const userTypeOf = (u) => (u || '').split(':')[0] || (subjectTypes[0] || 'user');
      if (mode === 'model' && n.kind === 'rel') {
        const objs = st.objectsOfType(n.type);
        const obj = (q.object && q.object.split(':')[0] === n.type ? q.object : objs[0]) || `${n.type}:1`;
        const u = firstUser();
        acts.push({ type: 'listUsers', object: obj, relation: n.rel, userType: userTypeOf(u) });
        acts.push({ type: 'listObjects', user: u, relation: n.rel, objectType: n.type });
        acts.push({ type: 'check', user: u, relation: n.rel, object: obj });
        acts.push({ type: 'expand', object: obj, relation: n.rel });
        return { title: `${n.type}#${n.rel}`, def: n.def + (n.direct.length ? `\nassignable: ${n.direct.join(', ')}` : '\ncomputed only (no direct tuples)'), acts };
      }
      if (mode === 'model' && n.kind === 'type') {
        const t = m.typeMap.get(n.type);
        const objs = st.objectsOfType(n.type);
        if (!t.relations.length) {
          const u = objs[0] || `${n.type}:someone`;
          const rel = q.relation || (m.types.find((x) => x.relations.length) || { relations: [{ name: 'viewer' }] }).relations[0].name;
          const ot = m.types.find((x) => x.relMap.has(rel)) || m.types.find((x) => x.relations.length);
          if (ot) acts.push({ type: 'listObjects', user: u, relation: rel, objectType: ot.name });
          if (ot) acts.push({ type: 'check', user: u, relation: rel, object: st.objectsOfType(ot.name)[0] || `${ot.name}:1` });
          return { title: `type ${n.type}`, def: `${objs.length} ${n.type} subject${objs.length === 1 ? '' : 's'} in the store${objs.length ? ': ' + objs.slice(0, 6).join(', ') + (objs.length > 6 ? '…' : '') : ''}`, acts };
        }
        const obj = objs[0] || `${n.type}:1`;
        const rel = (q.relation && t.relMap.has(q.relation) ? q.relation : t.relations[0].name);
        const u = firstUser();
        acts.push({ type: 'listUsers', object: obj, relation: rel, userType: userTypeOf(u) });
        acts.push({ type: 'expand', object: obj, relation: rel });
        acts.push({ type: 'listObjects', user: u, relation: rel, objectType: n.type });
        return { title: `type ${n.type}`, def: `${t.relations.length} relations: ${t.relations.map((r) => r.name).join(', ')}\n${objs.length} object${objs.length === 1 ? '' : 's'} in the store`, acts };
      }
      // data graph
      if (n.kind === 'slot') {
        const u = firstUser();
        acts.push({ type: 'listUsers', object: n.object, relation: n.rel, userType: userTypeOf(u) });
        acts.push({ type: 'expand', object: n.object, relation: n.rel });
        acts.push({ type: 'check', user: u, relation: n.rel, object: n.object });
        const ot = m.types.find((x) => x.relations.some((rr) => rr.directTypes.some((e) => e.type === n.type && e.relation === n.rel)));
        if (ot) { const rr = ot.relations.find((x) => x.directTypes.some((e) => e.type === n.type && e.relation === n.rel)); acts.push({ type: 'listObjects', user: `${n.object}#${n.rel}`, relation: rr.name, objectType: ot.name }); }
        return { title: n.id, def: `${n.def}\n${n.direct} direct tuple${n.direct === 1 ? '' : 's'} into this userset${n.derived ? ` · ${n.derived} derived link${n.derived === 1 ? '' : 's'}` : ''}`, acts };
      }
      const t = m.typeMap.get(n.type);
      const isSubject = n.kind === 'wildcard' || !t || !t.relations.length;
      if (isSubject) {
        const rel = q.relation || 'viewer';
        const ot = m.types.find((x) => x.relMap.has(rel)) || m.types.find((x) => x.relations.length);
        const obj = (q.object && ot && q.object.split(':')[0] === ot.name ? q.object : ot && st.objectsOfType(ot.name)[0]) || '';
        if (ot && !n.kind.includes('wildcard')) acts.push({ type: 'listObjects', user: n.id, relation: rel, objectType: ot.name });
        if (obj) acts.push({ type: 'check', user: n.id, relation: rel, object: obj });
        const tuples = n.tuples.map((id) => st.byId(id)).filter(Boolean);
        return { title: n.id, def: n.kind === 'wildcard' ? `public: every ${n.type}` : `${tuples.length} tuple${tuples.length === 1 ? '' : 's'}: ${tuples.slice(0, 5).map((x) => x.relation + ' ' + x.object.raw).join(', ')}${tuples.length > 5 ? '…' : ''}`, acts };
      }
      const rel = (q.relation && t.relMap.has(q.relation) ? q.relation : t.relations[0].name);
      const u = firstUser();
      acts.push({ type: 'listUsers', object: n.id, relation: rel, userType: userTypeOf(u) });
      acts.push({ type: 'check', user: u, relation: rel, object: n.id });
      acts.push({ type: 'expand', object: n.id, relation: rel });
      const asUserRels = t.relations.filter((r) => m.types.some((x) => x.relations.some((rr) => rr.directTypes.some((e) => e.type === n.type && e.relation === r.name))));
      if (asUserRels.length) { const ot = m.types.find((x) => x.relations.some((rr) => rr.directTypes.some((e) => e.type === n.type && e.relation === asUserRels[0].name))); const rr = ot.relations.find((x) => x.directTypes.some((e) => e.type === n.type && e.relation === asUserRels[0].name)); acts.push({ type: 'listObjects', user: `${n.id}#${asUserRels[0].name}`, relation: rr.name, objectType: ot.name }); }
      return { title: n.id, def: `type ${n.type} · ${n.tuples.length} tuple${n.tuples.length === 1 ? '' : 's'}`, acts };
    }
    function open(n, mode, ev) {
      if (!S.effectiveModel) return;
      const { title, def, acts } = actionsFor(n, mode);
      el.innerHTML = `<div class="nm-head"><code>${esc(title)}</code><span>run a query</span></div>${def ? `<div class="nm-def">${esc(def)}</div>` : ''}${acts.map((a, i) => `<button class="nm" data-i="${i}"><span class="k">${labelFor(a.type)}</span><span class="q">${esc(queryText(a))}</span></button>`).join('')}<button class="nm close">close (Esc)</button>`;
      el.hidden = false;
      const r = stage.getBoundingClientRect();
      let x = ev.clientX - r.left + 8, y = ev.clientY - r.top + 8;
      if (x + el.offsetWidth > r.width - 8) x = Math.max(8, r.width - el.offsetWidth - 8);
      if (y + el.offsetHeight > r.height - 8) y = Math.max(8, r.height - el.offsetHeight - 8);
      el.style.left = x + 'px'; el.style.top = y + 'px';
      $$('button.nm[data-i]', el).forEach((b) => b.addEventListener('click', () => { const a = acts[+b.dataset.i]; close(); Query.load(Object.assign({}, Query.q, a, { context: Query.q.context })); Query.run({}); if (mq.matches) { S.ui.mobileView = 'query'; applyMobile(); } }));
      $('button.nm.close', el).addEventListener('click', close);
      const first = $('button.nm', el); if (first) first.focus({ preventScroll: true });
    }
    return { open, close, get isOpen() { return !el.hidden; } };
  })();
  Graph.on('nodeClick', (n, mode, ev) => { CtxMenu.close(); NodeMenu.open(n, mode, ev); });
  Graph.on('blankClick', () => { NodeMenu.close(); CtxMenu.close(); if (!Graph.multiSelecting) Graph.clearFocus(); });

  // ── layout: collapsible panes, resizable widths, focus mode
  function applyLayout() {
    const app = $('#app');
    const mobile = mq.matches;
    app.classList.toggle('focus-graph', !mobile && !!S.ui.focus);
    $('#btn-focus').setAttribute('aria-pressed', String(!!S.ui.focus));
    $('#btn-focus').textContent = S.ui.focus ? '⤡' : '⤢'; $('#btn-focus').title = S.ui.focus ? 'Exit full view (Esc)' : 'Full view: hide the side panes (keyboard: f, Esc to exit)';
    const ed = $('#pane-editor'), qp = $('#pane-query');
    ed.classList.toggle('collapsed', !mobile && !S.ui.editorOpen);
    qp.classList.toggle('collapsed', !mobile && !S.ui.queryOpen);
    const left = S.ui.editorOpen ? `${S.ui.leftW}px` : '34px';
    const right = S.ui.queryOpen ? `${S.ui.rightW}px` : '34px';
    $('.workspace').style.gridTemplateColumns = mobile ? '' : (window.innerWidth <= 1180 ? '' : `${left} minmax(0, 1fr) ${right}`);
    // the step player floats over the graph in full view
    const stepper = $('#stepper'), stage = $('#graph-stage'), ebody = $('#explain-body');
    if (S.ui.focus && !mobile) { if (stepper.parentElement !== stage) stage.appendChild(stepper); }
    else if (stepper.parentElement !== ebody) ebody.insertBefore(stepper, $('#trace'));
    setTimeout(() => { Graph.setInsets({ bottom: S.ui.focus && !mobile && !stepper.hidden ? stepper.offsetHeight + 28 : 0 }); }, 30);
  }
  function setFocus(on) { S.ui.focus = on; applyLayout(); persist(); if (on) toast('Full view · press Esc or f to return'); }
  $('#btn-focus').addEventListener('click', () => setFocus(!S.ui.focus));
  $('#collapse-editor').addEventListener('click', () => { S.ui.editorOpen = false; applyLayout(); persist(); });
  $('#rail-editor').addEventListener('click', () => { S.ui.editorOpen = true; applyLayout(); persist(); });
  $('#collapse-query').addEventListener('click', () => { S.ui.queryOpen = false; applyLayout(); persist(); });
  $('#rail-query').addEventListener('click', () => { S.ui.queryOpen = true; applyLayout(); persist(); });
  (function wireResizers() {
    const ws = $('.workspace');
    const wire = (handle, side) => {
      let startX = 0, startW = 0;
      const move = (e) => {
        const total = ws.getBoundingClientRect().width;
        const delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
        const w = Math.max(260, Math.min(total * 0.55, startW + delta));
        if (side === 'left') S.ui.leftW = Math.round(w); else S.ui.rightW = Math.round(w);
        ws.style.gridTemplateColumns = `${S.ui.editorOpen ? S.ui.leftW + 'px' : '34px'} minmax(0, 1fr) ${S.ui.queryOpen ? S.ui.rightW + 'px' : '34px'}`;
      };
      const up = () => { handle.classList.remove('active'); document.body.style.cursor = ''; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); persist(); Graph.fit(false); };
      handle.addEventListener('pointerdown', (e) => {
        if (mq.matches || window.innerWidth <= 1180) return;
        if (side === 'left' && !S.ui.editorOpen) { S.ui.editorOpen = true; applyLayout(); }
        if (side === 'right' && !S.ui.queryOpen) { S.ui.queryOpen = true; applyLayout(); }
        startX = e.clientX; startW = side === 'left' ? S.ui.leftW : S.ui.rightW;
        handle.classList.add('active'); document.body.style.cursor = 'col-resize';
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); e.preventDefault();
      });
    };
    wire($('#rz-left'), 'left'); wire($('#rz-right'), 'right');
  })();
  window.addEventListener('resize', debounce(applyLayout, 150));
  $('#btn-inspector').addEventListener('click', () => toggleInspector());
  $('#insp-toggle').addEventListener('click', () => toggleInspector());
  (function wireInspectorResize() {
    const handle = $('#insp-resize'), insp = $('#inspector');
    if (S.ui.inspHeight) insp.style.height = S.ui.inspHeight + 'px';
    let startY = 0, startH = 0;
    const move = (e) => { const h = Math.max(120, Math.min(window.innerHeight * 0.75, startH + (startY - e.clientY))); insp.style.height = h + 'px'; S.ui.inspHeight = Math.round(h); };
    const up = () => { handle.classList.remove('active'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); persist(); Graph.fit(false); };
    handle.addEventListener('pointerdown', (e) => { if (!S.ui.inspOpen) return; startY = e.clientY; startH = insp.getBoundingClientRect().height; handle.classList.add('active'); window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); e.preventDefault(); });
  })();
  function toggleInspector(force) {
    S.ui.inspOpen = force !== undefined ? force : !S.ui.inspOpen;
    $('#inspector').classList.toggle('collapsed', !S.ui.inspOpen);
    $('#btn-inspector').setAttribute('aria-pressed', String(S.ui.inspOpen));
    $('#insp-toggle').textContent = S.ui.inspOpen ? '▾' : '▴';
    setTimeout(() => Graph.fit(false), 220);
    persist();
  }
  $('#btn-copy-dsl').addEventListener('click', () => copyText(dslEditor.value, 'Model DSL'));
  $('#btn-format-dsl').addEventListener('click', () => {
    const st = activeStore(); let inCond = false;
    const out = st.draftDsl.split('\n').map((raw) => {
      const l = raw.trim();
      if (!l) return '';
      if (inCond) { if (/\}/.test(l)) { inCond = false; return l === '}' ? '}' : '  ' + l; } return '  ' + l; }
      if (/^model$/.test(l) || /^type\b/.test(l) || /^condition\b/.test(l)) { if (/^condition\b/.test(l) && /\{/.test(l) && !/\}/.test(l)) inCond = true; return l; }
      if (/^schema\b/.test(l) || /^relations$/.test(l)) return '  ' + l;
      if (/^define\b/.test(l)) return '    ' + l;
      if (/^#/.test(l)) return raw.replace(/\s+$/, '');
      return l;
    }).join('\n').replace(/\n{3,}/g, '\n\n');
    st.draftDsl = out; dslEditor.value = out; recompute();
  });
  $('#qa-add').addEventListener('click', () => {
    const u = $('#qa-user').value.trim(), r = $('#qa-rel').value.trim(), o = $('#qa-obj').value.trim();
    if (!u || !r || !o) { toast('Fill in user, relation and object'); return; }
    const line = `${u} ${r} ${o}`;
    try { const t = FGA.parseTupleLine(line); if (S.effectiveModel) { const p = FGA.validateTuple(t, S.effectiveModel); if (p) { toast(`Rejected: ${p}`); return; } } } catch (e) { toast(e.message); return; }
    const st = activeStore();
    if (st.tuplesText.split('\n').some((l) => l.trim() === line)) { toast('That tuple already exists'); return; }
    st.tuplesText = st.tuplesText.replace(/\s*$/, '') + (st.tuplesText.trim() ? '\n' : '') + line + '\n';
    tuplesEditor.value = st.tuplesText; recompute(); changesSoon.flush();
    $('#qa-user').value = ''; $('#qa-rel').value = ''; $('#qa-obj').value = ''; $('#qa-user').focus();
    toast(`Wrote ${line}`);
  });
  $$('#qa-user, #qa-rel, #qa-obj').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#qa-add').click(); } }));
  // mobile views
  const mq = window.matchMedia('(max-width: 820px)');
  function applyMobile() {
    const mobile = mq.matches;
    if (mobile && S.ui.focus) { S.ui.focus = false; $('#app').classList.remove('focus-graph'); }
    ['editor', 'graph', 'query'].forEach((v) => { $('#pane-' + v).hidden = mobile && S.ui.mobileView !== v; });
    $('#inspector').hidden = mobile && S.ui.mobileView !== 'store';
    if (mobile && S.ui.mobileView === 'store') { $('#inspector').classList.remove('collapsed'); }
    $$('.mobile-nav button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === S.ui.mobileView)));
    setTimeout(() => Graph.fit(false), 50);
  }
  $$('.mobile-nav button').forEach((b) => b.addEventListener('click', () => { S.ui.mobileView = b.dataset.view; applyMobile(); persist(); }));
  mq.addEventListener('change', applyMobile);
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); Query.run({}); return; }
    if (typing && e.key === 'Escape' && !NodeMenu.isOpen && !S.ui.focus) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (mq.matches) { S.ui.mobileView = 'graph'; applyMobile(); } $('#graph-find').focus(); return; }
    if (e.key === 'Escape') { if (CtxMenu.isOpen) { CtxMenu.close(); return; } if (NodeMenu.isOpen) { NodeMenu.close(); return; } if (!gmenu.hidden) { gmenu.hidden = true; return; } if (Graph.hasFocus) { Graph.clearFocus(); return; } if (S.ui.focus) { setFocus(false); return; } }
    if (typing) return;
    if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setFocus(!S.ui.focus); return; }
    if (e.key === '[') { S.ui.editorOpen = !S.ui.editorOpen; applyLayout(); persist(); return; }
    if (e.key === ']') { S.ui.queryOpen = !S.ui.queryOpen; applyLayout(); persist(); return; }
    if ($('#stepper').hidden) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); Query.stopPlay(); Query.goto(S.step + 1, { scroll: true }); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); Query.stopPlay(); Query.goto(S.step - 1, { scroll: true }); }
    if (e.key === ' ') { e.preventDefault(); Query.play(); }
  });

  // ───────────────────────── boot ─────────────────────────
  function boot() {
    const saved = loadState();
    if (saved) {
      S.stores = saved.stores.map((s) => Object.assign({ models: [], changes: [], tupleKeys: [], assertions: [], queries: [], pins: { schema: {}, model: {}, data: {} }, collapsed: [] }, s));
      S.activeStoreId = S.stores.some((s) => s.id === saved.activeStoreId) ? saved.activeStoreId : S.stores[0].id;
      Object.assign(S.ui, saved.ui || {});
    } else {
      const ex = FGA_EXAMPLES[0];
      S.stores = [makeStore(ex.name, { dsl: ex.dsl, tuples: ex.tuples, assertions: ex.assertions, queries: ex.queries, exampleId: ex.id })];
      S.activeStoreId = S.stores[0].id;
      S.ui.inspOpen = window.innerHeight >= 780;
      S.ui.inspHeight = Math.max(170, Math.min(260, Math.round(window.innerHeight * 0.24)));
    }
    S.ui.live = S.ui.live !== false; $('#q-live').setAttribute('aria-pressed', String(S.ui.live));
    setEditorTab(S.ui.editorTab || 'dsl');
    Graph.setSubjects(!!S.ui.subjectEdges); $('#btn-subjects').setAttribute('aria-pressed', String(!!S.ui.subjectEdges));
    if (S.ui.layout) Graph.setLayout(S.ui.layout);
    if (S.ui.cards) Graph.setCardsMode(S.ui.cards);
    setGraphMode(S.ui.graphMode || 'schema');
    toggleInspector(S.ui.inspOpen !== false);
    switchStore(S.activeStoreId);
    applyMobile();
    applyLayout();
    document.fonts && document.fonts.ready.then(() => { Graph.setMode(S.ui.graphMode); });
  }
  boot();
  window.__fga = { Graph };
/*__SHARE__*/
})();
