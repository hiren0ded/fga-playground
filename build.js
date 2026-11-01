// Inline engine, examples, app and styles into one self-contained artifact page.
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
let html = src('page.html');
html = html.replace('/*__STYLES__*/', () => src('styles.css'));
html = html.replace('/*__ENGINE__*/', () => safe(src('engine.js')));
html = html.replace('/*__EXAMPLES__*/', () => safe(src('examples.js')));
html = html.replace('/*__APP__*/', () => safe(src('app.js').replace('/*__GRAPH__*/', () => src('app-graph.js')).replace('/*__SHARE__*/', () => src('app-share.js'))));
fs.writeFileSync(path.join(__dirname, 'openfga-playground.html'), html);
console.log('built openfga-playground.html', (html.length / 1024).toFixed(1), 'KB');

// local test build: inline the libraries so the page can be checked without network access
if (process.argv.includes('--local')) {
  const d3 = fs.readFileSync(path.join(__dirname, 'node_modules/d3/dist/d3.min.js'), 'utf8');
  const dagre = fs.readFileSync(path.join(__dirname, 'node_modules/dagre/dist/dagre.min.js'), 'utf8');
  let local = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/d3@[^"]+"><\/script>/, () => `<script>${safe(d3)}</script>`)
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/dagre@[^"]+"><\/script>/, () => `<script>${safe(dagre)}</script>`);
  fs.writeFileSync(path.join(__dirname, 'local-test.html'), local);
  console.log('built local-test.html', (local.length / 1024).toFixed(1), 'KB');
}

// standalone site (for hosting outside the artifact viewer): full document skeleton + head/body split
{
  const head = html.slice(0, html.indexOf('<div class="app"'));
  const body = html.slice(html.indexOf('<div class="app"'));
  const favicon = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0d1017"/><circle cx="8" cy="16" r="3.2" fill="#8ea2ff"/><circle cx="24" cy="8" r="3.2" fill="#38c7b5"/><circle cx="24" cy="24" r="3.2" fill="#38c7b5"/><circle cx="16" cy="16" r="2.4" fill="#8ea2ff"/><path d="M10.8 14.8 L13.8 15.4 M18.2 15.2 L21.4 9.6 M18.2 16.8 L21.4 22.4" stroke="#8ea2ff" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>');
  const site = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Write an OpenFGA authorization model, add relationship tuples, and watch Check, ListObjects, ListUsers and Expand resolve step by step on a live graph.">
<meta property="og:title" content="OpenFGA Visual Playground">
<meta property="og:description" content="Model, tuples, and a step-by-step resolver on a live authorization graph.">
<meta property="og:type" content="website">
<link rel="icon" href="data:image/svg+xml,${favicon}">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}</style>
${head.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')}</head>
<body>
${body}</body>
</html>
`;
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), site);
  console.log('built dist/index.html', (site.length / 1024).toFixed(1), 'KB');

  // split + minified variant for hosting (dist/site): index.html + content-hashed assets
  if (process.argv.includes('--site')) {
    const crypto = require('crypto');
    const { minify } = require('terser');
    const csso = require('csso');
    const out = path.join(__dirname, 'dist', 'site');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
    const h8 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
    const page = src('page.html');
    (async () => {
      const js = async (code) => (await minify(code, { compress: { passes: 2 }, mangle: true, format: { comments: false, ascii_only: false, max_line_len: 400 } })).code + '\n';
      // The app IIFE is split into top-level classic scripts (shared global lexical scope) so each
      // hosted file stays small; chunk boundaries are top-level statement boundaries of the IIFE body.
      const app = src('app.js');
      const open = "(function () {\n  'use strict';\n", close = '})();\n';
      const openAt = app.indexOf(open);
      if (openAt < 0 || openAt > 200 || !app.trimEnd().endsWith('})();')) throw new Error('app.js wrapper changed; update build.js');
      const body = app.slice(openAt + open.length, app.lastIndexOf(close));
      const cut = (marker) => { const i = body.indexOf(marker); if (i < 0) throw new Error('marker missing: ' + marker); return i; };
      const marks = [0, cut('/*__GRAPH__*/'), cut('// ───────────────────────── assertions'), cut('// ───────────────────────── tabs, panes'), body.length];
      const chunks = [];
      for (let i = 0; i < marks.length - 1; i++) chunks.push(body.slice(marks[i], marks[i + 1]));
      const strict = (code) => "'use strict';\n" + code;
      // self-hosted fonts (no font CDN) — @fontsource latin subsets, content-hashed
      fs.mkdirSync(path.join(out, 'assets', 'fonts'), { recursive: true });
      const FONTS = [['Bricolage Grotesque', 'bricolage-grotesque', [500, 700]], ['IBM Plex Sans', 'ibm-plex-sans', [400, 500, 600]], ['JetBrains Mono', 'jetbrains-mono', [400, 500, 600]]];
      let fontsCss = '';
      for (const [family, pkg, weights] of FONTS) for (const w of weights) {
        const buf = fs.readFileSync(path.join(__dirname, 'node_modules/@fontsource', pkg, 'files', `${pkg}-latin-${w}-normal.woff2`));
        const name = `assets/fonts/${pkg}-${w}.${h8(buf)}.woff2`;
        fs.writeFileSync(path.join(out, name), buf);
        fontsCss += `@font-face{font-family:'${family}';font-style:normal;font-display:swap;font-weight:${w};src:url(/${name}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2191-21FF,U+2200-22FF,U+2300-23FF,U+25A0-25FF,U+2600-26FF,U+2700-27BF,U+FEFF,U+FFFD}\n`;
      }
      const cssOut = (code) => csso.minify(code).css.replace(/\}(?=[^\s}])/g, '}\n').replace(/[^\x00-\x7f]/gu, (c) => '\\' + c.codePointAt(0).toString(16) + ' ') + '\n';
      const files = {
        'd3.js': fs.readFileSync(path.join(__dirname, 'node_modules/d3/dist/d3.min.js'), 'utf8'),
        'dagre.js': fs.readFileSync(path.join(__dirname, 'node_modules/dagre/dist/dagre.min.js'), 'utf8'),
        'elk.js': fs.readFileSync(path.join(__dirname, 'node_modules/elkjs/lib/elk.bundled.js'), 'utf8'),
        'site.css': cssOut(fontsCss + src('site/site.css')),
        'engine.js': await js(src('engine.js')),
        'examples.js': await js(src('examples.js')),
        'app-1.js': await js(strict(chunks[0])),
        'app-graph.js': await js(strict(src('app-graph.js'))),
        'app-2.js': await js(strict(chunks[1].replace('/*__GRAPH__*/', ''))),
        'app-3.js': await js(strict(chunks[2])),
        'app-4.js': await js(strict(chunks[3].replace('/*__SHARE__*/', ''))),
        'app-5.js': await js(strict(src('app-share.js'))),
        'styles.css': cssOut(fontsCss + src('styles.css'))
      };
      const named = {};
      for (const [k, v] of Object.entries(files)) {
        const ext = path.extname(k), base = path.basename(k, ext);
        const name = `assets/${base}.${h8(v)}${ext}`;
        named[k] = name;
        fs.writeFileSync(path.join(out, name), v);
      }
      const appOrder = ['app-1.js', 'app-graph.js', 'app-2.js', 'app-3.js', 'app-4.js', 'app-5.js'].map((k) => '/' + named[k]);
      const bootScript = `<script>
(function () {
  var app = ${JSON.stringify(appOrder)};
  function fail(msg) { var el = document.getElementById('graph-empty'); if (el) { el.hidden = false; el.textContent = msg; } }
  function load(srcs, done, onerr) {
    var left = srcs.length; if (!left) return done();
    srcs.forEach(function (s) { var sc = document.createElement('script'); sc.src = s; sc.async = false; sc.onload = function () { if (!--left) done(); }; sc.onerror = function () { onerr(s); }; document.head.appendChild(sc); });
  }
  function start() { load(app, function () {}, function (s) { fail('Failed to load ' + s + '. Reload the page.'); }); }
  if (typeof d3 !== 'undefined' && typeof dagre !== 'undefined') return start();
  fail('The graph libraries (d3, dagre) could not be loaded. Check your network and reload the page.');
})();
</script>`;
      let doc = page
        .replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
        .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n?/, '')
        .replace('<title>OpenFGA Visual Playground</title>', '<title>Playground — FGA Explorer</title>')
        .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/d3@[^"]+"><\/script>/, () => `<script>window.__FGA_ASSETS = { elk: '/${named['elk.js']}' };</script>\n<script src="/${named['d3.js']}"></script>`)
        .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/dagre@[^"]+"><\/script>/, () => `<script src="/${named['dagre.js']}"></script>`)
        .replace(/<style>\n\/\*__STYLES__\*\/\n<\/style>/, `<link rel="stylesheet" href="/${named['styles.css']}">`)
        .replace(/<script>\n\/\*__ENGINE__\*\/\n<\/script>\n<script>\n\/\*__EXAMPLES__\*\/\n<\/script>\n<script>[\s\S]*<\/script>/,
          () => `<script src="/${named['engine.js']}"></script>\n<script src="/${named['examples.js']}"></script>\n${bootScript}`);
      const hd = doc.slice(0, doc.indexOf('<div class="app"'));
      const bd = doc.slice(doc.indexOf('<div class="app"'));
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="FGA Explorer playground (unofficial): write an OpenFGA-style authorization model, add relationship tuples, and watch Check, ListObjects, ListUsers and Expand resolve step by step.">
<meta property="og:title" content="FGA Explorer — Playground">
<meta property="og:description" content="An unofficial learning playground: model, tuples, and a step-by-step resolver on a live authorization graph.">
<meta property="og:type" content="website">
<link rel="icon" href="data:image/svg+xml,${favicon}">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}</style>
${hd}</head>
<body>
${bd}</body>
</html>
`;
      const ascii = (h) => h.replace(/[ \t]*<!--[\s\S]*?-->\n?/g, '').replace(/[^\x00-\x7f]/gu, (c) => '&#x' + c.codePointAt(0).toString(16) + ';');
      fs.writeFileSync(path.join(out, 'playground.html'), ascii(html));
      // static pages: home, learning, legal — shared nav/footer partials
      const nav = src('site/_nav.html'), footer = src('site/_footer.html');
      const pages = { 'index.html': 'index.html', 'learning.html': 'learning.html', 'legal.html': 'legal.html' };
      for (const [from, to] of Object.entries(pages)) {
        let p = src('site/' + from)
          .replace(/\{\{NAV:(\w+)\}\}/, (m, cur) => nav.replace(/\{\{CUR:(\w+)\}\}/g, (mm, k) => (k === cur ? ' aria-current="page"' : '')))
          .replace('{{FOOTER}}', footer)
          .replace(/\{\{SITE_CSS\}\}/g, '/' + named['site.css'])
          .replace(/\{\{FAVICON\}\}/g, 'data:image/svg+xml,' + favicon);
        fs.writeFileSync(path.join(out, to), ascii(p));
      }
      const manifest = {};
      for (const f of ['playground.html', ...Object.keys(pages), ...Object.values(named)]) {
        const buf = fs.readFileSync(path.join(out, f));
        manifest[f] = { sha: crypto.createHash('sha1').update(buf).digest('hex'), size: buf.length };
      }
      fs.writeFileSync(path.join(out, '..', 'site-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      for (const [f, m] of Object.entries(manifest)) console.log('site:', f, m.size, 'B', m.sha);
    })();
  }
}
