  // ═══════════════════════════ GRAPH ═══════════════════════════
  // Three views over one model: schema (type cards), resolver (relation nodes), data (tuples).
  // Shared systems: layout presets, pinned positions & drag, focus/selection, highlight painting,
  // minimap, zoom level of detail, search, flashes, connect-to-create and export.

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
  // Resolver view without the subject fan-out: pure subject types become badges on the relations they can be assigned to.
  function resolverGraph(g, showSubjects) {
    if (showSubjects) return g;
    const counts = new Map();
    g.nodes.forEach((n) => counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1));
    const pure = new Set(g.clusters.filter((c) => counts.get(c.id) === 1).map((c) => c.id));
    const badges = new Map();
    const edges = g.edges.filter((e) => {
      const m = /^(.+)@self$/.exec(e.from);
      if (m && pure.has(m[1])) {
        const list = badges.get(e.to) || [];
        list.push(m[1] + (e.wildcard ? ', ' + m[1] + ':*' : '') + (e.conditions.length ? ' ⚡' : ''));
        badges.set(e.to, list);
        return false;
      }
      return true;
    });
    const nodes = g.nodes.filter((n) => !(n.kind === 'type' && pure.has(n.type))).map((n) => (badges.has(n.id) ? Object.assign({}, n, { badge: badges.get(n.id).join(', ') }) : n));
    return { nodes, edges, clusters: g.clusters.filter((c) => !pure.has(c.id)) };
  }

  const PALETTE = ['#8ea2ff', '#38c7b5', '#f0a152', '#c58cff', '#f2c94c', '#5cc8ff', '#ff7f9f', '#8fd16e', '#ff9b6b', '#6fd0d8'];
  const REL_PALETTE = ['#7f93b8', '#38c7b5', '#e2a04a', '#b48cff', '#5cc8ff', '#ff8aa6', '#8fd16e', '#f2c94c', '#ff9b6b', '#6fd0d8', '#d49bff', '#9bd0ff'];
  const hashStr = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

  const Graph = (() => {
    const svg = d3.select('#graph-svg');
    const defs = svg.append('defs');
    const MARKERS = ['direct', 'computed', 'ttu', 'exclusion', 'active', 'read', 'ok', 'fail', 'skip', 'in', 'out', 'ghost', 'added', 'removed'];
    MARKERS.forEach((k) => {
      defs.append('marker').attr('id', `arrow-${k}`).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5).attr('markerWidth', 9).attr('markerHeight', 9).attr('markerUnits', 'userSpaceOnUse').attr('orient', 'auto-start-reverse')
        .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('class', `mk mk-${k}`);
    });
    const root = svg.append('g').attr('class', 'viewport');
    const gClusters = root.append('g').attr('class', 'layer-clusters');
    const gEdges = root.append('g').attr('class', 'layer-edges');
    const gNodes = root.append('g').attr('class', 'layer-nodes');
    const gTemp = root.append('g').attr('class', 'layer-temp');
    const stage = $('#graph-stage'), tip = $('#graph-tip'), empty = $('#graph-empty');
    const mini = d3.select('#minimap');
    let curT = d3.zoomIdentity;
    const zoom = d3.zoom().scaleExtent([0.08, 4]).clickDistance(4).on('zoom', (e) => { curT = e.transform; root.attr('transform', e.transform); updateLod(e.transform.k); updateMinimap(); });
    svg.call(zoom).on('dblclick.zoom', null);
    const canvas = document.createElement('canvas').getContext('2d');
    const measure = (text, font) => { canvas.font = font; return canvas.measureText(text).width; };
    const MONO = '500 12px "JetBrains Mono", Menlo, monospace';
    const MONO_S = '500 11.5px "JetBrains Mono", Menlo, monospace';
    const DISPLAY = '700 12.5px "Bricolage Grotesque", sans-serif';

    // ── state
    let graphs = { schema: null, model: null, data: null };
    let mode = 'schema', layoutPreset = 'auto', showSubjects = false;
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
    function setData({ schema, model, data, types, relations, modelObj }) {
      graphs = { schema, model, data };
      modelRef = modelObj || null;
      typeIndex = new Map(types.map((t, i) => [t, i]));
      relIndex = new Map((relations || []).map((r, i) => [r, i]));
      hiddenRels.forEach((r) => { if (!relIndex.has(r)) hiddenRels.delete(r); });
      render(true);
    }
    function setMode(m) { mode = m; focus = null; hoverHl = null; render(false); }
    function setLayout(p) { layoutPreset = p; render(true); }
    function setSubjects(on) { showSubjects = !!on; if (mode === 'model') render(true); }
    function setPins(p) { pinned = Object.assign({ schema: {}, model: {}, data: {} }, p || {}); }
    function setCollapsed(list) { collapsed = new Set(list || []); }
    function resetLayout() { pinned[mode] = {}; emit('positions', pinned); render(true); }

    // ── view graphs: what each mode actually draws
    function viewGraph() {
      const g0 = graphs[mode];
      if (!g0 || !g0.nodes.length) return null;
      if (mode === 'schema') {
        const nodes = g0.nodes.map((n) => Object.assign({}, n, { collapsed: collapsed.has(n.id) }));
        return { nodes, edges: g0.edges.map((e) => Object.assign({}, e)), clusters: [] };
      }
      if (mode === 'model') {
        const g = resolverGraph(g0, showSubjects);
        if (!collapsed.size) return { nodes: g.nodes.map((n) => Object.assign({}, n)), edges: g.edges.map((e) => Object.assign({}, e)), clusters: g.clusters.map((c) => Object.assign({}, c)) };
        const relCount = new Map();
        g.nodes.forEach((n) => { if (n.kind === 'rel') relCount.set(n.type, (relCount.get(n.type) || 0) + 1); });
        const nodes = g.nodes.filter((n) => !(collapsed.has(n.type) && n.kind === 'rel')).map((n) => Object.assign({}, n, collapsed.has(n.type) && n.kind === 'type' ? { collapsedCount: relCount.get(n.type) || 0 } : {}));
        const remap = (id) => { const t = id.includes('#') ? id.split('#')[0] : id.split('@')[0]; return collapsed.has(t) ? `${t}@self` : id; };
        const seen = new Map();
        for (const e of g.edges) {
          const from = remap(e.from), to = remap(e.to);
          if (from === to && (from !== e.from || to !== e.to)) continue;
          const key = `${from}=>${to}|${e.kind}`;
          if (seen.has(key)) { seen.get(key).gids.push(e.id); continue; }
          seen.set(key, Object.assign({}, e, { id: from === e.from && to === e.to ? e.id : key, from, to, gids: [e.id] }));
        }
        return { nodes, edges: Array.from(seen.values()), clusters: g.clusters.map((c) => Object.assign({}, c, { collapsed: collapsed.has(c.id) })) };
      }
      // data: merge parallel tuples between the same two nodes into one edge
      const groups = new Map();
      for (const e of g0.edges) {
        const key = `g:${e.from}→${e.to}`;
        let gr = groups.get(key);
        if (!gr) { gr = { id: key, from: e.from, to: e.to, tupleIds: [], rels: [], labels: [], usersets: [], conditions: [], contextual: false, wildcard: /:\*$/.test(e.from), kind: 'tuple' }; groups.set(key, gr); }
        gr.tupleIds.push(e.tupleId);
        if (!gr.rels.includes(e.label)) gr.rels.push(e.label);
        gr.labels.push(e.label + (e.userset ? ` ⟵ #${e.userset}` : '') + (e.condition ? ' ⚡' : ''));
        if (e.userset && !gr.usersets.includes(e.userset)) gr.usersets.push(e.userset);
        if (e.condition && !gr.conditions.includes(e.condition)) gr.conditions.push(e.condition);
        if (e.contextual) gr.contextual = true;
      }
      const edges = Array.from(groups.values());
      edges.forEach((e) => { e.rel = e.rels[0]; e.label = Array.from(new Set(e.labels)).join(', '); e.reverse = groups.has(`g:${e.to}→${e.from}`); });
      return { nodes: g0.nodes.map((n) => Object.assign({}, n)), edges, clusters: [] };
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
        n.badgeW = n.badge ? Math.ceil(measure(n.badge, MONO_S) * 0.9) + 10 : 0;
        const extra = n.collapsedCount ? measure(` ${n.collapsedCount} relations`, MONO_S) + 6 : 0;
        n.width = Math.ceil(measure(n.label, MONO)) + (n.kind === 'type' ? 30 : n.op ? 44 : 26) + (n.badgeW ? n.badgeW + 8 : 0) + extra;
        n.height = n.kind === 'type' ? 28 : 26;
        return;
      }
      n.width = Math.ceil(measure(n.label, MONO)) + 28 + (n.kind === 'wildcard' ? 14 : 0);
      n.height = 30;
    }
    function schemaEdgeText(e) {
      const labels = e.labels.length > 3 ? e.labels.slice(0, 3).concat([`+${e.labels.length - 3}`]) : e.labels;
      return labels.join(', ') + (e.wildcard ? '  *' : '') + (e.conditions.length ? '  ⚡' : '');
    }
    function edgeText(e) {
      if (mode === 'schema') return schemaEdgeText(e);
      if (mode === 'data') return e.label;
      const parts = [];
      if (e.kind === 'ttu') parts.push(e.label);
      if (e.wildcard) parts.push('*');
      if (e.conditions && e.conditions.length) parts.push('⚡');
      return parts.join(' ');
    }

    // ── layouts
    function layoutDagre(vg, rankdir) {
      const compound = mode === 'model';
      const dg = new dagre.graphlib.Graph({ compound, multigraph: true });
      const sep = mode === 'schema' ? { nodesep: rankdir === 'LR' ? 40 : 70, ranksep: rankdir === 'LR' ? 130 : 90, edgesep: 24 } : mode === 'model' ? { nodesep: rankdir === 'LR' ? 26 : 30, ranksep: rankdir === 'LR' ? 72 : 60, edgesep: 10 } : { nodesep: 22, ranksep: rankdir === 'LR' ? 100 : 72, edgesep: 14 };
      dg.setGraph(Object.assign({ rankdir, marginx: 28, marginy: 30, compound }, sep));
      dg.setDefaultEdgeLabel(() => ({}));
      if (compound) vg.clusters.forEach((c) => dg.setNode(c.id, { label: c.label }));
      vg.nodes.forEach((n) => { sizeNode(n); dg.setNode(n.id, { width: n.width, height: n.height }); if (compound) dg.setParent(n.id, n.cluster); });
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
      edges.forEach((e) => { const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`; (groups.get(k) || groups.set(k, []).get(k)).push(e); });
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
      const nodes = vg.nodes.map((n) => Object.assign(n, { x: n.x ?? Math.random() * 600, y: n.y ?? Math.random() * 400 }));
      markParallel(vg.edges);
      const links = vg.edges.map((e) => ({ source: e.from, target: e.to }));
      const sim = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id((d) => d.id).distance(130).strength(0.6))
        .force('charge', d3.forceManyBody().strength(-520))
        .force('collide', d3.forceCollide((d) => Math.max(d.width, d.height) / 2 + 18))
        .force('x', d3.forceX(0).strength(0.03)).force('y', d3.forceY(0).strength(0.05))
        .stop();
      for (let i = 0; i < 320; i++) sim.tick();
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
      else L = bestOf((dir) => layoutDagre(vg, dir));
      applyPins(L);
      computeClusters(L);
      return L;
    }
    function applyPins(L) {
      const pins = pinned[mode] || {};
      const moved = new Set();
      L.nodes.forEach((n) => { const p = pins[n.id]; if (p) { n.x = p.x; n.y = p.y; n.pinned = true; moved.add(n.id); } });
      L.edges.forEach((e) => { if (moved.has(e.from) || moved.has(e.to)) e.points = null; });
    }
    function computeClusters(L) {
      if (mode !== 'model') return;
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
    function bezier(a0, b0, bend) {
      const dx0 = b0.x - a0.x, dy0 = b0.y - a0.y;
      const dist0 = Math.hypot(dx0, dy0) || 1;
      const nx0 = -dy0 / dist0, ny0 = dx0 / dist0;
      const a = bend ? { x: a0.x + nx0 * bend * 0.35, y: a0.y + ny0 * bend * 0.35 } : a0;
      const b = bend ? { x: b0.x + nx0 * bend * 0.35, y: b0.y + ny0 * bend * 0.35 } : b0;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist, ny = dx / dist;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
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
      if (mode === 'data') return `url(#arrow-rel-${(relIndex.has(e.rel) ? relIndex.get(e.rel) : hashStr(e.rel)) % REL_PALETTE.length})`;
      return `url(#arrow-${e.ctx === 'exclusion' ? 'exclusion' : (e.kind === 'computed' || e.kind === 'ttu') ? e.kind : 'direct'})`;
    }

    // ── render
    function render(animate) {
      $('#legend-schema').hidden = mode !== 'schema';
      $('#legend-model').hidden = mode !== 'model';
      $('#legend-data').hidden = mode !== 'data';
      $('#btn-subjects').hidden = mode !== 'model';
      const vg = viewGraph();
      curVG = vg;
      if (!vg) {
        gClusters.selectAll('*').remove(); gEdges.selectAll('*').remove(); gNodes.selectAll('*').remove();
        empty.hidden = false;
        empty.textContent = mode === 'data' ? 'No tuples yet. Add relationship tuples (user relation object) to see the data graph.' : 'No valid model yet. Define at least one type in the Model DSL to see its graph.';
        bounds = null; curL = null; updateMinimap();
        return;
      }
      empty.hidden = true;
      lastStage = { w: stage.clientWidth, h: stage.clientHeight };
      const L = runLayout(vg);
      curL = L;
      bounds = boundsOf(L);
      if (mode === 'data') {
        Array.from(new Set(L.edges.map((e) => e.rel))).forEach((r) => {
          const id = `arrow-rel-${(relIndex.has(r) ? relIndex.get(r) : hashStr(r)) % REL_PALETTE.length}`;
          if (defs.select(`#${id}`).empty()) defs.append('marker').attr('id', id).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5).attr('markerWidth', 9).attr('markerHeight', 9).attr('markerUnits', 'userSpaceOnUse').attr('orient', 'auto-start-reverse').append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('fill', relColor(r));
        });
      }
      draw(L, animate && lastMode === mode);
      lastMode = mode;
      fit(false);
      afterRender();
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
      eg.on('mouseenter', (ev, e) => { showTip(ev, tipForEdge(e)); if (!focus) { hoverHl = edgeHl(e); applyVisual(); } })
        .on('mousemove', moveTip).on('mouseleave', () => { hideTip(); if (hoverHl) { hoverHl = null; applyVisual(); } })
        .on('contextmenu', (ev, e) => { ev.preventDefault(); ev.stopPropagation(); hideTip(); emit('context', { kind: 'edge', datum: e, mode }, ev); });
      // nodes / cards
      const ng = gNodes.selectAll('g.node').data(L.nodes, (n) => n.id).join(
        (enter) => enter.append('g'), (update) => update, (exit) => exit.remove(),
      ).attr('class', (n) => `node ${n.kind}${n.pinned ? ' pinned' : ''}${n.diff ? ' diff-' + n.diff : ''}`).attr('data-id', (n) => n.id).style('--c', (n) => colorOf(n.type));
      ng.each(function (n) {
        const sel = d3.select(this);
        const tr = `translate(${n.x - n.width / 2},${n.y - n.height / 2})`;
        if (dur && sel.attr('transform')) sel.transition().duration(dur).attr('transform', tr); else sel.attr('transform', tr);
        sel.selectAll('*').remove();
        if (isCard) drawCard(sel, n); else drawNode(sel, n);
      });
      ng.on('mouseenter', (ev, n) => { if (isCard) return; showTip(ev, tipForNode(n)); previewFocus(n.id); emit('nodeHover', n.id); }).on('mousemove', moveTip)
        .on('mouseleave', () => { if (isCard) return; hideTip(); previewFocus(null); emit('nodeHover', null); })
        .on('click', (ev, n) => { if (isCard || ev.defaultPrevented) return; hideTip(); ev.stopPropagation(); setFocus(n.id, n, ev); })
        .on('dblclick', (ev, n) => { if (isCard) return; hideTip(); ev.stopPropagation(); emit('nodeClick', n, mode, ev); })
        .on('contextmenu', (ev, n) => { if (isCard) return; ev.preventDefault(); ev.stopPropagation(); hideTip(); emit('context', { kind: 'node', datum: n, mode }, ev); });
      ng.call(dragBehaviour());
      svg.on('click', () => emit('blankClick'));
      svg.on('contextmenu', (ev) => { ev.preventDefault(); emit('context', { kind: 'blank', mode }, ev); });
    }
    function drawEdgeLabel(g, e, dur) {
      g.selectAll('*').remove();
      const { x: lx, y: ly } = e.mid || { x: 0, y: 0 };
      if (mode === 'schema' || mode === 'data') {
        if (!e.text) return;
        const w = measure(e.text, MONO_S) * 0.92 + 12;
        g.append('rect').attr('class', 'lbl-bg').attr('x', lx - w / 2).attr('y', ly - 9).attr('width', w).attr('height', 18).attr('rx', 4);
        g.append('text').attr('class', 'slbl').attr('x', lx).attr('y', ly + 3.5).attr('text-anchor', 'middle').text(e.text);
        return;
      }
      const glyph = e.ctx === 'intersection' ? '∧' : e.ctx === 'exclusion' ? '¬' : e.ctx === 'base' ? '∖' : null;
      let offset = 0;
      if (glyph) { g.append('circle').attr('class', 'opbg').attr('cx', lx).attr('cy', ly).attr('r', 8); g.append('text').attr('class', 'opglyph').attr('x', lx).attr('y', ly + 4).attr('text-anchor', 'middle').text(glyph); offset = 12; }
      if (e.text) {
        const w = measure(e.text, MONO) * 0.85 + 8;
        g.append('rect').attr('class', 'lbl-bg').attr('x', lx - w / 2).attr('y', ly - 20 - offset / 2).attr('width', w).attr('height', 14).attr('rx', 3);
        g.append('text').attr('class', e.wildcard && e.text === '*' ? 'star' : '').attr('x', lx).attr('y', ly - 9.5 - offset / 2).attr('text-anchor', 'middle').text(e.text);
      }
    }
    function drawNode(sel, n) {
      sel.append('rect').attr('width', n.width).attr('height', n.height).attr('rx', n.kind === 'type' ? 14 : 7);
      if (n.badge) { sel.append('rect').attr('class', 'badge-bg').attr('x', 6).attr('y', 5).attr('width', n.badgeW).attr('height', 16).attr('rx', 4); sel.append('text').attr('class', 'badge').attr('x', 11).attr('y', 16.5).text(n.badge); }
      const label = n.kind === 'wildcard' ? `✶ ${n.label}` : n.collapsedCount ? `${n.label}  ${n.collapsedCount} relations` : n.label;
      sel.append('text').attr('x', n.badge ? 6 + n.badgeW + 8 : n.op ? 12 : n.width / 2).attr('y', n.height / 2 + 4).attr('text-anchor', n.op || n.badge ? 'start' : 'middle').text(label);
      if (n.op) sel.append('text').attr('class', 'op').attr('x', n.width - 10).attr('y', n.height / 2 + 4).attr('text-anchor', 'end').text(n.op === 'or' ? '∨' : n.op === 'and' ? '∧' : '¬');
      if (n.pinned) sel.append('circle').attr('class', 'pin').attr('cx', n.width - 4).attr('cy', 4).attr('r', 3);
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
      let start = null, connecting = false, tempLine = null, incident = [];
      return d3.drag().clickDistance(4)
        .on('start', function (ev, n) {
          connecting = connectMode || !!(ev.sourceEvent && ev.sourceEvent.altKey);
          if (connecting) { if (mode !== 'data') { connecting = false; return; } tempLine = gTemp.append('path').attr('class', 'connect-line'); return; }
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
          incident.forEach((e) => { e.points = null; const geo = edgePath(e, byId); e.mid = geo.mid; const sel = gEdges.select(`g.edge[data-id="${cssEsc(e.id)}"]`); sel.select('path.hit').attr('d', geo.d); sel.select('path.main').attr('d', geo.d); drawEdgeLabel(sel.select('g.lbl'), e, 0); });
          if (mode === 'model') { computeClusters(curL); gClusters.selectAll('g.cluster').each(function (c) { const s = d3.select(this); s.select('rect:not(.hdr-hit)').attr('x', c.x - c.width / 2).attr('y', c.y - c.height / 2).attr('width', c.width).attr('height', c.height); s.select('text').attr('x', c.x - c.width / 2 + 10).attr('y', c.y - c.height / 2 + 14); s.select('rect.hdr-hit').attr('x', c.x - c.width / 2).attr('y', c.y - c.height / 2).attr('width', c.width); }); }
        })
        .on('end', function (ev, n) {
          if (connecting) {
            if (tempLine) { tempLine.remove(); tempLine = null; }
            const se = ev.sourceEvent;
            const el = se && document.elementFromPoint(se.clientX, se.clientY);
            const targetEl = el && el.closest('g.node');
            const target = targetEl && curL.nodes.find((m) => m.id === targetEl.getAttribute('data-id'));
            if (target && target.id !== n.id) emit('connect', n, target, se);
            return;
          }
          if (!start) return;
          d3.select(this).classed('dragging', false);
          if (Math.hypot(n.x - start.x, n.y - start.y) < 2) { n.x = start.x; n.y = start.y; return; }
          pinned[mode][n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
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
      if (mode === 'model') {
        if (n.kind === 'type') return `<code>type ${esc(n.label)}</code>${degreeInfo(n.id)}<div class="sub">click to focus · double-click for queries · drag to move</div>`;
        return `<code>${esc(n.def)}</code><div class="sub">${n.direct.length ? 'directly assignable: ' + esc(n.direct.join(', ')) : 'not directly assignable (computed only)'}</div>${degreeInfo(n.id)}<div class="sub">click to focus · double-click for queries · right-click for more</div>`;
      }
      const tuples = (n.tuples || []).slice(0, 6).map((id) => S.store && S.store.byId(id)).filter(Boolean).map((t) => FGA.formatTuple(t));
      return `<code>${esc(n.label)}</code><div class="sub">${n.kind === 'wildcard' ? 'public access: every ' + esc(n.type) : 'type ' + esc(n.type)} · ${n.tuples.length} tuple${n.tuples.length === 1 ? '' : 's'}</div>${degreeInfo(n.id)}<code>${esc(tuples.join('\n'))}${n.tuples.length > 6 ? '\n…' : ''}</code><div class="sub">click to focus · double-click for queries · drag to move · Alt-drag to another node to write a tuple</div>`;
    }
    function tipForEdge(e) {
      if (mode === 'data') {
        const ts = e.tupleIds.map((id) => S.store && S.store.byId(id)).filter(Boolean);
        const lines = ts.map((t) => FGA.formatTuple(t)).join('\n');
        const cond = e.conditions.length ? (emit('condInfo', ts.filter((t) => t.condition)) || '') : '';
        return `<code>${esc(lines)}</code><div class="sub">${ts.length === 1 ? 'relationship tuple' : ts.length + ' tuples between these nodes'}${e.usersets.length ? ` · userset${e.usersets.length > 1 ? 's' : ''} #${esc(e.usersets.join(', #'))}` : ''}${e.contextual ? ' · contextual' : ''} · right-click to delete</div>${cond}`;
      }
      if (mode === 'schema') return `<code>${esc(e.from)} → ${esc(e.to)}</code><div class="sub">${e.diff === 'removed' ? 'removed in the draft · ' : e.diff === 'added' ? 'new in the draft · ' : ''}${e.kind === 'direct' ? 'can be assigned directly to' : 'inherited through a tupleset relation'}</div><code>${esc(e.labels.join('\n'))}</code>${e.conditions.length ? `<div class="sub">with condition ${esc(e.conditions.join(', '))}</div>` : ''}`;
      const kind = e.kind === 'direct' ? `direct assignment${e.wildcard ? ' (includes public wildcard)' : ''}${e.conditions.length ? ' with condition ' + e.conditions.join(', ') : ''}` : e.kind === 'computed' ? 'computed userset (implied relation)' : `tuple-to-userset: ${esc(e.label)}`;
      const ctx = e.ctx === 'intersection' ? ' · inside an "and"' : e.ctx === 'exclusion' ? ' · the excluded side of "but not"' : e.ctx === 'base' ? ' · base of "but not"' : '';
      return `<code>${esc(e.from)} → ${esc(e.to)}</code><div class="sub">${kind}${ctx}</div>`;
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
      const w = stage.clientWidth, h = stage.clientHeight - insetBottom - top;
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
      root.selectAll('.node, .edge, .cluster, .row').each(function () { this.classList.remove(...HL); });
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
      const nodes = mode === 'model' ? hl.modelNodes : hl.dataNodes;
      const edgesHl = mode === 'model' ? hl.modelEdges : hl.dataEdges;
      for (const [id, st] of Object.entries(nodes || {})) {
        const el = gNodes.select(`g.node[data-id="${cssEsc(id)}"]`);
        if (!el.empty()) { mark(el.node(), st); touchClusters.add(el.datum().cluster); }
        else if (mode === 'model' && collapsed.size) { const t = id.includes('#') ? id.split('#')[0] : id.split('@')[0]; if (collapsed.has(t)) { const el2 = gNodes.select(`g.node[data-id="${cssEsc(t + '@self')}"]`); if (!el2.empty()) { mark(el2.node(), st); touchClusters.add(t); } } }
      }
      gEdges.selectAll('g.edge').each(function (e) {
        let best = (edgesHl || {})[e.id] || null;
        const keys = mode === 'data' ? e.tupleIds.map((id) => `t${id}`) : (e.gids || []);
        for (const k of keys) { const st = (edgesHl || {})[k]; if (st && (best === null || rank[st] > rank[best])) best = st; }
        const main = d3.select(this).select('path.main');
        if (best) { mark(this, best); main.attr('marker-end', `url(#arrow-${best})`); touchClusters.add(e.from.split('#')[0].split('@')[0]); touchClusters.add(e.to.split('#')[0].split('@')[0]); }
        else main.attr('marker-end', baseMarker(e));
      });
      touchClusters.forEach((c) => { const el = gClusters.select(`g.cluster[data-id="${cssEsc(c)}"]`); if (!el.empty()) el.node().classList.add('hl'); });
      svgEl.classList.toggle('has-hl', any);
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
      (graphs.data ? graphs.data.nodes : []).forEach((n) => { if (n.id.toLowerCase().includes(q)) add(n.id, n.id, 'data', n.kind === 'wildcard' ? 'wildcard' : 'object', n); });
      (graphs.model ? graphs.model.nodes : []).forEach((n) => { if (n.kind === 'rel' && n.id.toLowerCase().includes(q)) add(n.id, n.id, 'model', 'relation', n); });
      (graphs.schema ? graphs.schema.nodes : []).forEach((n) => { if (n.id.toLowerCase().includes(q)) add(n.id, `type ${n.id}`, 'schema', 'type', n); });
      const curFirst = (x) => (x.mode === mode ? 0 : 1);
      return out.sort((a, b) => a.score - b.score || curFirst(a) - curFirst(b) || a.label.localeCompare(b.label)).slice(0, 12);
    }
    function jumpTo(item) {
      if (item.mode !== mode) { mode = item.mode; emit('modeChanged', mode); render(false); }
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
      setData, setMode, setLayout, setSubjects, setPins, setCollapsed, resetLayout, setInsets, setConnectMode, toggleMinimap,
      fit, fitToHighlighted, panTo, zoomBy, highlight, flash, clearFocus,
      focusNode: (id) => { const n = curL && curL.nodes.find((x) => x.id === id); if (n) setFocus(id, n, null); },
      candidates, jumpTo, pathsBetween, svgMarkup, pngBlob, _layout: () => curL,
      on: (k, fn) => { handlers[k] = fn; }, colorOf, relColor,
      get mode() { return mode; }, get layout() { return layoutPreset; }, get hasFocus() { return !!focus; }, get multiSelecting() { return !!(focus && focus.multi); }, get connectMode() { return connectMode; }, get focusNodes() { return focus ? focus.nodes.slice() : []; },
    };
  })();
