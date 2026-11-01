# FGA Explorer

An unofficial learning site for OpenFGA™-style authorization: a home page (`/`), a concepts guide (`/learning`), the interactive playground (`/playground`) and a disclaimer & privacy page (`/legal`). Not affiliated with or endorsed by the OpenFGA project, CNCF or The Linux Foundation; the resolver is an independent re-implementation for teaching. OpenFGA™ is a trademark of The Linux Foundation.

## The playground

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
    cards, and the **edges** menu adds every grant no tuple states (or shows only those), with the proof on
    hover. By default objects are small nodes; cards can be opened for the objects the query walks, for
    every object, or one at a time with ⊕ (a proof walk always opens the cards it passes through).
  - *Matrix* – subjects × objects for one relation: direct tuple, derived, public wildcard or
    excluded, with a diff against any written model version (gained / lost). Click a cell to
    run that Check and see its proof in place — as a matrix of usersets (the subject's row plus a
    row per parent link / userset grant it leans on, foldable to "users only") or as Check's
    recursion tree — or double-click to walk it on the data graph.
  - *Proof walk* – every allowed Check becomes numbered steps from the subject to the goal
    (`1 user:bob ─member→ group:eng · 2 group:eng#member ─viewer→ folder:product · 3 … · 4 viewer
    from parent ⇒ viewer`). The numbers sit on the exact edges, card arcs and derived edges the
    resolver followed; a bar lists them, hovering a step flashes it. Hover a derived edge to
    preview its walk, click to pin it; Esc clears.
  - Everywhere: focus mode, multi-select with paths between nodes, layouts (dagre, lanes, force,
    radial), find, minimap, drag/pin, SVG/PNG export.
- **Query lab** – Check / ListObjects / ListUsers / Expand with a numbered proof for ALLOWED
  and a **why not** for DENIED: the branch that got furthest with the step it stopped at, or the
  "but not" that took the access away, plus the tuples that would flip the answer (verified by
  re-running the check) with one-click *try* (as a contextual tuple) or *write*. The same numbered
  steps appear on the data graph, in the matrix and in tooltips. Step-by-step resolution trace,
  contextual tuples and condition context.
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

## Site routes

`node build.js --site` writes `dist/site/`: `index.html` (home), `learning.html`, `legal.html`,
`playground.html`, and content-hashed `assets/` (app chunks, d3, dagre, self-hosted fonts). Vercel
serves them at `/`, `/learning`, `/legal`, `/playground` (`cleanUrls`); `/home` and `/learn`
redirect. Old share links (`/#s=…`) forward to `/playground#s=…`. `/playground?example=<id>&view=<schema|model|data|matrix>`
opens an example store in a given view. No third-party requests: fonts and libraries are served
from the site itself. Static page sources live in `src/site/`.

## Graph layout

- **Data view:** ELK's layered algorithm (elkjs, loaded on first use) with card rows as fixed
  ports and orthogonal edge routing; dagre elsewhere and as the fallback. → / ↓ force dagre.
- **Stable layout:** small edits keep existing nodes (and their edge routes) where they were; new
  nodes are placed by the fresh layout, shifted into the old frame and nudged clear of overlaps.
  *Tidy layout* (⋯ menu) and *Reset* lay out afresh; Reset also puts dragged nodes back (with Undo).
  *Clear highlights, keep layout* (⋯ menu, or Esc) clears the walk and focus without moving anything.
- **Big stores** (over 60 nodes): the data view shows the query's neighbourhood (two hops, `+N`
  handles to expand) or, without a query, one node per type (`+` expands). *Data view shows* in the
  ⋯ menu and the pill at the bottom switch between auto / all / near / by type.
- **Grouped derived edges:** several derived relations from one subject to one plain node share an edge
  ("viewer +2 ▸"); click it for one edge per relation (Shift-click folds back), or ⋯ → *Derived edges*.
- **Bundling:** three or more subjects of one type whose only tuple points at the same slot become
  one "N users" node; `+` opens it.
- **Labels** are placed by priority (hovered, highlighted, then the rest), moved along their edge if
  they collide, and hidden until hover if there is no room.
