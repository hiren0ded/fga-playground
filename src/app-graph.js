  // ═══════════════════════════ GRAPH ═══════════════════════════
  // Three views over one model: schema (type cards), resolution (one relation's rewrite as a tree),
  // data (tuples). Shared systems: layout presets, pinned positions & drag, focus/selection,
  // highlight painting, minimap, zoom level of detail, search, flashes, connect-to-create and export.

  function buildSchemaGraph(model, base) {
    const mg = FGA.buildModelGraph(model);
    const relInfo = new Map(mg.nodes.filter((n) => n.kind === 'rel').map((n) => [n.id, n]));
    const baseRel = new Map();
    if (base) for (const t of base.types) for (const r of t.relations) baseRel.set(`${t.name}#${r.name}`, { type: t.name, rel: r.name, short: FGA.describeRewrite(r.rewrite), def: `define ${r.name}: ${FGA.describeRewrite(r.rewrite)}` });
    const nodes = model.types.map((t) => ({
      id: t.name, type: t.name, kind: 'card', label: t.name, line: t.line,
      diff: base && !base.typeMap.has(t.name) ? 'added' : null,
      rows: t.relations.map((r) => {
        const id = `${t.name}#${r.name}`;
        const info = relInfo.get(id) || {};
        const short = FGA.describeRewrite(r.rewrite);
        const b = baseRel.get(id);
        const diff = base ? (!b ? 'added' : b.short !== short ? 'changed' : null) : null;
        return { id, kind: 'rel', type: t.name, rel: r.name, label: r.name, name: r.name, def: info.def || `define ${r.name}: ${short}`, direct: info.direct || [], op: info.op || null, short, line: r.line, diff, was: b && diff === 'changed' ? b.short : null };
      }),
    }));
    if (base) {
      for (const [id, b] of baseRel) {
        if (relInfo.has(id)) continue;
        let card = nodes.find((n) => n.id === b.type);
        if (!card) { card = { id: b.type, type: b.type, kind: 'card', label: b.type, rows: [], diff: 'removed' }; nodes.push(card); }
        card.rows.push({ id, kind: 'rel', type: b.type, rel: b.rel, label: b.rel, name: b.rel, def: b.def, direct: [], op: null, short: b.short, diff: 'removed' });
      }
    }
    const edgeMap = (m) => {
      const byKey = new Map();
      for (const e of FGA.modelEdges(m)) {
        if (e.kind === 'computed') continue;
        const from = e.kind === 'direct' ? e.entry.type : e.parentType;
        const key = `${from}=>${e.type}|${e.kind}`;
        let g = byKey.get(key);
        if (!g) { g = { id: key, from, to: e.type, kind: e.kind, labels: [], gids: [], wildcard: false, conditions: [], ctx: 'union' }; byKey.set(key, g); }
        g.gids.push(e.gid);
        const label = e.kind === 'direct' ? e.relation + (e.entry.relation ? ` ⟵ #${e.entry.relation}` : '') : `${e.relation} ⇐ ${e.computed} from ${e.tupleset}`;
        if (!g.labels.includes(label)) g.labels.push(label);
        if (e.entry && e.entry.wildcard) g.wildcard = true;
        if (e.entry && e.entry.condition && !g.conditions.includes(e.entry.condition)) g.conditions.push(e.entry.condition);
        if (e.ctx === 'exclusion' && g.labels.length === 1) g.ctx = 'exclusion';
      }
      return byKey;
    };
    const cur = edgeMap(model);
    const edges = Array.from(cur.values());
    if (base) {
      const old = edgeMap(base);
      for (const e of edges) { const o = old.get(e.id); e.diff = !o ? 'added' : (o.labels.join('|') !== e.labels.join('|') ? 'changed' : null); }
      for (const [k, o] of old) if (!cur.has(k)) edges.push(Object.assign({}, o, { diff: 'removed' }));
    }
    return { nodes, edges };
  }
  // Resolution view: one relation's userset rewrite as a tree, the way Check walks it.
  //   rel ─ op (any of / all of / but not) ─ direct ─ subject types
  //                                        ├ computed relation (subtree)
  //                                        └ "X from Y" ─ the parent type's relation (subtree)
  // Relations nested deeper than `autoDepth` start collapsed; a relation already on its own ancestor
  // path is drawn once more as a ↻ marker instead of recursing. Edges that correspond to a model edge
  // carry that edge's gid so the resolver trace can light them up.
  function rewriteTree(model, rootKey, expanded, autoDepth = 1) {
    const nodes = [], edges = [];
    const [rootType, rootRel] = rootKey.split('#');
    const rootT = model.typeMap.get(rootType), rootR = rootT && rootT.relMap.get(rootRel);
    if (!rootR) return null;
    const relNode = (id, type, rel, depth, ancestors, viaKind) => {
      const t = model.typeMap.get(type), r = t && t.relMap.get(rel);
      const key = `${type}#${rel}`;
      const cycle = ancestors.includes(key);
      const node = { id, kind: 'rel', type, rel, key, label: key, depth, cycle, via: viaKind || null, def: r ? `define ${rel}: ${FGA.describeRewrite(r.rewrite)}` : `${key} is not defined`, direct: r ? r.directTypes.map(FGA.describeEntry) : [], line: r && r.line, children: 0 };
      nodes.push(node);
      if (!r || cycle) return node;
      const isExpanded = expanded.has(id) ? expanded.get(id) : depth <= autoDepth;
      node.expandable = true; node.expanded = isExpanded;
      if (!isExpanded) return node;
      // `rp` is this rewrite's position in the relation's rewrite tree (child indices from the root);
      // the engine stamps the same positions on its trace events (hl.rewrites) so each branch can light up.
      const sub = (rw, parentId, ctxLabel, ctx, rp) => {
        const idx = `${parentId}/${nodes.length}`;
        const rkey = `${key}|${rp.join('.')}`;
        switch (rw.kind) {
          case 'union': case 'intersection': {
            const op = { id: idx, kind: 'op', op: rw.kind, label: rw.kind === 'union' ? 'any of' : 'all of', glyph: rw.kind === 'union' ? '∨' : '∧', type, depth, rkey };
            nodes.push(op); edges.push({ id: `${parentId}>${idx}`, from: parentId, to: idx, kind: 'tree', label: ctxLabel, ctx });
            rw.children.forEach((c, i) => sub(c, idx, '', rw.kind === 'intersection' ? 'intersection' : 'union', rp.concat([i])));
            node.children++;
            return;
          }
          case 'difference': {
            const op = { id: idx, kind: 'op', op: 'difference', label: 'but not', glyph: '∖', type, depth, rkey };
            nodes.push(op); edges.push({ id: `${parentId}>${idx}`, from: parentId, to: idx, kind: 'tree', label: ctxLabel, ctx });
            sub(rw.base, idx, 'base', 'base', rp.concat([0]));
            sub(rw.subtract, idx, 'but not', 'exclusion', rp.concat([1]));
            node.children++;
            return;
          }
          case 'this': {
            const d = { id: idx, kind: 'direct', label: 'directly assigned', type, rel, key, depth, entries: rw.types.map(FGA.describeEntry), rkey };
            nodes.push(d); edges.push({ id: `${parentId}>${idx}`, from: parentId, to: idx, kind: 'tree', label: ctxLabel, ctx });
            rw.types.forEach((en, i) => {
              const sid = `${idx}/${i}`;
              if (en.relation) {
                const child = relNode(sid, en.type, en.relation, depth + 1, ancestors.concat([key]), 'userset');
                child.userset = true;
                edges.push({ id: `${idx}>${sid}`, from: idx, to: sid, kind: 'direct', gid: `${en.type}#${en.relation}=>${key}|direct`, label: en.condition ? `⚡ ${en.condition}` : 'members of', ctx });
              } else {
                nodes.push({ id: sid, kind: 'subject', type: en.type, label: en.wildcard ? `${en.type}:*` : en.type, subj: `${en.type}@self`, wildcard: !!en.wildcard, condition: en.condition || null, depth });
                edges.push({ id: `${idx}>${sid}`, from: idx, to: sid, kind: 'direct', gid: `${en.type}@self=>${key}|direct`, label: en.condition ? `⚡ ${en.condition}` : '', wildcard: !!en.wildcard, ctx });
              }
            });
            node.children++;
            return;
          }
          case 'computed': {
            const child = relNode(idx, type, rw.relation, depth + 1, ancestors.concat([key]), 'computed');
            edges.push({ id: `${parentId}>${idx}`, from: parentId, to: idx, kind: 'computed', gid: `${type}#${rw.relation}=>${key}|computed`, label: ctxLabel || 'implied by', ctx, rkey });
            node.children++;
            return;
          }
          case 'ttu': {
            const ts = t.relMap.get(rw.tupleset);
            const parents = ts ? Array.from(new Set(ts.directTypes.filter((e) => !e.relation && !e.wildcard).map((e) => e.type))) : [];
            const tt = { id: idx, kind: 'ttu', label: `${rw.computed} from ${rw.tupleset}`, tupleset: rw.tupleset, computed: rw.computed, type, key, depth, parents, rkey };
            nodes.push(tt); edges.push({ id: `${parentId}>${idx}`, from: parentId, to: idx, kind: 'tree', label: ctxLabel, ctx });
            parents.forEach((pt, i) => {
              const pr = model.typeMap.get(pt);
              if (!pr || !pr.relMap.has(rw.computed)) return;
              const sid = `${idx}/${i}`;
              relNode(sid, pt, rw.computed, depth + 1, ancestors.concat([key]), 'ttu');
              edges.push({ id: `${idx}>${sid}`, from: idx, to: sid, kind: 'ttu', gid: `${pt}#${rw.computed}=>${key}|ttu|${rw.tupleset}`, label: `each ${rw.tupleset} (${pt})`, ctx });
            });
            node.children++;
            return;
          }
          default:
        }
      };
      sub(r.rewrite, id, '', 'union', []);
      return node;
    };
    relNode(`R:${rootKey}`, rootType, rootRel, 0, [], null);
    return { nodes, edges, clusters: [] };
  }

  const PALETTE = ['#8ea2ff', '#38c7b5', '#f0a152', '#c58cff', '#f2c94c', '#5cc8ff', '#ff7f9f', '#8fd16e', '#ff9b6b', '#6fd0d8'];
  const REL_PALETTE = ['#7f93b8', '#38c7b5', '#e2a04a', '#b48cff', '#5cc8ff', '#ff8aa6', '#8fd16e', '#f2c94c', '#ff9b6b', '#6fd0d8', '#d49bff', '#9bd0ff'];
  const hashStr = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

  const Graph = (() => {
    const svg = d3.select('#graph-svg');
    const defs = svg.append('defs');
    const MARKERS = ['direct', 'computed', 'ttu', 'tree', 'exclusion', 'active', 'read', 'ok', 'fail', 'skip', 'in', 'out', 'ghost', 'added', 'removed'];
    MARKERS.forEach((k) => {
      defs.append('marker').attr('id', `arrow-${k}`).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5).attr('markerWidth', 11).attr('markerHeight', 11).attr('markerUnits', 'userSpaceOnUse').attr('orient', 'auto-start-reverse')
        .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('class', `mk mk-${k}`);
      defs.append('marker').attr('id', `arrow-s-${k}`).attr('viewBox', '0 0 10 10').attr('refX', 8).attr('refY', 5).attr('markerWidth', 6).attr('markerHeight', 6).attr('markerUnits', 'userSpaceOnUse').attr('orient', 'auto-start-reverse')
        .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('class', `mk mk-${k}`);
    });
    const root = svg.append('g').attr('class', 'viewport');
    const gClusters = root.append('g').attr('class', 'layer-clusters');
    const gEdges = root.append('g').attr('class', 'layer-edges');
    const gNodes = root.append('g').attr('class', 'layer-nodes');
    const gTemp = root.append('g').attr('class', 'layer-temp');
    const gBadges = root.append('g').attr('class', 'layer-badges');
    const stage = $('#graph-stage'), tip = $('#graph-tip'), empty = $('#graph-empty');
    const mini = d3.select('#minimap');
    let curT = d3.zoomIdentity;
    let userMoved = false; // the viewer panned/zoomed since the last fresh layout: don't re-fit under them
    const zoom = d3.zoom().scaleExtent([0.08, 4]).clickDistance(4).on('zoom', (e) => { curT = e.transform; root.attr('transform', e.transform); updateLod(e.transform.k); updateMinimap(); if (e.sourceEvent) userMoved = true; });
    svg.call(zoom).on('dblclick.zoom', null);
    const canvas = document.createElement('canvas').getContext('2d');
    const measure = (text, font) => { canvas.font = font; return canvas.measureText(text).width; };
    const MONO = '500 12px "JetBrains Mono", Menlo, monospace';
    const MONO_S = '500 11.5px "JetBrains Mono", Menlo, monospace';
    const DISPLAY = '700 12.5px "Bricolage Grotesque", sans-serif';

    // ── state
    let graphs = { schema: null, model: null, data: null };
    let mode = 'schema', layoutPreset = 'auto';
    let treeRoot = null, treeQueryKey = null, treeExpanded = new Map();
    // instance graph (data view): which objects open as cards with one slot per relation
    let cardsMode = 'path', pathObjects = new Set(), cardOverride = new Map(), storeRef = null, modelEdgesCache = null;
    let derivedOnly = false;
    let derivedAccess = null; // [{ user, relation, object, wildcard }] materialised access that no tuple states directly
    // proof walk: a numbered path (FGA.proofSteps) drawn over the data graph. `proofWalk` is pinned by a
    // click / a Check result; `proofPreview` follows the pointer over a derived edge.
    let proofWalk = null, proofPreview = null, proofObjects = new Set();
    // scope of the data view on big stores: 'auto' | 'all' | 'near' (around the query) | 'grouped' (by type)
    let scopeMode = 'auto', expandedNodes = new Set(), expandedTypes = new Set(), openBundles = new Set(), scopeInfo = null;
    const BIG = 60, BUNDLE_MIN = 3;
    // stable layout: last positions per view, reused when the graph changes only a little
    const prevPos = {}; let freshNext = false;
    // ELK (layered, port-aware, orthogonal edges) for the data view; loaded on first use
    let elk = null, elkLoading = null, elkFailed = false, layoutVersion = 0;
    // ELK results by graph shape: the same graph always gets the same picture (Reset, Tidy, coming back)
    const elkCache = new Map();
    const elkSig = (L) => viewKey() + '|' + L.nodes.map((n) => `${n.id}:${Math.round(n.width)}x${Math.round(n.height)}`).join(',') + '|' + L.edges.map((e) => `${e.from}>${e.to}:${e.fromSlot || ''}>${e.toSlot || ''}:${e.text || ''}`).join(',');
    let proofOrder = 'check'; // 'check' = numbered as Check resolves (object → subject); 'flow' = subject → goal
    let proofLock = false;    // locked: clicks on the graph cannot change the selection or clear the walk
    let typeIndex = new Map(), relIndex = new Map();
    let curVG = null, curL = null, bounds = null, lastStage = { w: 0, h: 0 }, insetBottom = 0;
    let currentHl = null, lastOpts = {}, hoverHl = null, focus = null;
    let hiddenRels = new Set(), collapsed = new Set();
    let pinned = { schema: {}, model: {}, data: {} };
    let history = [], hIndex = -1;
    let connectMode = false;
    let handlers = {};
    let modelRef = null;
    const colorOf = (type) => PALETTE[(typeIndex.has(type) ? typeIndex.get(type) : typeIndex.size + hashStr(type)) % PALETTE.length];
    const relColor = (rel) => REL_PALETTE[(relIndex.has(rel) ? relIndex.get(rel) : hashStr(rel)) % REL_PALETTE.length];
    const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');
    const emit = (k, ...a) => { if (handlers[k]) return handlers[k](...a); return undefined; };

    // ── public setters
    function setData({ schema, model, data, types, relations, modelObj, store, derived, derivedOnly: only }) {
      if (only !== undefined) derivedOnly = !!only;
      graphs = { schema, model, data };
      modelRef = modelObj || null;
      storeRef = store || null;
      if (derived !== undefined) derivedAccess = derived;
      modelEdgesCache = modelRef ? FGA.modelEdges(modelRef) : null;
      cardOverride.forEach((v, id) => { if (!(data && data.nodes.some((n) => n.id === id))) cardOverride.delete(id); });
      typeIndex = new Map(types.map((t, i) => [t, i]));
      relIndex = new Map((relations || []).map((r, i) => [r, i]));
      hiddenRels.forEach((r) => { if (!relIndex.has(r)) hiddenRels.delete(r); });
      render(true);
    }
    function setMode(m) { mode = m; focus = null; hoverHl = null; render(false); }
    function setLayout(p) { layoutPreset = p; freshNext = true; userMoved = false; render(true); }
    function setSubjects() { /* kept for API compatibility; the resolution view has no subject fan-out */ }
    // instance graph: 'path' = cards for the objects the current query touched, 'all', or 'none'
    function setCardsMode(m) { if (!['path', 'all', 'none'].includes(m)) m = 'path'; if (m === cardsMode) return; cardsMode = m; cardOverride.clear(); if (mode === 'data') render(true); }
    function setPathObjects(ids) {
      const next = new Set((ids || []).filter(Boolean));
      const same = next.size === pathObjects.size && Array.from(next).every((x) => pathObjects.has(x));
      pathObjects = next;
      if (!same && mode === 'data' && cardsMode === 'path') render(true);
    }
    function toggleCard(id, on) { cardOverride.set(id, !!on); render(true); }
    // only: draw just the derived grants (who has access that no tuple states), not the tuples themselves
    function setDerived(list, only) { derivedAccess = list || null; derivedOnly = !!(list && only); freshNext = true; if (mode === 'data') render(true); }
    // resolution view: which relation is drawn. null = follow the current query.
    function resolutionKey() {
      if (!modelRef) return null;
      const ok = (k) => { if (!k) return false; const [t, r] = k.split('#'); const tt = modelRef.typeMap.get(t); return !!(tt && tt.relMap.has(r)); };
      if (ok(treeRoot)) return treeRoot;
      if (ok(treeQueryKey)) return treeQueryKey;
      for (const t of modelRef.types) if (t.relations.length) return `${t.name}#${t.relations[0].name}`;
      return null;
    }
    function setResolutionRoot(key) { treeRoot = key || null; treeExpanded = new Map(); if (mode === 'model') { focus = null; render(true); } emit('rootChanged', treeRoot); }
    function setQueryRelation(key) { if (key === treeQueryKey) return; treeQueryKey = key || null; if (mode === 'model' && !treeRoot) { treeExpanded = new Map(); focus = null; render(true); } }
    function toggleExpand(id, on) { treeExpanded.set(id, on); render(true); }
    function setPins(p) { pinned = Object.assign({ schema: {}, model: {}, data: {} }, p || {}); }
    function setCollapsed(list) { collapsed = new Set(list || []); }
    // dragged positions belong to the picture they were dragged in: in the data view a different layout
    // preset or card setting is a different picture (cards are much bigger), so it gets its own pins
    const pinKey = () => (mode === 'data' ? `data|${layoutPreset}|${cardsMode}` : mode);
    const pinsNow = () => pinned[pinKey()] || (pinned[pinKey()] = {});
    function resetLayout() { pinned[pinKey()] = {}; emit('positions', pinned); render(true); }

    // ── view graphs: what each mode actually draws
    function viewGraph() {
      const g0 = graphs[mode];
      if (!g0 || !g0.nodes.length) return null;
      if (mode === 'schema') {
        const nodes = g0.nodes.map((n) => Object.assign({}, n, { collapsed: collapsed.has(n.id) }));
        return { nodes, edges: g0.edges.map((e) => Object.assign({}, e)), clusters: [] };
      }
      if (mode === 'model') {
        const key = resolutionKey();
        if (!key || !modelRef) return null;
        return rewriteTree(modelRef, key, treeExpanded);
      }
      const vg = instanceGraph(scopeGraph(g0));
      bundleSubjects(vg);
      return vg;
    }
    // ── scope: on big stores show the neighbourhood of the query, or one node per type
    function scopeGraph(g0) {
      const total = g0.nodes.length;
      const seeds = new Set();
      const has = new Set(g0.nodes.map((n) => n.id));
      const addSeed = (id) => { if (!id) return; const o = id.split('#')[0]; if (has.has(o)) seeds.add(o); };
      pathObjects.forEach(addSeed); proofObjects.forEach(addSeed); expandedNodes.forEach(addSeed);
      if (proofWalk) proofWalk.steps.forEach((st) => { addSeed(st.from); addSeed(st.to); });
      if (focus) focus.nodes.forEach(addSeed);
      const eff = scopeMode === 'auto' ? (total <= BIG ? 'all' : seeds.size ? 'near' : 'grouped') : scopeMode === 'near' && !seeds.size ? 'grouped' : scopeMode;
      scopeInfo = { mode: scopeMode, eff, total, shown: total };
      if (eff === 'all') return g0;
      if (eff === 'near') {
        const adj = new Map();
        const link = (a, b) => { (adj.get(a) || adj.set(a, new Set()).get(a)).add(b); };
        g0.edges.forEach((e) => { link(e.from, e.to); link(e.to, e.from); });
        const keep = new Set(seeds);
        let frontier = Array.from(seeds);
        for (let d = 0; d < 2; d++) { const next = []; frontier.forEach((v) => (adj.get(v) || []).forEach((w) => { if (!keep.has(w)) { keep.add(w); next.push(w); } })); frontier = next; }
        expandedNodes.forEach((v) => (adj.get(v) || []).forEach((w) => keep.add(w)));
        const nodes = g0.nodes.filter((n) => keep.has(n.id)).map((n) => { const more = Array.from(adj.get(n.id) || []).filter((w) => !keep.has(w)).length; return more ? Object.assign({}, n, { more }) : n; });
        scopeInfo.shown = nodes.length;
        return { nodes, edges: g0.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
      }
      // grouped: one node per type unless the type is small, expanded, or holds a seed
      const byType = new Map();
      g0.nodes.forEach((n) => { (byType.get(n.type) || byType.set(n.type, []).get(n.type)).push(n); });
      const groupOf = new Map();
      const nodes = [];
      byType.forEach((list, type) => {
        if (list.length <= 3 || expandedTypes.has(type)) { nodes.push(...list); return; }
        const gid = `grp:${type}`;
        const kept = list.filter((n) => seeds.has(n.id));
        nodes.push(...kept);
        const rest = list.filter((n) => !seeds.has(n.id));
        rest.forEach((n) => groupOf.set(n.id, gid));
        nodes.push({ id: gid, type, kind: 'group', label: `${type} ×${rest.length}`, members: rest.map((n) => n.id), tuples: [].concat(...rest.map((n) => n.tuples || [])) });
      });
      const map = (id) => groupOf.get(id) || id;
      const edges = g0.edges.map((e) => Object.assign({}, e, { from: map(e.from), to: map(e.to), userset: groupOf.has(e.from) ? null : e.userset })).filter((e) => e.from !== e.to);
      scopeInfo.shown = nodes.length;
      return { nodes, edges };
    }
    // ── bundling: plain subjects of one type whose only edge goes to the same place become one node
    function bundleSubjects(vg) {
      if (!vg) return;
      const protect = new Set();
      Object.keys((currentHl && currentHl.dataNodes) || {}).forEach((k) => protect.add(k.split('#')[0]));
      if (proofWalk) proofWalk.steps.forEach((st) => { if (st.from) protect.add(st.from.split('#')[0]); });
      if (focus) focus.nodes.forEach((id) => protect.add(id));
      Object.keys(pinned[pinKey()] || {}).forEach((id) => protect.add(id));
      const deg = new Map();
      vg.edges.forEach((e) => { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); });
      const byId = new Map(vg.nodes.map((n) => [n.id, n]));
      const groups = new Map();
      vg.edges.forEach((e) => {
        const n = byId.get(e.from);
        if (!n || n.kind !== 'object' || n.expandable || e.kind !== 'tuple' || e.fromSlot || deg.get(n.id) !== 1 || protect.has(n.id)) return;
        const key = `${n.type}|${e.toSlot || e.to}|${e.rels.join(',')}${e.conditions.length ? '|c' : ''}`;
        if (openBundles.has(key)) return;
        (groups.get(key) || groups.set(key, []).get(key)).push(e);
      });
      groups.forEach((list, key) => {
        if (list.length < BUNDLE_MIN) return;
        const members = list.map((e) => e.from), first = list[0], type = byId.get(first.from).type;
        const bid = `bnd:${key}`;
        const drop = new Set(members);
        vg.nodes = vg.nodes.filter((n) => !drop.has(n.id));
        vg.nodes.push({ id: bid, kind: 'bundle', type, key, members, label: `${members.length} ${type}s`, tuples: [].concat(...members.map((m) => (byId.get(m).tuples || []))) });
        vg.edges = vg.edges.filter((e) => !list.includes(e));
        vg.edges.push(Object.assign({}, first, { id: `bnd-e:${key}`, from: bid, tupleIds: [].concat(...list.map((e) => e.tupleIds)), bundled: members.length, label: first.label, labels: first.labels }));
      });
    }
    function setScope(m) { if (!['auto', 'all', 'near', 'grouped'].includes(m)) m = 'auto'; scopeMode = m; expandedNodes.clear(); expandedTypes.clear(); freshNext = true; if (mode === 'data') render(true); }
    function expandNode(id) { expandedNodes.add(id); if (mode === 'data') render(true); }
    function expandGroup(type) { expandedTypes.add(type); if (mode === 'data') render(true); }
    function openBundle(key) { openBundles.add(key); if (mode === 'data') render(true); }
    // ── instance graph (data view)
    // OpenFGA reasons about usersets — `doc:roadmap#viewer`, not `doc:roadmap` — so an object whose type has
    // relations can open as a card with one slot per relation. Tuples then point at the slot they grant,
    // userset subjects start from a slot on their own card, computed relations become links between the
    // rows of one card, and "X from Y" becomes a derived edge from the parent's slot to the child's.
    // Objects that stay plain nodes keep the classic one-edge-per-tuple drawing.
    // When a pinned proof walk asks for "only the path", the data view is reduced to exactly the
    // nodes, slots, tuples and derivations the proof uses — nothing else is laid out at all.
    function proofFilter() {
      const walk = proofWalk;
      if (!walk || !walk.only) return null;
      const f = { nodes: new Set(), slots: new Set(), tuples: new Set(), ttu: new Set(), gids: new Set() };
      walk.steps.forEach((st) => {
        [st.from, st.to].forEach((k) => { if (!k) return; if (k.includes('#')) { f.slots.add(k); f.nodes.add(k.split('#')[0]); } else f.nodes.add(k); });
        if (st.fromObject) f.nodes.add(st.fromObject);
        if (st.object) f.nodes.add(st.object);
        if (st.kind === 'tuple' && st.tupleId != null) f.tuples.add(st.tupleId);
        if (st.kind === 'ttu') { f.ttu.add(`${st.tupleId}|${st.relation}`); f.tuples.add(st.tupleId); }
        if (st.gid) f.gids.add(st.gid);
        if ((st.kind === 'and' || st.kind === 'not') && st.object && st.relation) f.slots.add(`${st.object}#${st.relation}`);
      });
      return f;
    }
    function instanceGraph(g0) {
      const m = modelRef, store = storeRef;
      const pf = proofFilter();
      const typeOf = (t) => (m ? m.typeMap.get(t) : null);
      const canCard = (n) => { if (n.kind !== 'object') return false; const t = typeOf(n.type); return !!(t && t.relations.length); };
      const wantCard = (n) => { if (!canCard(n)) return false; if (proofObjects.has(n.id)) return true; if (cardOverride.has(n.id)) return cardOverride.get(n.id); return cardsMode === 'all' ? true : cardsMode === 'none' ? false : pathObjects.has(n.id); };
      const nodes = (pf ? g0.nodes.filter((n) => pf.nodes.has(n.id)) : g0.nodes).map((n) => {
        if (!wantCard(n)) return Object.assign({}, n, { expandable: canCard(n) });
        const t = typeOf(n.type);
        const rels = pf ? t.relations.filter((r) => pf.slots.has(`${n.id}#${r.name}`)) : t.relations;
        if (!rels.length) return Object.assign({}, n, { expandable: false });
        const rows = rels.map((r) => ({ id: `${n.id}#${r.name}`, kind: 'slot', rel: r.name, object: n.id, type: n.type, label: `${n.id}#${r.name}`, def: `define ${r.name}: ${FGA.describeRewrite(r.rewrite)}`, short: FGA.describeRewrite(r.rewrite), direct: 0, derived: 0, directTypes: r.directTypes.map(FGA.describeEntry), line: r.line }));
        return Object.assign({}, n, { kind: 'inst', card: true, rows, rowMap: new Map(rows.map((r) => [r.rel, r])), links: [] });
      });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const groups = new Map();
      for (const e of g0.edges) {
        if (pf && !pf.tuples.has(e.tupleId)) continue;
        if (!byId.has(e.from) || !byId.has(e.to)) continue;
        const toN = byId.get(e.to), fromN = byId.get(e.from);
        const toSlot = toN.kind === 'inst' && toN.rowMap.has(e.label) ? `${e.to}#${e.label}` : null;
        const fromSlot = e.userset && fromN.kind === 'inst' && fromN.rowMap.has(e.userset) ? `${e.from}#${e.userset}` : null;
        const key = `g:${fromSlot || e.from}→${toSlot || e.to}`;
        let gr = groups.get(key);
        if (!gr) { gr = { id: key, from: e.from, to: e.to, fromSlot, toSlot, tupleIds: [], rels: [], labels: [], usersets: [], conditions: [], contextual: false, wildcard: /:\*$/.test(e.from), kind: 'tuple' }; groups.set(key, gr); }
        gr.tupleIds.push(e.tupleId);
        if (!gr.rels.includes(e.label)) gr.rels.push(e.label);
        const lbl = toSlot ? ((e.userset && !fromSlot ? `#${e.userset}` : '') + (e.condition ? ' ⚡' : '')).trim() : e.label + (e.userset ? ` ⟵ #${e.userset}` : '') + (e.condition ? ' ⚡' : '');
        if (lbl) gr.labels.push(lbl);
        if (e.userset && !gr.usersets.includes(e.userset)) gr.usersets.push(e.userset);
        if (e.condition && !gr.conditions.includes(e.condition)) gr.conditions.push(e.condition);
        if (e.contextual) gr.contextual = true;
        if (toSlot) toN.rowMap.get(e.label).direct++;
      }
      const edges = Array.from(groups.values());
      edges.forEach((e) => { e.rel = e.rels[0]; e.label = Array.from(new Set(e.labels)).join(', '); });
      // derived structure: computed links inside a card, tuple-to-userset edges into a card
      if (m && store && modelEdgesCache) {
        nodes.forEach((n) => {
          if (n.kind !== 'inst') return;
          for (const me of modelEdgesCache) {
            if (me.type !== n.type) continue;
            if (me.kind === 'computed') {
              if (!n.rowMap.has(me.via) || !n.rowMap.has(me.relation)) continue;
              if (pf && !pf.gids.has(me.gid)) continue;
              n.links.push({ id: `cmp:${n.id}:${me.via}>${me.relation}`, from: me.via, to: me.relation, gid: me.gid, ctx: me.ctx, object: n.id });
              n.rowMap.get(me.relation).derived++;
            } else if (me.kind === 'ttu') {
              if (!n.rowMap.has(me.relation)) continue;
              for (const t of store.read(n.id, me.tupleset)) {
                if (t.user.relation || t.user.wildcard || t.user.type !== me.parentType) continue;
                if (pf && !pf.ttu.has(`${t.id}|${me.relation}`)) continue;
                const pid = `${t.user.type}:${t.user.id}`; const pn = byId.get(pid); if (!pn) continue;
                const fromSlot = pn.kind === 'inst' && pn.rowMap.has(me.computed) ? `${pid}#${me.computed}` : null;
                edges.push({ id: `ttu:${t.id}:${me.relation}`, kind: 'ttu', derived: true, from: pid, to: n.id, fromSlot, toSlot: `${n.id}#${me.relation}`, tupleIds: [t.id], tupleId: t.id, rel: me.relation, rels: [me.relation], labels: [], usersets: [], conditions: [], contextual: !!t.contextual, wildcard: false, gid: me.gid, ctx: me.ctx, tupleset: me.tupleset, computed: me.computed, label: fromSlot ? `from ${me.tupleset}` : `${me.computed} from ${me.tupleset}` });
                n.rowMap.get(me.relation).derived++;
              }
            }
          }
        });
      }
      // materialised access: who ends up holding each relation without a tuple saying so
      if (derivedAccess && !pf) {
        const seen = new Set(edges.map((e) => `${e.fromSlot || e.from}|${e.toSlot || e.to}`));
        for (const d of derivedAccess) {
          const fromN = byId.get(d.user), toN = byId.get(d.object);
          if (!fromN || !toN) continue;
          const toSlot = toN.kind === 'inst' && toN.rowMap.has(d.relation) ? `${d.object}#${d.relation}` : null;
          const id = `drv:${d.user}→${d.object}#${d.relation}`;
          if (seen.has(`${d.user}|${toSlot || d.object}`) && !toSlot && !derivedOnly) continue; // a plain node already has a tuple edge from this subject
          // into a plain node, one edge per subject → object pair carries every derived relation
          const same = !toSlot && edges.find((x) => x.kind === 'derived' && x.access && !x.toSlot && x.from === d.user && x.to === d.object);
          if (same) { same.allRels.push(d.relation); same.label = `${same.allRels[0]} +${same.allRels.length - 1}`; continue; }
          edges.push({ id, kind: 'derived', access: true, from: d.user, to: d.object, fromSlot: null, toSlot, tupleIds: [], rel: d.relation, rels: [d.relation], labels: [], usersets: [], conditions: [], contextual: false, wildcard: !!d.wildcard, label: toSlot ? '' : d.relation, user: d.user, relation: d.relation, object: d.object, allRels: [d.relation] });
          if (toSlot) toN.rowMap.get(d.relation).derived++;
        }
      }
      if (derivedAccess && derivedOnly && !pf) {
        // keep the derived grants and only the nodes they connect; rows light up for derived access only
        const kept = edges.filter((e) => e.kind === 'derived');
        const ends = new Set(); kept.forEach((e) => { ends.add(e.from); ends.add(e.to); });
        edges.length = 0; kept.forEach((e) => edges.push(e));
        for (let i = nodes.length - 1; i >= 0; i--) if (!ends.has(nodes[i].id)) nodes.splice(i, 1);
        nodes.forEach((n) => { if (n.rows) n.rows.forEach((r) => { r.direct = 0; }); });
      }
      const pairs = new Set(edges.map((e) => `${e.from}|${e.to}`));
      edges.forEach((e) => { e.reverse = pairs.has(`${e.to}|${e.from}`); });
      return { nodes, edges, clusters: [] };
    }

    // ── sizes
    const CARD_W_MAX = 380, HDR = 28, ROW = 19;
    function sizeNode(n) {
      if (n.kind === 'card') {
        const rows = n.collapsed ? [] : n.rows;
        const nameW = Math.max(0, ...n.rows.map((r) => measure(r.name, MONO_S)));
        n.nameColW = Math.ceil(nameW) + 14;
        let w = Math.max(measure(`type ${n.label}`, DISPLAY) + 70, 150);
        n.rows.forEach((r) => { r.defShort = r.short; w = Math.max(w, 12 + n.nameColW + measure(r.short, MONO_S) + 16 + (r.op ? 16 : 0) + (r.diff ? 10 : 0)); });
        w = Math.min(CARD_W_MAX, Math.ceil(w));
        n.rows.forEach((r) => {
          const room = w - 12 - n.nameColW - 16 - (r.op ? 16 : 0) - (r.diff ? 10 : 0);
          if (measure(r.short, MONO_S) > room) { let t = r.short; while (t.length > 4 && measure(t + '…', MONO_S) > room) t = t.slice(0, -1); r.defShort = t + '…'; }
        });
        n.width = w; n.height = HDR + (rows.length ? 8 + rows.length * ROW + 6 : 0);
        return;
      }
      if (mode === 'model') {
        if (n.kind === 'rel') { n.width = Math.ceil(measure(n.label, MONO)) + 30 + (n.expandable ? 22 : 0) + (n.cycle ? 22 : 0); n.height = 30; return; }
        if (n.kind === 'op') { n.width = Math.ceil(measure(n.label, MONO_S)) + 40; n.height = 26; return; }
        if (n.kind === 'ttu') { n.width = Math.ceil(measure(n.label, MONO_S)) + 28; n.height = 26; return; }
        if (n.kind === 'direct') { n.width = Math.ceil(measure(n.label, MONO_S)) + 28; n.height = 24; return; }
        n.width = Math.ceil(measure(n.label, MONO)) + 26 + (n.condition ? measure(` ⚡${n.condition}`, MONO_S) + 4 : 0); n.height = 26; // subject
        return;
      }
      if (n.kind === 'inst') {
        const nameW = Math.max(0, ...n.rows.map((r) => measure(r.rel, MONO_S)));
        n.nameColW = Math.ceil(nameW) + 14;
        n.arcW = n.links.length ? 20 + Math.min(n.links.length, 4) * 3 : 0;
        let w = Math.max(measure(n.label, MONO) + 12 + 14 + measure(n.type, MONO_S) + 12 + 22, 170);
        n.rows.forEach((r) => { r.defShort = r.short; w = Math.max(w, 12 + n.nameColW + measure(r.short, MONO_S) + 16 + n.arcW); });
        w = Math.min(CARD_W_MAX, Math.ceil(w));
        n.rows.forEach((r) => {
          const room = w - 12 - n.nameColW - 16 - n.arcW;
          if (measure(r.short, MONO_S) > room) { let t = r.short; while (t.length > 4 && measure(t + '…', MONO_S) > room) t = t.slice(0, -1); r.defShort = t + '…'; }
        });
        n.width = w; n.height = HDR + 8 + n.rows.length * ROW + 6;
        return;
      }
      if (n.kind === 'group' || n.kind === 'bundle') { n.width = Math.ceil(measure(n.label, MONO)) + 50; n.height = 34; return; }
      n.moreW = n.more ? Math.ceil(measure(`+${n.more}`, MONO_S)) + 14 : 0;
      n.width = Math.ceil(measure(n.label, MONO)) + 28 + (n.kind === 'wildcard' ? 14 : 0) + (n.expandable ? 18 : 0) + (n.moreW ? n.moreW + 6 : 0);
      n.height = 30;
    }
    // y of a slot row's centre, relative to the card's top edge
    const rowCentre = (i) => HDR + 8 + i * ROW + 8.5;
    function slotPoint(card, slotId, towardX) {
      const i = card.rows.findIndex((r) => r.id === slotId);
      if (i < 0) return null;
      const right = towardX >= card.x;
      return { x: card.x + (right ? card.width / 2 : -card.width / 2), y: card.y - card.height / 2 + rowCentre(i) };
    }
    function schemaEdgeText(e) {
      const labels = e.labels.length > 3 ? e.labels.slice(0, 3).concat([`+${e.labels.length - 3}`]) : e.labels;
      return labels.join(', ') + (e.wildcard ? '  *' : '') + (e.conditions.length ? '  ⚡' : '');
    }
    function edgeText(e) {
      if (mode === 'schema') return schemaEdgeText(e);
      if (e.access) return e.label ? `⇢ ${e.label}` : '';
      return e.label || '';
    }

    // ── layouts
    function layoutDagre(vg, rankdir) {
      const compound = false;
      const dg = new dagre.graphlib.Graph({ compound, multigraph: true });
      const hasCards = mode === 'data' && vg.nodes.some((n) => n.kind === 'inst');
      const sep = mode === 'schema' ? { nodesep: rankdir === 'LR' ? 40 : 70, ranksep: rankdir === 'LR' ? 130 : 90, edgesep: 24 } : mode === 'model' ? { nodesep: rankdir === 'LR' ? 14 : 18, ranksep: rankdir === 'LR' ? 70 : 46, edgesep: 8 } : hasCards ? { nodesep: 26, ranksep: rankdir === 'LR' ? 120 : 80, edgesep: 14 } : { nodesep: 22, ranksep: rankdir === 'LR' ? 100 : 72, edgesep: 14 };
      dg.setGraph(Object.assign({ rankdir, marginx: 28, marginy: 30, compound }, sep));
      dg.setDefaultEdgeLabel(() => ({}));
      vg.nodes.forEach((n) => { sizeNode(n); dg.setNode(n.id, { width: n.width, height: n.height }); });
      vg.edges.forEach((e, i) => {
        e.text = edgeText(e);
        const lw = e.from === e.to || !e.text ? 0 : Math.ceil(measure(e.text, MONO_S) * 0.92) + 14;
        dg.setEdge(e.from, e.to, { labelpos: 'c', width: lw, height: lw ? 18 : 0, weight: e.kind === 'computed' ? 2 : 1 }, `e${i}`);
      });
      dagre.layout(dg);
      const nodes = vg.nodes.map((n) => Object.assign(n, { x: dg.node(n.id).x, y: dg.node(n.id).y }));
      const edges = vg.edges.map((e, i) => { const le = dg.edge(e.from, e.to, `e${i}`) || {}; return Object.assign(e, { points: mode === 'schema' ? null : (le.points || []).map((p) => ({ x: p.x, y: p.y })), lx: mode === 'schema' ? undefined : le.x, ly: mode === 'schema' ? undefined : le.y }); });
      markParallel(edges);
      return { nodes, edges, clusters: vg.clusters };
    }
    function markParallel(edges) {
      const groups = new Map();
      edges.forEach((e) => { const a = e.fromSlot || e.from, b = e.toSlot || e.to; const k = a < b ? `${a}|${b}` : `${b}|${a}`; (groups.get(k) || groups.set(k, []).get(k)).push(e); });
      groups.forEach((list) => { if (list.length === 1) { list[0].bend = 0; return; } list.forEach((e, i) => { const sign = e.from < e.to ? 1 : -1; e.bend = sign * (i - (list.length - 1) / 2) * 34; }); });
    }
    function layoutLanes(vg) {
      vg.nodes.forEach(sizeNode);
      vg.edges.forEach((e) => { e.text = edgeText(e); e.points = null; });
      markParallel(vg.edges);
      const types = Array.from(new Set(vg.nodes.map((n) => n.type)));
      const rank = new Map(types.map((t) => [t, 0]));
      const byId = new Map(vg.nodes.map((n) => [n.id, n]));
      for (let it = 0; it < 12; it++) {
        let changed = false;
        for (const e of vg.edges) {
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b || a.type === b.type) continue;
          if (rank.get(b.type) < rank.get(a.type) + 1) { rank.set(b.type, rank.get(a.type) + 1); changed = true; }
        }
        if (!changed) break;
      }
      const cols = new Map();
      vg.nodes.forEach((n) => { const c = rank.get(n.type); if (!cols.has(c)) cols.set(c, []); cols.get(c).push(n); });
      const order = Array.from(cols.keys()).sort((a, b) => a - b);
      const nbrs = new Map();
      vg.edges.forEach((e) => { (nbrs.get(e.from) || nbrs.set(e.from, []).get(e.from)).push(e.to); (nbrs.get(e.to) || nbrs.set(e.to, []).get(e.to)).push(e.from); });
      let x = 40;
      const rowGap = 14;
      order.forEach((c, ci) => {
        const list = cols.get(c);
        list.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
        if (ci > 0) {
          const prevY = new Map(order.slice(0, ci).flatMap((pc) => cols.get(pc)).map((n) => [n.id, n.y]));
          const bary = (n) => { const ys = (nbrs.get(n.id) || []).map((id) => prevY.get(id)).filter((v) => v != null); return ys.length ? ys.reduce((s, v) => s + v, 0) / ys.length : Infinity; };
          list.sort((a, b) => { const ba = bary(a), bb = bary(b); if (ba !== bb) return ba - bb; return a.label.localeCompare(b.label); });
        }
        const colW = Math.max(...list.map((n) => n.width));
        let y = 40;
        list.forEach((n) => { n.x = x + colW / 2; n.y = y + n.height / 2; y += n.height + rowGap; });
        x += colW + 150;
      });
      // centre columns vertically
      const maxH = Math.max(...order.map((c) => cols.get(c).reduce((s, n) => s + n.height + rowGap, 0)));
      order.forEach((c) => { const list = cols.get(c); const h = list.reduce((s, n) => s + n.height + rowGap, 0); const off = (maxH - h) / 2; list.forEach((n) => { n.y += off; }); });
      return { nodes: vg.nodes, edges: vg.edges, clusters: [] };
    }
    function layoutForce(vg) {
      vg.nodes.forEach(sizeNode);
      vg.edges.forEach((e) => { e.text = edgeText(e); e.points = null; });
      // seeded, so the same graph settles the same way every time
      let seed = 1234567; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      const nodes = vg.nodes.map((n) => Object.assign(n, { x: n.x ?? rnd() * 600, y: n.y ?? rnd() * 400 }));
      markParallel(vg.edges);
      const links = vg.edges.map((e) => ({ source: e.from, target: e.to }));
      const sim = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id((d) => d.id).distance(130).strength(0.6))
        .force('charge', d3.forceManyBody().strength(-520))
        .force('collide', d3.forceCollide((d) => Math.max(d.width, d.height) / 2 + 18))
        .force('x', d3.forceX(0).strength(0.03)).force('y', d3.forceY(0).strength(0.05))
        .stop();
      if (sim.randomSource) sim.randomSource(rnd);
      for (let i = 0; i < 320; i++) sim.tick();
      separate({ nodes }, new Set());
      const minX = Math.min(...nodes.map((n) => n.x - n.width / 2)), minY = Math.min(...nodes.map((n) => n.y - n.height / 2));
      nodes.forEach((n) => { n.x = n.x - minX + 40; n.y = n.y - minY + 40; delete n.vx; delete n.vy; delete n.index; });
      return { nodes: vg.nodes, edges: vg.edges, clusters: [] };
    }
    function layoutRadial(vg, centerId) {
      vg.nodes.forEach(sizeNode);
      vg.edges.forEach((e) => { e.text = edgeText(e); e.points = null; });
      markParallel(vg.edges);
      const byId = new Map(vg.nodes.map((n) => [n.id, n]));
      const adj = new Map();
      vg.edges.forEach((e) => { (adj.get(e.from) || adj.set(e.from, []).get(e.from)).push(e.to); (adj.get(e.to) || adj.set(e.to, []).get(e.to)).push(e.from); });
      let center = centerId && byId.has(centerId) ? centerId : null;
      if (!center) { let best = null, bd = -1; vg.nodes.forEach((n) => { const d = (adj.get(n.id) || []).length; if (d > bd) { bd = d; best = n.id; } }); center = best; }
      const ring = new Map([[center, 0]]);
      const parent = new Map();
      let frontier = [center];
      while (frontier.length) { const next = []; for (const v of frontier) for (const w of adj.get(v) || []) if (!ring.has(w)) { ring.set(w, ring.get(v) + 1); parent.set(w, v); next.push(w); } frontier = next; }
      const maxRing = Math.max(0, ...ring.values());
      vg.nodes.forEach((n) => { if (!ring.has(n.id)) ring.set(n.id, maxRing + 1); });
      const rings = new Map();
      vg.nodes.forEach((n) => { const r = ring.get(n.id); (rings.get(r) || rings.set(r, []).get(r)).push(n); });
      // rings: each ring spread evenly, ordered by the parent's angle so branches stay together
      const angle = new Map([[center, 0]]);
      let radius = 0;
      const R = [0];
      const maxR = Math.max(...rings.keys());
      for (let r = 1; r <= maxR; r++) {
        const list = rings.get(r) || [];
        const need = list.reduce((s, n) => s + n.width + 30, 0) / (2 * Math.PI);
        radius = Math.max(radius + 150, need);
        R[r] = radius;
        list.sort((a, b) => ((angle.get(parent.get(a.id)) ?? 0) - (angle.get(parent.get(b.id)) ?? 0)) || a.label.localeCompare(b.label));
        const start = -Math.PI / 2 + (r % 2 ? 0 : Math.PI / Math.max(1, list.length));
        list.forEach((n, i) => angle.set(n.id, start + (2 * Math.PI * i) / list.length));
      }
      vg.nodes.forEach((n) => { const r = R[ring.get(n.id)] || 0; const a = angle.get(n.id) || 0; n.x = 60 + radius + r * Math.cos(a); n.y = 60 + radius + r * Math.sin(a); });
      return { nodes: vg.nodes, edges: vg.edges, clusters: [] };
    }
    function bestOf(fn) {
      const w = stage.clientWidth || 800, h = stage.clientHeight || 500;
      const snapshot = JSON.parse(JSON.stringify({ nodes: curVG.nodes.map((n) => ({ id: n.id })), }));
      const a = fn('LR');
      const ba = boundsOf(a);
      const ka = Math.min(w / ba.w, h / ba.h);
      if (ba.w <= w && ba.h <= h && ka > 0.9) return a;
      const pa = a.nodes.map((n) => ({ x: n.x, y: n.y })), pe = a.edges.map((e) => ({ points: e.points, lx: e.lx, ly: e.ly }));
      const b = fn('TB');
      const bb = boundsOf(b);
      const kb = Math.min(w / bb.w, h / bb.h);
      if (kb > ka * 1.15) return b;
      a.nodes.forEach((n, i) => { n.x = pa[i].x; n.y = pa[i].y; }); a.edges.forEach((e, i) => { e.points = pe[i].points; e.lx = pe[i].lx; e.ly = pe[i].ly; });
      void snapshot;
      return a;
    }
    function boundsOf(L) {
      const xs0 = [], xs1 = [], ys0 = [], ys1 = [];
      L.nodes.forEach((n) => { xs0.push(n.x - n.width / 2); xs1.push(n.x + n.width / 2); ys0.push(n.y - n.height / 2); ys1.push(n.y + n.height / 2); });
      (L.clusters || []).forEach((c) => { if (c.width) { xs0.push(c.x - c.width / 2); xs1.push(c.x + c.width / 2); ys0.push(c.y - c.height / 2); ys1.push(c.y + c.height / 2); } });
      L.edges.forEach((e) => (e.points || []).forEach((p) => { xs0.push(p.x); xs1.push(p.x); ys0.push(p.y); ys1.push(p.y); }));
      const x0 = Math.min(...xs0) - 30, x1 = Math.max(...xs1) + 30, y0 = Math.min(...ys0) - 30, y1 = Math.max(...ys1) + 30;
      return { x0, y0, x1, y1, w: Math.max(10, x1 - x0), h: Math.max(10, y1 - y0) };
    }
    function runLayout(vg) {
      const center = focus && focus.nodes[0];
      let L;
      if (layoutPreset === 'LR' || layoutPreset === 'TB') L = layoutDagre(vg, layoutPreset);
      else if (layoutPreset === 'lanes' && mode === 'data') L = layoutLanes(vg);
      else if (layoutPreset === 'force' && mode === 'data') L = layoutForce(vg);
      else if (layoutPreset === 'radial' && mode !== 'model') L = layoutRadial(vg, center);
      else if (mode === 'model') L = layoutDagre(vg, 'TB');
      else if (mode === 'data' && vg.nodes.some((n) => n.kind === 'inst')) L = layoutDagre(vg, 'LR');
      else L = bestOf((dir) => layoutDagre(vg, dir));
      stabilize(L);
      applyPins(L);
      computeClusters(L);
      return L;
    }
    // keep the picture still when the graph changes only a little: nodes that were already on screen
    // stay put, new ones arrive where the fresh layout puts them (shifted into the old frame), nudged
    // clear of anything they would overlap. A bigger change, a resized node or "Tidy" lays out afresh.
    function viewKey() { return [mode, layoutPreset, scopeInfo ? scopeInfo.eff : '', cardsMode].join('|'); }
    function stabilize(L) {
      L.stabilized = false;
      const prev = prevPos[mode];
      if (freshNext || !prev || prev.key !== viewKey()) { freshNext = false; return; }
      // never freeze a provisional layout (the quick dagre draw that ELK is about to replace)
      if (!prev.final) return;
      const kept = L.nodes.filter((n) => prev.pos.has(n.id)), added = L.nodes.filter((n) => !prev.pos.has(n.id));
      const removed = prev.pos.size - kept.length;
      if (kept.length < 2 || added.length + removed > Math.max(4, L.nodes.length * 0.25)) return;
      // many small edits add up: after enough nodes were slotted in by hand, lay out afresh
      if ((prev.drift || 0) + added.length + removed > Math.max(6, L.nodes.length * 0.3)) return;
      L.drift = (prev.drift || 0) + added.length + removed;
      if (kept.some((n) => { const p = prev.pos.get(n.id); return Math.abs(p.w - n.width) > 24 || Math.abs(p.h - n.height) > 10; })) return;
      let dx = 0, dy = 0;
      kept.forEach((n) => { const p = prev.pos.get(n.id); dx += p.x - n.x; dy += p.y - n.y; });
      dx /= kept.length; dy /= kept.length;
      kept.forEach((n) => { const p = prev.pos.get(n.id); n.x = p.x; n.y = p.y; });
      const placed = kept.slice();
      const hit = (a, b) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 16 && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + 12;
      added.forEach((n) => {
        n.x += dx; n.y += dy;
        let guard = 0, o;
        while ((o = placed.find((m) => hit(n, m))) && guard++ < 60) n.y = o.y + (o.height + n.height) / 2 + 14;
        placed.push(n);
      });
      // edges between nodes that stayed keep their previous route; the rest are redrawn as curves
      const stayed = new Set(kept.map((n) => n.id));
      L.edges.forEach((e) => {
        const pe = prev.edges && prev.edges.get(e.id);
        if (pe && stayed.has(e.from) && stayed.has(e.to)) { e.points = pe.points; e.elk = pe.elk; e.lx = pe.lx; e.ly = pe.ly; }
        else { e.points = null; e.lx = undefined; e.ly = undefined; e.elk = false; }
      });
      L.stabilized = true;
    }
    function rememberPositions(L) { if (!L) return; const final = !useElk() || !!L.elkDone || (L.stabilized && !!(prevPos[mode] && prevPos[mode].final)); prevPos[mode] = { key: viewKey(), final, drift: L.stabilized ? (L.drift || 0) : 0, pos: new Map(L.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.width, h: n.height }])), edges: new Map(L.edges.map((e) => [e.id, { points: e.points ? e.points.map((p) => ({ x: p.x, y: p.y })) : null, elk: !!e.elk, lx: e.lx, ly: e.ly }])) }; }
    function tidy() { freshNext = true; pinned[pinKey()] = {}; emit('positions', pinned); userMoved = false; render(true); }
    // ── ELK
    function loadElk() {
      if (elk) return Promise.resolve(elk);
      if (elkFailed) return Promise.reject(new Error('elk unavailable'));
      const url = window.__FGA_ASSETS && window.__FGA_ASSETS.elk;
      if (!url) { elkFailed = true; return Promise.reject(new Error('elk not bundled')); }
      if (!elkLoading) elkLoading = new Promise((resolve, reject) => {
        const sc = document.createElement('script'); sc.src = url; sc.async = true;
        sc.onload = () => { try { elk = new window.ELK(); resolve(elk); } catch (e) { elkFailed = true; reject(e); } };
        sc.onerror = () => { elkFailed = true; reject(new Error('could not load elk')); };
        document.head.appendChild(sc);
      });
      return elkLoading;
    }
    const useElk = () => mode === 'data' && layoutPreset === 'auto' && !elkFailed;
    function elkLayout(L, version) {
      const nodes = L.nodes, edges = L.edges.filter((e) => e.from !== e.to);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const graph = {
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
          'elk.layered.spacing.nodeNodeBetweenLayers': '72', 'elk.spacing.nodeNode': '22', 'elk.spacing.edgeNode': '14', 'elk.spacing.edgeEdge': '9',
          'elk.layered.spacing.edgeNodeBetweenLayers': '16', 'elk.layered.spacing.edgeEdgeBetweenLayers': '9',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
          'elk.edgeLabels.placement': 'CENTER', 'elk.layered.edgeLabels.sideSelection': 'SMART_DOWN', 'elk.separateConnectedComponents': 'true', 'elk.spacing.componentComponent': '40',
        },
        children: nodes.map((n) => {
          const c = { id: n.id, width: n.width, height: n.height };
          if (n.kind === 'inst') {
            c.layoutOptions = { 'elk.portConstraints': 'FIXED_POS' };
            c.ports = [].concat(...n.rows.map((r, i) => [
              { id: `${r.id}::in`, x: -1, y: rowCentre(i) - 1, width: 2, height: 2, layoutOptions: { 'elk.port.side': 'WEST' } },
              { id: `${r.id}::out`, x: n.width - 1, y: rowCentre(i) - 1, width: 2, height: 2, layoutOptions: { 'elk.port.side': 'EAST' } },
            ]));
          }
          return c;
        }),
        edges: edges.map((e, i) => {
          const fromN = byId.get(e.from), toN = byId.get(e.to);
          const src = e.fromSlot && fromN && fromN.kind === 'inst' && fromN.rows.some((r) => r.id === e.fromSlot) ? `${e.fromSlot}::out` : e.from;
          const dst = e.toSlot && toN && toN.kind === 'inst' && toN.rows.some((r) => r.id === e.toSlot) ? `${e.toSlot}::in` : e.to;
          const w = e.text ? Math.ceil(measure(e.text, MONO_S) * 0.92) + 12 : 0;
          return { id: `x${i}`, sources: [src], targets: [dst], labels: w ? [{ id: `x${i}l`, text: e.text, width: w, height: 18 }] : [] };
        }),
      };
      const sig = elkSig(L);
      const cached = elkCache.get(sig);
      const run = cached ? Promise.resolve(cached) : elk.layout(graph).then((res) => { elkCache.set(sig, res); if (elkCache.size > 40) elkCache.delete(elkCache.keys().next().value); return res; });
      return run.then((res) => {
        if (version !== layoutVersion || curL !== L || mode !== 'data') return;
        const pos = new Map(res.children.map((c) => [c.id, c]));
        L.nodes.forEach((n) => { const c = pos.get(n.id); if (c) { n.x = c.x + n.width / 2; n.y = c.y + n.height / 2; } });
        res.edges.forEach((re, i) => {
          const e = edges[i]; const sec = re.sections && re.sections[0];
          if (!sec) return;
          e.points = [sec.startPoint].concat(sec.bendPoints || [], [sec.endPoint]).map((p) => ({ x: p.x, y: p.y }));
          e.elk = true;
          const lb = re.labels && re.labels[0];
          if (lb && lb.x != null) { e.lx = lb.x + lb.width / 2; e.ly = lb.y + lb.height / 2; } else { e.lx = undefined; e.ly = undefined; }
        });
        applyPins(L);
        L.elkDone = true;
        bounds = boundsOf(L);
        draw(L, true);
        rememberPositions(L);
        if (!userMoved) fit(true);
        afterRender();
      }).catch(() => { if (L.pendingDraw) L.pendingDraw(); });
    }
    function roundedPath(pts, r = 7) {
      if (pts.length < 3) return `M${pts[0].x},${pts[0].y} L${pts[pts.length - 1].x},${pts[pts.length - 1].y}`;
      let d = `M${pts[0].x},${pts[0].y}`;
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
        const k = Math.min(r, l1 / 2, l2 / 2);
        const p1 = { x: b.x - ((b.x - a.x) / (l1 || 1)) * k, y: b.y - ((b.y - a.y) / (l1 || 1)) * k };
        const p2 = { x: b.x + ((c.x - b.x) / (l2 || 1)) * k, y: b.y + ((c.y - b.y) / (l2 || 1)) * k };
        d += ` L${p1.x},${p1.y} Q${b.x},${b.y} ${p2.x},${p2.y}`;
      }
      const z = pts[pts.length - 1];
      return d + ` L${z.x},${z.y}`;
    }
    function polyMid(pts) {
      let total = 0; for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      let half = total / 2;
      for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); if (half <= l) { const t = l ? half / l : 0; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; } half -= l; }
      return pts[0];
    }
    // ── labels: the most important win, the rest move along their edge or hide until hovered
    function declutterLabels() {
      if (!curL || mode === 'model' || mode === 'matrix') return;
      const rects = curL.nodes.map((n) => ({ x0: n.x - n.width / 2, y0: n.y - n.height / 2, x1: n.x + n.width / 2, y1: n.y + n.height / 2 }));
      const over = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      const items = [];
      gEdges.selectAll('g.edge').each(function (e) {
        const lbl = this.querySelector('g.lbl'); if (!lbl) return;
        lbl.classList.remove('lbl-off'); lbl.removeAttribute('transform');
        if (!e.text || !e.mid) return;
        const cl = this.classList;
        const prio = cl.contains('hover') ? 5 : cl.contains('hl-ok') || cl.contains('hl-active') || cl.contains('hl-fail') ? 4 : cl.contains('hl') ? 3 : e.access ? 0 : 1;
        items.push({ el: this, lbl, e, prio, w: measure(e.text, MONO_S) * 0.92 + 12 });
      });
      items.sort((a, b) => b.prio - a.prio || a.w - b.w);
      const placed = [];
      items.forEach((it) => {
        // the hit path gets its final geometry at once; path.main may still be animating from the old layout
        const path = it.el.querySelector('path.hit') || it.el.querySelector('path.main');
        let total = 0; try { total = path.getTotalLength(); } catch (err) { total = 0; }
        const cands = [it.e.mid];
        if (total > 40) [0.35, 0.65, 0.22, 0.78].forEach((t) => { try { const p = path.getPointAtLength(total * t); cands.push({ x: p.x, y: p.y }); } catch (err) { /* ignore */ } });
        const ok = cands.find((c) => { const r = { x0: c.x - it.w / 2, y0: c.y - 9, x1: c.x + it.w / 2, y1: c.y + 9 }; return !placed.some((p) => over(r, p)) && !rects.some((p) => over(r, p)); });
        if (!ok) { it.lbl.classList.add('lbl-off'); return; }
        if (ok !== it.e.mid) it.lbl.setAttribute('transform', `translate(${ok.x - it.e.mid.x},${ok.y - it.e.mid.y})`);
        placed.push({ x0: ok.x - it.w / 2, y0: ok.y - 9, x1: ok.x + it.w / 2, y1: ok.y + 9 });
      });
    }
    function applyPins(L) {
      const pins = pinned[pinKey()] || {};
      const moved = new Set();
      L.nodes.forEach((n) => { const p = pins[n.id]; if (p) { n.x = p.x; n.y = p.y; n.pinned = true; moved.add(n.id); } });
      if (moved.size) separate(L, moved);
      L.edges.forEach((e) => { if (moved.has(e.from) || moved.has(e.to)) e.points = null; });
    }
    // safety net: no two boxes may overlap. Pinned nodes stay (unless two pins collide, then both give
    // way); whatever overlaps them, or each other, is pushed out along the shorter axis. Every node it moves is added to `moved` (its edges re-route).
    function separate(L, moved) {
      const pad = 14, nodes = L.nodes;
      for (let pass = 0; pass < 40; pass++) {
        let any = false;
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const ox = (a.width + b.width) / 2 + pad - Math.abs(a.x - b.x), oy = (a.height + b.height) / 2 + pad - Math.abs(a.y - b.y);
          if (ox <= 0 || oy <= 0) continue;
          any = true;
          const share = a.pinned ? [0, 1] : b.pinned ? [1, 0] : [0.5, 0.5];
          if (ox < oy) { const d = (a.x <= b.x ? -1 : 1) * ox; a.x += d * share[0]; b.x -= d * share[1]; }
          else { const d = (a.y <= b.y ? -1 : 1) * oy; a.y += d * share[0]; b.y -= d * share[1]; }
          if (!a.pinned) moved.add(a.id); if (!b.pinned) moved.add(b.id);
        }
        if (!any) break;
      }
    }
    function computeClusters(L) {
      if (!L.clusters || !L.clusters.length) { L.clusters = []; return; }
      const HEAD = 20, PAD = 10;
      L.clusters = (L.clusters || []).map((c) => {
        const members = L.nodes.filter((n) => n.cluster === c.id);
        if (!members.length) return null;
        const x0 = Math.min(...members.map((n) => n.x - n.width / 2)) - PAD, x1 = Math.max(...members.map((n) => n.x + n.width / 2)) + PAD;
        const y0 = Math.min(...members.map((n) => n.y - n.height / 2)) - PAD - HEAD, y1 = Math.max(...members.map((n) => n.y + n.height / 2)) + PAD;
        return Object.assign(c, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: x1 - x0, height: y1 - y0 });
      }).filter(Boolean);
    }

    // ── edge geometry
    const line = d3.line().x((p) => p.x).y((p) => p.y).curve(d3.curveBasis);
    function anchor(n, tx, ty) {
      const dx = tx - n.x, dy = ty - n.y;
      const hw = n.width / 2, hh = n.height / 2;
      if (!dx && !dy) return { x: n.x, y: n.y };
      const sx = hw / Math.abs(dx || 1e-9), sy = hh / Math.abs(dy || 1e-9);
      const s = Math.min(sx, sy);
      return { x: n.x + dx * s, y: n.y + dy * s };
    }
    function bezier(a0, b0, bend, forceH) {
      const dx0 = b0.x - a0.x, dy0 = b0.y - a0.y;
      const dist0 = Math.hypot(dx0, dy0) || 1;
      const nx0 = -dy0 / dist0, ny0 = dx0 / dist0;
      const a = bend ? { x: a0.x + nx0 * bend * 0.35, y: a0.y + ny0 * bend * 0.35 } : a0;
      const b = bend ? { x: b0.x + nx0 * bend * 0.35, y: b0.y + ny0 * bend * 0.35 } : b0;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist, ny = dx / dist;
      const horizontal = forceH || Math.abs(dx) >= Math.abs(dy);
      let c1, c2;
      if (horizontal) { c1 = { x: a.x + dx * 0.4, y: a.y }; c2 = { x: b.x - dx * 0.4, y: b.y }; }
      else { c1 = { x: a.x, y: a.y + dy * 0.4 }; c2 = { x: b.x, y: b.y - dy * 0.4 }; }
      if (bend) { c1 = { x: c1.x + nx * bend, y: c1.y + ny * bend }; c2 = { x: c2.x + nx * bend, y: c2.y + ny * bend }; }
      const mid = { x: 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x, y: 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y };
      return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, mid };
    }
    function edgePath(e, byId) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) return { d: '', mid: { x: 0, y: 0 } };
      if (e.from === e.to) {
        const x = a.x + a.width / 2 - 10, y = a.y - a.height / 2;
        return { d: `M${x - 14},${y} C${x - 14},${y - 30} ${x + 26},${y - 30} ${x + 10},${y - 2}`, mid: { x: a.x + a.width / 2, y: y - 24 } };
      }
      if (e.elk && e.points && e.points.length >= 2) return { d: roundedPath(e.points), mid: e.lx != null ? { x: e.lx, y: e.ly } : polyMid(e.points) };
      if (mode === 'data' && (e.fromSlot || e.toSlot)) {
        // slot edges leave and enter cards at the row they concern
        const pb0 = e.toSlot && b.kind === 'inst' ? slotPoint(b, e.toSlot, a.x) : null;
        const pa0 = e.fromSlot && a.kind === 'inst' ? slotPoint(a, e.fromSlot, b.x) : null;
        if (pa0 || pb0) {
          const pa = pa0 || anchor(a, (pb0 || b).x, (pb0 || b).y);
          const pb = pb0 || anchor(b, pa.x, pa.y);
          return bezier(pa, pb, e.bend || 0, true);
        }
      }
      if (e.points && e.points.length) {
        const mid = e.lx != null ? { x: e.lx, y: e.ly } : e.points[Math.floor(e.points.length / 2)];
        return { d: line(e.points), mid };
      }
      const pa = anchor(a, b.x, b.y), pb = anchor(b, a.x, a.y);
      return bezier(pa, pb, (e.bend || 0) + (e.reverse && !e.bend ? 22 : 0));
    }
    function baseMarker(e) {
      if (e.diff === 'removed') return 'url(#arrow-removed)';
      if (e.diff === 'added') return 'url(#arrow-added)';
      if (mode === 'data') return `url(#arrow-rel${e.access ? 'h' : ''}-${(relIndex.has(e.rel) ? relIndex.get(e.rel) : hashStr(e.rel)) % REL_PALETTE.length})`;
      return `url(#arrow-${e.ctx === 'exclusion' ? 'exclusion' : (e.kind === 'computed' || e.kind === 'ttu' || e.kind === 'tree') ? e.kind : 'direct'})`;
    }

    // ── render
    function render(animate) {
      $('#legend-schema').hidden = mode !== 'schema';
      $('#legend-model').hidden = mode !== 'model';
      $('#legend-data').hidden = mode !== 'data';
      const lm = $('#legend-matrix'); if (lm) lm.hidden = mode !== 'matrix';
      $('#btn-subjects').hidden = true;
      stage.classList.toggle('mx-mode', mode === 'matrix');
      if (mode === 'matrix') {
        // the access matrix is an HTML table drawn by the app; the svg stays empty underneath
        gClusters.selectAll('*').remove(); gEdges.selectAll('*').remove(); gNodes.selectAll('*').remove();
        empty.hidden = true; bounds = null; curL = null; curVG = null; updateMinimap(); renderProofBar(); gBadges.selectAll('*').remove();
        emit('renderMatrix');
        return;
      }
      const vg = viewGraph();
      curVG = vg;
      if (!vg) {
        gClusters.selectAll('*').remove(); gEdges.selectAll('*').remove(); gNodes.selectAll('*').remove();
        empty.hidden = false;
        empty.textContent = mode === 'data' ? 'No tuples yet. Add relationship tuples (user relation object) to see the data graph.' : mode === 'model' ? 'No relations yet. Define a relation in the Model DSL to see how it resolves.' : 'No valid model yet. Define at least one type in the Model DSL to see its graph.';
        bounds = null; curL = null; updateMinimap(); renderProofBar(); gBadges.selectAll('*').remove();
        return;
      }
      empty.hidden = true;
      lastStage = { w: stage.clientWidth, h: stage.clientHeight };
      const fresh = !prevPos[mode] || freshNext || prevPos[mode].key !== viewKey();
      const L = runLayout(vg);
      curL = L;
      layoutVersion++;
      bounds = boundsOf(L);
      if (mode === 'data') {
        Array.from(new Set(L.edges.map((e) => e.rel))).forEach((r) => {
          const id = `arrow-rel-${(relIndex.has(r) ? relIndex.get(r) : hashStr(r)) % REL_PALETTE.length}`;
          if (defs.select(`#${id}`).empty()) defs.append('marker').attr('id', id).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5).attr('markerWidth', 11).attr('markerHeight', 11).attr('markerUnits', 'userSpaceOnUse').attr('orient', 'auto-start-reverse').append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('fill', relColor(r));
          // hollow variant for derived (materialised) access
          const hid = id.replace('arrow-rel-', 'arrow-relh-');
          if (defs.select(`#${hid}`).empty()) defs.append('marker').attr('id', hid).attr('viewBox', '0 0 12 12').attr('refX', 10).attr('refY', 6).attr('markerWidth', 11).attr('markerHeight', 11).attr('markerUnits', 'userSpaceOnUse').attr('orient', 'auto-start-reverse').append('path').attr('d', 'M1.5,1.5 L10.5,6 L1.5,10.5 z').attr('class', 'mk-hollow').attr('stroke', relColor(r));
        });
      }
      const modeChanged = lastMode !== mode;
      const wantElk = !L.stabilized && useElk() && (fresh || L.nodes.length > 1);
      const finish = () => {
        L.pendingDraw = null;
        draw(L, animate && lastMode === mode);
        lastMode = mode;
        renderProofBar();
        renderScopePill();
        if (!L.stabilized || modeChanged || !userMoved) { fit(false); userMoved = false; }
        rememberPositions(L);
        afterRender();
      };
      if (wantElk && elk) {
        // ELK is loaded: skip the quick dagre picture (it would only flash and then rearrange);
        // draw it only if ELK is slow or fails
        L.pendingDraw = finish;
        const v = layoutVersion;
        setTimeout(() => { if (L.pendingDraw && curL === L && v === layoutVersion) finish(); }, 400);
        elkLayout(L, v).then(() => { if (curL === L) { L.pendingDraw = null; lastMode = mode; renderScopePill(); } });
        return;
      }
      finish();
      if (wantElk) loadElk().then(() => elkLayout(L, layoutVersion)).catch(() => {});
    }
    // scope pill: how much of a big store is on screen, and how to see more
    function renderScopePill() {
      const el = $('#scope-pill'); if (!el) return;
      if (mode !== 'data' || !scopeInfo || (scopeInfo.eff === 'all' && scopeInfo.total <= BIG && scopeMode === 'auto')) { el.hidden = true; return; }
      el.hidden = false;
      const what = scopeInfo.eff === 'near' ? 'near the query' : scopeInfo.eff === 'grouped' ? 'grouped by type' : 'everything';
      el.innerHTML = `<span>${scopeInfo.eff === 'all' ? `all ${scopeInfo.total} nodes` : `${scopeInfo.shown} of ${scopeInfo.total} nodes · ${what}`}</span>${scopeInfo.eff !== 'all' ? '<button class="btn xs ghost" data-s="all">show all</button>' : ''}${scopeInfo.eff !== 'near' ? '<button class="btn xs ghost" data-s="near">near the query</button>' : ''}${scopeInfo.eff !== 'grouped' ? '<button class="btn xs ghost" data-s="grouped">group by type</button>' : ''}`;
      $$('button[data-s]', el).forEach((b) => b.addEventListener('click', () => { setScope(b.dataset.s); emit('scope', scopeMode); }));
    }
    let lastMode = null;
    function draw(L, animate) {
      const dur = animate ? 380 : 0;
      const byId = new Map(L.nodes.map((n) => [n.id, n]));
      const isCard = mode === 'schema';
      // clusters
      gClusters.selectAll('g.cluster').data(L.clusters || [], (c) => c.id).join(
        (enter) => { const g = enter.append('g').attr('class', 'cluster'); g.append('rect').attr('rx', 12); g.append('text'); g.append('rect').attr('class', 'hdr-hit'); return g; },
        (update) => update, (exit) => exit.remove(),
      ).attr('data-id', (c) => c.id).style('--c', (c) => colorOf(c.type)).classed('collapsed', (c) => !!c.collapsed)
        .each(function (c) {
          const sel = d3.select(this);
          sel.select('rect:not(.hdr-hit)').transition().duration(dur).attr('x', c.x - c.width / 2).attr('y', c.y - c.height / 2).attr('width', c.width).attr('height', c.height);
          sel.select('text').transition().duration(dur).attr('x', c.x - c.width / 2 + 10).attr('y', c.y - c.height / 2 + 14);
          sel.select('text').text(`type ${c.label}${c.collapsed ? '  ▸' : ''}`);
          sel.select('rect.hdr-hit').attr('x', c.x - c.width / 2).attr('y', c.y - c.height / 2).attr('width', c.width).attr('height', 20).attr('fill', 'transparent').style('cursor', 'pointer')
            .on('click', (ev) => { ev.stopPropagation(); toggleCollapse(c.id); })
            .on('mouseenter', (ev) => showTip(ev, `<code>type ${esc(c.label)}</code><div class="sub">click to ${c.collapsed ? 'expand' : 'collapse'} this type</div>`)).on('mousemove', moveTip).on('mouseleave', hideTip);
        });
      // edges
      const eg = gEdges.selectAll('g.edge').data(L.edges, (e) => e.id).join(
        (enter) => { const g = enter.append('g'); g.append('path').attr('class', 'hit'); g.append('path').attr('class', 'main'); g.append('g').attr('class', 'lbl'); return g; },
        (update) => update, (exit) => exit.remove(),
      ).attr('class', (e) => `edge ${e.kind || 'tuple'}${e.ctx === 'exclusion' ? ' exclusion' : ''}${e.wildcard ? ' wild' : ''}${e.contextual ? ' contextual' : ''}${e.conditions && e.conditions.length ? ' cond' : ''}${e.diff ? ' diff-' + e.diff : ''}${e.from === e.to ? ' loop' : ''}`)
        .attr('data-id', (e) => e.id).style('--e', (e) => (mode === 'data' ? relColor(e.rel) : null));
      eg.each(function (e) {
        const sel = d3.select(this);
        const geo = edgePath(e, byId);
        e.mid = geo.mid;
        sel.select('path.hit').attr('d', geo.d);
        const main = sel.select('path.main');
        (dur ? main.transition().duration(dur) : main).attr('d', geo.d);
        main.attr('marker-end', baseMarker(e));
        drawEdgeLabel(sel.select('g.lbl'), e, dur);
      });
      eg.on('dblclick', (ev, e) => { if (e.access) { ev.stopPropagation(); hideTip(); emit('runCheck', { user: e.user, relation: e.relation, object: e.object }); } })
        .on('click', (ev, e) => { if (!e.access || locked()) return; ev.stopPropagation(); hideTip(); const pr = proofFor(e); if (pr) showProof(pr, { pin: true, lock: true, title: `${e.user} ${e.relation} ${e.object}` }); })
        .on('mouseenter', function (ev, e) {
          d3.select(this).classed('hover', true).raise();
          showTip(ev, tipForEdge(e));
          if (e.access) { const steps = stepsFor(e); if (steps && !proofWalk) { proofPreview = { steps, title: `${e.user} ${e.relation} ${e.object}` }; applyVisual(); } return; }
          if (!focus && !proofWalk) { hoverHl = edgeHl(e); applyVisual(); }
        })
        .on('mousemove', moveTip).on('mouseleave', function () { d3.select(this).classed('hover', false); hideTip(); if (hoverHl || proofPreview) { hoverHl = null; proofPreview = null; applyVisual(); } })
        .on('contextmenu', (ev, e) => { ev.preventDefault(); ev.stopPropagation(); hideTip(); if (locked()) return; emit('context', { kind: 'edge', datum: e, mode }, ev); });
      // nodes / cards
      const ng = gNodes.selectAll('g.node').data(L.nodes, (n) => n.id).join(
        (enter) => enter.append('g'), (update) => update, (exit) => exit.remove(),
      ).attr('class', (n) => `node ${n.kind === 'inst' ? 'card inst' : n.kind}${n.pinned ? ' pinned' : ''}${n.diff ? ' diff-' + n.diff : ''}${n.cycle ? ' cycle' : ''}${n.userset ? ' userset' : ''}`).attr('data-id', (n) => n.id).style('--c', (n) => colorOf(n.type));
      ng.each(function (n) {
        const sel = d3.select(this);
        const tr = `translate(${n.x - n.width / 2},${n.y - n.height / 2})`;
        if (dur && sel.attr('transform')) sel.transition().duration(dur).attr('transform', tr); else sel.attr('transform', tr);
        sel.selectAll('*').remove();
        if (isCard) drawCard(sel, n); else if (n.kind === 'inst') drawInstCard(sel, n); else if (mode === 'model') drawTreeNode(sel, n); else drawNode(sel, n);
      });
      // in the resolution tree only relation and subject nodes answer to queries / menus
      const menuDatum = (n) => (mode !== 'model' ? n : n.kind === 'rel' ? { kind: 'rel', id: n.key, type: n.type, rel: n.rel, label: n.rel, def: n.def, direct: n.direct, line: n.line } : n.kind === 'subject' ? { kind: 'type', type: n.type, label: n.type } : null);
      const own = (n) => isCard || n.kind === 'inst'; // cards wire their own header / row handlers
      ng.on('mouseenter', (ev, n) => { if (own(n)) return; showTip(ev, tipForNode(n)); previewFocus(n.id); emit('nodeHover', mode === 'model' ? (n.key || n.subj || null) : n.id); }).on('mousemove', moveTip)
        .on('mouseleave', (ev, n) => { if (own(n)) return; hideTip(); previewFocus(null); emit('nodeHover', null); })
        .on('click', (ev, n) => { if (own(n) || ev.defaultPrevented) return; hideTip(); ev.stopPropagation(); if (locked()) return; setFocus(n.id, n, ev); })
        .on('dblclick', (ev, n) => { if (own(n)) return; hideTip(); ev.stopPropagation(); if (locked()) return; const d = menuDatum(n); if (d) emit('nodeClick', d, mode, ev); })
        .on('contextmenu', (ev, n) => { if (own(n)) return; ev.preventDefault(); ev.stopPropagation(); hideTip(); if (locked()) return; const d = menuDatum(n); if (d) emit('context', { kind: 'node', datum: d, mode }, ev); });
      ng.call(dragBehaviour());
      svg.on('click', () => emit('blankClick'));
      svg.on('contextmenu', (ev) => { ev.preventDefault(); if (locked()) return; emit('context', { kind: 'blank', mode }, ev); });
    }
    function drawEdgeLabel(g, e, dur) {
      g.selectAll('*').remove();
      const { x: lx, y: ly } = e.mid || { x: 0, y: 0 };
      if (!e.text) return;
      const w = measure(e.text, MONO_S) * 0.92 + 12;
      g.append('rect').attr('class', 'lbl-bg').attr('x', lx - w / 2).attr('y', ly - 9).attr('width', w).attr('height', 18).attr('rx', 4);
      g.append('text').attr('class', 'slbl').attr('x', lx).attr('y', ly + 3.5).attr('text-anchor', 'middle').text(e.text);
    }
    function drawTreeNode(sel, n) {
      const rx = n.kind === 'rel' ? 8 : n.kind === 'subject' ? 13 : n.kind === 'op' ? 13 : 6;
      sel.append('rect').attr('class', 'bg').attr('width', n.width).attr('height', n.height).attr('rx', rx);
      if (n.kind === 'rel') {
        sel.append('text').attr('x', 12).attr('y', n.height / 2 + 4).text(n.label);
        if (n.cycle) sel.append('text').attr('class', 'cyc').attr('x', n.width - (n.expandable ? 34 : 12)).attr('y', n.height / 2 + 4).attr('text-anchor', 'end').text('↻');
        if (n.expandable) {
          const tog = sel.append('g').attr('class', 'card-toggle').attr('transform', `translate(${n.width - 20},${n.height / 2 - 6})`).style('cursor', 'pointer');
          tog.append('rect').attr('width', 12).attr('height', 12).attr('rx', 3);
          tog.append('text').attr('x', 6).attr('y', 9.5).attr('text-anchor', 'middle').text(n.expanded ? '–' : '+');
          tog.on('click', (ev) => { ev.stopPropagation(); toggleExpand(n.id, !n.expanded); })
            .on('mouseenter', (ev) => { ev.stopPropagation(); showTip(ev, `<div class="sub">${n.expanded ? 'collapse' : 'expand'} how ${esc(n.label)} resolves</div>`); });
        }
        return;
      }
      if (n.kind === 'op') {
        sel.append('text').attr('class', 'glyph').attr('x', 12).attr('y', n.height / 2 + 4.5).text(n.glyph);
        sel.append('text').attr('x', 28).attr('y', n.height / 2 + 4).text(n.label);
        return;
      }
      if (n.kind === 'subject') {
        sel.append('text').attr('x', n.condition ? 12 : n.width / 2).attr('y', n.height / 2 + 4).attr('text-anchor', n.condition ? 'start' : 'middle').text((n.wildcard ? '✶ ' : '') + n.label);
        if (n.condition) sel.append('text').attr('class', 'cond').attr('x', n.width - 10).attr('y', n.height / 2 + 4).attr('text-anchor', 'end').text(`⚡${n.condition}`);
        return;
      }
      sel.append('text').attr('x', n.width / 2).attr('y', n.height / 2 + 4).attr('text-anchor', 'middle').text(n.label); // direct / ttu
    }
    function drawNode(sel, n) {
      if (n.kind === 'group' || n.kind === 'bundle') {
        sel.append('rect').attr('width', n.width).attr('height', n.height).attr('rx', 9);
        if (n.kind === 'bundle') { sel.append('rect').attr('class', 'stack').attr('x', 3).attr('y', -3).attr('width', n.width - 6).attr('height', 4).attr('rx', 2); }
        sel.append('text').attr('x', 12).attr('y', n.height / 2 + 4).text(n.label);
        const tog = sel.append('g').attr('class', 'card-toggle').attr('transform', `translate(${n.width - 22},${n.height / 2 - 7})`).style('cursor', 'pointer');
        tog.append('rect').attr('width', 14).attr('height', 14).attr('rx', 3);
        tog.append('text').attr('x', 7).attr('y', 10.5).attr('text-anchor', 'middle').text('+');
        tog.on('click', (ev) => { ev.stopPropagation(); hideTip(); if (locked()) return; if (n.kind === 'group') expandGroup(n.type); else openBundle(n.key); })
          .on('mouseenter', (ev) => { ev.stopPropagation(); showTip(ev, `<div class="sub">${n.kind === 'group' ? `show the ${n.members.length} ${esc(n.type)} objects individually` : `show these ${n.members.length} ${esc(n.type)}s individually`}</div>`); });
        return;
      }
      sel.append('rect').attr('width', n.width).attr('height', n.height).attr('rx', n.kind === 'type' ? 14 : 7);
      if (n.badge) { sel.append('rect').attr('class', 'badge-bg').attr('x', 6).attr('y', 5).attr('width', n.badgeW).attr('height', 16).attr('rx', 4); sel.append('text').attr('class', 'badge').attr('x', 11).attr('y', 16.5).text(n.badge); }
      const label = n.kind === 'wildcard' ? `✶ ${n.label}` : n.collapsedCount ? `${n.label}  ${n.collapsedCount} relations` : n.label;
      sel.append('text').attr('x', n.badge ? 6 + n.badgeW + 8 : n.op ? 12 : n.width / 2).attr('y', n.height / 2 + 4).attr('text-anchor', n.op || n.badge ? 'start' : 'middle').text(label);
      if (n.op) sel.append('text').attr('class', 'op').attr('x', n.width - 10).attr('y', n.height / 2 + 4).attr('text-anchor', 'end').text(n.op === 'or' ? '∨' : n.op === 'and' ? '∧' : '¬');
      if (n.expandable) {
        sel.select('text').attr('x', (n.width - 18) / 2);
        const tog = sel.append('g').attr('class', 'card-toggle').attr('transform', `translate(${n.width - 20},${n.height / 2 - 6})`).style('cursor', 'pointer');
        tog.append('rect').attr('width', 12).attr('height', 12).attr('rx', 3);
        tog.append('text').attr('x', 6).attr('y', 9.5).attr('text-anchor', 'middle').text('+');
        tog.on('click', (ev) => { ev.stopPropagation(); hideTip(); if (locked()) return; toggleCard(n.id, true); })
          .on('mouseenter', (ev) => { ev.stopPropagation(); showTip(ev, `<div class="sub">open ${esc(n.id)} as a card: one slot per relation, tuples pointing at the slot they grant</div>`); });
      }
      if (n.more) {
        sel.select('text').attr('x', (n.width - n.moreW - 6 - (n.expandable ? 18 : 0)) / 2);
        const mx = n.width - n.moreW - 4 - (n.expandable ? 20 : 0);
        const mg = sel.append('g').attr('class', 'more').attr('transform', `translate(${mx},${n.height / 2 - 8})`).style('cursor', 'pointer');
        mg.append('rect').attr('width', n.moreW).attr('height', 16).attr('rx', 8);
        mg.append('text').attr('x', n.moreW / 2).attr('y', 11.5).attr('text-anchor', 'middle').text(`+${n.more}`);
        mg.on('click', (ev) => { ev.stopPropagation(); hideTip(); if (locked()) return; expandNode(n.id); })
          .on('mouseenter', (ev) => { ev.stopPropagation(); showTip(ev, `<div class="sub">${n.more} more connection${n.more === 1 ? '' : 's'} not on screen — click to show them</div>`); });
      }
      if (n.pinned) sel.append('circle').attr('class', 'pin').attr('cx', n.width - 4).attr('cy', 4).attr('r', 3);
    }
    // instance card: an object with one slot (userset) per relation of its type
    function drawInstCard(sel, n) {
      const plain = { id: n.id, type: n.type, kind: 'object', label: n.label, tuples: n.tuples, card: true };
      sel.append('rect').attr('class', 'bg').attr('width', n.width).attr('height', n.height).attr('rx', 10);
      sel.append('path').attr('class', 'hdr').attr('d', `M10,0 H${n.width - 10} a10,10 0 0 1 10,10 V${HDR} H0 V10 a10,10 0 0 1 10,-10 z`);
      sel.append('text').attr('class', 'hdr-t').attr('x', 12).attr('y', 18.5).text(n.label);
      sel.append('text').attr('class', 'hdr-n').attr('x', n.width - 26).attr('y', 18.5).attr('text-anchor', 'end').text(n.type);
      const tog = sel.append('g').attr('class', 'card-toggle').attr('transform', `translate(${n.width - 18},8)`).style('cursor', 'pointer');
      tog.append('rect').attr('width', 12).attr('height', 12).attr('rx', 3);
      tog.append('text').attr('x', 6).attr('y', 9.5).attr('text-anchor', 'middle').text('–');
      tog.on('click', (ev) => { ev.stopPropagation(); hideTip(); if (locked()) return; toggleCard(n.id, false); })
        .on('mouseenter', (ev) => { ev.stopPropagation(); showTip(ev, `<div class="sub">collapse ${esc(n.id)} back to a plain node</div>`); });
      if (n.pinned) sel.append('circle').attr('class', 'pin').attr('cx', n.width - 4).attr('cy', 4).attr('r', 3);
      sel.append('rect').attr('class', 'hdr-hit').attr('width', n.width - 30).attr('height', HDR).attr('fill', 'transparent')
        .on('mouseenter', (ev) => { showTip(ev, tipForNode(plain)); previewFocus(n.id); emit('nodeHover', n.id); }).on('mousemove', moveTip).on('mouseleave', () => { hideTip(); previewFocus(null); emit('nodeHover', null); })
        .on('click', (ev) => { if (ev.defaultPrevented) return; hideTip(); ev.stopPropagation(); if (locked()) return; setFocus(n.id, plain, ev); })
        .on('dblclick', (ev) => { hideTip(); ev.stopPropagation(); if (locked()) return; emit('nodeClick', plain, 'data', ev); })
        .on('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); hideTip(); if (locked()) return; emit('context', { kind: 'node', datum: plain, mode }, ev); });
      const rows = sel.selectAll('g.row').data(n.rows).enter().append('g').attr('class', (r) => `row${r.direct || r.derived ? '' : ' empty'}`).attr('data-id', (r) => r.id)
        .attr('transform', (r, i) => `translate(0,${HDR + 8 + i * ROW + 13})`);
      rows.append('rect').attr('class', 'row-bg').attr('x', 5).attr('y', -13.5).attr('width', n.width - 10).attr('height', 18).attr('rx', 4);
      rows.append('text').attr('class', 'rname').attr('x', 12).attr('y', 0).text((r) => r.rel);
      rows.append('text').attr('class', 'rdef').attr('x', 12 + n.nameColW).attr('y', 0).text((r) => r.defShort);
      rows.on('mouseenter', (ev, r) => { showTip(ev, tipForSlot(r)); emit('nodeHover', r.id); }).on('mousemove', moveTip).on('mouseleave', () => { hideTip(); emit('nodeHover', null); })
        .on('click', (ev, r) => { hideTip(); ev.stopPropagation(); if (locked()) return; emit('nodeClick', r, 'data', ev); })
        .on('contextmenu', (ev, r) => { ev.preventDefault(); ev.stopPropagation(); hideTip(); if (locked()) return; emit('context', { kind: 'slot', datum: r, mode }, ev); });
      // computed relations: an arc from the implying row to the implied one, down the right margin
      const idx = new Map(n.rows.map((r, i) => [r.rel, i]));
      n.links.forEach((l, i) => {
        const yi = rowCentre(idx.get(l.from)), yj = rowCentre(idx.get(l.to));
        // arcs live in the card's reserved right margin, staggered so parallel ones stay apart
        const x0 = n.width - n.arcW + 2 + (i % 4) * 3;
        const bulge = Math.max(6, n.arcW - 6 - (i % 4) * 3);
        sel.append('path').datum(l).attr('class', `ilink computed${l.ctx === 'exclusion' ? ' exclusion' : ''}`).attr('data-id', l.id).attr('d', `M${x0},${yi} C${x0 + bulge},${yi} ${x0 + bulge},${yj} ${x0 + 1},${yj}`).attr('marker-end', `url(#arrow-s-${l.ctx === 'exclusion' ? 'exclusion' : 'computed'})`)
          .on('mouseenter', (ev) => { ev.stopPropagation(); showTip(ev, `<code>${esc(l.to)} ⇐ ${esc(l.from)}</code><div class="sub">${l.ctx === 'exclusion' ? `anyone who is <b>${esc(l.from)}</b> of ${esc(n.id)} is <b>excluded</b> from ${esc(l.to)}` : `anyone who is <b>${esc(l.from)}</b> of ${esc(n.id)} is also <b>${esc(l.to)}</b>${l.ctx === 'intersection' ? ' (one of several conditions that must all hold)' : ''}`}</div>`); }).on('mousemove', moveTip).on('mouseleave', hideTip);
      });
    }
    function tipForSlot(r) {
      const ts = storeRef ? storeRef.read(r.object, r.rel) : [];
      const lines = ts.slice(0, 6).map((t) => FGA.formatTuple(t)).join('\n');
      return `<code>${esc(r.id)}</code><div class="sub">${esc(r.def)}</div><div class="sub">${ts.length} direct tuple${ts.length === 1 ? '' : 's'}${r.derived ? ` · ${r.derived} derived link${r.derived === 1 ? '' : 's'}` : ''}${r.directTypes.length ? ' · assignable: ' + esc(r.directTypes.join(', ')) : ' · computed only'}</div>${lines ? `<code>${esc(lines)}${ts.length > 6 ? '\n…' : ''}</code>` : ''}<div class="sub">click for queries on this userset · right-click for more · Alt-drag a subject here to write a tuple</div>`;
    }
    function drawCard(sel, n) {
      sel.append('rect').attr('class', 'bg').attr('width', n.width).attr('height', n.height).attr('rx', 10);
      sel.append('path').attr('class', 'hdr').attr('d', n.collapsed || !n.rows.length ? `M10,0 H${n.width - 10} a10,10 0 0 1 10,10 V${n.height - 10} a10,10 0 0 1 -10,10 H10 a10,10 0 0 1 -10,-10 V10 a10,10 0 0 1 10,-10 z` : `M10,0 H${n.width - 10} a10,10 0 0 1 10,10 V${HDR} H0 V10 a10,10 0 0 1 10,-10 z`);
      sel.append('text').attr('class', 'hdr-t').attr('x', 12).attr('y', 18.5).text(`type ${n.label}`);
      sel.append('text').attr('class', 'hdr-n').attr('x', n.width - 26).attr('y', 18.5).attr('text-anchor', 'end').text(n.rows.length ? `${n.rows.length} rel${n.rows.length === 1 ? '' : 's'}` : 'subject');
      const tog = sel.append('g').attr('class', 'card-toggle').attr('transform', `translate(${n.width - 18},8)`).style('cursor', 'pointer');
      tog.append('rect').attr('width', 12).attr('height', 12).attr('rx', 3);
      tog.append('text').attr('x', 6).attr('y', 9.5).attr('text-anchor', 'middle').text(n.collapsed ? '+' : '–');
      if (n.rows.length) tog.on('click', (ev) => { ev.stopPropagation(); toggleCollapse(n.id); });
      if (n.pinned) sel.append('circle').attr('class', 'pin').attr('cx', n.width - 4).attr('cy', 4).attr('r', 3);
      sel.append('rect').attr('class', 'hdr-hit').attr('width', n.width - 30).attr('height', HDR).attr('fill', 'transparent')
        .on('mouseenter', (ev) => { showTip(ev, `<code>type ${esc(n.label)}</code><div class="sub">${n.rows.length ? n.rows.length + ' relation' + (n.rows.length === 1 ? '' : 's') : 'subject type: no relations of its own'} · click to focus · double-click for queries · drag to move</div>`); previewFocus(n.id); emit('nodeHover', n.id); }).on('mousemove', moveTip).on('mouseleave', () => { hideTip(); previewFocus(null); emit('nodeHover', null); })
        .on('click', (ev) => { if (ev.defaultPrevented) return; hideTip(); ev.stopPropagation(); setFocus(n.id, { kind: 'type', type: n.type, label: n.label }, ev); })
        .on('dblclick', (ev) => { hideTip(); ev.stopPropagation(); emit('nodeClick', { kind: 'type', type: n.type, label: n.label }, 'model', ev); })
        .on('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); hideTip(); emit('context', { kind: 'card', datum: n, mode }, ev); });
      if (n.collapsed) return;
      const rows = sel.selectAll('g.row').data(n.rows).enter().append('g').attr('class', (r) => `row${r.diff ? ' diff-' + r.diff : ''}`).attr('data-id', (r) => r.id)
        .attr('transform', (r, i) => `translate(0,${HDR + 8 + i * ROW + 13})`);
      rows.append('rect').attr('class', 'row-bg').attr('x', 5).attr('y', -13.5).attr('width', n.width - 10).attr('height', 18).attr('rx', 4);
      rows.filter((r) => r.diff).append('text').attr('class', 'rdiff').attr('x', 7).attr('y', 0).text((r) => (r.diff === 'added' ? '+' : r.diff === 'removed' ? '−' : '~'));
      rows.append('text').attr('class', 'rname').attr('x', (r) => 12 + (r.diff ? 8 : 0)).attr('y', 0).text((r) => r.name);
      rows.append('text').attr('class', 'rdef').attr('x', (r) => 12 + n.nameColW + (r.diff ? 8 : 0)).attr('y', 0).text((r) => r.defShort);
      rows.filter((r) => r.op).append('text').attr('class', 'rop').attr('x', n.width - 10).attr('y', 0).attr('text-anchor', 'end').text((r) => (r.op === 'or' ? '∨' : r.op === 'and' ? '∧' : '¬'));
      rows.on('mouseenter', (ev, r) => showTip(ev, `<code>${esc(r.def)}</code>${r.was ? `<div class="sub">was: ${esc(r.was)}</div>` : ''}<div class="sub">${r.diff === 'removed' ? 'removed in the draft · ' : ''}${r.direct.length ? 'directly assignable: ' + esc(r.direct.join(', ')) : 'computed only (no direct tuples)'} · click for queries · right-click for more</div>`)).on('mousemove', moveTip).on('mouseleave', hideTip)
        .on('click', (ev, r) => { hideTip(); ev.stopPropagation(); emit('nodeClick', r, 'model', ev); emit('reveal', r); })
        .on('contextmenu', (ev, r) => { ev.preventDefault(); ev.stopPropagation(); hideTip(); emit('context', { kind: 'row', datum: r, mode }, ev); });
    }
    function toggleCollapse(type) { if (collapsed.has(type)) collapsed.delete(type); else collapsed.add(type); emit('collapsed', Array.from(collapsed)); render(true); }

    // ── drag: move nodes (pin them) or, in connect mode / with Alt, draw a new tuple
    function dragBehaviour() {
      let start = null, connecting = false, tempLine = null, incident = [], fromSlot = null;
      return d3.drag().clickDistance(4).filter((ev) => !ev.ctrlKey && !ev.button && !locked())
        .on('start', function (ev, n) {
          connecting = connectMode || !!(ev.sourceEvent && ev.sourceEvent.altKey);
          if (connecting) { if (mode !== 'data') { connecting = false; return; } const rowEl = ev.sourceEvent && ev.sourceEvent.target.closest && ev.sourceEvent.target.closest('g.row'); fromSlot = rowEl ? rowEl.getAttribute('data-id') : null; tempLine = gTemp.append('path').attr('class', 'connect-line'); return; }
          start = { x: n.x, y: n.y, raised: false };
          incident = curL.edges.filter((e) => e.from === n.id || e.to === n.id);
        })
        .on('drag', function (ev, n) {
          if (connecting) { if (tempLine) tempLine.attr('d', `M${n.x},${n.y} L${ev.x},${ev.y}`); return; }
          if (!start) return;
          if (!start.raised) { start.raised = true; d3.select(this).raise().classed('dragging', true); }
          n.x = ev.x; n.y = ev.y; n.pinned = true;
          d3.select(this).attr('transform', `translate(${n.x - n.width / 2},${n.y - n.height / 2})`);
          const byId = new Map(curL.nodes.map((m) => [m.id, m]));
          incident.forEach((e) => { e.points = null; e.elk = false; const geo = edgePath(e, byId); e.mid = geo.mid; const sel = gEdges.select(`g.edge[data-id="${cssEsc(e.id)}"]`); sel.select('path.hit').attr('d', geo.d); sel.select('path.main').attr('d', geo.d); drawEdgeLabel(sel.select('g.lbl'), e, 0); });
          if (proofWalk || proofPreview) placeBadges();
          if (mode === 'model') { computeClusters(curL); gClusters.selectAll('g.cluster').each(function (c) { const s = d3.select(this); s.select('rect:not(.hdr-hit)').attr('x', c.x - c.width / 2).attr('y', c.y - c.height / 2).attr('width', c.width).attr('height', c.height); s.select('text').attr('x', c.x - c.width / 2 + 10).attr('y', c.y - c.height / 2 + 14); s.select('rect.hdr-hit').attr('x', c.x - c.width / 2).attr('y', c.y - c.height / 2).attr('width', c.width); }); }
        })
        .on('end', function (ev, n) {
          if (connecting) {
            if (tempLine) { tempLine.remove(); tempLine = null; }
            const se = ev.sourceEvent;
            const el = se && document.elementFromPoint(se.clientX, se.clientY);
            const targetEl = el && el.closest('g.node');
            const rowEl = el && el.closest('g.row');
            const target = targetEl && curL.nodes.find((m) => m.id === targetEl.getAttribute('data-id'));
            if (target && target.id !== n.id) emit('connect', n, target, se, { fromSlot, toSlot: rowEl ? rowEl.getAttribute('data-id') : null });
            fromSlot = null;
            return;
          }
          if (!start) return;
          d3.select(this).classed('dragging', false);
          if (Math.hypot(n.x - start.x, n.y - start.y) < 2) { n.x = start.x; n.y = start.y; return; }
          pinsNow()[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
          rememberPositions(curL);
          d3.select(this).classed('pinned', true);
          if (!d3.select(this).select('circle.pin').size()) d3.select(this).append('circle').attr('class', 'pin').attr('cx', n.width - 4).attr('cy', 4).attr('r', 3);
          bounds = boundsOf(curL);
          updateMinimap();
          emit('positions', pinned);
          start = null;
        });
    }
    function setConnectMode(on) { connectMode = !!on; svg.node().classList.toggle('connect', connectMode); }

    // ── tooltips
    function degreeInfo(id) {
      if (!curL) return '';
      const outs = curL.edges.filter((e) => e.from === id), ins = curL.edges.filter((e) => e.to === id);
      const fmt = (list) => { const m = new Map(); list.forEach((e) => (e.rels || [e.kind]).forEach((r) => m.set(r, (m.get(r) || 0) + 1))); return Array.from(m).map(([r, c]) => `${r}×${c}`).join(', '); };
      const reachOut = Object.keys(neighbourhood([id], { dir: 'out', depth: Infinity, excludeRels: new Set() }).nodes).length - 1;
      const reachIn = Object.keys(neighbourhood([id], { dir: 'in', depth: Infinity, excludeRels: new Set() }).nodes).length - 1;
      return `<div class="sub">out ${outs.length}${outs.length ? ' (' + esc(fmt(outs)) + ')' : ''} · in ${ins.length}${ins.length ? ' (' + esc(fmt(ins)) + ')' : ''}</div><div class="sub">reaches ${reachOut} node${reachOut === 1 ? '' : 's'} · reached by ${reachIn}</div>`;
    }
    function tipForNode(n) {
      if (n.kind === 'group') return `<code>${esc(n.label)}</code><div class="sub">${n.members.length} ${esc(n.type)} objects shown as one node to keep a big store readable</div><code>${esc(n.members.slice(0, 8).join('\n'))}${n.members.length > 8 ? '\n…' : ''}</code><div class="sub">+ shows them individually · “show all” above the graph shows everything</div>`;
      if (n.kind === 'bundle') return `<code>${esc(n.label)}</code><div class="sub">${n.members.length} ${esc(n.type)}s with the same single tuple, bundled into one edge</div><code>${esc(n.members.slice(0, 10).join('\n'))}${n.members.length > 10 ? '\n…' : ''}</code><div class="sub">+ shows them individually</div>`;
      if (mode === 'model') {
        if (n.kind === 'rel') {
          const how = n.via === 'computed' ? `holding <b>${esc(n.rel)}</b> on the same object implies the parent relation` : n.via === 'ttu' ? `checked on each parent object reached through the tupleset` : n.via === 'userset' ? `anyone who is <b>${esc(n.rel)}</b> of a <b>${esc(n.type)}</b> named in a tuple` : 'the relation being resolved';
          return `<code>${esc(n.def)}</code><div class="sub">${how}${n.cycle ? ' · <b>↻ recursive</b>: already being resolved higher up, so OpenFGA stops here' : ''}</div><div class="sub">${n.expandable ? (n.expanded ? '– collapses' : '+ expands') + ' this branch · ' : ''}click to focus · double-click for queries · right-click for more</div>`;
        }
        if (n.kind === 'op') return `<code>${n.op === 'union' ? 'or' : n.op === 'intersection' ? 'and' : 'but not'}</code><div class="sub">${n.op === 'union' ? 'satisfied when ANY branch is; Check stops at the first one that holds' : n.op === 'intersection' ? 'satisfied only when ALL branches hold; Check stops at the first one that fails' : 'the base must hold AND the excluded branch must not'}</div>`;
        if (n.kind === 'direct') return `<code>[${esc(n.entries.join(', '))}]</code><div class="sub">tuples written straight onto <b>${esc(n.key)}</b>: Check reads them first and compares the subject</div>`;
        if (n.kind === 'ttu') return `<code>${esc(n.label)}</code><div class="sub">tuple-to-userset: read the object's <b>${esc(n.tupleset)}</b> tuples, then check <b>${esc(n.computed)}</b> on each of those objects${n.parents.length ? ` (${esc(n.parents.join(', '))})` : ''}</div>`;
        return `<code>${esc(n.label)}</code><div class="sub">${n.wildcard ? `a public grant: every ${esc(n.type)}` : `a subject of type ${esc(n.type)}`}${n.condition ? ` · only while condition <b>${esc(n.condition)}</b> holds` : ''}</div>`;
      }
      const tuples = (n.tuples || []).slice(0, 6).map((id) => S.store && S.store.byId(id)).filter(Boolean).map((t) => FGA.formatTuple(t));
      return `<code>${esc(n.label)}</code><div class="sub">${n.kind === 'wildcard' ? 'public access: every ' + esc(n.type) : 'type ' + esc(n.type)} · ${n.tuples.length} tuple${n.tuples.length === 1 ? '' : 's'}</div>${degreeInfo(n.id)}<code>${esc(tuples.join('\n'))}${n.tuples.length > 6 ? '\n…' : ''}</code><div class="sub">click to focus · double-click for queries · drag to move · Alt-drag to another node to write a tuple${n.card ? ' · – collapses the card' : n.expandable ? ' · + opens it as a card' : ''}</div>`;
    }
    function tipForEdge(e) {
      if (mode === 'data' && e.access) {
        const steps = stepsFor(e);
        const more = e.allRels && e.allRels.length > 1 ? `<div class="sub">${esc(e.user)} also holds, without a tuple: <b>${esc(e.allRels.slice(1).join(', '))}</b> (open ${esc(e.object)} as a card for one edge per relation)</div>` : '';
        return `<code>${esc(e.user)} ${esc(e.relation)} ${esc(e.object)}</code>${more}<div class="sub">derived — no tuple says this. Check follows these steps (numbered on the graph):</div>${steps ? stepsHtml(steps) : `<div class="sub">${esc(e.proofError || 'not allowed any more — the store changed')}</div>`}<div class="sub">click to pin the walk · double-click to run this Check</div>`;
      }
      if (mode === 'data' && e.derived) {
        const t = storeRef && storeRef.byId(e.tupleId);
        return `<code>${esc(e.fromSlot || e.from)} → ${esc(e.toSlot)}</code><div class="sub">derived, not a tuple: <b>${esc(e.computed)} from ${esc(e.tupleset)}</b> — whoever is ${esc(e.computed)} of ${esc(e.from)} is ${esc(e.rel)} of ${esc(e.to)}${t ? `, because of the tuple <code>${esc(FGA.formatTuple(t))}</code>` : ''}</div>`;
      }
      if (mode === 'data') {
        const ts = e.tupleIds.map((id) => S.store && S.store.byId(id)).filter(Boolean);
        const lines = ts.map((t) => FGA.formatTuple(t)).join('\n');
        const cond = e.conditions.length ? (emit('condInfo', ts.filter((t) => t.condition)) || '') : '';
        return `<code>${esc(lines)}</code><div class="sub">${ts.length === 1 ? 'relationship tuple' : ts.length + ' tuples between these nodes'}${e.usersets.length ? ` · userset${e.usersets.length > 1 ? 's' : ''} #${esc(e.usersets.join(', #'))}` : ''}${e.contextual ? ' · contextual' : ''} · right-click to delete</div>${cond}`;
      }
      if (mode === 'schema') return `<code>${esc(e.from)} → ${esc(e.to)}</code><div class="sub">${e.diff === 'removed' ? 'removed in the draft · ' : e.diff === 'added' ? 'new in the draft · ' : ''}${e.kind === 'direct' ? 'can be assigned directly to' : 'inherited through a tupleset relation'}</div><code>${esc(e.labels.join('\n'))}</code>${e.conditions.length ? `<div class="sub">with condition ${esc(e.conditions.join(', '))}</div>` : ''}`;
      const kind = e.kind === 'direct' ? `direct assignment${e.wildcard ? ' (public wildcard)' : ''}` : e.kind === 'computed' ? 'computed userset: an implied relation on the same object' : e.kind === 'ttu' ? 'tuple-to-userset: follows a tuple to another object' : 'branch of the definition';
      const ctx = e.ctx === 'intersection' ? ' · inside an "and"' : e.ctx === 'exclusion' ? ' · the excluded side of "but not"' : e.ctx === 'base' ? ' · base of "but not"' : '';
      return `<div class="sub">${kind}${ctx}</div>`;
    }
    function showTip(ev, html) { tip.innerHTML = html; tip.hidden = false; moveTip(ev); }
    function moveTip(ev) {
      const r = stage.getBoundingClientRect();
      let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
      if (x + tip.offsetWidth > r.width - 8) x = Math.max(8, ev.clientX - r.left - tip.offsetWidth - 10);
      if (y + tip.offsetHeight > r.height - 8) y = Math.max(8, ev.clientY - r.top - tip.offsetHeight - 10);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    function hideTip() { tip.hidden = true; }

    // ── viewport
    function setInsets({ bottom }) { insetBottom = bottom || 0; fit(false); }
    function fitBox(b, animate, maxK = 1.75) {
      const top = fbar && !fbar.hidden ? Math.min(fbar.offsetHeight + 14, stage.clientHeight * 0.45) : 0;
      const bottomBar = pbar && !pbar.hidden ? Math.min(pbar.offsetHeight + 14, stage.clientHeight * 0.4) : 0;
      const w = stage.clientWidth, h = stage.clientHeight - insetBottom - bottomBar - top;
      if (!w || h <= 40 || !b) return;
      const k = Math.min(maxK, 0.92 * Math.min(w / b.w, h / b.h));
      const t = d3.zoomIdentity.translate((w - b.w * k) / 2 - b.x0 * k, top + (h - b.h * k) / 2 - b.y0 * k).scale(k);
      (animate ? svg.transition().duration(350) : svg).call(zoom.transform, t);
    }
    function fit(animate = true) { fitBox(bounds, animate); }
    function fitToHighlighted(animate = true) {
      if (!curL) return;
      const ids = new Set(Array.from(gNodes.node().querySelectorAll('g.node.hl')).map((el) => el.getAttribute('data-id')));
      const ns = curL.nodes.filter((n) => ids.has(n.id));
      if (!ns.length) { fit(animate); return; }
      const x0 = Math.min(...ns.map((n) => n.x - n.width / 2)) - 40, x1 = Math.max(...ns.map((n) => n.x + n.width / 2)) + 40;
      const y0 = Math.min(...ns.map((n) => n.y - n.height / 2)) - 40, y1 = Math.max(...ns.map((n) => n.y + n.height / 2)) + 40;
      fitBox({ x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }, animate);
    }
    function panTo(id, animate = true) {
      const n = curL && curL.nodes.find((x) => x.id === id);
      if (!n) return;
      const k = Math.max(curT.k, 1);
      const w = stage.clientWidth, h = stage.clientHeight - insetBottom;
      const t = d3.zoomIdentity.translate(w / 2 - n.x * k, h / 2 - n.y * k).scale(k);
      (animate ? svg.transition().duration(400) : svg).call(zoom.transform, t);
    }
    function zoomBy(f) { svg.transition().duration(200).call(zoom.scaleBy, f); }
    function updateLod(k) { const el = svg.node(); el.classList.toggle('lod-low', k < 0.38); el.classList.toggle('lod-mid', k >= 0.38 && k < 0.6); }

    // ── minimap
    function updateMinimap() {
      const el = mini.node(); if (!el) return;
      const show = curL && curL.nodes.length > 8 && !el.classList.contains('user-hidden');
      el.toggleAttribute('hidden', !show);
      if (!show) return;
      const b = bounds; if (!b) return;
      const W = 150, H = Math.max(60, Math.min(110, Math.round((W * b.h) / b.w)));
      mini.attr('width', W).attr('height', H).attr('viewBox', `${b.x0} ${b.y0} ${b.w} ${b.h}`).attr('preserveAspectRatio', 'xMidYMid meet');
      mini.selectAll('rect.mn').data(curL.nodes, (n) => n.id).join('rect').attr('class', 'mn').attr('x', (n) => n.x - n.width / 2).attr('y', (n) => n.y - n.height / 2).attr('width', (n) => n.width).attr('height', (n) => n.height).attr('rx', 6).style('fill', (n) => colorOf(n.type));
      const w = stage.clientWidth, h = stage.clientHeight;
      const vx = -curT.x / curT.k, vy = -curT.y / curT.k, vw = w / curT.k, vh = h / curT.k;
      let vp = mini.select('rect.vp'); if (vp.empty()) vp = mini.append('rect').attr('class', 'vp');
      vp.attr('x', vx).attr('y', vy).attr('width', vw).attr('height', vh).raise();
    }
    (function wireMinimap() {
      const el = mini.node(); if (!el) return;
      const toGraph = (ev) => { const r = el.getBoundingClientRect(); const b = bounds; const sx = b.w / r.width, sy = b.h / r.height; const s = Math.max(sx, sy); const cx = b.x0 + b.w / 2, cy = b.y0 + b.h / 2; return { x: cx + (ev.clientX - (r.left + r.width / 2)) * s, y: cy + (ev.clientY - (r.top + r.height / 2)) * s }; };
      let down = false;
      const go = (ev) => { if (!bounds) return; const p = toGraph(ev); svg.call(zoom.translateTo, p.x, p.y); };
      el.addEventListener('pointerdown', (ev) => { down = true; el.setPointerCapture(ev.pointerId); go(ev); ev.preventDefault(); });
      el.addEventListener('pointermove', (ev) => { if (down) go(ev); });
      el.addEventListener('pointerup', () => { down = false; });
      el.addEventListener('dblclick', (ev) => ev.stopPropagation());
    })();
    function toggleMinimap() { const el = mini.node(); el.classList.toggle('user-hidden'); updateMinimap(); }

    // ── focus / selection
    const relKeysOf = (e) => (mode === 'data' ? e.rels : [e.kind]);
    function adjacency() {
      const outMap = new Map(), inMap = new Map();
      const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
      for (const e of (curL ? curL.edges : [])) { if (e.diff === 'removed') continue; push(outMap, e.from, e); push(inMap, e.to, e); }
      return { outMap, inMap };
    }
    function bfs(id, f, adj) {
      const nodes = new Map([[id, 'active']]), edges = new Map(), rels = new Set();
      const allowed = (e) => { const ks = relKeysOf(e); return ks.some((k) => !(mode === 'data' && hiddenRels.has(k)) && !f.excludeRels.has(k)); };
      let frontier = [id];
      for (let d = 0; d < f.depth && frontier.length; d++) {
        const next = [];
        for (const v of frontier) {
          if (f.dir !== 'in') for (const e of adj.outMap.get(v) || []) { relKeysOf(e).forEach((k) => rels.add(k)); if (!allowed(e)) continue; if (!edges.has(e.id)) edges.set(e.id, 'out'); if (!nodes.has(e.to)) { nodes.set(e.to, 'out'); next.push(e.to); } }
          if (f.dir !== 'out') for (const e of adj.inMap.get(v) || []) { relKeysOf(e).forEach((k) => rels.add(k)); if (!allowed(e)) continue; if (!edges.has(e.id)) edges.set(e.id, 'in'); if (!nodes.has(e.from)) { nodes.set(e.from, 'in'); next.push(e.from); } }
        }
        frontier = next;
      }
      return { nodes, edges, rels };
    }
    function neighbourhood(ids, f) {
      const nodes = {}, edges = {}, rels = new Set();
      if (!curL || !ids.length) return { nodes, edges, rels, connected: 0 };
      const adj = adjacency();
      const runs = ids.map((id) => bfs(id, f, adj));
      runs.forEach((r) => r.rels.forEach((x) => rels.add(x)));
      const selected = new Set(ids);
      if (ids.length === 1 || f.combine !== 'between') {
        runs.forEach((r) => { r.nodes.forEach((st, n) => { nodes[n] = selected.has(n) ? 'active' : (nodes[n] || st); }); r.edges.forEach((st, e) => { if (!edges[e]) edges[e] = st; }); });
      } else {
        const hits = new Map();
        runs.forEach((r) => r.nodes.forEach((st, n) => hits.set(n, (hits.get(n) || 0) + 1)));
        const keep = new Set(ids);
        hits.forEach((c, n) => { if (c >= 2) keep.add(n); });
        keep.forEach((n) => { nodes[n] = selected.has(n) ? 'active' : 'out'; });
        const byId = new Map(curL.edges.map((e) => [e.id, e]));
        runs.forEach((r) => r.edges.forEach((st, eid) => { const e = byId.get(eid); if (e && keep.has(e.from) && keep.has(e.to)) edges[eid] = 'out'; }));
        const touched = new Set(); Object.keys(edges).forEach((eid) => { const e = byId.get(eid); touched.add(e.from); touched.add(e.to); });
        Object.keys(nodes).forEach((n) => { if (!selected.has(n) && !touched.has(n)) delete nodes[n]; });
      }
      return { nodes, edges, rels, connected: Object.keys(nodes).length - ids.length };
    }
    // all simple paths from a to b (following edge direction, both directions when dir = both)
    function pathsBetween(a, b, { dir = 'out', maxLen = 6, limit = 25 } = {}) {
      if (!curL) return [];
      const adj = adjacency();
      const out = [];
      const label = (e) => (mode === 'data' ? e.rels.join(', ') : e.kind === 'ttu' ? e.label || 'from' : e.kind);
      const walk = (v, path, edgesUsed, hops, seen) => {
        if (out.length >= limit) return;
        if (v === b && path.length > 1) { out.push({ nodes: path.slice(), edges: edgesUsed.slice(), hops: hops.slice() }); return; }
        if (path.length > maxLen) return;
        const steps = [];
        if (dir !== 'in') (adj.outMap.get(v) || []).forEach((e) => steps.push({ e, to: e.to, back: false }));
        if (dir !== 'out') (adj.inMap.get(v) || []).forEach((e) => steps.push({ e, to: e.from, back: true }));
        for (const s of steps) { if (seen.has(s.to)) continue; seen.add(s.to); path.push(s.to); edgesUsed.push(s.e.id); hops.push({ to: s.to, back: s.back, rel: label(s.e) }); walk(s.to, path, edgesUsed, hops, seen); path.pop(); edgesUsed.pop(); hops.pop(); seen.delete(s.to); }
      };
      walk(a, [a], [], [], new Set([a]));
      out.sort((x, y) => x.nodes.length - y.nodes.length);
      return out;
    }
    function toHl(nb) {
      if (mode === 'data') return { dataNodes: nb.nodes, dataEdges: nb.edges };
      if (mode === 'model') return { modelNodes: nb.nodes, modelEdges: nb.edges };
      const modelNodes = {}; Object.entries(nb.nodes).forEach(([k, v]) => { modelNodes[`${k}@self`] = v; });
      return { modelNodes, schemaEdges: nb.edges };
    }
    function edgeHl(e) { const nodes = {}; nodes[e.from] = 'in'; nodes[e.to] = 'out'; const edges = {}; edges[e.id] = 'active'; return toHl({ nodes, edges }); }
    const defaultFocus = { dir: 'both', depth: 1, excludeRels: new Set(), combine: 'union' };
    function previewFocus(id) { if (focus) return; hoverHl = id ? toHl(neighbourhood([id], defaultFocus)) : null; applyVisual(); }
    function pushHistory(nodeId) { history = history.slice(0, hIndex + 1); history.push(nodeId); if (history.length > 40) history.shift(); hIndex = history.length - 1; }
    function setFocus(nodeId, datum, ev, opts = {}) {
      const additive = !!(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) || !!(focus && focus.multi);
      if (!focus) {
        const adj = adjacency();
        const outs = (adj.outMap.get(nodeId) || []).length, ins = (adj.inMap.get(nodeId) || []).length;
        const dir = outs && !ins ? 'out' : ins && !outs ? 'in' : 'both';
        focus = { nodes: [], datums: new Map(), dir, depth: dir === 'both' ? 1 : Infinity, excludeRels: new Set(), isolate: false, combine: 'between', multi: false, pathIdx: -1 };
      }
      if (additive) {
        const i = focus.nodes.indexOf(nodeId);
        if (i >= 0) { focus.nodes.splice(i, 1); focus.datums.delete(nodeId); if (!focus.nodes.length) { clearFocus(); return; } }
        else { focus.nodes.push(nodeId); focus.datums.set(nodeId, datum); }
      } else { focus.nodes = [nodeId]; focus.datums = new Map([[nodeId, datum]]); if (!opts.fromHistory) pushHistory(nodeId); }
      focus.pathIdx = -1;
      hoverHl = null;
      renderFocusBar();
      applyVisual();
      if (focus.isolate) fitToHighlighted(true);
    }
    function clearFocus() { if (!focus) return; focus = null; hoverHl = null; renderFocusBar(); applyVisual(); }
    function goHistory(delta) {
      const i = hIndex + delta; if (i < 0 || i >= history.length) return;
      hIndex = i; const id = history[i];
      const n = curL && curL.nodes.find((x) => x.id === id);
      if (!n) return;
      setFocus(id, n, null, { fromHistory: true }); panTo(id);
    }

    // ── painting
    const HL = ['hl', 'hl-active', 'hl-read', 'hl-ok', 'hl-fail', 'hl-skip', 'hl-in', 'hl-out', 'hl-ghost'];
    function highlight(hl, opts = {}) { currentHl = hl; lastOpts = opts; applyVisual(); }
    function applyVisual() {
      const svgEl = svg.node();
      const wasIsolated = svgEl.classList.contains('isolate');
      svgEl.classList.toggle('isolate', !!(focus && focus.isolate));
      svgEl.classList.toggle('multi', !!(focus && focus.multi));
      gEdges.selectAll('g.edge').each(function (e) { this.classList.toggle('off', mode === 'data' && e.rels.every((r) => hiddenRels.has(r))); });
      const walk = mode === 'data' ? (proofWalk || proofPreview) : null;
      if (walk) { paint(proofHlOf(walk.steps), { stepping: true, proof: true }); placeBadges(); if (wasIsolated) fit(true); return; }
      gBadges.selectAll('*').remove();
      if (focus) {
        let hl;
        if (focus.pathIdx >= 0 && focus.paths && focus.paths[focus.pathIdx]) { const p = focus.paths[focus.pathIdx]; const nodes = {}, edges = {}; p.nodes.forEach((n, i) => { nodes[n] = i === 0 || i === p.nodes.length - 1 ? 'active' : 'ok'; }); p.edges.forEach((e) => { edges[e] = 'ok'; }); hl = toHl({ nodes, edges }); }
        else hl = toHl(neighbourhood(focus.nodes, focus));
        paint(hl, { stepping: true, focus: true });
        if (focus.isolate) fitToHighlighted(true); else if (wasIsolated) fit(true);
        return;
      }
      if (wasIsolated) fit(true);
      if (hoverHl) { paint(hoverHl, { stepping: true, focus: true }); return; }
      paint(currentHl, lastOpts);
    }
    function paint(hl, opts = {}) {
      const svgEl = svg.node();
      svgEl.classList.toggle('stepping', !!opts.stepping);
      svgEl.classList.toggle('focusing', !!opts.focus);
      svgEl.classList.toggle('proofing', !!opts.proof);
      root.selectAll('.node, .edge, .cluster, .row, .ilink').each(function () { this.classList.remove(...HL); });
      if (!hl) { svgEl.classList.remove('has-hl'); gEdges.selectAll('g.edge').each(function (e) { d3.select(this).select('path.main').attr('marker-end', baseMarker(e)); }); return; }
      const rank = { skip: 0, ghost: 0, read: 1, active: 2, in: 2, out: 2, fail: 3, ok: 4 };
      let any = false;
      const touchClusters = new Set();
      const mark = (el, st) => { el.classList.add('hl', `hl-${st}`); any = true; };
      if (mode === 'schema') {
        for (const [id, st] of Object.entries(hl.modelNodes || {})) {
          const m = /^(.+)@self$/.exec(id);
          const el = m ? gNodes.select(`g.node[data-id="${cssEsc(m[1])}"]`) : gNodes.select(`g.row[data-id="${cssEsc(id)}"]`);
          if (el.empty()) continue;
          mark(el.node(), st);
          if (!m) { const card = el.node().closest('g.node'); if (card) card.classList.add('hl'); }
        }
        gEdges.selectAll('g.edge').each(function (e) {
          let best = hl.schemaEdges ? (hl.schemaEdges[e.id] || null) : null;
          if (!hl.schemaEdges) for (const gid of e.gids) { const st = (hl.modelEdges || {})[gid]; if (st && (best === null || rank[st] > rank[best])) best = st; }
          const main = d3.select(this).select('path.main');
          if (best) { mark(this, best); main.attr('marker-end', `url(#arrow-${best})`); [e.from, e.to].forEach((id) => gNodes.select(`g.node[data-id="${cssEsc(id)}"]`).each(function () { this.classList.add('hl'); })); }
          else main.attr('marker-end', baseMarker(e));
        });
        svgEl.classList.toggle('has-hl', any);
        return;
      }
      if (mode === 'model') { paintTree(hl, rank, mark); svgEl.classList.toggle('has-hl', any); return; }
      const nodes = hl.dataNodes || {};
      const edgesHl = hl.dataEdges || {};
      for (const [id, st] of Object.entries(nodes)) {
        if (id.includes('#')) {
          // a userset `object#relation` is a slot row on that object's card
          const row = gNodes.select(`g.row[data-id="${cssEsc(id)}"]`);
          if (!row.empty()) { mark(row.node(), st); const card = row.node().closest('g.node'); if (card) card.classList.add('hl'); }
          continue;
        }
        const el = gNodes.select(`g.node[data-id="${cssEsc(id)}"]`);
        if (!el.empty()) { mark(el.node(), st); touchClusters.add(el.datum().cluster); }
      }
      // bundles and type groups light up when any member does
      gNodes.selectAll('g.node.bundle, g.node.group').each(function (d) {
        let best = null; (d.members || []).forEach((m) => { const v = nodes[m]; if (v && (!best || rank[v] > rank[best])) best = v; });
        if (best) mark(this, best);
      });
      gEdges.selectAll('g.edge').each(function (e) {
        let best = null;
        if (e.access) {
          // materialised access lights up when both ends are proven in the current highlight
          const a = nodes[e.from], b = e.toSlot ? nodes[e.toSlot] : nodes[e.to];
          if (a && b && rank[a] >= rank.active && rank[b] >= rank.active) best = a === 'ok' && b === 'ok' ? 'ok' : 'read';
        } else if (e.derived) {
          // a tuple-to-userset edge lights up with the tuple it derives from, when its slot is in play
          const st = edgesHl[`t${e.tupleId}`];
          if (st && nodes[e.toSlot]) best = st;
        } else {
          best = edgesHl[e.id] || null;
          const keys = mode === 'data' ? e.tupleIds.map((id) => `t${id}`) : (e.gids || []);
          for (const k of keys) { const st = edgesHl[k]; if (st && (best === null || rank[st] > rank[best])) best = st; }
        }
        const main = d3.select(this).select('path.main');
        if (best) { mark(this, best); main.attr('marker-end', `url(#arrow-${best})`); touchClusters.add(e.from.split('#')[0].split('@')[0]); touchClusters.add(e.to.split('#')[0].split('@')[0]); }
        else main.attr('marker-end', baseMarker(e));
      });
      // computed links inside a card follow the model edge they stand for, on the object being resolved
      const me = hl.modelEdges || {};
      gNodes.selectAll('path.ilink').each(function (l) {
        const st = me[l.gid];
        if (st && nodes[l.object]) { this.classList.add('hl', `hl-${st}`); this.setAttribute('marker-end', `url(#arrow-s-${st})`); any = true; }
        else this.setAttribute('marker-end', `url(#arrow-s-${l.ctx === 'exclusion' ? 'exclusion' : 'computed'})`);
      });
      touchClusters.forEach((c) => { const el = gClusters.select(`g.cluster[data-id="${cssEsc(c)}"]`); if (!el.empty()) el.node().classList.add('hl'); });
      svgEl.classList.toggle('has-hl', any);
    }
    // Resolution tree: trace keys are relation keys (type#rel), subject keys (type@self) and model
    // edge gids; the same relation can appear in several branches, so every matching tree node lights
    // up. Structural nodes (any of / directly assigned / from) and their edges take the strongest state
    // of what hangs below them so the highlighted path stays connected. Focus/hover highlights come in
    // keyed by tree node id and are applied directly.
    function paintTree(hl, rank, mark) {
      if (!curL) return;
      const nodeSt = new Map(), edgeSt = new Map();
      const better = (m, k, st) => { const cur = m.get(k); if (!cur || rank[st] > rank[cur]) m.set(k, st); };
      const mn = hl.modelNodes || {}, me = hl.modelEdges || {}, rw = hl.rewrites || {};
      // seeds: [tree node id, state, strong]. A relation lights up everywhere it appears in the tree, but
      // only the branch the engine actually walked (edge gid / rewrite position) carries its verdict upward;
      // a relation that happens to appear in another branch only marks that branch as "seen".
      const seeds = [];
      curL.nodes.forEach((n) => {
        if (mn[n.id]) { better(nodeSt, n.id, mn[n.id]); seeds.push([n.id, mn[n.id], true]); }
        if (n.kind === 'rel' && mn[n.key]) { better(nodeSt, n.id, mn[n.key]); seeds.push([n.id, mn[n.key], false]); }
        if (n.kind === 'subject' && mn[n.subj]) { better(nodeSt, n.id, mn[n.subj]); seeds.push([n.id, mn[n.subj], false]); }
        if (n.rkey && rw[n.rkey]) { better(nodeSt, n.id, rw[n.rkey]); seeds.push([n.id, rw[n.rkey], true]); }
      });
      curL.edges.forEach((e) => {
        let st = null;
        if (me[e.id]) st = me[e.id];
        if (e.gid && me[e.gid] && (!st || rank[me[e.gid]] > rank[st])) st = me[e.gid];
        if (e.rkey && rw[e.rkey] && (!st || rank[rw[e.rkey]] > rank[st])) st = rw[e.rkey];
        if (st) { better(edgeSt, e.id, st); seeds.push([e.from, st, true]); }
      });
      // propagate upwards through structural nodes: a marked child marks the edge into it and its parent
      const byId = new Map(curL.nodes.map((n) => [n.id, n]));
      const parentOf = new Map(curL.edges.map((e) => [e.to, e]));
      const lift = (st, strong) => (strong && (st === 'ok' || st === 'fail') ? st : 'read');
      seeds.forEach(([id, st, strong]) => {
        let cur = byId.get(id), guard = 0;
        while (cur && guard++ < 50) {
          if (cur.kind !== 'rel') better(nodeSt, cur.id, lift(st, strong));
          const pe = parentOf.get(cur.id); if (!pe) break;
          better(edgeSt, pe.id, lift(st, strong));
          const parent = byId.get(pe.from);
          if (!parent || parent.kind === 'rel') break;
          cur = parent;
        }
      });
      nodeSt.forEach((st, id) => { const el = gNodes.select(`g.node[data-id="${cssEsc(id)}"]`); if (!el.empty()) mark(el.node(), st); });
      gEdges.selectAll('g.edge').each(function (e) {
        const st = edgeSt.get(e.id);
        const main = d3.select(this).select('path.main');
        if (st) { mark(this, st); main.attr('marker-end', `url(#arrow-${st})`); } else main.attr('marker-end', baseMarker(e));
      });
    }
    function flash(ids, ms = 1400) {
      const set = new Set(ids);
      root.selectAll('.node, .edge, .row, .cluster').each(function (d) {
        const id = this.getAttribute('data-id');
        const hit = set.has(id) || (d && d.tupleIds && d.tupleIds.some((t) => set.has(`t${t}`))) || (d && d.gids && d.gids.some((g) => set.has(g)));
        if (hit) { this.classList.remove('flash'); void this.getBoundingClientRect(); this.classList.add('flash'); setTimeout(() => this.classList.remove('flash'), ms); }
      });
    }
    function afterRender() {
      if (focus) { const ids = new Set((curL ? curL.nodes : []).map((n) => n.id)); focus.nodes = focus.nodes.filter((id) => ids.has(id)); if (!focus.nodes.length) focus = null; }
      renderRelChips();
      renderFocusBar();
      applyVisual();
      updateMinimap();
      updateLod(curT.k);
      declutterLabels();
    }

    // ── proof walk
    // Steps come from FGA.proofSteps: one per tuple hop, implied relation or tuple-to-userset
    // derivation, numbered from the subject to the goal. The same numbers are drawn as badges on the
    // edges / card arcs they refer to and listed in the bar at the bottom of the stage.
    function proofFor(e) {
      if (e.proof !== undefined) return e.proof;
      e.proof = null;
      if (!modelRef || !storeRef) return null;
      try {
        const res = FGA.check(modelRef, storeRef, { user: e.user, relation: e.relation, object: e.object, context: {} });
        if (res.allowed && res.root && res.root.proof) e.proof = res.root.proof;
        else e.proofError = res.error || 'not allowed any more — the store changed';
      } catch (err) { e.proofError = err.message; }
      return e.proof;
    }
    function stepsFor(e) { const pr = proofFor(e); return pr ? FGA.proofSteps(pr, proofOrder) : null; }
    const locked = () => proofLock && !!proofWalk;
    const stepShort = (st) => {
      const down = proofOrder === 'check';
      if (st.kind === 'tuple') return down ? `${st.object} ←${st.relation}─ ${st.from}` : `${st.from} ─${st.relation}→ ${st.object}`;
      if (st.kind === 'computed') return down ? `${st.object}#${st.relation} ⇐ ${st.implied}` : `${st.implied} ⇒ ${st.object}#${st.relation}`;
      if (st.kind === 'ttu') return down ? `${st.object}#${st.relation} ⇐ ${st.computed} from ${st.tupleset}` : `${st.computed} from ${st.tupleset} ⇒ ${st.object}#${st.relation}`;
      if (st.kind === 'and') return down ? `${st.object}#${st.relation}: ∧ all branches` : `∧ all hold → ${st.object}#${st.relation}`;
      if (st.kind === 'check') return `${st.user} ${st.ok ? 'is' : 'is not'} ${st.relation} of ${st.object}`;
      if (st.kind === 'direct') return `no ${st.relation} tuple for ${st.user} on ${st.object}`;
      if (st.kind === 'noparent') return `${st.object} has no ${st.tupleset}`;
      if (st.kind === 'base') return `base of ${st.relation} holds`;
      return st.text;
    };
    function stepsHtml(steps) {
      return `<ol class="steps">${steps.map((st) => `<li class="${st.ok === false || st.excluded ? 'fail' : ''}"><b>${st.n}</b><span>${esc(st.text)}</span></li>`).join('')}</ol>`;
    }
    function proofHlOf(steps) {
      const hl = { dataNodes: {}, dataEdges: {}, modelEdges: {}, tupleIds: [] };
      const put = (m, k, v) => { if (!m[k] || (v === 'fail' && m[k] !== 'fail')) m[k] = v; };
      steps.forEach((st) => {
        const v = st.ok === false || st.excluded ? 'fail' : 'ok';
        if (st.tupleId != null) { put(hl.dataEdges, `t${st.tupleId}`, v); hl.tupleIds.push(st.tupleId); }
        [st.from, st.to].forEach((k) => { if (!k) return; put(hl.dataNodes, k, v); put(hl.dataNodes, k.split('#')[0], v === 'fail' && st.kind !== 'check' ? 'read' : v); });
        if (st.fromObject) put(hl.dataNodes, st.fromObject, 'read');
        if (st.object) put(hl.dataNodes, st.object, v === 'fail' ? 'read' : 'ok');
        if (st.gid) put(hl.modelEdges, st.gid, v);
      });
      return hl;
    }
    function showProof(src, opts = {}) {
      // src: a proof (from a Check) or { stepsFor(order) } for any other numbered walk (a denial)
      const stepsFor = !src ? () => [] : typeof src.stepsFor === 'function' ? src.stepsFor : (o) => FGA.proofSteps(src, o);
      const steps = stepsFor(proofOrder);
      if (!steps.length) { clearProof({ force: true }); return; }
      const objs = new Set();
      steps.forEach((st) => { if (st.object) objs.add(st.object); if (st.fromObject) objs.add(st.fromObject); [st.from, st.to].forEach((k) => { if (k && k.includes('#')) objs.add(k.split('#')[0]); }); });
      const canOpen = (o) => { const t = modelRef && modelRef.typeMap.get(o.split(':')[0]); return !!(t && t.relations.length); };
      const isCardNow = (o) => !!(curL && curL.nodes.some((n) => n.id === o && n.kind === 'inst'));
      const wasOnly = !!(proofWalk && proofWalk.only);
      proofWalk = { stepsFor, steps, title: opts.title || '', back: opts.back || null, auto: !!opts.auto, denial: !!opts.denial, only: opts.only !== undefined ? !!opts.only : !!opts.lock };
      proofLock = !!opts.lock;
      svg.node().classList.toggle('locked', proofLock);
      proofPreview = null;
      proofObjects = objs;
      // "only the path" changes which nodes exist at all; otherwise open the cards the walk needs
      if (mode === 'data' && (proofWalk.only || wasOnly || Array.from(objs).some((o) => canOpen(o) && !isCardNow(o) && curL && curL.nodes.some((n) => n.id === o)))) render(true);
      else { renderProofBar(); applyVisual(); }
      if (!opts.auto && mode === 'data') setTimeout(() => fitToHighlighted(true), 30);
    }
    // back to the plain graph: no proof walk, focus, query highlight, opened cards or isolation
    // Reset = back to the picture as first drawn: also forgets nodes dragged in this view (returned so
    // the caller can offer Undo). keepLayout: clear the highlights only, leave every node where it is.
    function resetView(opts = {}) {
      const keep = !!opts.keepLayout;
      const key = pinKey(), hadPins = pinned[key] && Object.keys(pinned[key]).length ? pinned[key] : null;
      if (!keep && hadPins) { pinned[key] = {}; emit('positions', pinned); }
      proofLock = false; svg.node().classList.remove('locked');
      proofWalk = null; proofPreview = null; proofObjects = new Set();
      focus = null; hoverHl = null; currentHl = null; lastOpts = {};
      if (!keep) { cardOverride.clear(); expandedNodes.clear(); openBundles.clear(); expandedTypes.clear(); freshNext = true; }
      userMoved = false;
      gBadges.selectAll('*').remove();
      emit('reset');
      render(true);
      fit(true);
      return keep ? null : hadPins;
    }
    function restorePins(p) { if (!p) return; pinned[pinKey()] = p; emit('positions', pinned); render(true); }
    function setProofOnly(on) {
      if (!proofWalk || proofWalk.only === !!on) return;
      proofWalk.only = !!on;
      if (mode === 'data') { render(true); setTimeout(() => fitToHighlighted(true), 30); } else renderProofBar();
    }
    function clearProof(opts = {}) {
      if (locked() && !opts.force) return;
      proofLock = false; svg.node().classList.remove('locked');
      if (!proofWalk && !proofPreview && !proofObjects.size) return;
      const wouldStay = (o) => (cardOverride.has(o) ? cardOverride.get(o) : cardsMode === 'all' ? true : cardsMode === 'none' ? false : pathObjects.has(o));
      const closes = mode === 'data' && Array.from(proofObjects).some((o) => !wouldStay(o) && curL && curL.nodes.some((n) => n.id === o && n.kind === 'inst'));
      const wasOnly = !!(proofWalk && proofWalk.only);
      proofWalk = null; proofPreview = null; proofObjects = new Set();
      if (closes || (wasOnly && mode === 'data')) render(true); else { renderProofBar(); applyVisual(); }
    }
    const pbar = $('#proof-bar');
    function renderProofBar() {
      if (!pbar) return;
      const walk = mode === 'data' ? proofWalk : null;
      pbar.hidden = !walk;
      if (!walk) return;
      pbar.innerHTML = `<div class="pb-head"><span class="pb-title"><span class="pb-k${walk.denial ? ' no' : ''}">${walk.denial ? 'why not' : 'proof'}</span>${walk.title ? esc(walk.title) : ''}</span><span class="seg xs pb-order" title="Numbering: as Check resolves (from the queried object down to the subject) or as access flows (from the subject up to the goal)"><button data-o="check" aria-pressed="${proofOrder === 'check'}">Check order ↓</button><button data-o="flow" aria-pressed="${proofOrder === 'flow'}">access flow ↑</button></span><span class="seg xs pb-only" title="Only the path: lay out just the nodes, slots and edges this proof uses. Whole graph: keep everything, dimmed"><button data-only="1" aria-pressed="${!!walk.only}">only the path</button><button data-only="0" aria-pressed="${!walk.only}">whole graph</button></span><button class="btn sm toggle pb-lock" id="pb-lock" aria-pressed="${proofLock}" title="${proofLock ? 'Locked: clicks on the graph cannot change the selection or clear this walk. Click to unlock.' : 'Lock this walk so clicks on the graph cannot disturb it'}">${proofLock ? '🔒 locked' : '🔓 unlocked'}</button><span class="pb-hint">hover a step to flash it · click to go there</span><button class="btn sm ghost" id="pb-md" title="Copy this explanation as markdown">copy md</button>${walk.back ? `<button class="btn sm pb-back" id="pb-back">← back to ${esc(walk.back)}</button>` : ''}<button class="btn sm pb-close" id="pb-close" title="Leave the proof and show the whole graph again (Esc)">✕ show whole graph</button></div><div class="pb-steps">${walk.steps.map((st, i) => `<button class="pb-step k-${st.kind}${st.ok === false || st.excluded ? ' fail' : ''}" data-i="${i}" title="${esc(st.text)} — ${esc(st.why || '')}"><b>${st.n}</b>${esc(stepShort(st))}</button>`).join('')}</div>`;
      $$('.pb-step', pbar).forEach((b) => {
        const st = walk.steps[+b.dataset.i];
        b.addEventListener('mouseenter', () => flashStep(st));
        b.addEventListener('click', () => { const p = stepAnchor(st); if (p) panToPoint(p.x, p.y); flashStep(st); });
      });
      $$('.pb-order button', pbar).forEach((b) => b.addEventListener('click', () => setProofOrder(b.dataset.o)));
      $$('.pb-only button', pbar).forEach((b) => b.addEventListener('click', () => setProofOnly(b.dataset.only === '1')));
      $('#pb-lock').addEventListener('click', () => { proofLock = !proofLock; svg.node().classList.toggle('locked', proofLock); renderProofBar(); });
      const back = $('#pb-back'); if (back) back.addEventListener('click', () => emit('proofBack', walk.back));
      $('#pb-md').addEventListener('click', () => emit('proofCopy', walk.title));
      $('#pb-close').addEventListener('click', () => resetView());
    }
    function setProofOrder(o) {
      if (o !== 'check' && o !== 'flow') return;
      proofOrder = o;
      emit('proofOrder', o);
      if (proofWalk) { proofWalk.steps = proofWalk.stepsFor(proofOrder); renderProofBar(); placeBadges(); }
    }
    function flashStep(st) {
      const ids = [];
      if (st.tupleId != null) ids.push(`t${st.tupleId}`);
      if (st.kind === 'ttu') ids.push(`ttu:${st.tupleId}:${st.relation}`);
      if (st.to) ids.push(st.to);
      if (st.from && st.from.includes('#')) ids.push(st.from);
      flash(ids, 900);
      gBadges.selectAll('g.badge').each(function (d) { if (d === st) { this.classList.remove('flash'); void this.getBoundingClientRect(); this.classList.add('flash'); setTimeout(() => this.classList.remove('flash'), 900); } });
    }
    function slotPos(slotId, byId, side) {
      const obj = slotId.split('#')[0]; const card = byId.get(obj); if (!card) return null;
      const dx = side === 'right' ? card.width / 2 + 14 : -card.width / 2 - 14;
      if (card.kind === 'inst') { const i = card.rows.findIndex((r) => r.id === slotId); if (i >= 0) return { x: card.x + dx, y: card.y - card.height / 2 + rowCentre(i) }; }
      return { x: card.x + dx, y: card.y };
    }
    function stepAnchor(st) {
      if (!curL) return null;
      const byId = new Map(curL.nodes.map((n) => [n.id, n]));
      const onEdge = (e) => { if (!e || !e.mid) return null; const w = e.text ? measure(e.text, MONO_S) * 0.92 + 12 : 0; return { x: e.mid.x - (w ? w / 2 + 12 : 0), y: e.mid.y }; };
      if (st.kind === 'tuple') return onEdge(curL.edges.find((x) => x.kind === 'tuple' && x.tupleIds.includes(st.tupleId))) || slotPos(st.to, byId, 'left');
      if (st.kind === 'ttu') return onEdge(curL.edges.find((x) => x.kind === 'ttu' && x.tupleId === st.tupleId && x.rel === st.relation)) || slotPos(st.to, byId, 'left');
      if (st.kind === 'computed') {
        const card = byId.get(st.object);
        if (card && card.kind === 'inst') {
          const idx = card.links.findIndex((l) => l.from === st.implied && l.to === st.relation);
          if (idx >= 0) {
            const l = card.links[idx];
            const i = card.rows.findIndex((r) => r.rel === l.from), j = card.rows.findIndex((r) => r.rel === l.to);
            const x0 = card.width - card.arcW + 2 + (idx % 4) * 3, bulge = Math.max(6, card.arcW - 6 - (idx % 4) * 3);
            return { x: card.x - card.width / 2 + x0 + bulge + 9, y: card.y - card.height / 2 + (rowCentre(i) + rowCentre(j)) / 2 };
          }
        }
        return slotPos(st.to, byId, 'right');
      }
      if (st.kind === 'and' || st.kind === 'not') return slotPos(`${st.object}#${st.relation}`, byId, 'right');
      if (st.kind === 'check' || st.kind === 'base') return slotPos(st.to, byId, 'right');
      if (st.kind === 'direct' || st.kind === 'noparent') return slotPos(st.to, byId, 'left');
      return null;
    }
    function placeBadges() {
      gBadges.selectAll('*').remove();
      const walk = proofWalk || proofPreview;
      if (!walk || !curL || mode !== 'data') return;
      const placed = [];
      walk.steps.forEach((st) => {
        const p = stepAnchor(st); if (!p) return;
        // nudge right until clear of every badge already placed
        let x = p.x, guard = 0;
        while (guard++ < 12 && placed.some((q) => Math.hypot(q.x - x, q.y - p.y) < 19)) x += 19;
        placed.push({ x, y: p.y });
        const g = gBadges.append('g').datum(st).attr('class', `badge k-${st.kind}${st.ok === false || st.excluded ? ' fail' : ''}`).attr('transform', `translate(${x},${p.y})`);
        g.append('circle').attr('r', 9);
        g.append('text').attr('y', 3.5).attr('text-anchor', 'middle').text(st.n);
        g.on('mouseenter', (ev) => showTip(ev, `<code>${st.n}. ${esc(st.text)}</code><div class="sub">${esc(st.why || '')}</div>`)).on('mousemove', moveTip).on('mouseleave', hideTip);
      });
    }
    function panToPoint(x, y, animate = true) {
      const k = Math.max(curT.k, 1);
      const w = stage.clientWidth, h = stage.clientHeight - insetBottom;
      const t = d3.zoomIdentity.translate(w / 2 - x * k, h / 2 - y * k).scale(k);
      (animate ? svg.transition().duration(400) : svg).call(zoom.transform, t);
    }

    // ── focus bar
    const fbar = $('#focus-bar');
    function renderFocusBar() {
      if (!focus) { fbar.hidden = true; return; }
      fbar.hidden = false;
      const nb = neighbourhood(focus.nodes, Object.assign({}, focus, { excludeRels: new Set() }));
      const rels = Array.from(nb.rels).sort();
      const many = focus.nodes.length > 1;
      const nameOf = (id) => (mode === 'schema' ? `type ${id}` : id);
      const pathsAvail = focus.nodes.length === 2;
      if (pathsAvail) focus.paths = pathsBetween(focus.nodes[0], focus.nodes[1], { dir: focus.dir === 'both' ? 'both' : focus.dir }); else { focus.paths = null; focus.pathIdx = -1; }
      fbar.innerHTML = `<span class="fb-hist"><button class="btn sm icon ghost" id="fb-back" title="Previous focus" ${hIndex > 0 ? '' : 'disabled'}>‹</button><button class="btn sm icon ghost" id="fb-fwd" title="Next focus" ${hIndex < history.length - 1 ? '' : 'disabled'}>›</button></span>
        <span class="fb-nodes">${focus.nodes.map((id) => `<span class="fb-node" title="${esc(nameOf(id))}"><code>${esc(nameOf(id))}</code><button class="fb-x" data-rm="${esc(id)}" title="Remove from selection" aria-label="Remove ${esc(id)}">✕</button></span>`).join('')}</span>
        <button class="btn sm toggle" id="fb-multi" aria-pressed="${focus.multi}" title="Add nodes to the selection with a plain click (or hold Shift / Ctrl / ⌘ while clicking)">${focus.multi ? '+ adding…' : '+ add'}</button>
        <span class="fb-count">${nb.connected} connected</span>
        ${many ? `<span class="seg xs" data-fb="combine"><button data-v="between" aria-pressed="${focus.combine === 'between'}" title="Only what links the selected nodes to each other">Between</button><button data-v="union" aria-pressed="${focus.combine === 'union'}" title="Everything attached to any selected node">Union</button></span>` : ''}
        <span class="seg xs" data-fb="dir">${[['both', 'Both'], ['in', 'In'], ['out', 'Out']].map(([v, t]) => `<button data-v="${v}" aria-pressed="${focus.dir === v}" title="${v === 'in' ? 'Edges pointing at the node' : v === 'out' ? 'Edges leaving the node' : 'Both directions'}">${t}</button>`).join('')}</span>
        <span class="seg xs" data-fb="depth">${[[1, '1 hop'], [2, '2'], [3, '3'], [Infinity, 'All']].map(([v, t]) => `<button data-v="${v}" aria-pressed="${focus.depth === v}">${t}</button>`).join('')}</span>
        ${rels.length ? `<span class="fb-rels">${rels.map((r) => `<button class="relchip${focus.excludeRels.has(r) ? ' off' : ''}" data-rel="${esc(r)}" style="--e:${mode === 'data' ? relColor(r) : r === 'computed' ? 'var(--edge-computed)' : r === 'ttu' ? 'var(--edge-ttu)' : 'var(--edge-direct)'}" aria-pressed="${!focus.excludeRels.has(r)}">${esc(r)}</button>`).join('')}</span>` : ''}
        ${pathsAvail ? `<span class="fb-paths"><button class="btn sm toggle" id="fb-paths" aria-pressed="${focus.pathIdx >= 0}" title="All simple paths between the two selected nodes">${focus.paths.length} path${focus.paths.length === 1 ? '' : 's'}</button></span>` : ''}
        <button class="btn sm toggle" id="fb-isolate" aria-pressed="${focus.isolate}" title="Hide everything that is not connected">Isolate</button>
        <button class="btn sm ghost" id="fb-zoom" title="Zoom to the highlighted part">Zoom to</button>
        <button class="btn sm" id="fb-query" title="Queries for the first selected node">Query ▾</button>
        <button class="btn sm ghost" id="fb-clear" title="Clear selection (Esc)">✕</button>
        ${pathsAvail && focus.paths.length ? `<div class="fb-pathlist" id="fb-pathlist" ${focus.pathIdx >= 0 || focus.showPaths ? '' : 'hidden'}>${focus.paths.map((p, i) => `<button class="pathrow${focus.pathIdx === i ? ' on' : ''}" data-p="${i}"><span class="n">${p.nodes.length - 1} hop${p.nodes.length - 1 === 1 ? '' : 's'}</span><code>${esc(p.nodes[0])}${p.hops.map((h) => (h.back ? ` ←${h.rel}─ ` : ` ─${h.rel}→ `) + h.to).map(esc).join('')}</code></button>`).join('')}<button class="btn sm ghost" id="fb-paths-off">show neighbourhood instead</button></div>` : ''}`;
      const rerender = () => { renderFocusBar(); applyVisual(); };
      $$('[data-fb="dir"] button', fbar).forEach((b) => b.addEventListener('click', () => { focus.dir = b.dataset.v; focus.pathIdx = -1; rerender(); }));
      $$('[data-fb="depth"] button', fbar).forEach((b) => b.addEventListener('click', () => { focus.depth = b.dataset.v === 'Infinity' ? Infinity : +b.dataset.v; rerender(); }));
      $$('[data-fb="combine"] button', fbar).forEach((b) => b.addEventListener('click', () => { focus.combine = b.dataset.v; rerender(); }));
      $$('.relchip', fbar).forEach((b) => b.addEventListener('click', () => { const r = b.dataset.rel; if (focus.excludeRels.has(r)) focus.excludeRels.delete(r); else focus.excludeRels.add(r); rerender(); }));
      $$('.fb-x', fbar).forEach((b) => b.addEventListener('click', () => { const id = b.dataset.rm; focus.nodes = focus.nodes.filter((x) => x !== id); focus.datums.delete(id); if (!focus.nodes.length) clearFocus(); else rerender(); }));
      $$('.pathrow', fbar).forEach((b) => b.addEventListener('click', () => { focus.pathIdx = +b.dataset.p; focus.showPaths = true; rerender(); fitToHighlighted(true); }));
      const pb = $('#fb-paths'); if (pb) pb.addEventListener('click', () => { focus.showPaths = !focus.showPaths; if (focus.showPaths && focus.pathIdx < 0 && focus.paths.length) focus.pathIdx = 0; if (!focus.showPaths) focus.pathIdx = -1; rerender(); });
      const po = $('#fb-paths-off'); if (po) po.addEventListener('click', () => { focus.pathIdx = -1; focus.showPaths = false; rerender(); });
      $('#fb-multi').addEventListener('click', () => { focus.multi = !focus.multi; rerender(); });
      $('#fb-isolate').addEventListener('click', () => { focus.isolate = !focus.isolate; rerender(); });
      $('#fb-zoom').addEventListener('click', () => fitToHighlighted(true));
      $('#fb-clear').addEventListener('click', clearFocus);
      $('#fb-back').addEventListener('click', () => goHistory(-1));
      $('#fb-fwd').addEventListener('click', () => goHistory(1));
      $('#fb-query').addEventListener('click', (ev) => { const id = focus.nodes[0]; emit('nodeClick', focus.datums.get(id) || { kind: 'type', type: id, label: id }, mode === 'schema' ? 'model' : mode, ev); });
    }
    // ── relation legend chips (data view)
    const chipsEl = $('#rel-chips');
    function renderRelChips() {
      if (mode !== 'data' || !curL) { chipsEl.hidden = true; chipsEl.innerHTML = ''; return; }
      const rels = Array.from(new Set(curL.edges.flatMap((e) => e.rels))).sort((a, b) => (relIndex.get(a) ?? 99) - (relIndex.get(b) ?? 99));
      chipsEl.hidden = !rels.length;
      chipsEl.innerHTML = rels.map((r) => `<button class="relchip${hiddenRels.has(r) ? ' off' : ''}" data-rel="${esc(r)}" style="--e:${relColor(r)}" aria-pressed="${!hiddenRels.has(r)}" title="Show or hide ${esc(r)} tuples">${esc(r)}</button>`).join('') + (hiddenRels.size ? `<button class="btn sm ghost" id="rel-all">show all</button>` : '');
      $$('.relchip', chipsEl).forEach((b) => b.addEventListener('click', () => { const r = b.dataset.rel; if (hiddenRels.has(r)) hiddenRels.delete(r); else hiddenRels.add(r); renderRelChips(); renderFocusBar(); applyVisual(); }));
      const all = $('#rel-all'); if (all) all.addEventListener('click', () => { hiddenRels.clear(); renderRelChips(); renderFocusBar(); applyVisual(); });
    }

    // ── search
    function candidates(query) {
      const q = (query || '').trim().toLowerCase();
      if (!q) return [];
      const out = [];
      const add = (id, label, m, kind, datum) => out.push({ id, label, mode: m, kind, datum, score: label.toLowerCase().startsWith(q) ? 0 : label.toLowerCase().includes(q) ? 1 : 2 });
      if (mode === 'matrix') return [];
      (graphs.data ? graphs.data.nodes : []).forEach((n) => { if (n.id.toLowerCase().includes(q)) add(n.id, n.id, 'data', n.kind === 'wildcard' ? 'wildcard' : 'object', n); });
      if (q.includes('#') && graphs.data && modelRef) graphs.data.nodes.forEach((n) => { const t = modelRef.typeMap.get(n.type); if (!t || n.kind !== 'object') return; t.relations.forEach((r) => { const id = `${n.id}#${r.name}`; if (id.toLowerCase().includes(q)) add(id, id, 'data', 'userset', { id, object: n.id, rel: r.name }); }); });
      (graphs.model ? graphs.model.nodes : []).forEach((n) => { if (n.kind === 'rel' && n.id.toLowerCase().includes(q)) add(n.id, n.id, 'model', 'relation', n); });
      (graphs.schema ? graphs.schema.nodes : []).forEach((n) => { if (n.id.toLowerCase().includes(q)) add(n.id, `type ${n.id}`, 'schema', 'type', n); });
      const curFirst = (x) => (x.mode === mode ? 0 : 1);
      return out.sort((a, b) => a.score - b.score || curFirst(a) - curFirst(b) || a.label.localeCompare(b.label)).slice(0, 12);
    }
    function jumpTo(item) {
      if (item.mode !== mode) { mode = item.mode; emit('modeChanged', mode); render(false); }
      if (mode === 'data') {
        const target = item.kind === 'userset' ? item.datum.object : item.id;
        if (curL && !curL.nodes.some((x) => x.id === target)) {
          expandedNodes.add(target); expandedTypes.add(String(target).split(':')[0]);
          Array.from(openBundles); curVG && curVG.nodes.filter((x) => x.kind === 'bundle' && x.members.includes(target)).forEach((b) => openBundles.add(b.key));
          render(true);
        }
      }
      if (mode === 'model') { setResolutionRoot(item.id); fit(true); const r = curL && curL.nodes[0]; if (r) flash([r.id]); return; }
      if (item.kind === 'userset') {
        if (!cardOverride.get(item.datum.object) && !(curL && curL.nodes.some((x) => x.id === item.datum.object && x.kind === 'inst'))) toggleCard(item.datum.object, true);
        const n = curL && curL.nodes.find((x) => x.id === item.datum.object);
        if (!n) return;
        setFocus(n.id, n, null); panTo(n.id, true); flash([item.id]);
        return;
      }
      const n = curL && curL.nodes.find((x) => x.id === item.id);
      if (!n) return;
      setFocus(item.id, n, null);
      panTo(item.id, true);
      flash([item.id]);
    }

    // ── export
    function svgMarkup() {
      const src = svg.node();
      const clone = src.cloneNode(true);
      const b = bounds || { x0: 0, y0: 0, w: 800, h: 600 };
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', Math.round(b.w)); clone.setAttribute('height', Math.round(b.h));
      clone.setAttribute('viewBox', `${b.x0} ${b.y0} ${b.w} ${b.h}`);
      const vp = clone.querySelector('g.viewport'); if (vp) vp.removeAttribute('transform');
      const PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'opacity', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'display', 'marker-end', 'rx'];
      const walk = (orig, cp) => {
        if (orig.nodeType !== 1) return;
        const cs = getComputedStyle(orig);
        if (orig.tagName !== 'svg' && orig.tagName !== 'defs') PROPS.forEach((p) => { const v = cs.getPropertyValue(p); if (v && v !== 'none' || p === 'fill') cp.style.setProperty(p, v); });
        Array.from(orig.children).forEach((c, i) => walk(c, cp.children[i]));
      };
      walk(src, clone);
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', b.x0); bg.setAttribute('y', b.y0); bg.setAttribute('width', b.w); bg.setAttribute('height', b.h); bg.setAttribute('fill', getComputedStyle(document.body).backgroundColor);
      clone.insertBefore(bg, clone.firstChild.nextSibling);
      return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    }
    function pngBlob(scale = 2) {
      return new Promise((resolve, reject) => {
        const markup = svgMarkup();
        const b = bounds || { w: 800, h: 600 };
        const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
        const img = new Image();
        img.onload = () => { const c = document.createElement('canvas'); c.width = Math.round(b.w * scale); c.height = Math.round(b.h * scale); const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not render'))), 'image/png'); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not render the SVG')); };
        img.src = url;
      });
    }

    new ResizeObserver(debounce(() => {
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      const big = lastStage.w && (Math.abs(w - lastStage.w) / lastStage.w > 0.25 || Math.abs(h - lastStage.h) / lastStage.h > 0.25);
      lastStage = { w, h };
      if (big && layoutPreset === 'auto') render(true); else { fit(false); updateMinimap(); }
    }, 120)).observe(stage);

    return {
      setData, setMode, setLayout, setSubjects, setPins, restorePins, setCollapsed, resetLayout, setInsets, setConnectMode, toggleMinimap,
      setResolutionRoot, setQueryRelation, get resolutionRoot() { return treeRoot; }, get resolutionKey() { return resolutionKey(); },
      setCardsMode, setPathObjects, toggleCard, setDerived, showProof, clearProof, resetView, setScope, tidy, get scope() { return scopeMode; }, setProofOrder, setProofOnly, flashStep, panToStep: (st) => { const p = stepAnchor(st); if (p) panToPoint(p.x, p.y); flashStep(st); }, get proofActive() { return !!proofWalk; }, get proofLocked() { return locked(); }, get proofOrder() { return proofOrder; }, get cardsMode() { return cardsMode; }, isCard: (id) => !!(curL && curL.nodes.some((n) => n.id === id && n.kind === 'inst')),
      fit, fitToHighlighted, panTo, zoomBy, highlight, flash, clearFocus,
      focusNode: (id) => { const n = curL && curL.nodes.find((x) => x.id === id); if (n) setFocus(id, n, null); },
      candidates, jumpTo, pathsBetween, svgMarkup, pngBlob, _layout: () => curL,
      on: (k, fn) => { handlers[k] = fn; }, colorOf, relColor,
      get mode() { return mode; }, get layout() { return layoutPreset; }, get hasFocus() { return !!focus; }, get multiSelecting() { return !!(focus && focus.multi); }, get connectMode() { return connectMode; }, get focusNodes() { return focus ? focus.nodes.slice() : []; },
    };
  })();
