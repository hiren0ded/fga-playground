// Node test harness: parse every example, run its assertions, and cross-check
// ListObjects / ListUsers against brute-force Check over every object/user seen in the store.
const assert = require('assert');
const FGA = require('../src/engine.js');
const EXAMPLES = require('../src/examples.js');

let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log('  ✗', msg); } };

for (const ex of EXAMPLES) {
  console.log(`\n[${ex.id}] ${ex.name}`);
  const { model, errors, warnings } = FGA.parseDSL(ex.dsl);
  ok(errors.length === 0, `model errors: ${JSON.stringify(errors)}`);
  if (warnings.length) console.log('  warnings:', warnings.map((w) => `L${w.line} ${w.message}`).join(' | '));
  const tp = FGA.parseTuples(ex.tuples, model);
  ok(tp.errors.length === 0, `tuple errors: ${JSON.stringify(tp.errors)}`);
  ok(tp.rejected.length === 0, `rejected tuples: ${JSON.stringify(tp.rejected.map((r) => r.message))}`);
  const store = FGA.buildStore(tp.tuples);

  // assertions
  for (const a of ex.assertions || []) {
    const r = FGA.check(model, store, { user: a.user, relation: a.relation, object: a.object, context: a.context });
    ok(!r.error, `check error ${a.user} ${a.relation} ${a.object}: ${r.error}`);
    ok(r.allowed === a.expected, `assertion ${a.user} ${a.relation} ${a.object} expected ${a.expected} got ${r.allowed} (${r.root && r.root.reason})`);
  }

  // model JSON round trip sanity
  const json = FGA.modelToJSON(model);
  ok(json.type_definitions.length === model.types.length, 'json types');

  // brute-force cross checks
  const users = store.allUsers().filter((u) => !u.includes('#') && !u.endsWith(':*'));
  const ctxs = ex.id === 'conditions' ? [{ current_time: '2026-10-31T10:00:00Z', user_ip: '10.1.1.1' }, { current_time: '2026-11-01T10:00:00Z', user_ip: '8.8.8.8' }] : [{}];
  for (const context of ctxs) {
    for (const t of model.types) for (const r of t.relations) {
      const objects = store.objectsOfType(t.name);
      for (const u of users) {
        const lo = FGA.listObjects(model, store, { user: u, relation: r.name, type: t.name, context });
        ok(!lo.error, `listObjects error ${u} ${r.name} ${t.name}: ${lo.error}`);
        const brute = objects.filter((o) => FGA.check(model, store, { user: u, relation: r.name, object: o, context }).allowed).sort();
        ok(JSON.stringify(lo.objects) === JSON.stringify(brute), `listObjects(${u}, ${r.name}, ${t.name}) = ${JSON.stringify(lo.objects)} but brute force = ${JSON.stringify(brute)}`);
      }
      for (const o of objects) {
        for (const ut of model.types) {
          const lu = FGA.listUsers(model, store, { object: o, relation: r.name, userType: ut.name, context });
          ok(!lu.error, `listUsers error ${o} ${r.name} ${ut.name}: ${lu.error}`);
          const cand = store.usersOfType(ut.name).concat([`${ut.name}:__nobody__`]);
          for (const u of cand) {
            const c = FGA.check(model, store, { user: u, relation: r.name, object: o, context }).allowed;
            const inList = lu.users.includes(u) || (lu.wildcard && !lu.excluded.includes(u));
            ok(c === inList, `listUsers(${o}, ${r.name}, ${ut.name}) says ${inList} for ${u} but check says ${c} (users=${lu.users} wildcard=${lu.wildcard} excluded=${lu.excluded})`);
          }
        }
      }
    }
  }
}

// cycle: must terminate and deny
{
  const { model } = FGA.parseDSL(`model\n  schema 1.1\ntype user\ntype group\n  relations\n    define member: [user, group#member]`);
  const store = FGA.buildStore(FGA.parseTuples(`group:a#member member group:b\ngroup:b#member member group:a`, model).tuples);
  const r = FGA.check(model, store, { user: 'user:x', relation: 'member', object: 'group:a' });
  ok(r.allowed === false, 'cycle denies');
  ok(r.trace.frames.some((f) => f.cycle), 'cycle detected in trace');
}

// parser diagnostics
{
  const bad = FGA.parseDSL(`model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user] or editor\n    define parent: [folder]\n    define x: y from parent`);
  ok(bad.errors.length >= 3, `expected errors for undefined editor/folder/y: ${JSON.stringify(bad.errors)}`);
  const noEntry = FGA.parseDSL(`model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define a: b\n    define b: a`);
  ok(noEntry.errors.some((e) => /entrypoint/.test(e.message)), 'no entrypoint error');
  const mixed = FGA.parseDSL(`model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define a: [user]\n    define b: [user]\n    define c: a or b and a`);
  ok(mixed.warnings.some((w) => /parentheses/.test(w.message)), 'mixed operator warning');
  const paren = FGA.parseDSL(`model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define a: [user]\n    define b: [user]\n    define blocked: [user]\n    define c: (a or b) but not blocked`);
  ok(paren.errors.length === 0 && paren.warnings.length === 0, `parenthesised mixing is fine: ${JSON.stringify(paren.warnings)}`);
  ok(FGA.describeRewrite(paren.model.typeMap.get('doc').relMap.get('c').rewrite) === '(a or b) but not blocked', 'describeRewrite keeps parens');
}

// expand json
{
  const ex = EXAMPLES[0];
  const { model } = FGA.parseDSL(ex.dsl);
  const store = FGA.buildStore(FGA.parseTuples(ex.tuples, model).tuples);
  const e = FGA.expand(model, store, { object: 'doc:roadmap', relation: 'viewer' });
  const j = FGA.expandTreeToJSON(e.tree);
  ok(j.tree.root.union && j.tree.root.union.nodes.length === 3, 'expand tree has 3 union nodes');
  const ttu = j.tree.root.union.nodes[2].leaf.tupleToUserset;
  ok(ttu.computed[0].userset === 'folder:product#viewer', 'expand ttu computed userset');
}

// CEL
{
  const c = FGA.CEL.compile('current_time < grant_time + grant_duration && size(tags) > 0 && "x" in tags && ip.in_cidr(cidr)');
  const v = c.eval({ current_time: { __t: 'timestamp', ms: 10 }, grant_time: { __t: 'timestamp', ms: 5 }, grant_duration: { __t: 'duration', ms: 10 }, tags: ['x'], ip: '10.2.3.4', cidr: '10.0.0.0/8' });
  ok(v === true, 'CEL evaluates');
  let threw = false;
  try { c.eval({}); } catch (e) { threw = !!e.missing; }
  ok(threw, 'CEL missing param');
}

// contextual tuples merge
{
  const ex = EXAMPLES[0];
  const { model } = FGA.parseDSL(ex.dsl);
  const base = FGA.parseTuples(ex.tuples, model).tuples;
  const ctxT = FGA.parseTuples('user:zoe viewer doc:roadmap', model, { contextual: true }).tuples;
  const store = FGA.buildStore(base.concat(ctxT));
  ok(FGA.check(model, store, { user: 'user:zoe', relation: 'viewer', object: 'doc:roadmap' }).allowed, 'contextual tuple applies');
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
