  // ───────────────────────── share links (no backend) ─────────────────────────
  // The whole store travels in the URL fragment: model DSL, tuples, assertions, suggested queries
  // and the current query, JSON → deflate → base64url. A fragment is never sent to any server, so
  // nothing is uploaded; the recipient's playground rebuilds the store locally from the link.
  const Share = (() => {
    const toB64u = (bytes) => {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const canZip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
    const pipe = async (bytes, Stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw'))).arrayBuffer());
    async function encode(obj) {
      const raw = new TextEncoder().encode(JSON.stringify(obj));
      return canZip ? '1.' + toB64u(await pipe(raw, CompressionStream)) : '0.' + toB64u(raw);
    }
    async function decode(str) {
      const dot = str.indexOf('.');
      if (dot < 0) throw new Error('not a share link');
      const kind = str.slice(0, dot), bytes = fromB64u(str.slice(dot + 1));
      if (kind === '1' && !canZip) throw new Error('this browser cannot open compressed links');
      return JSON.parse(new TextDecoder().decode(kind === '1' ? await pipe(bytes, DecompressionStream) : bytes));
    }
    function payload(st, extra) {
      const q = Query.q;
      return Object.assign({
        v: 1, name: st.name, dsl: st.draftDsl, tuples: st.tuplesText, assertions: st.assertions || [], queries: st.queries || [],
        q: { type: q.type, user: q.user, relation: q.relation, object: q.object, objectType: q.objectType, userType: q.userType, userRelation: q.userRelation, context: q.context, ctxTuples: q.ctxTuples },
        view: S.ui.graphMode,
      }, extra || {});
    }
    async function link(extra) {
      const st = activeStore();
      if (!st) return null;
      return location.origin + location.pathname + '#s=' + await encode(payload(st, extra));
    }
    // extra.explain = { user, relation, object, view: 'matrix' | 'data', mx: 'matrix' | 'tree' } opens that
    // explanation (proof or why-not) on arrival
    async function copy(extra, label) {
      try {
        const url = await link(extra);
        if (!url) return;
        const kb = (url.length / 1024).toFixed(1);
        copyText(url, `${label || 'Share link'} (${kb} KB) copied`);
        if (url.length > 30000) setTimeout(() => toast('Long link: some chat apps truncate URLs this size — the store JSON export is safer there'), 2800);
      } catch (e) { toast(`Could not build the link: ${e.message}`); }
    }
    async function openFromHash() {
      const m = /^#s=(.+)$/.exec(location.hash);
      if (!m) return false;
      history.replaceState(null, '', location.pathname + location.search);
      let p;
      try { p = await decode(decodeURIComponent(m[1])); } catch (e) { toast(/browser/.test(e.message) ? `Could not open the shared store: ${e.message}` : 'Could not open the shared store: the link is incomplete or damaged'); return false; }
      if (!p || typeof p.dsl !== 'string') { toast('That link does not contain a store'); return false; }
      const key = `shared:${hashStr(m[1])}`;
      let st = S.stores.find((s) => s.sharedKey === key);
      if (!st) {
        st = makeStore(String(p.name || 'Shared store'), { dsl: p.dsl, tuples: typeof p.tuples === 'string' ? p.tuples : '', assertions: Array.isArray(p.assertions) ? p.assertions : [], queries: Array.isArray(p.queries) ? p.queries : [] });
        st.sharedKey = key;
        S.stores.push(st);
      }
      const ex = p.explain && typeof p.explain === 'object' && p.explain.user && p.explain.relation && p.explain.object ? p.explain : null;
      if (ex) st.query = Object.assign({ type: 'check' }, p.q || {}, { type: 'check', user: ex.user, relation: ex.relation, object: ex.object });
      else if (p.q && typeof p.q === 'object') st.query = Object.assign({ type: 'check' }, p.q);
      const view = ex ? (ex.view === 'matrix' ? 'matrix' : 'data') : p.view;
      if (['schema', 'model', 'data', 'matrix'].includes(view)) setGraphMode(view);
      switchStore(st.id);
      if (ex && view === 'matrix') { S.ui.mxWalk = Object.assign(S.ui.mxWalk || {}, { view: ex.mx === 'tree' ? 'tree' : 'matrix' }); S.ui.matrix = { type: ex.object.split(':')[0], relation: ex.relation }; Matrix.openWalk(ex.user, ex.relation, ex.object); }
      toast(`Opened shared store “${st.name}” — it is saved in this browser like any other store`);
      return true;
    }
    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.id = 'btn-share';
    btn.textContent = 'Share';
    btn.title = 'Copy a link that opens this store anywhere: model, tuples, assertions and the current query live in the link itself, nothing is uploaded';
    const anchor = $('#btn-write-model');
    anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    btn.addEventListener('click', () => copy());
    window.addEventListener('hashchange', openFromHash);
    openFromHash();
    return { link, copy, openFromHash, encode, decode };
  })();
  window.__fga.Share = Share;
