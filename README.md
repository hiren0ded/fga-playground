# OpenFGA Visual Playground

Write an [OpenFGA](https://openfga.dev) authorization model, add relationship tuples, and watch
**Check**, **ListObjects**, **ListUsers** and **Expand** resolve step by step on a live graph.

Live: https://fga.memoised.dev

Everything runs in the browser. There is no backend: the resolver is a small JavaScript
re-implementation of OpenFGA's algorithms (union short-circuit, intersection, exclusion,
tuple-to-userset, usersets, wildcards, conditions with a CEL subset, cycle detection, depth limit,
reverse expansion with candidate verification for ListObjects, forward expansion with
wildcard/exclusion set algebra for ListUsers).

## What is in the box

- **Stores and model versions** – create stores, write immutable authorization-model versions,
  diff a draft against a written version, see the tuple change log and replay it.
- **Model DSL editor** (schema 1.1) with diagnostics, formatting and model-to-graph sync.
- **Four views of the same store**
  - *Schema* – one card per type with its relations, cross-type links as edges.
  - *Resolution* – one relation drawn as the tree Check walks: any-of / all-of / but-not,
    directly assigned subjects, computed relations and "X from Y" branches. It follows the
    query's relation (or any relation you pin) and the trace lights up the branch being tried,
    short-circuited, satisfied or rejected.
  - *Data* – tuples as edges. Objects the query walked open as **cards with one slot per
    relation** (`doc:roadmap#viewer` is a real node), tuples point at the slot they grant,
    computed relations are arcs between rows, "viewer from parent" is a derived edge between
    cards, and a **derived** toggle materialises every grant no tuple states, with the proof on
    hover. Cards can be opened for every object or none.
  - *Matrix* – subjects × objects for one relation: direct tuple, derived, public wildcard or
    excluded, with a diff against any written model version (gained / lost). Click a cell to
    run that Check.
  - Everywhere: focus mode, multi-select with paths between nodes, layouts (dagre, lanes, force,
    radial), find, minimap, drag/pin, SVG/PNG export.
- **Query lab** – Check / ListObjects / ListUsers / Expand with a one-line proof for ALLOWED,
  a step-by-step resolution trace, contextual tuples and condition context.
- **Store inspector** – tuples (Read filter), models, types, model JSON, changes, and the
  equivalent HTTP API calls and `fga` CLI session, plus a `store.fga.yaml` test file.
- **Assertions** and nine example stores (Drive, GitHub, Slack, expenses, entitlements,
  conditions, custom roles, org/team roles, recursive groups).
- **Share links with no backend** – *Share* copies a link such as
  `https://fga.memoised.dev/#s=1.pZVNb9sw…` that carries the whole store (model, tuples,
  assertions, suggested queries, the current query and graph view) deflate-compressed in the URL
  fragment. Fragments are never sent to a server; the recipient's browser rebuilds the store
  locally and keeps it like any other. A typical store is a 1–3 KB link.

## Layout

```
src/engine.js      pure engine: DSL parser, model JSON, tuples, store, resolvers, CEL, graphs
src/examples.js    example stores
src/app.js         application layer (editors, query lab, inspector, wiring)
src/app-graph.js   graph module (inlined into app.js at build time)
src/app-share.js   share links: store ⇄ compressed URL fragment (inlined after the app)
src/page.html      markup
src/styles.css     styles
build.js           bundler: artifact page, local test page, and the hosted site
test/engine.test.js
```

## Develop

```sh
npm install
npm test               # engine tests (brute-force cross-checks of the resolvers)
npm run build          # hosted site -> dist/site (index.html + content-hashed assets)
npm run build:local    # also writes local-test.html with d3/dagre inlined (works offline)
```

Open `local-test.html` directly in a browser, or serve `dist/site` with any static server.

## Deploy

The site is static. `vercel.json` tells Vercel to run `node build.js --site` and serve
`dist/site`; every push to the default branch deploys. d3 and dagre are loaded from jsDelivr
with a cdnjs fallback.
