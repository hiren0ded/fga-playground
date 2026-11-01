/* OpenFGA engine for the playground.
   DSL (schema 1.1) parser · relationship tuple store · Check / ListObjects / ListUsers / Expand
   with step-by-step traces · conditions (CEL subset) · model / data graph builders.
   Pure JS, no DOM: runs in Node (tests) and in the page. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FGA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── helpers ─────────────────────────
  const IDENT_RE = /^[A-Za-z_][\w-]*$/;
  const RESERVED = new Set(['or', 'and', 'but', 'not', 'from', 'with']);
  const isIdent = (t) => typeof t === 'string' && IDENT_RE.test(t) && !RESERVED.has(t);
  const uniq = (arr) => Array.from(new Set(arr));
  const an = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

  function stripComment(line) {
    // `#` starts a comment only at line start or after whitespace, so `group#member` survives.
    return line.replace(/(^|\s)#.*$/, '$1');
  }

  function tokenizeExpr(src) {
    const out = [];
    const re = /(\[|\]|\(|\)|,|#|:|\*|[A-Za-z_][\w-]*)|(\S)/g;
    let m;
    while ((m = re.exec(src))) {
      if (m[2]) throw new Error(`Unexpected character "${m[2]}"`);
      out.push(m[1]);
    }
    return out;
  }

  // ───────────────────────── rewrite parser ─────────────────────────
  function parseRewrite(src, lineNo, warnings) {
    const toks = tokenizeExpr(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const expect = (v) => {
      const t = next();
      if (t !== v) throw new Error(`Expected "${v}" but found ${t === undefined ? 'end of line' : '"' + t + '"'}`);
    };
    const warnMixed = () => warnings.push({
      line: lineNo,
      message: 'OpenFGA requires parentheses when mixing "or", "and" and "but not" in one definition',
    });

    function parseOr() {
      const first = parseAnd();
      if (peek() !== 'or') return first;
      const children = [first];
      while (peek() === 'or') { next(); children.push(parseAnd()); }
      if (children.some((c) => !c.paren && (c.kind === 'intersection' || c.kind === 'difference'))) warnMixed();
      return { kind: 'union', children };
    }
    function parseAnd() {
      const first = parseButNot();
      if (peek() !== 'and') return first;
      const children = [first];
      while (peek() === 'and') { next(); children.push(parseButNot()); }
      if (children.some((c) => !c.paren && c.kind === 'difference')) warnMixed();
      return { kind: 'intersection', children };
    }
    function parseButNot() {
      let left = parseTerm();
      while (peek() === 'but') {
        next(); expect('not');
        const right = parseTerm();
        left = { kind: 'difference', base: left, subtract: right };
      }
      return left;
    }
    function parseTerm() {
      const t = peek();
      if (t === undefined) throw new Error('Expected a relation, "[types]" or "( … )"');
      if (t === '[') { next(); return parseTypeList(); }
      if (t === '(') {
        next();
        const e = parseOr();
        expect(')');
        e.paren = true;
        return e;
      }
      if (isIdent(t)) {
        next();
        if (peek() === 'from') {
          next();
          const ts = next();
          if (!isIdent(ts)) throw new Error(`Expected a tupleset relation after "from" (e.g. "${t} from parent")`);
          return { kind: 'ttu', computed: t, tupleset: ts };
        }
        return { kind: 'computed', relation: t };
      }
      throw new Error(`Unexpected "${t}"`);
    }
    function parseTypeList() {
      const types = [];
      if (peek() === ']') throw new Error('The type restriction list [ … ] cannot be empty');
      for (;;) {
        const tn = next();
        if (!isIdent(tn)) throw new Error(`Expected a type name inside [ … ] but found ${tn === undefined ? 'end of line' : '"' + tn + '"'}`);
        const entry = { type: tn };
        if (peek() === ':') { next(); expect('*'); entry.wildcard = true; }
        else if (peek() === '#') {
          next();
          const r = next();
          if (!isIdent(r)) throw new Error(`Expected a relation name after "${tn}#"`);
          entry.relation = r;
        }
        if (peek() === 'with') {
          next();
          const c = next();
          if (!isIdent(c)) throw new Error(`Expected a condition name after "with"`);
          entry.condition = c;
        }
        types.push(entry);
        if (peek() === ',') { next(); continue; }
        expect(']');
        break;
      }
      return { kind: 'this', types };
    }

    const node = parseOr();
    if (p < toks.length) throw new Error(`Unexpected "${toks[p]}" after the expression`);
    return node;
  }

  function walkRewrite(node, fn) {
    fn(node);
    if (node.kind === 'union' || node.kind === 'intersection') node.children.forEach((c) => walkRewrite(c, fn));
    if (node.kind === 'difference') { walkRewrite(node.base, fn); walkRewrite(node.subtract, fn); }
  }

  function describeEntry(e) {
    return e.type + (e.wildcard ? ':*' : '') + (e.relation ? '#' + e.relation : '') + (e.condition ? ' with ' + e.condition : '');
  }
  function describeRewrite(n, top = true) {
    switch (n.kind) {
      case 'this': return '[' + n.types.map(describeEntry).join(', ') + ']';
      case 'computed': return n.relation;
      case 'ttu': return `${n.computed} from ${n.tupleset}`;
      case 'union': { const s = n.children.map((c) => describeRewrite(c, false)).join(' or '); return top ? s : `(${s})`; }
      case 'intersection': { const s = n.children.map((c) => describeRewrite(c, false)).join(' and '); return top ? s : `(${s})`; }
      case 'difference': { const s = `${describeRewrite(n.base, false)} but not ${describeRewrite(n.subtract, false)}`; return top ? s : `(${s})`; }
      default: return '?';
    }
  }
  function topOperator(n) {
    if (n.kind === 'union') return n.children.length > 1 ? 'or' : null;
    if (n.kind === 'intersection') return 'and';
    if (n.kind === 'difference') return 'but not';
    return null;
  }

  // ───────────────────────── DSL parser ─────────────────────────
  function parseParams(src) {
    return src.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const m = /^([\w-]+)\s*:\s*(.+)$/.exec(s);
      return m ? { name: m[1], type: m[2].trim() } : { name: s, type: 'string' };
    });
  }

  function parseDSL(text) {
    const lines = (text || '').split(/\r?\n/);
    const model = { schema: '1.1', types: [], conditions: [], typeMap: new Map(), condMap: new Map() };
    const errors = [], warnings = [];
    let cur = null;
    let i = 0;
    while (i < lines.length) {
      const lineNo = i + 1;
      const line = stripComment(lines[i]).trim();
      if (!line) { i++; continue; }
      let m;
      if (/^model$/.test(line)) { /* header */ }
      else if ((m = /^schema\s+(\S+)$/.exec(line))) {
        model.schema = m[1];
        if (m[1] !== '1.1') warnings.push({ line: lineNo, message: `Schema ${m[1]}: this playground implements schema 1.1 semantics` });
      } else if ((m = /^type\s+([\w-]+)\s*$/.exec(line))) {
        if (model.typeMap.has(m[1])) errors.push({ line: lineNo, message: `Type "${m[1]}" is defined twice` });
        cur = { name: m[1], relations: [], relMap: new Map(), line: lineNo };
        model.types.push(cur);
        model.typeMap.set(cur.name, cur);
      } else if (/^relations\s*$/.test(line)) {
        if (!cur) errors.push({ line: lineNo, message: '"relations" must follow a "type" line' });
      } else if ((m = /^define\s+([\w-]+)\s*:\s*(.*)$/.exec(line))) {
        if (!cur) errors.push({ line: lineNo, message: '"define" must appear under a type' });
        else if (cur.relMap.has(m[1])) errors.push({ line: lineNo, message: `Relation "${m[1]}" is defined twice on type "${cur.name}"` });
        else {
          try {
            const rewrite = parseRewrite(m[2], lineNo, warnings);
            const rel = { name: m[1], rewrite, line: lineNo, type: cur.name, source: m[2].trim() };
            cur.relations.push(rel);
            cur.relMap.set(rel.name, rel);
          } catch (e) {
            errors.push({ line: lineNo, message: `${cur.name}#${m[1]}: ${e.message}` });
          }
        }
      } else if ((m = /^define\s+([\w-]+)\s*$/.exec(line))) {
        errors.push({ line: lineNo, message: `"define ${m[1]}" needs a definition, e.g. "define ${m[1]}: [user]"` });
      } else if ((m = /^condition\s+([\w-]+)\s*\(([^)]*)\)\s*\{(.*)$/.exec(line))) {
        let body = m[3];
        let j = i;
        while (!/\}/.test(body) && j + 1 < lines.length) { j++; body += '\n' + stripComment(lines[j]); }
        const close = body.lastIndexOf('}');
        if (close < 0) errors.push({ line: lineNo, message: `Condition "${m[1]}" is missing its closing "}"` });
        const expression = (close >= 0 ? body.slice(0, close) : body).trim();
        const cond = { name: m[1], params: parseParams(m[2]), expression, line: lineNo };
        if (model.condMap.has(cond.name)) errors.push({ line: lineNo, message: `Condition "${cond.name}" is defined twice` });
        if (!expression) errors.push({ line: lineNo, message: `Condition "${cond.name}" has an empty body` });
        else {
          try { cond.compiled = CEL.compile(expression); }
          catch (e) { errors.push({ line: lineNo, message: `Condition "${cond.name}": ${e.message}` }); }
        }
        model.conditions.push(cond);
        model.condMap.set(cond.name, cond);
        i = j;
        cur = null;
      } else if (/^(type|condition)\b/.test(line)) {
        errors.push({ line: lineNo, message: `Could not parse "${line}" — expected "type <name>" or "condition <name>(<params>) { … }"` });
      } else {
        errors.push({ line: lineNo, message: `Unexpected line: "${line.slice(0, 70)}"` });
      }
      i++;
    }
    validateModel(model, errors, warnings);
    if (!model.types.length && !errors.length) warnings.push({ line: 1, message: 'The model has no types yet. Start with "type user".' });
    return { model, errors, warnings };
  }

  function validateModel(model, errors, warnings) {
    // pass 1: direct types
    for (const t of model.types) for (const r of t.relations) {
      r.directTypes = [];
      let thisCount = 0;
      walkRewrite(r.rewrite, (n) => { if (n.kind === 'this') { thisCount++; r.directTypes.push(...n.types); } });
      if (thisCount > 1) warnings.push({ line: r.line, message: `${t.name}#${r.name}: OpenFGA allows a single [ … ] list per relation` });
    }
    // pass 2: references
    for (const t of model.types) for (const r of t.relations) {
      const where = `${t.name}#${r.name}`;
      for (const e of r.directTypes) {
        const et = model.typeMap.get(e.type);
        if (!et) errors.push({ line: r.line, message: `${where}: type "${e.type}" is not defined` });
        else if (e.relation && !et.relMap.has(e.relation)) errors.push({ line: r.line, message: `${where}: relation "${e.relation}" is not defined on type "${e.type}"` });
        if (e.condition && !model.condMap.has(e.condition)) errors.push({ line: r.line, message: `${where}: condition "${e.condition}" is not defined` });
      }
      walkRewrite(r.rewrite, (n) => {
        if (n.kind === 'computed') {
          if (!t.relMap.has(n.relation)) errors.push({ line: r.line, message: `${where}: "${n.relation}" is not a relation of ${t.name}` });
          else if (n.relation === r.name) errors.push({ line: r.line, message: `${where} cannot reference itself directly` });
        }
        if (n.kind === 'ttu') {
          const ts = t.relMap.get(n.tupleset);
          if (!ts) errors.push({ line: r.line, message: `${where}: tupleset relation "${n.tupleset}" is not defined on ${t.name}` });
          else {
            if (!ts.directTypes.length) errors.push({ line: r.line, message: `${where}: "${n.tupleset}" must be directly assignable to use it in "${n.computed} from ${n.tupleset}"` });
            if (ts.directTypes.some((e) => e.relation || e.wildcard)) errors.push({ line: r.line, message: `${where}: tupleset relation "${n.tupleset}" cannot allow usersets or wildcards` });
            const anyHas = ts.directTypes.some((e) => model.typeMap.get(e.type)?.relMap.has(n.computed));
            if (ts.directTypes.length && !anyHas) errors.push({ line: r.line, message: `${where}: none of the types related through "${n.tupleset}" (${uniq(ts.directTypes.map((e) => e.type)).join(', ')}) define "${n.computed}"` });
          }
        }
      });
    }
    // pass 3: entrypoints (a relation nobody can ever hold is a model error in OpenFGA)
    const has = new Set();
    const entry = (n, t) => {
      switch (n.kind) {
        case 'this': return n.types.some((e) => !e.relation || has.has(`${e.type}#${e.relation}`));
        case 'computed': return has.has(`${t.name}#${n.relation}`);
        case 'ttu': {
          const ts = t.relMap.get(n.tupleset);
          return !!ts && ts.directTypes.some((e) => has.has(`${e.type}#${n.computed}`));
        }
        case 'union': return n.children.some((c) => entry(c, t));
        case 'intersection': return n.children.every((c) => entry(c, t));
        case 'difference': return entry(n.base, t);
        default: return false;
      }
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of model.types) for (const r of t.relations) {
        const k = `${t.name}#${r.name}`;
        if (!has.has(k) && entry(r.rewrite, t)) { has.add(k); changed = true; }
      }
    }
    if (!errors.length) {
      for (const t of model.types) for (const r of t.relations) {
        if (!has.has(`${t.name}#${r.name}`)) errors.push({ line: r.line, message: `${t.name}#${r.name} has no entrypoint: no tuple could ever satisfy it (OpenFGA rejects this model)` });
      }
    }
    for (const c of model.conditions) {
      const used = model.types.some((t) => t.relations.some((r) => r.directTypes.some((e) => e.condition === c.name)));
      if (!used) warnings.push({ line: c.line, message: `Condition "${c.name}" is defined but no relation uses it` });
    }
  }

  // ───────────────────────── model JSON ─────────────────────────
  function rewriteToJSON(n) {
    switch (n.kind) {
      case 'this': return { this: {} };
      case 'computed': return { computedUserset: { object: '', relation: n.relation } };
      case 'ttu': return { tupleToUserset: { tupleset: { object: '', relation: n.tupleset }, computedUserset: { object: '', relation: n.computed } } };
      case 'union': return { union: { child: n.children.map(rewriteToJSON) } };
      case 'intersection': return { intersection: { child: n.children.map(rewriteToJSON) } };
      case 'difference': return { difference: { base: rewriteToJSON(n.base), subtract: rewriteToJSON(n.subtract) } };
      default: return {};
    }
  }
  const CEL_TYPE_NAMES = { string: 'TYPE_NAME_STRING', int: 'TYPE_NAME_INT', uint: 'TYPE_NAME_UINT', double: 'TYPE_NAME_DOUBLE', bool: 'TYPE_NAME_BOOL', timestamp: 'TYPE_NAME_TIMESTAMP', duration: 'TYPE_NAME_DURATION', ipaddress: 'TYPE_NAME_IPADDRESS', any: 'TYPE_NAME_ANY' };
  function paramTypeJSON(type) {
    const m = /^(list|map)<(.+)>$/.exec(type);
    if (m) return { type_name: m[1] === 'list' ? 'TYPE_NAME_LIST' : 'TYPE_NAME_MAP', generic_types: [paramTypeJSON(m[2].trim())] };
    return { type_name: CEL_TYPE_NAMES[type] || 'TYPE_NAME_UNSPECIFIED' };
  }
  function modelToJSON(model, id) {
    const json = { schema_version: model.schema || '1.1', type_definitions: [] };
    if (id) json.id = id;
    for (const t of model.types) {
      const td = { type: t.name, relations: {} };
      if (t.relations.length) {
        td.metadata = { relations: {} };
        for (const r of t.relations) {
          td.relations[r.name] = rewriteToJSON(r.rewrite);
          td.metadata.relations[r.name] = {
            directly_related_user_types: r.directTypes.map((e) => {
              const o = { type: e.type };
              if (e.relation) o.relation = e.relation;
              if (e.wildcard) o.wildcard = {};
              if (e.condition) o.condition = e.condition;
              return o;
            }),
          };
        }
      }
      json.type_definitions.push(td);
    }
    if (model.conditions.length) {
      json.conditions = {};
      for (const c of model.conditions) {
        const parameters = {};
        c.params.forEach((p) => { parameters[p.name] = paramTypeJSON(p.type); });
        json.conditions[c.name] = { name: c.name, expression: c.expression, parameters };
      }
    }
    return json;
  }

  // Crockford base32 ULID-like ids (OpenFGA uses ULIDs for store and model ids)
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function ulid(seedStr, time) {
    const t = time || Date.now();
    let out = '';
    let ms = t;
    for (let i = 0; i < 10; i++) { out = B32[ms % 32] + out; ms = Math.floor(ms / 32); }
    let h = 2166136261;
    const s = seedStr || String(Math.random());
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    let rnd = '';
    let x = h;
    for (let i = 0; i < 16; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      rnd += B32[x % 32];
    }
    return out + rnd;
  }

  // ───────────────────────── tuple parsing ─────────────────────────
  function parseUserRef(s) {
    const raw = String(s || '').trim();
    const m = /^([A-Za-z_][\w-]*):([^#\s]+?)(?:#([A-Za-z_][\w-]*))?$/.exec(raw);
    if (!m) throw new Error(`"${raw || '(empty)'}" is not a valid user: expected type:id, type:* or type:id#relation`);
    const ref = { raw, type: m[1], id: m[2] };
    if (m[2] === '*') {
      if (m[3]) throw new Error(`"${raw}": a wildcard cannot carry a relation`);
      ref.wildcard = true;
    } else if (m[3]) ref.relation = m[3];
    return ref;
  }
  function parseObjectRef(s) {
    const raw = String(s || '').trim();
    const m = /^([A-Za-z_][\w-]*):([^#\s*]+)$/.exec(raw);
    if (!m) throw new Error(`"${raw || '(empty)'}" is not a valid object: expected type:id`);
    return { raw, type: m[1], id: m[2] };
  }
  const objectOfUser = (u) => ({ raw: `${u.type}:${u.id}`, type: u.type, id: u.id });

  function tupleKey(t) {
    return `${t.user.raw}|${t.relation}|${t.object.raw}` + (t.condition ? `|${t.condition.name}|${JSON.stringify(t.condition.context || {})}` : '');
  }
  function formatTuple(t, opts = {}) {
    let s = `${t.user.raw} ${t.relation} ${t.object.raw}`;
    if (t.condition) s += ` with ${t.condition.name}` + (t.condition.context && Object.keys(t.condition.context).length ? ' ' + JSON.stringify(t.condition.context) : '');
    if (t.contextual && !opts.plain) s += '  (contextual)';
    return s;
  }
  const arrowTuple = (t) => `${t.user.raw} ─${t.relation}→ ${t.object.raw}${t.contextual ? ' (contextual)' : ''}`;

  function parseTupleLine(line) {
    const m = /^([^\s,]+)\s*[,\s]\s*([^\s,]+)\s*[,\s]\s*([^\s,]+)\s*(.*)$/.exec(line.trim());
    if (!m) throw new Error('Expected "user relation object" (e.g. user:anne viewer document:roadmap)');
    const user = parseUserRef(m[1]);
    const relation = m[2];
    if (!isIdent(relation)) throw new Error(`"${relation}" is not a valid relation name`);
    const object = parseObjectRef(m[3]);
    const t = { user, relation, object };
    const rest = m[4].trim();
    if (rest) {
      const cm = /^with\s+([\w-]+)\s*(\{[\s\S]*\})?\s*$/.exec(rest);
      if (!cm) throw new Error(`Could not parse "${rest}" — use: with <condition> {"key": value}`);
      let context = {};
      if (cm[2]) {
        try { context = JSON.parse(cm[2]); } catch (e) { throw new Error(`Condition context is not valid JSON: ${e.message}`); }
      }
      t.condition = { name: cm[1], context };
    }
    return t;
  }

  function validateTuple(t, model) {
    const ot = model.typeMap.get(t.object.type);
    if (!ot) return `type "${t.object.type}" is not in the model`;
    const rel = ot.relMap.get(t.relation);
    if (!rel) return `"${t.relation}" is not a relation of ${t.object.type}`;
    if (!model.typeMap.has(t.user.type)) return `user type "${t.user.type}" is not in the model`;
    if (t.user.relation && !model.typeMap.get(t.user.type).relMap.has(t.user.relation)) return `"${t.user.relation}" is not a relation of ${t.user.type}`;
    if (!rel.directTypes.length) return `${t.object.type}#${t.relation} is not directly assignable (its definition has no [ … ] list)`;
    const condName = t.condition ? t.condition.name : null;
    if (condName && !model.condMap.has(condName)) return `condition "${condName}" is not defined in the model`;
    const ok = rel.directTypes.some((e) => e.type === t.user.type && !!e.wildcard === !!t.user.wildcard && (e.relation || null) === (t.user.relation || null) && (e.condition || null) === condName);
    if (!ok) {
      const allowed = rel.directTypes.map(describeEntry).join(', ');
      const shape = t.user.type + (t.user.wildcard ? ':*' : '') + (t.user.relation ? '#' + t.user.relation : '') + (condName ? ' with ' + condName : '');
      return `${t.object.type}#${t.relation} accepts [${allowed}] but got ${shape}`;
    }
    return null;
  }

  function parseTuples(text, model, opts = {}) {
    const tuples = [], errors = [], rejected = [];
    const seen = new Map();
    (text || '').split(/\r?\n/).forEach((raw, idx) => {
      const line = stripComment(raw).trim();
      if (!line) return;
      const lineNo = idx + 1;
      let t;
      try { t = parseTupleLine(line); } catch (e) { errors.push({ line: lineNo, message: e.message }); return; }
      t.line = lineNo;
      if (opts.contextual) t.contextual = true;
      const key = tupleKey(t);
      if (seen.has(key)) { errors.push({ line: lineNo, message: `Duplicate of line ${seen.get(key)} (OpenFGA rejects duplicate writes)` }); return; }
      seen.set(key, lineNo);
      if (model) {
        const problem = validateTuple(t, model);
        if (problem) { rejected.push({ line: lineNo, message: problem, tuple: t }); return; }
      }
      tuples.push(t);
    });
    return { tuples, errors, rejected };
  }

  // ───────────────────────── store ─────────────────────────
  function buildStore(tuples) {
    const all = tuples.map((t, i) => Object.assign({}, t, { id: t.id ?? i }));
    const byObjRel = new Map(), byUserRelType = new Map();
    const push = (map, k, v) => { const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); };
    for (const t of all) {
      push(byObjRel, `${t.object.raw}#${t.relation}`, t);
      push(byUserRelType, `${t.user.raw}|${t.relation}|${t.object.type}`, t);
    }
    const objects = new Map(), users = new Map();
    for (const t of all) {
      objects.set(t.object.raw, t.object);
      if (!t.user.wildcard) {
        const o = objectOfUser(t.user);
        objects.set(o.raw, o);
        if (!t.user.relation) users.set(t.user.raw, t.user);
      }
    }
    return {
      tuples: all,
      read: (object, relation) => byObjRel.get(`${object}#${relation}`) || [],
      readByUser: (user, relation, objectType) => byUserRelType.get(`${user}|${relation}|${objectType}`) || [],
      objectsOfType: (type) => Array.from(objects.values()).filter((o) => o.type === type).map((o) => o.raw).sort(),
      usersOfType: (type) => uniq([...Array.from(users.values()).filter((u) => u.type === type).map((u) => u.raw), ...Array.from(objects.values()).filter((o) => o.type === type).map((o) => o.raw)]).sort(),
      allObjects: () => Array.from(objects.keys()).sort(),
      allUsers: () => uniq(all.map((t) => t.user.raw)).sort(),
      byId: (id) => all.find((t) => t.id === id),
    };
  }

  // ───────────────────────── trace ─────────────────────────
  function makeTrace() {
    const trace = { frames: [], events: [], reads: 0, maxDepth: 0 };
    trace.frame = (props) => {
      const f = Object.assign({ id: trace.frames.length, items: [], children: [], result: null, status: 'pending', parent: null, depth: 0 }, props);
      trace.frames.push(f);
      if (f.parent) { f.parent.children.push(f); f.parent.items.push({ frame: f }); }
      trace.maxDepth = Math.max(trace.maxDepth, f.depth || 0);
      return f;
    };
    trace.emit = (type, frame, text, extra = {}) => {
      const ev = Object.assign({ idx: trace.events.length, type, frame, text, status: extra.status || 'info', hl: extra.hl || {}, minor: !!extra.minor, detail: extra.detail || null });
      trace.events.push(ev);
      frame.items.push({ event: ev });
      if (type === 'enter') frame.startIdx = ev.idx;
      if (type === 'exit') frame.endIdx = ev.idx;
      return ev;
    };
    return trace;
  }

  const relNode = (type, rel) => `${type}#${rel}`;
  const edgeGid = (from, to, kind, extra) => `${from}=>${to}|${kind}` + (extra ? `|${extra}` : '');

  // ───────────────────────── conditions ─────────────────────────
  function parseDurationMs(s) {
    if (typeof s === 'number') return s * 1000;
    const str = String(s).trim();
    const re = /(-?\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d)/g;
    let m, total = 0, any = false;
    const mult = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
    while ((m = re.exec(str))) { total += parseFloat(m[1]) * mult[m[2]]; any = true; }
    if (!any) throw new Error(`"${s}" is not a duration (use e.g. 90m, 2h30m, 10s)`);
    return total;
  }
  function parseTimestampMs(s) {
    if (typeof s === 'number') return s;
    const ms = Date.parse(String(s));
    if (Number.isNaN(ms)) throw new Error(`"${s}" is not an RFC 3339 timestamp`);
    return ms;
  }
  function coerceParam(type, v) {
    if (v === undefined || v === null) return v;
    const base = type.replace(/<.*$/, '');
    switch (base) {
      case 'timestamp': return { __t: 'timestamp', ms: parseTimestampMs(v) };
      case 'duration': return { __t: 'duration', ms: parseDurationMs(v) };
      case 'int': case 'uint': case 'double': { const n = Number(v); if (Number.isNaN(n)) throw new Error(`"${v}" is not a number`); return n; }
      case 'bool': return typeof v === 'string' ? v === 'true' : !!v;
      case 'string': case 'ipaddress': return String(v);
      case 'list': return Array.isArray(v) ? v : (typeof v === 'string' ? JSON.parse(v) : v);
      default: return v;
    }
  }

  const CEL = (function () {
    const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '[', ']', ',', '.', '?', ':', '{', '}'];
    function lex(src) {
      const toks = [];
      let i = 0;
      while (i < src.length) {
        const ch = src[i];
        if (/\s/.test(ch)) { i++; continue; }
        if (/[0-9]/.test(ch)) {
          const m = /^\d+(\.\d+)?/.exec(src.slice(i));
          toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
        }
        if (ch === '"' || ch === "'") {
          let j = i + 1, s = '';
          while (j < src.length && src[j] !== ch) { if (src[j] === '\\') { j++; } s += src[j]; j++; }
          if (j >= src.length) throw new Error('Unterminated string');
          toks.push({ t: 'str', v: s }); i = j + 1; continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
          const m = /^[A-Za-z_][\w]*/.exec(src.slice(i));
          toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
        }
        const op = OPS.find((o) => src.startsWith(o, i));
        if (!op) throw new Error(`Unexpected character "${ch}" in condition`);
        toks.push({ t: 'op', v: op }); i += op.length;
      }
      return toks;
    }
    function parse(toks) {
      let p = 0;
      const peek = () => toks[p];
      const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
      const isId = (v) => peek() && peek().t === 'id' && peek().v === v;
      const eat = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}" in condition`); p++; };
      function ternary() {
        const c = or();
        if (isOp('?')) { p++; const a = ternary(); eat(':'); const b = ternary(); return { k: 'tern', c, a, b }; }
        return c;
      }
      function or() { let l = and(); while (isOp('||')) { p++; l = { k: 'bin', op: '||', l, r: and() }; } return l; }
      function and() { let l = rel(); while (isOp('&&')) { p++; l = { k: 'bin', op: '&&', l, r: rel() }; } return l; }
      function rel() {
        let l = add();
        for (;;) {
          const o = ['==', '!=', '<=', '>=', '<', '>'].find(isOp);
          if (o) { p++; l = { k: 'bin', op: o, l, r: add() }; continue; }
          if (isId('in')) { p++; l = { k: 'bin', op: 'in', l, r: add() }; continue; }
          return l;
        }
      }
      function add() { let l = mul(); for (;;) { const o = ['+', '-'].find(isOp); if (!o) return l; p++; l = { k: 'bin', op: o, l, r: mul() }; } }
      function mul() { let l = unary(); for (;;) { const o = ['*', '/', '%'].find(isOp); if (!o) return l; p++; l = { k: 'bin', op: o, l, r: unary() }; } }
      function unary() { if (isOp('!')) { p++; return { k: 'un', op: '!', e: unary() }; } if (isOp('-')) { p++; return { k: 'un', op: '-', e: unary() }; } return postfix(); }
      function postfix() {
        let e = primary();
        for (;;) {
          if (isOp('.')) {
            p++;
            const name = peek(); if (!name || name.t !== 'id') throw new Error('Expected a name after "."'); p++;
            if (isOp('(')) { p++; const args = argList(); e = { k: 'call', fn: name.v, recv: e, args }; }
            else e = { k: 'member', e, name: name.v };
            continue;
          }
          if (isOp('[')) { p++; const idx = ternary(); eat(']'); e = { k: 'index', e, idx }; continue; }
          return e;
        }
      }
      function argList() { const args = []; if (isOp(')')) { p++; return args; } for (;;) { args.push(ternary()); if (isOp(',')) { p++; continue; } eat(')'); return args; } }
      function primary() {
        const t = peek();
        if (!t) throw new Error('Unexpected end of condition expression');
        if (t.t === 'num') { p++; return { k: 'lit', v: t.v }; }
        if (t.t === 'str') { p++; return { k: 'lit', v: t.v }; }
        if (t.t === 'id') {
          p++;
          if (t.v === 'true') return { k: 'lit', v: true };
          if (t.v === 'false') return { k: 'lit', v: false };
          if (t.v === 'null') return { k: 'lit', v: null };
          if (isOp('(')) { p++; return { k: 'call', fn: t.v, recv: null, args: argList() }; }
          return { k: 'id', name: t.v };
        }
        if (t.t === 'op' && t.v === '(') { p++; const e = ternary(); eat(')'); return e; }
        if (t.t === 'op' && t.v === '[') {
          p++; const items = [];
          if (isOp(']')) { p++; return { k: 'list', items }; }
          for (;;) { items.push(ternary()); if (isOp(',')) { p++; continue; } eat(']'); return { k: 'list', items }; }
        }
        throw new Error(`Unexpected "${t.v}" in condition`);
      }
      const ast = ternary();
      if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}" in condition`);
      return ast;
    }
    const isTagged = (v) => v && typeof v === 'object' && v.__t;
    const num = (v) => (isTagged(v) ? v.ms : v);
    function ipToInt(ip) {
      const parts = String(ip).split('.').map(Number);
      if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) throw new Error(`"${ip}" is not an IPv4 address`);
      return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
    }
    function inCidr(ip, cidr) {
      const [base, bitsStr] = String(cidr).split('/');
      const bits = Number(bitsStr);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (ipToInt(ip) & mask) >>> 0 === (ipToInt(base) & mask) >>> 0;
    }
    function evaluate(n, env) {
      switch (n.k) {
        case 'lit': return n.v;
        case 'id': {
          if (!(n.name in env)) { const e = new Error(`missing parameter "${n.name}"`); e.missing = n.name; throw e; }
          return env[n.name];
        }
        case 'list': return n.items.map((i) => evaluate(i, env));
        case 'tern': return evaluate(n.c, env) ? evaluate(n.a, env) : evaluate(n.b, env);
        case 'un': { const v = evaluate(n.e, env); return n.op === '!' ? !v : -num(v); }
        case 'member': { const o = evaluate(n.e, env); if (o == null || typeof o !== 'object') throw new Error(`cannot read "${n.name}"`); return o[n.name]; }
        case 'index': { const o = evaluate(n.e, env); const i = evaluate(n.idx, env); return o[i]; }
        case 'call': {
          const args = n.args.map((a) => evaluate(a, env));
          if (n.recv) {
            const r = evaluate(n.recv, env);
            switch (n.fn) {
              case 'contains': return Array.isArray(r) ? r.includes(args[0]) : String(r).includes(args[0]);
              case 'startsWith': return String(r).startsWith(args[0]);
              case 'endsWith': return String(r).endsWith(args[0]);
              case 'matches': return new RegExp(args[0]).test(String(r));
              case 'size': return r.length;
              case 'in_cidr': return inCidr(r, args[0]);
              case 'getHours': return new Date(num(r)).getUTCHours();
              case 'getDayOfWeek': return new Date(num(r)).getUTCDay();
              default: throw new Error(`unknown method "${n.fn}"`);
            }
          }
          switch (n.fn) {
            case 'timestamp': return { __t: 'timestamp', ms: parseTimestampMs(args[0]) };
            case 'duration': return { __t: 'duration', ms: parseDurationMs(args[0]) };
            case 'ipaddress': return String(args[0]);
            case 'size': return args[0].length;
            case 'string': return String(args[0]);
            case 'int': case 'uint': case 'double': return Number(args[0]);
            case 'bool': return !!args[0];
            case 'has': return args[0] !== undefined && args[0] !== null;
            default: throw new Error(`unknown function "${n.fn}"`);
          }
        }
        case 'bin': {
          if (n.op === '&&') return !!(evaluate(n.l, env) && evaluate(n.r, env));
          if (n.op === '||') return !!(evaluate(n.l, env) || evaluate(n.r, env));
          const a = evaluate(n.l, env), b = evaluate(n.r, env);
          switch (n.op) {
            case '==': return num(a) === num(b);
            case '!=': return num(a) !== num(b);
            case '<': return num(a) < num(b);
            case '<=': return num(a) <= num(b);
            case '>': return num(a) > num(b);
            case '>=': return num(a) >= num(b);
            case '+': {
              if (isTagged(a) || isTagged(b)) return { __t: (isTagged(a) && a.__t === 'timestamp') || (isTagged(b) && b.__t === 'timestamp') ? 'timestamp' : 'duration', ms: num(a) + num(b) };
              if (typeof a === 'string' || typeof b === 'string') return String(a) + String(b);
              if (Array.isArray(a)) return a.concat(b);
              return a + b;
            }
            case '-': { if (isTagged(a) || isTagged(b)) return { __t: isTagged(a) && isTagged(b) && a.__t === 'timestamp' && b.__t === 'timestamp' ? 'duration' : (isTagged(a) ? a.__t : 'duration'), ms: num(a) - num(b) }; return a - b; }
            case '*': return num(a) * num(b);
            case '/': return num(a) / num(b);
            case '%': return num(a) % num(b);
            case 'in': return Array.isArray(b) ? b.some((x) => num(x) === num(a)) : (b && typeof b === 'object' ? a in b : String(b).includes(a));
            default: throw new Error(`unknown operator ${n.op}`);
          }
        }
        default: throw new Error('bad expression');
      }
    }
    function compile(src) {
      const ast = parse(lex(src));
      return { ast, eval: (env) => evaluate(ast, env) };
    }
    function fmtValue(v) {
      if (isTagged(v)) return v.__t === 'timestamp' ? new Date(v.ms).toISOString() : `${v.ms / 1000}s`;
      return JSON.stringify(v);
    }
    return { compile, fmtValue };
  })();

  // Evaluate a tuple's condition. Request context is merged under the tuple's own context (tuple wins).
  function evaluateCondition(model, tuple, requestContext) {
    if (!tuple.condition) return { ok: true };
    const def = model.condMap.get(tuple.condition.name);
    if (!def) return { ok: false, error: `condition "${tuple.condition.name}" is not in the model` };
    if (!def.compiled) return { ok: false, error: `condition "${def.name}" failed to compile` };
    const merged = Object.assign({}, requestContext || {}, tuple.condition.context || {});
    const env = {};
    const bound = [];
    try {
      for (const p of def.params) {
        if (p.name in merged) { env[p.name] = coerceParam(p.type, merged[p.name]); bound.push(`${p.name} = ${JSON.stringify(merged[p.name])}`); }
      }
      const v = def.compiled.eval(env);
      return { ok: v === true, value: v, bound, def, missing: null };
    } catch (e) {
      return { ok: false, error: e.missing ? `missing context parameter "${e.missing}"` : e.message, bound, def, missing: e.missing || null };
    }
  }

  // ───────────────────────── model graph & edges ─────────────────────────
  // Every way a userset can flow into a relation, with the boolean context it sits under.
  function modelEdges(model) {
    const edges = [];
    for (const t of model.types) for (const r of t.relations) {
      const to = relNode(t.name, r.name);
      const walk = (n, ctx) => {
        switch (n.kind) {
          case 'this':
            for (const e of n.types) {
              const from = e.relation ? relNode(e.type, e.relation) : `${e.type}@self`;
              edges.push({ gid: edgeGid(from, to, 'direct'), from, to, kind: 'direct', ctx, entry: e, type: t.name, relation: r.name });
            }
            break;
          case 'computed': {
            const from = relNode(t.name, n.relation);
            edges.push({ gid: edgeGid(from, to, 'computed'), from, to, kind: 'computed', ctx, type: t.name, relation: r.name, via: n.relation });
            break;
          }
          case 'ttu': {
            const ts = t.relMap.get(n.tupleset);
            if (!ts) break;
            for (const pt of uniq(ts.directTypes.map((e) => e.type))) {
              const ptDef = model.typeMap.get(pt);
              if (!ptDef || !ptDef.relMap.has(n.computed)) continue;
              const from = relNode(pt, n.computed);
              edges.push({ gid: edgeGid(from, to, 'ttu', n.tupleset), from, to, kind: 'ttu', ctx, type: t.name, relation: r.name, tupleset: n.tupleset, computed: n.computed, parentType: pt });
            }
            break;
          }
          case 'union': n.children.forEach((c) => walk(c, ctx)); break;
          case 'intersection': n.children.forEach((c) => walk(c, ctx === 'exclusion' ? ctx : 'intersection')); break;
          case 'difference': walk(n.base, ctx === 'union' ? 'base' : ctx); walk(n.subtract, 'exclusion'); break;
          default: break;
        }
      };
      walk(r.rewrite, 'union');
    }
    return edges;
  }

  function buildModelGraph(model) {
    const nodes = [], clusters = [];
    for (const t of model.types) {
      clusters.push({ id: t.name, label: t.name, type: t.name });
      nodes.push({ id: `${t.name}@self`, kind: 'type', type: t.name, label: t.name, cluster: t.name });
      for (const r of t.relations) {
        nodes.push({ id: relNode(t.name, r.name), kind: 'rel', type: t.name, rel: r.name, label: r.name, cluster: t.name, op: topOperator(r.rewrite), def: `define ${r.name}: ${describeRewrite(r.rewrite)}`, direct: r.directTypes.map(describeEntry) });
      }
    }
    const byGid = new Map();
    for (const e of modelEdges(model)) {
      let g = byGid.get(e.gid);
      if (!g) {
        g = { id: e.gid, from: e.from, to: e.to, kind: e.kind, ctx: e.ctx, wildcard: false, conditions: [], tupleset: e.tupleset || null, label: e.kind === 'ttu' ? `from ${e.tupleset}` : '' };
        byGid.set(e.gid, g);
      }
      if (e.entry) {
        if (e.entry.wildcard) g.wildcard = true;
        if (e.entry.condition) g.conditions.push(e.entry.condition);
      }
      const rank = { union: 0, base: 1, intersection: 2, exclusion: 3 };
      if (rank[e.ctx] > rank[g.ctx]) g.ctx = e.ctx;
    }
    return { nodes, edges: Array.from(byGid.values()), clusters };
  }

  function buildDataGraph(store) {
    const nodes = new Map(), edges = [];
    const addNode = (id, type, kind) => { if (!nodes.has(id)) nodes.set(id, { id, type, kind, label: id, tuples: [] }); return nodes.get(id); };
    for (const t of store.tuples) {
      const o = addNode(t.object.raw, t.object.type, 'object');
      let from;
      if (t.user.wildcard) from = addNode(`${t.user.type}:*`, t.user.type, 'wildcard');
      else from = addNode(`${t.user.type}:${t.user.id}`, t.user.type, 'object');
      o.tuples.push(t.id); from.tuples.push(t.id);
      edges.push({ id: `t${t.id}`, tupleId: t.id, from: from.id, to: o.id, label: t.relation, userset: t.user.relation || null, condition: t.condition ? t.condition.name : null, contextual: !!t.contextual });
    }
    return { nodes: Array.from(nodes.values()), edges };
  }

  // ───────────────────────── CHECK ─────────────────────────
  function makeCtx(model, store, context, trace) {
    return { model, store, trace, context: context || {}, memo: new Map(), memoProof: new Map(), maxDepth: 25, errors: [] };
  }

  function check(model, store, q, options = {}) {
    const trace = makeTrace();
    const ctx = makeCtx(model, store, q.context, trace);
    let user, object;
    try {
      user = parseUserRef(q.user);
      object = parseObjectRef(q.object);
      if (!isIdent(q.relation || '')) throw new Error(`"${q.relation || ''}" is not a valid relation name`);
    } catch (e) { return { allowed: false, error: e.message, trace, root: null }; }
    const root = checkRec(ctx, user, q.relation, object, null, new Set(), 0);
    return { allowed: root.result === true, trace, root, error: ctx.errors[0] || null, steps: trace.events.length, reads: trace.reads };
  }

  function checkRec(ctx, user, relation, object, parent, path, depth) {
    const T = ctx.trace;
    const objType = ctx.model.typeMap.get(object.type);
    const modelNode = relNode(object.type, relation);
    const frame = T.frame({ kind: 'check', user: user.raw, relation, object: object.raw, depth, parent, modelNode, label: `${user.raw} · ${relation} · ${object.raw}` });
    const userNode = user.wildcard ? `${user.type}:*` : `${user.type}:${user.id}`;
    T.emit('enter', frame, depth === 0 ? `Check — is ${user.raw} ${an(relation)} ${relation} of ${object.raw}?` : `Sub-check — is ${user.raw} ${an(relation)} ${relation} of ${object.raw}?`, { hl: { modelNodes: { [modelNode]: 'active' }, dataNodes: { [object.raw]: 'active', [userNode]: 'active' } } });
    const key = `${object.raw}#${relation}@${user.raw}`;
    const finish = (value, reason, status, proof) => {
      frame.result = value; frame.status = 'done'; frame.reason = reason; frame.proof = value ? (proof || null) : null;
      T.emit('exit', frame, (value ? 'ALLOWED — ' : 'DENIED — ') + reason, { status: status || (value ? 'ok' : 'fail'), hl: { modelNodes: { [modelNode]: value ? 'ok' : 'fail' }, dataNodes: { [object.raw]: value ? 'ok' : 'fail' } } });
      return frame;
    };
    if (!objType) { ctx.errors.push(`type "${object.type}" is not in the model`); return finish(false, `type "${object.type}" is not in the model`, 'warn'); }
    const rel = objType.relMap.get(relation);
    if (!rel) { ctx.errors.push(`relation "${relation}" is not defined on ${object.type}`); return finish(false, `"${relation}" is not a relation of ${object.type}`, 'warn'); }
    if (path.has(key)) {
      frame.cycle = true;
      return finish(false, `cycle — ${key} is already being resolved higher in the stack; OpenFGA stops here and treats this branch as not satisfied`, 'warn');
    }
    if (depth > ctx.maxDepth) { ctx.errors.push('resolution depth exceeded'); return finish(false, `resolution depth ${depth} exceeds OpenFGA's limit of ${ctx.maxDepth}`, 'warn'); }
    if (ctx.memo.has(key)) {
      const v = ctx.memo.get(key);
      frame.cached = true;
      return finish(v, `already resolved earlier in this request → reusing ${v ? 'ALLOWED' : 'DENIED'} (no new tuple reads)`, null, ctx.memoProof.get(key) || null);
    }
    path.add(key);
    const res = evalRewrite(ctx, frame, rel.rewrite, user, relation, object, path, depth);
    path.delete(key);
    frame.cycleSeen = !!res.cycle;
    if (!res.cycle) { ctx.memo.set(key, res.value); if (res.proof) ctx.memoProof.set(key, res.proof); }
    return finish(res.value, res.value ? `${user.raw} is ${an(relation)} ${relation} of ${object.raw}${res.via ? ' via ' + res.via : ''}` : `${user.raw} is not ${an(relation)} ${relation} of ${object.raw}${res.via ? ' — ' + res.via : ''}`, null, res.proof);
  }

  function condStep(ctx, frame, t) {
    const r = evaluateCondition(ctx.model, t, ctx.context);
    if (!t.condition) return r;
    const T = ctx.trace;
    const what = `condition ${t.condition.name}(${r.def ? r.def.params.map((p) => p.name).join(', ') : ''})`;
    if (r.error) T.emit('cond', frame, `${what} could not be evaluated: ${r.error}${r.missing ? ' → pass it in the query context' : ''} — tuple skipped`, { status: 'warn', hl: { dataEdges: { [`t${t.id}`]: 'fail' }, tupleIds: [t.id] }, detail: r.def ? `${r.def.expression}\n${(r.bound || []).join('\n')}` : null });
    else T.emit('cond', frame, `${what} → ${r.ok ? 'true' : 'false'}${r.bound.length ? '  (' + r.bound.join(', ') + ')' : ''}`, { status: r.ok ? 'ok' : 'fail', hl: { dataEdges: { [`t${t.id}`]: r.ok ? 'ok' : 'fail' }, tupleIds: [t.id] }, detail: r.def ? r.def.expression : null });
    return r;
  }

  // `rp` is the position of `node` inside the relation's rewrite tree (child indices from the root);
  // trace events carry it as hl.rewrites so the resolution view can light up the branch being walked.
  function evalRewrite(ctx, frame, node, user, relation, object, path, depth, rp = []) {
    const T = ctx.trace;
    const modelNode = relNode(object.type, relation);
    const idsOf = (tuples) => Object.fromEntries(tuples.map((t) => [`t${t.id}`, 'read']));
    const rk = (p, st) => ({ [`${modelNode}|${p.join('.')}`]: st });
    switch (node.kind) {
      case 'this': {
        const tuples = ctx.store.read(object.raw, relation);
        T.reads++;
        T.emit('read', frame, `Direct assignment ${describeRewrite(node)} → read tuples where object = ${object.raw} and relation = ${relation}: ${tuples.length ? tuples.length + ' found' : 'none'}`, { status: 'read', hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp, 'active'), dataNodes: { [object.raw]: 'active' }, dataEdges: idsOf(tuples), tupleIds: tuples.map((t) => t.id) } });
        let cycle = false;
        for (const t of tuples) {
          const tu = t.user;
          const uNode = tu.wildcard ? `${tu.type}:*` : `${tu.type}:${tu.id}`;
          if (tu.raw === user.raw) {
            if (!condStep(ctx, frame, t).ok) continue;
            T.emit('match', frame, `${arrowTuple(t)} matches ${user.raw} directly`, { status: 'ok', hl: { modelEdges: { [edgeGid(`${tu.type}@self`, modelNode, 'direct')]: 'ok' }, rewrites: rk(rp, 'ok'), dataEdges: { [`t${t.id}`]: 'ok' }, dataNodes: { [uNode]: 'ok', [object.raw]: 'ok' }, tupleIds: [t.id] } });
            return { value: true, cycle, via: 'a direct tuple', proof: { kind: 'direct', tuple: t, relation, object: object.raw } };
          }
          if (tu.wildcard && !user.relation && tu.type === user.type) {
            if (!condStep(ctx, frame, t).ok) continue;
            T.emit('match', frame, `${arrowTuple(t)} is a public (wildcard) grant for every ${tu.type} → it covers ${user.raw}`, { status: 'ok', hl: { modelEdges: { [edgeGid(`${tu.type}@self`, modelNode, 'direct')]: 'ok' }, rewrites: rk(rp, 'ok'), dataEdges: { [`t${t.id}`]: 'ok' }, dataNodes: { [uNode]: 'ok', [object.raw]: 'ok' }, tupleIds: [t.id] } });
            return { value: true, cycle, via: `the public wildcard ${tu.raw}`, proof: { kind: 'wildcard', tuple: t, relation, object: object.raw, user: user.raw } };
          }
          if (tu.relation) {
            T.emit('note', frame, `${arrowTuple(t)} grants ${relation} to the userset ${tu.raw} → is ${user.raw} a member of it?`, { status: 'info', hl: { dataEdges: { [`t${t.id}`]: 'active' }, dataNodes: { [uNode]: 'active' }, tupleIds: [t.id] } });
            if (!condStep(ctx, frame, t).ok) continue;
            const child = checkRec(ctx, user, tu.relation, objectOfUser(tu), frame, path, depth + 1);
            if (child.cycle || child.cycleSeen) cycle = true;
            if (child.result) {
              T.emit('match', frame, `${user.raw} ∈ ${tu.raw} → ${arrowTuple(t)} applies`, { status: 'ok', hl: { modelEdges: { [edgeGid(relNode(tu.type, tu.relation), modelNode, 'direct')]: 'ok' }, rewrites: rk(rp, 'ok'), dataEdges: { [`t${t.id}`]: 'ok' }, dataNodes: { [uNode]: 'ok', [object.raw]: 'ok' }, tupleIds: [t.id] } });
              return { value: true, cycle, via: `the userset ${tu.raw}`, proof: { kind: 'userset', tuple: t, relation, object: object.raw, child: child.proof } };
            }
            continue;
          }
          T.emit('skip', frame, `${arrowTuple(t)} — ${tu.raw} is not ${user.raw}`, { status: 'skip', minor: true, hl: { dataEdges: { [`t${t.id}`]: 'skip' }, tupleIds: [t.id] } });
        }
        return { value: false, cycle, via: tuples.length ? 'no direct tuple matched' : 'no direct tuples' };
      }
      case 'computed': {
        const from = relNode(object.type, node.relation);
        T.emit('rewrite', frame, `${relation} includes the computed userset "${node.relation}" → anyone who is ${node.relation} of ${object.raw} is also ${relation}`, { hl: { modelNodes: { [modelNode]: 'active', [from]: 'active' }, modelEdges: { [edgeGid(from, modelNode, 'computed')]: 'active' }, rewrites: rk(rp, 'active') } });
        const child = checkRec(ctx, user, node.relation, object, frame, path, depth + 1);
        // the sub-check's exit event is what the user sees; stamp its outcome on this branch's edge too
        const last = T.events[T.events.length - 1];
        if (last && last.hl) { last.hl.modelEdges = Object.assign({}, last.hl.modelEdges, { [edgeGid(from, modelNode, 'computed')]: child.result ? 'ok' : 'fail' }); last.hl.rewrites = Object.assign({}, last.hl.rewrites, rk(rp, child.result ? 'ok' : 'fail')); }
        return { value: !!child.result, cycle: child.cycle || child.cycleSeen, via: child.result ? `computed userset ${node.relation}` : `not ${node.relation} either`, proof: child.result ? { kind: 'computed', relation, implied: node.relation, object: object.raw, child: child.proof } : null };
      }
      case 'ttu': {
        const tuples = ctx.store.read(object.raw, node.tupleset);
        T.reads++;
        const ttuEdges = {};
        for (const pt of uniq((objType(ctx, object.type).relMap.get(node.tupleset)?.directTypes || []).map((e) => e.type))) {
          ttuEdges[edgeGid(relNode(pt, node.computed), modelNode, 'ttu', node.tupleset)] = 'active';
        }
        T.emit('read', frame, `"${node.computed} from ${node.tupleset}" → read ${object.raw}'s ${node.tupleset} tuples: ${tuples.length ? tuples.map((t) => t.user.raw).join(', ') : 'none'}`, { status: 'read', hl: { modelNodes: { [modelNode]: 'active' }, modelEdges: ttuEdges, rewrites: rk(rp, 'active'), dataNodes: { [object.raw]: 'active' }, dataEdges: idsOf(tuples), tupleIds: tuples.map((t) => t.id) } });
        let cycle = false;
        for (const t of tuples) {
          if (t.user.relation || t.user.wildcard) { T.emit('skip', frame, `${arrowTuple(t)} — tupleset tuples must point at a plain object, skipped`, { status: 'skip', minor: true }); continue; }
          if (!condStep(ctx, frame, t).ok) continue;
          const parentObj = objectOfUser(t.user);
          T.emit('note', frame, `${parentObj.raw} is a ${node.tupleset} of ${object.raw} → check ${node.computed} on it`, { status: 'info', hl: { dataEdges: { [`t${t.id}`]: 'active' }, dataNodes: { [parentObj.raw]: 'active' }, tupleIds: [t.id] } });
          const child = checkRec(ctx, user, node.computed, parentObj, frame, path, depth + 1);
          if (child.cycle || child.cycleSeen) cycle = true;
          if (child.result) {
            T.emit('match', frame, `${user.raw} is ${node.computed} of ${parentObj.raw} → inherited through ${node.tupleset}`, { status: 'ok', hl: { modelEdges: { [edgeGid(relNode(parentObj.type, node.computed), modelNode, 'ttu', node.tupleset)]: 'ok' }, rewrites: rk(rp, 'ok'), dataEdges: { [`t${t.id}`]: 'ok' }, dataNodes: { [parentObj.raw]: 'ok', [object.raw]: 'ok' }, tupleIds: [t.id] } });
            return { value: true, cycle, via: `${node.computed} from ${node.tupleset} (${parentObj.raw})`, proof: { kind: 'ttu', tuple: t, relation, tupleset: node.tupleset, computed: node.computed, object: object.raw, child: child.proof } };
          }
        }
        return { value: false, cycle, via: tuples.length ? `no ${node.tupleset} granted ${node.computed}` : `${object.raw} has no ${node.tupleset}` };
      }
      case 'union': {
        const n = node.children.length;
        T.emit('rewrite', frame, `${relation} = ${describeRewrite(node)} → union: satisfied if ANY branch is`, { hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp, 'active') } });
        let cycle = false;
        for (let i = 0; i < n; i++) {
          T.emit('branch', frame, `Branch ${i + 1} of ${n}: ${describeRewrite(node.children[i])}`, { status: 'info', hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp.concat([i]), 'active') } });
          const r = evalRewrite(ctx, frame, node.children[i], user, relation, object, path, depth, rp.concat([i]));
          cycle = cycle || !!r.cycle;
          if (r.value) {
            if (i < n - 1) T.emit('note', frame, `Branch ${i + 1} is satisfied → the remaining ${n - 1 - i} branch${n - 1 - i > 1 ? 'es are' : ' is'} skipped (short-circuit)`, { status: 'ok', hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp.concat([i]), 'ok') } });
            return { value: true, cycle, via: r.via, proof: r.proof };
          }
        }
        return { value: false, cycle, via: 'no union branch is satisfied' };
      }
      case 'intersection': {
        const n = node.children.length;
        T.emit('rewrite', frame, `${relation} = ${describeRewrite(node)} → intersection: ALL branches must be satisfied`, { hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp, 'active') } });
        let cycle = false;
        const vias = [], parts = [];
        for (let i = 0; i < n; i++) {
          T.emit('branch', frame, `Branch ${i + 1} of ${n}: ${describeRewrite(node.children[i])}`, { status: 'info', hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp.concat([i]), 'active') } });
          const r = evalRewrite(ctx, frame, node.children[i], user, relation, object, path, depth, rp.concat([i]));
          cycle = cycle || !!r.cycle;
          if (!r.value) {
            if (i < n - 1) T.emit('note', frame, `Branch ${i + 1} failed → the intersection cannot be satisfied; remaining branches skipped`, { status: 'fail', hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp.concat([i]), 'fail') } });
            return { value: false, cycle, via: `"${describeRewrite(node.children[i])}" is not satisfied (intersection)` };
          }
          vias.push(r.via); parts.push(r.proof);
        }
        return { value: true, cycle, via: `all of: ${vias.join('; ')}`, proof: { kind: 'all', parts, relation, object: object.raw } };
      }
      case 'difference': {
        T.emit('rewrite', frame, `${relation} = ${describeRewrite(node)} → exclusion: the base must hold AND the excluded part must not`, { hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp, 'active') } });
        T.emit('branch', frame, `Base: ${describeRewrite(node.base)}`, { status: 'info', hl: { modelNodes: { [modelNode]: 'active' }, rewrites: rk(rp.concat([0]), 'active') } });
        const b = evalRewrite(ctx, frame, node.base, user, relation, object, path, depth, rp.concat([0]));
        if (!b.value) return { value: false, cycle: b.cycle, via: `the base "${describeRewrite(node.base)}" is not satisfied` };
        T.emit('branch', frame, `Base holds → now the exclusion: but not ${describeRewrite(node.subtract)}`, { status: 'info', hl: { modelNodes: { [modelNode]: 'active' }, rewrites: Object.assign(rk(rp.concat([0]), 'ok'), rk(rp.concat([1]), 'active')) } });
        const s = evalRewrite(ctx, frame, node.subtract, user, relation, object, path, depth, rp.concat([1]));
        const cycle = b.cycle || s.cycle;
        if (s.value) {
          T.emit('note', frame, `Excluded by "but not ${describeRewrite(node.subtract)}"`, { status: 'fail', hl: { modelNodes: { [modelNode]: 'fail' }, rewrites: rk(rp.concat([1]), 'fail') } });
          return { value: false, cycle, via: `excluded by "but not ${describeRewrite(node.subtract)}"` };
        }
        return { value: true, cycle, via: `${b.via}, and not excluded`, proof: b.proof ? Object.assign({}, b.proof, { notExcluded: describeRewrite(node.subtract) }) : null };
      }
      default:
        return { value: false, cycle: false, via: 'unknown rewrite' };
    }
  }
  const objType = (ctx, name) => ctx.model.typeMap.get(name) || { relMap: new Map() };

  // ───────────────────────── LIST OBJECTS (reverse expansion) ─────────────────────────
  function reverseReach(edges, target) {
    const incoming = new Map();
    for (const e of edges) { if (e.ctx === 'exclusion') continue; const a = incoming.get(e.to) || []; a.push(e); incoming.set(e.to, a); }
    const reach = new Set([target]);
    const queue = [target];
    const used = new Set();
    while (queue.length) {
      const n = queue.shift();
      for (const e of incoming.get(n) || []) {
        used.add(e.gid);
        if (!reach.has(e.from)) { reach.add(e.from); queue.push(e.from); }
      }
    }
    return { reach, used };
  }

  function listObjects(model, store, q) {
    const trace = makeTrace();
    const ctx = makeCtx(model, store, q.context, trace);
    const T = trace;
    let user;
    try {
      user = parseUserRef(q.user);
      if (!model.typeMap.has(q.type)) throw new Error(`type "${q.type}" is not in the model`);
      if (!model.typeMap.get(q.type).relMap.has(q.relation)) throw new Error(`"${q.relation}" is not a relation of ${q.type}`);
    } catch (e) { return { objects: [], error: e.message, trace, root: null }; }
    const target = relNode(q.type, q.relation);
    const root = T.frame({ kind: 'listobjects', user: user.raw, relation: q.relation, object: `${q.type}:?`, depth: 0, modelNode: target, label: `${user.raw} · ${q.relation} · ${q.type}` });
    const userNode = user.wildcard ? `${user.type}:*` : `${user.type}:${user.id}`;
    T.emit('enter', root, `ListObjects — which ${q.type} objects is ${user.raw} ${an(q.relation)} ${q.relation} of?`, { hl: { modelNodes: { [target]: 'active' }, dataNodes: { [userNode]: 'active' } } });
    const edges = modelEdges(model);
    const { reach, used } = reverseReach(edges, target);
    const startNode = user.relation ? relNode(user.type, user.relation) : `${user.type}@self`;
    const planHl = { modelNodes: {}, modelEdges: {} };
    reach.forEach((n) => { planHl.modelNodes[n] = 'read'; });
    used.forEach((g) => { planHl.modelEdges[g] = 'read'; });
    planHl.modelNodes[target] = 'active';
    T.emit('plan', root, `Reverse expansion plan: ${reach.size - 1} model node${reach.size - 1 === 1 ? '' : 's'} can lead into ${target} (edges under "but not" are never followed). Start at ${startNode} and walk the tuples backwards.`, { status: 'read', hl: planHl });
    if (!reach.has(startNode)) {
      T.emit('note', root, `${startNode} has no path to ${target} in this model → the result is empty without reading any tuple`, { status: 'fail' });
      root.result = []; root.status = 'done';
      T.emit('exit', root, `ListObjects → 0 objects`, { status: 'fail' });
      return { objects: [], trace, root, candidates: [], error: null, steps: trace.events.length, reads: trace.reads };
    }
    const queue = [{ us: user, node: startNode, needsCheck: false, frame: root }];
    const visited = new Map([[user.raw, false]]);
    const candidates = new Map();
    const needsLabel = (ctxName) => ctxName === 'intersection' ? '"and"' : ctxName === 'base' ? '"but not"' : null;

    const enqueue = (cur, us, node, needsCheck, how, tuple, edge) => {
      const objRaw = `${us.type}:${us.id}`;
      const hl = { modelNodes: { [node]: 'active' }, dataNodes: { [objRaw]: 'active' }, modelEdges: edge ? { [edge.gid]: 'active' } : {}, dataEdges: tuple ? { [`t${tuple.id}`]: 'active' } : {}, tupleIds: tuple ? [tuple.id] : [] };
      if (visited.has(us.raw)) {
        const prev = visited.get(us.raw);
        if (prev && !needsCheck && candidates.has(objRaw) && node === target) {
          visited.set(us.raw, false);
          candidates.get(objRaw).needsCheck = false;
          T.emit('note', cur.frame, `${us.raw} reached again through a plain union path → no Check needed after all`, { status: 'ok', hl });
        } else T.emit('skip', cur.frame, `${us.raw} already expanded — skipped`, { status: 'skip', minor: true, hl });
        return;
      }
      visited.set(us.raw, needsCheck);
      const f = T.frame({ kind: 'expand', parent: cur.frame, depth: cur.frame.depth + 1, modelNode: node, object: objRaw, relation: us.relation, user: user.raw, label: us.raw });
      T.emit('enter', f, `→ ${us.raw}  (${how})`, { hl });
      if (node === target) {
        candidates.set(objRaw, { needsCheck, frame: f, ok: null });
        if (needsCheck) T.emit('note', f, `${objRaw} is a candidate — the path crossed ${cur.needsCheckWhy || needsLabel(edge && edge.ctx) || '"and"/"but not"'}, so OpenFGA must confirm it with a Check`, { status: 'warn', hl: { dataNodes: { [objRaw]: 'read' }, modelNodes: { [node]: 'read' } } });
        else T.emit('match', f, `${objRaw} is a result — the path only crossed unions, no verification needed`, { status: 'ok', hl: { dataNodes: { [objRaw]: 'ok' }, modelNodes: { [node]: 'ok' } } });
      }
      queue.push({ us, node, needsCheck, frame: f, needsCheckWhy: needsCheck ? (cur.needsCheckWhy || needsLabel(edge && edge.ctx)) : null });
    };

    while (queue.length) {
      const cur = queue.shift();
      const cu = cur.us;
      const outgoing = edges.filter((e) => e.from === cur.node && e.ctx !== 'exclusion' && reach.has(e.to));
      for (const e of outgoing) {
        const [toType, toRel] = e.to.split('#');
        const strict = e.ctx === 'intersection' || e.ctx === 'base';
        const needs = cur.needsCheck || strict;
        if (e.kind === 'direct') {
          if (e.entry.wildcard && cu.relation) continue;
          const readUser = e.entry.wildcard ? `${cu.type}:*` : cu.raw;
          const tuples = store.readByUser(readUser, toRel, toType);
          T.reads++;
          T.emit('read', cur.frame, `${e.to} directly accepts ${describeEntry(e.entry)} → read tuples where user = ${readUser}, relation = ${toRel}, object type = ${toType}: ${tuples.length ? tuples.map((t) => t.object.raw).join(', ') : 'none'}`, { status: 'read', hl: { modelEdges: { [e.gid]: 'active' }, modelNodes: { [cur.node]: 'active', [e.to]: 'active' }, dataEdges: Object.fromEntries(tuples.map((t) => [`t${t.id}`, 'read'])), tupleIds: tuples.map((t) => t.id) } });
          for (const t of tuples) {
            if (!condStep(ctx, cur.frame, t).ok) continue;
            enqueue(cur, { raw: `${t.object.raw}#${toRel}`, type: toType, id: t.object.id, relation: toRel }, e.to, needs, `tuple ${arrowTuple(t)}`, t, e);
          }
        } else if (e.kind === 'computed') {
          if (!cu.relation) continue;
          T.emit('note', cur.frame, `${toRel} includes the computed userset ${cu.relation} → ${cu.type}:${cu.id}#${cu.relation} implies ${cu.type}:${cu.id}#${toRel} (no tuple read)`, { status: 'info', hl: { modelEdges: { [e.gid]: 'active' }, modelNodes: { [cur.node]: 'active', [e.to]: 'active' } } });
          enqueue(cur, { raw: `${cu.type}:${cu.id}#${toRel}`, type: cu.type, id: cu.id, relation: toRel }, e.to, needs, `computed userset: ${toRel} includes ${cu.relation}`, null, e);
        } else if (e.kind === 'ttu') {
          if (!cu.relation) continue;
          const parentRaw = `${cu.type}:${cu.id}`;
          const tuples = store.readByUser(parentRaw, e.tupleset, toType);
          T.reads++;
          T.emit('read', cur.frame, `${e.to} = "${e.computed} from ${e.tupleset}" → read tuples where user = ${parentRaw}, relation = ${e.tupleset}, object type = ${toType}: ${tuples.length ? tuples.map((t) => t.object.raw).join(', ') : 'none'}`, { status: 'read', hl: { modelEdges: { [e.gid]: 'active' }, modelNodes: { [cur.node]: 'active', [e.to]: 'active' }, dataEdges: Object.fromEntries(tuples.map((t) => [`t${t.id}`, 'read'])), tupleIds: tuples.map((t) => t.id) } });
          for (const t of tuples) {
            if (!condStep(ctx, cur.frame, t).ok) continue;
            enqueue(cur, { raw: `${t.object.raw}#${toRel}`, type: toType, id: t.object.id, relation: toRel }, e.to, needs, `${t.object.raw}'s ${e.tupleset} is ${parentRaw}, and ${parentRaw}#${cu.relation} holds`, t, e);
          }
        }
      }
    }
    const results = [];
    for (const [objRaw, c] of candidates) {
      if (c.needsCheck) {
        T.emit('note', c.frame, `Verifying candidate with Check(${user.raw}, ${q.relation}, ${objRaw})`, { status: 'read', hl: { dataNodes: { [objRaw]: 'read' } } });
        const cf = checkRec(ctx, user, q.relation, parseObjectRef(objRaw), c.frame, new Set(), c.frame.depth + 1);
        c.ok = cf.result === true;
        T.emit(c.ok ? 'match' : 'note', c.frame, c.ok ? `Check confirmed → ${objRaw} is a result` : `Check denied → ${objRaw} is dropped`, { status: c.ok ? 'ok' : 'fail', hl: { dataNodes: { [objRaw]: c.ok ? 'ok' : 'fail' } } });
      } else c.ok = true;
      c.frame.result = c.ok;
      if (c.ok) results.push(objRaw);
    }
    results.sort();
    root.result = results; root.status = 'done';
    T.emit('exit', root, `ListObjects → ${results.length} object${results.length === 1 ? '' : 's'}${results.length ? ': ' + results.join(', ') : ''}`, { status: results.length ? 'ok' : 'fail', hl: { dataNodes: Object.fromEntries(results.map((r) => [r, 'ok'])) } });
    return { objects: results, trace, root, candidates: Array.from(candidates.entries()).map(([object, c]) => ({ object, needsCheck: c.needsCheck, ok: c.ok })), error: ctx.errors[0] || null, steps: trace.events.length, reads: trace.reads };
  }

  // ───────────────────────── LIST USERS (forward expansion) ─────────────────────────
  const emptySet = () => ({ users: new Set(), wildcard: false, excluded: new Set() });
  function normalize(s) { if (s.wildcard) s.users.forEach((u) => s.excluded.delete(u)); else s.excluded.clear(); return s; }
  function setUnion(a, b) {
    const r = emptySet();
    a.users.forEach((u) => r.users.add(u)); b.users.forEach((u) => r.users.add(u));
    r.wildcard = a.wildcard || b.wildcard;
    if (a.wildcard && b.wildcard) a.excluded.forEach((u) => { if (b.excluded.has(u)) r.excluded.add(u); });
    else if (a.wildcard) a.excluded.forEach((u) => { if (!b.users.has(u)) r.excluded.add(u); });
    else if (b.wildcard) b.excluded.forEach((u) => { if (!a.users.has(u)) r.excluded.add(u); });
    return normalize(r);
  }
  function setIntersect(a, b) {
    const r = emptySet();
    if (a.wildcard && b.wildcard) { r.wildcard = true; a.excluded.forEach((u) => r.excluded.add(u)); b.excluded.forEach((u) => r.excluded.add(u)); a.users.forEach((u) => { if (!b.excluded.has(u)) r.users.add(u); }); b.users.forEach((u) => { if (!a.excluded.has(u)) r.users.add(u); }); }
    else if (a.wildcard) b.users.forEach((u) => { if (!a.excluded.has(u)) r.users.add(u); });
    else if (b.wildcard) a.users.forEach((u) => { if (!b.excluded.has(u)) r.users.add(u); });
    else a.users.forEach((u) => { if (b.users.has(u)) r.users.add(u); });
    return normalize(r);
  }
  function setDifference(a, b) {
    const r = emptySet();
    if (b.wildcard) { if (a.wildcard) b.excluded.forEach((u) => { if (!a.excluded.has(u)) r.users.add(u); }); else a.users.forEach((u) => { if (b.excluded.has(u)) r.users.add(u); }); }
    else if (a.wildcard) { r.wildcard = true; a.excluded.forEach((u) => r.excluded.add(u)); b.users.forEach((u) => r.excluded.add(u)); a.users.forEach((u) => { if (!b.users.has(u)) r.users.add(u); }); }
    else a.users.forEach((u) => { if (!b.users.has(u)) r.users.add(u); });
    return normalize(r);
  }
  function fmtSet(s, type) {
    const parts = Array.from(s.users).sort();
    if (s.wildcard) parts.unshift(`${type}:*` + (s.excluded.size ? ` (except ${Array.from(s.excluded).sort().join(', ')})` : ''));
    return parts.length ? parts.join(', ') : '∅';
  }

  function listUsers(model, store, q) {
    const trace = makeTrace();
    const ctx = makeCtx(model, store, q.context, trace);
    const T = trace;
    let object;
    const filter = { type: q.userType, relation: q.userRelation || null };
    try {
      object = parseObjectRef(q.object);
      if (!model.typeMap.has(object.type)) throw new Error(`type "${object.type}" is not in the model`);
      if (!model.typeMap.get(object.type).relMap.has(q.relation)) throw new Error(`"${q.relation}" is not a relation of ${object.type}`);
      if (!model.typeMap.has(filter.type)) throw new Error(`user filter type "${filter.type}" is not in the model`);
    } catch (e) { return { users: [], wildcard: false, excluded: [], error: e.message, trace, root: null }; }
    ctx.filter = filter;
    const filterLabel = filter.type + (filter.relation ? '#' + filter.relation : '');
    const root = T.frame({ kind: 'listusers', object: object.raw, relation: q.relation, user: filterLabel, depth: 0, modelNode: relNode(object.type, q.relation), label: `${object.raw} · ${q.relation} · ${filterLabel}` });
    T.emit('enter', root, `ListUsers — who holds ${q.relation} on ${object.raw}? Filter: ${filterLabel}. OpenFGA expands the userset ${object.raw}#${q.relation} forward.`, { hl: { modelNodes: { [root.modelNode]: 'active' }, dataNodes: { [object.raw]: 'active' } } });
    const res = expandUsers(ctx, root, object, q.relation, new Set(), 1);
    root.result = res; root.status = 'done';
    const users = Array.from(res.users).sort();
    T.emit('exit', root, `ListUsers → ${fmtSet(res, filter.type)}`, { status: users.length || res.wildcard ? 'ok' : 'fail', hl: { dataNodes: Object.fromEntries(users.map((u) => [u, 'ok'])) } });
    return { users, wildcard: res.wildcard, excluded: Array.from(res.excluded).sort(), trace, root, error: ctx.errors[0] || null, steps: trace.events.length, reads: trace.reads };
  }

  function expandUsers(ctx, parent, object, relation, path, depth) {
    const T = ctx.trace;
    const modelNode = relNode(object.type, relation);
    const frame = T.frame({ kind: 'users', parent, depth, object: object.raw, relation, user: ctx.filter.type, modelNode, label: `${object.raw}#${relation}` });
    T.emit('enter', frame, `Expand userset ${object.raw}#${relation}`, { hl: { modelNodes: { [modelNode]: 'active' }, dataNodes: { [object.raw]: 'active' } } });
    const key = `${object.raw}#${relation}`;
    const finish = (set, note) => {
      frame.result = set; frame.status = 'done';
      const n = set.users.size + (set.wildcard ? 1 : 0);
      T.emit('exit', frame, `${key} → ${fmtSet(set, ctx.filter.type)}${note ? ' (' + note + ')' : ''}`, { status: n ? 'ok' : 'fail', hl: { modelNodes: { [modelNode]: n ? 'ok' : 'fail' }, dataNodes: Object.fromEntries(Array.from(set.users).map((u) => [u, 'ok'])) } });
      return set;
    };
    const typeDef = ctx.model.typeMap.get(object.type);
    const rel = typeDef && typeDef.relMap.get(relation);
    if (!rel) return finish(emptySet(), `"${relation}" is not defined on ${object.type}`);
    if (path.has(key)) { frame.cycle = true; return finish(emptySet(), 'cycle — already expanding this userset higher up'); }
    if (depth > ctx.maxDepth) return finish(emptySet(), 'depth limit');
    if (ctx.memo.has(key)) { frame.cached = true; return finish(ctx.memo.get(key), 'reused from earlier in this request'); }
    path.add(key);
    const set = evalUsers(ctx, frame, rel.rewrite, object, relation, path, depth);
    path.delete(key);
    ctx.memo.set(key, set);
    return finish(set);
  }

  function evalUsers(ctx, frame, node, object, relation, path, depth) {
    const T = ctx.trace;
    const f = ctx.filter;
    const modelNode = relNode(object.type, relation);
    switch (node.kind) {
      case 'this': {
        const tuples = ctx.store.read(object.raw, relation);
        T.reads++;
        T.emit('read', frame, `Direct ${describeRewrite(node)} → read tuples where object = ${object.raw}, relation = ${relation}: ${tuples.length || 'none'}`, { status: 'read', hl: { modelNodes: { [modelNode]: 'active' }, dataEdges: Object.fromEntries(tuples.map((t) => [`t${t.id}`, 'read'])), tupleIds: tuples.map((t) => t.id) } });
        let set = emptySet();
        for (const t of tuples) {
          const tu = t.user;
          if (tu.wildcard) {
            if (tu.type === f.type && !f.relation) { if (!condStep(ctx, frame, t).ok) continue; set.wildcard = true; T.emit('match', frame, `${arrowTuple(t)} → every ${tu.type} (wildcard)`, { status: 'ok', hl: { dataEdges: { [`t${t.id}`]: 'ok' }, tupleIds: [t.id] } }); }
            else T.emit('skip', frame, `${arrowTuple(t)} — wildcard of type ${tu.type}, filter is ${f.type}`, { status: 'skip', minor: true });
          } else if (tu.relation) {
            if (f.relation && tu.type === f.type && tu.relation === f.relation) { if (!condStep(ctx, frame, t).ok) continue; set.users.add(tu.raw); T.emit('match', frame, `${arrowTuple(t)} → userset ${tu.raw} matches the filter`, { status: 'ok', hl: { dataEdges: { [`t${t.id}`]: 'ok' }, tupleIds: [t.id] } }); }
            else {
              T.emit('note', frame, `${arrowTuple(t)} → userset ${tu.raw}: expand its members`, { status: 'info', hl: { dataEdges: { [`t${t.id}`]: 'active' }, tupleIds: [t.id] } });
              if (!condStep(ctx, frame, t).ok) continue;
              set = setUnion(set, expandUsers(ctx, frame, objectOfUser(tu), tu.relation, path, depth + 1));
            }
          } else if (tu.type === f.type && !f.relation) {
            if (!condStep(ctx, frame, t).ok) continue;
            set.users.add(tu.raw);
            T.emit('match', frame, `${arrowTuple(t)} → ${tu.raw}`, { status: 'ok', hl: { dataEdges: { [`t${t.id}`]: 'ok' }, dataNodes: { [tu.raw]: 'ok' }, tupleIds: [t.id] } });
          } else T.emit('skip', frame, `${arrowTuple(t)} — ${tu.raw} is a ${tu.type}, filter is ${f.type}${f.relation ? '#' + f.relation : ''}`, { status: 'skip', minor: true });
        }
        return normalize(set);
      }
      case 'computed': {
        const from = relNode(object.type, node.relation);
        T.emit('rewrite', frame, `${relation} includes computed userset ${node.relation} → expand ${object.raw}#${node.relation}`, { hl: { modelNodes: { [modelNode]: 'active', [from]: 'active' }, modelEdges: { [edgeGid(from, modelNode, 'computed')]: 'active' } } });
        return expandUsers(ctx, frame, object, node.relation, path, depth + 1);
      }
      case 'ttu': {
        const tuples = ctx.store.read(object.raw, node.tupleset);
        T.reads++;
        T.emit('read', frame, `"${node.computed} from ${node.tupleset}" → read ${object.raw}'s ${node.tupleset} tuples: ${tuples.length ? tuples.map((t) => t.user.raw).join(', ') : 'none'}`, { status: 'read', hl: { modelNodes: { [modelNode]: 'active' }, dataEdges: Object.fromEntries(tuples.map((t) => [`t${t.id}`, 'read'])), tupleIds: tuples.map((t) => t.id) } });
        let set = emptySet();
        for (const t of tuples) {
          if (t.user.relation || t.user.wildcard) continue;
          if (!condStep(ctx, frame, t).ok) continue;
          set = setUnion(set, expandUsers(ctx, frame, objectOfUser(t.user), node.computed, path, depth + 1));
        }
        return set;
      }
      case 'union': {
        T.emit('rewrite', frame, `${relation} = ${describeRewrite(node)} → union of all branches`, { hl: { modelNodes: { [modelNode]: 'active' } } });
        let set = emptySet();
        node.children.forEach((c, i) => {
          T.emit('branch', frame, `Branch ${i + 1} of ${node.children.length}: ${describeRewrite(c)}`, { status: 'info' });
          set = setUnion(set, evalUsers(ctx, frame, c, object, relation, path, depth));
        });
        return set;
      }
      case 'intersection': {
        T.emit('rewrite', frame, `${relation} = ${describeRewrite(node)} → intersection of all branches`, { hl: { modelNodes: { [modelNode]: 'active' } } });
        let set = null;
        node.children.forEach((c, i) => {
          T.emit('branch', frame, `Branch ${i + 1} of ${node.children.length}: ${describeRewrite(c)}`, { status: 'info' });
          const s = evalUsers(ctx, frame, c, object, relation, path, depth);
          set = set === null ? s : setIntersect(set, s);
          T.emit('note', frame, `Intersection so far: ${fmtSet(set, f.type)}`, { status: 'info', minor: true });
        });
        return set || emptySet();
      }
      case 'difference': {
        T.emit('rewrite', frame, `${relation} = ${describeRewrite(node)} → base minus excluded`, { hl: { modelNodes: { [modelNode]: 'active' } } });
        T.emit('branch', frame, `Base: ${describeRewrite(node.base)}`, { status: 'info' });
        const b = evalUsers(ctx, frame, node.base, object, relation, path, depth);
        T.emit('branch', frame, `Excluded: ${describeRewrite(node.subtract)}`, { status: 'info' });
        const s = evalUsers(ctx, frame, node.subtract, object, relation, path, depth);
        const r = setDifference(b, s);
        T.emit('note', frame, `${fmtSet(b, f.type)} minus ${fmtSet(s, f.type)} = ${fmtSet(r, f.type)}`, { status: 'info' });
        return r;
      }
      default: return emptySet();
    }
  }

  // ───────────────────────── EXPAND (one level) ─────────────────────────
  function expand(model, store, q) {
    let object;
    try {
      object = parseObjectRef(q.object);
      if (!model.typeMap.has(object.type)) throw new Error(`type "${object.type}" is not in the model`);
      if (!model.typeMap.get(object.type).relMap.has(q.relation)) throw new Error(`"${q.relation}" is not a relation of ${object.type}`);
    } catch (e) { return { error: e.message, tree: null }; }
    const rel = model.typeMap.get(object.type).relMap.get(q.relation);
    const name = `${object.raw}#${q.relation}`;
    const reads = [];
    const build = (n) => {
      switch (n.kind) {
        case 'this': {
          const tuples = store.read(object.raw, q.relation);
          reads.push(...tuples.map((t) => t.id));
          return { kind: 'leaf', name, users: tuples.map((t) => ({ user: t.user.raw, userset: !!t.user.relation, wildcard: !!t.user.wildcard, condition: t.condition ? t.condition.name : null, tupleId: t.id })) };
        }
        case 'computed': return { kind: 'computed', name, userset: `${object.raw}#${n.relation}` };
        case 'ttu': {
          const tuples = store.read(object.raw, n.tupleset);
          reads.push(...tuples.map((t) => t.id));
          return { kind: 'ttu', name, tupleset: `${object.raw}#${n.tupleset}`, computed: tuples.filter((t) => !t.user.relation && !t.user.wildcard).map((t) => ({ userset: `${t.user.raw}#${n.computed}`, tupleId: t.id })) };
        }
        case 'union': return { kind: 'union', name, nodes: n.children.map(build) };
        case 'intersection': return { kind: 'intersection', name, nodes: n.children.map(build) };
        case 'difference': return { kind: 'difference', name, base: build(n.base), subtract: build(n.subtract) };
        default: return { kind: 'leaf', name, users: [] };
      }
    };
    const tree = build(rel.rewrite);
    return { tree, name, reads: uniq(reads), definition: `define ${q.relation}: ${describeRewrite(rel.rewrite)}`, error: null };
  }
  function expandTreeToJSON(tree) {
    const conv = (n) => {
      switch (n.kind) {
        case 'leaf': return { name: n.name, leaf: { users: { users: n.users.map((u) => u.user) } } };
        case 'computed': return { name: n.name, leaf: { computed: { userset: n.userset } } };
        case 'ttu': return { name: n.name, leaf: { tupleToUserset: { tupleset: n.tupleset, computed: n.computed.map((c) => ({ userset: c.userset })) } } };
        case 'union': return { name: n.name, union: { nodes: n.nodes.map(conv) } };
        case 'intersection': return { name: n.name, intersection: { nodes: n.nodes.map(conv) } };
        case 'difference': return { name: n.name, difference: { base: conv(n.base), subtract: conv(n.subtract) } };
        default: return {};
      }
    };
    return { tree: { root: conv(tree) } };
  }

  // Turn a proof tree into one or more tuple chains: [{ segments: [{from, relation, via, to, tupleId, wildcard}], derived: [...] }]
  function proofChains(proof) {
    if (!proof) return [];
    const seg = (t, via) => ({ from: t.user.wildcard ? t.user.raw : `${t.user.type}:${t.user.id}`, relation: t.relation, via: via || null, to: t.object.raw, tupleId: t.id, wildcard: !!t.user.wildcard, condition: t.condition ? t.condition.name : null });
    const build = (p) => {
      switch (p.kind) {
        case 'direct': return [{ segments: [seg(p.tuple)], derived: [] }];
        case 'wildcard': return [{ segments: [seg(p.tuple)], derived: [] }];
        case 'userset': return build(p.child).map((c) => ({ segments: c.segments.concat([seg(p.tuple, `#${p.tuple.user.relation}`)]), derived: c.derived }));
        case 'computed': return build(p.child).map((c) => ({ segments: c.segments, derived: c.derived.concat([{ object: p.object, from: p.implied, to: p.relation }]) }));
        case 'ttu': return build(p.child).map((c) => ({ segments: c.segments.concat([seg(p.tuple)]), derived: c.derived.concat([{ object: p.object, from: `${p.computed} of ${p.tuple.user.raw}`, to: p.relation, viaTupleset: p.tupleset }]) }));
        case 'all': return p.parts.flatMap((x) => build(x).map((c) => Object.assign(c, { conjunct: true })));
        default: return [];
      }
    };
    const chains = build(proof);
    if (proof.notExcluded) chains.forEach((c) => { c.notExcluded = proof.notExcluded; });
    return chains;
  }
  function chainText(chain) {
    const parts = [];
    chain.segments.forEach((sg, i) => {
      if (i === 0) parts.push(sg.from);
      parts.push(`─${sg.relation}${sg.via ? ' (' + sg.via + ')' : ''}${sg.condition ? ' ⚡' + sg.condition : ''}→`);
      parts.push(sg.to);
    });
    let text = parts.join(' ');
    const d = chain.conjunct ? [] : chain.derived.filter((x) => !x.viaTupleset).map((x) => `${x.from} ⇒ ${x.to}`);
    if (d.length) text += `  (${d.join(', ')})`;
    if (chain.notExcluded) text += `  and not ${chain.notExcluded}`;
    return text;
  }

  // Aggregate highlight for the finished query (every tuple read / matched, every resolved frame).
  function summaryHighlight(trace) {
    const hl = { modelNodes: {}, modelEdges: {}, dataNodes: {}, dataEdges: {}, rewrites: {}, tupleIds: [] };
    const rank = { skip: 0, read: 1, active: 1, fail: 2, ok: 3 };
    const put = (map, k, v) => { if (!map[k] || rank[v] > rank[map[k]]) map[k] = v; };
    for (const ev of trace.events) {
      const h = ev.hl || {};
      for (const [k, v] of Object.entries(h.dataEdges || {})) put(hl.dataEdges, k, v === 'active' ? 'read' : v);
      for (const [k, v] of Object.entries(h.modelEdges || {})) put(hl.modelEdges, k, v === 'active' ? 'read' : v);
      for (const [k, v] of Object.entries(h.rewrites || {})) put(hl.rewrites, k, v === 'active' ? 'read' : v);
      if (h.tupleIds) hl.tupleIds.push(...h.tupleIds);
    }
    for (const f of trace.frames) {
      if (!f.modelNode) continue;
      const ok = f.kind === 'users' ? (f.result && (f.result.users.size || f.result.wildcard)) : f.kind === 'listobjects' ? (f.result && f.result.length) : f.result === true;
      const st = ok ? 'ok' : (f.result === null ? 'read' : 'fail');
      put(hl.modelNodes, f.modelNode, st);
      if (f.object && !f.object.endsWith(':?')) put(hl.dataNodes, f.object, st);
    }
    hl.tupleIds = uniq(hl.tupleIds);
    return hl;
  }

  return {
    parseDSL, parseRewrite, describeRewrite, describeEntry, walkRewrite,
    modelToJSON, ulid, modelEdges, buildModelGraph, buildDataGraph,
    parseUserRef, parseObjectRef, parseTupleLine, parseTuples, validateTuple, tupleKey, formatTuple, arrowTuple,
    buildStore, check, listObjects, listUsers, expand, expandTreeToJSON, summaryHighlight, proofChains, chainText,
    evaluateCondition, CEL,
  };
});
