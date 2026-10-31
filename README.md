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
- **Three graph views** – schema (one card per type), resolver (every relation as a node) and
  data (every tuple as an edge); focus mode, multi-select with paths between nodes, layouts
  (dagre, lanes, force, radial), find, minimap, drag/pin, collapse, SVG/PNG export.
- **Query lab** – Check / ListObjects / ListUsers / Expand with a one-line proof for ALLOWED,
  a step-by-step resolution trace, contextual tuples and condition context.
- **Store inspector** – tuples (Read filter), models, types, model JSON, changes, and the
  equivalent HTTP API calls and `fga` CLI session, plus a `store.fga.yaml` test file.
- **Assertions** and nine example stores (Drive, GitHub, Slack, expenses, entitlements,
  conditions, custom roles, org/team roles, recursive groups).

## Layout

```
src/engine.js      pure engine: DSL parser, model JSON, tuples, store, resolvers, CEL, graphs
src/examples.js    example stores
src/app.js         application layer (editors, query lab, inspector, wiring)
src/app-graph.js   graph module (inlined into app.js at build time)
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
