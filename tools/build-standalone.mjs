/**
 * Builds the single-file, double-clickable version of the game.
 *
 *   node tools/build-standalone.mjs [output.html]
 *
 * The whole app is ES modules, so this is a tiny bundler: it wraps every client
 * module in a definition function with a ~20 line module runtime, rewrites the
 * `import` statements to `__require()` calls, and inlines the stylesheet, the
 * markup and the bundle into one .html file. No network, no server, no build
 * tooling — open it and play.
 *
 * Default output is PLAY-ME-first.html in the project root, so a GitHub/ZIP
 * download can be played by double-clicking a single file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(root, 'PLAY-ME-first.html');

/** Module id → file. Ids mirror the URLs the browser uses. */
const MODULES = [
  'src/engine/cards.js',
  'src/engine/evaluator.js',
  'src/engine/table.js',
  'src/engine/ai.js',
  'public/js/store.js',
  'public/js/sound.js',
  'public/js/ui.js',
  'public/js/net.js',
  'public/js/practice.js',
  'public/js/game-view.js',
  'public/js/app.js'          // entry point, required last
];

const ENTRY = 'public/js/app.js';

/** Canonical module id for a specifier, from the point of view of `fromFile`. */
function resolveId(specifier, fromFile) {
  if (specifier.startsWith('/engine/')) return `src/engine/${specifier.slice('/engine/'.length)}`;
  if (specifier.startsWith('/js/')) return `public/js/${specifier.slice('/js/'.length)}`;
  if (specifier.startsWith('/shared/')) return `src/${specifier.slice('/shared/'.length)}`;
  if (specifier.startsWith('.')) return path.normalize(path.join(path.dirname(fromFile), specifier));
  throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
}

/**
 * Rewrite one ES module into a CommonJS-ish factory body.
 * Handles the exact syntax this project uses: named imports (single or multi
 * line), `export const/let/var/function/class`, `export default X | {...}` and
 * `export { a, b }`.
 */
function transform(source, file) {
  const named = [];
  let defaultName = null;
  let body = source;

  // import { a, b } from 'x';   (may span lines)
  body = body.replace(/^import\s+\{([^}]*)\}\s+from\s+'([^']+)';?[ \t]*$/gm, (match, names, specifier) => {
    const list = names.split(',').map((name) => name.trim()).filter(Boolean).join(', ');
    return `const { ${list} } = __require(${JSON.stringify(resolveId(specifier, file))});`;
  });

  // export default Name;   |   export default { ... };
  body = body.replace(/^export default ([A-Za-z_$][\w$]*);[ \t]*$/gm, (match, name) => {
    defaultName = name;
    return '';
  });
  body = body.replace(/^export default (\{[\s\S]*?\});[ \t]*$/gm, (match, literal) => `__exports.default = ${literal};`);

  // export { a, b };
  body = body.replace(/^export \{([^}]*)\};[ \t]*$/gm, (match, names) => names
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const [local, exported = local] = name.split(/\s+as\s+/);
      return `__exports.${exported.trim()} = ${local.trim()};`;
    })
    .join('\n'));

  // export const / let / var / function / async function / class Name
  body = body.replace(/^export\s+(const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm, (match, kind, name) => {
    named.push(name);
    return `${kind} ${name}`;
  });

  const epilogue = named.map((name) => `__exports.${name} = ${name};`);
  if (defaultName) epilogue.push(`__exports.default = ${defaultName};`);

  const compiled = `${body}\n${epilogue.join('\n')}`;
  // A literal </script> inside the bundle would close the inline script tag.
  if (compiled.includes('</script')) throw new Error(`${file} contains a literal </script>`);
  return compiled;
}

export function build({ entry = ENTRY, modules = MODULES, out = DEFAULT_OUT } = {}) {
  const order = [...modules.filter((file) => file !== entry), entry];

  const definitions = order.map((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    return `__define(${JSON.stringify(file)}, function (__exports, __require) {\n${transform(source, file)}\n});`;
  });

  const runtime = `(function () {
  'use strict';
  var __modules = {};
  var __cache = {};
  function __define(id, factory) { __modules[id] = factory; }
  function __require(id) {
    if (__cache[id]) return __cache[id].exports;
    var module = { exports: {} };
    __cache[id] = module;
    if (!__modules[id]) throw new Error('Missing module: ' + id);
    __modules[id](module.exports, __require);
    return module.exports;
  }
${definitions.join('\n')}
  __require(${JSON.stringify(entry)});
})();`;

  const pageHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

  const banner = `<!--
  Teen Patti Arena — single-file offline build.
  Generated by tools/build-standalone.mjs — do not edit by hand.
  Practice vs AI runs entirely inside this file: no server, no internet, no install.
-->`;

  const standaloneFlag = '<script>window.__TEEN_PATTI_STANDALONE__ = true;</script>';

  // NOTE: replacement *functions* are mandatory below — in a replacement string
  // `$$` collapses to `$` and `$&` expands the match, which would silently
  // corrupt the bundled source (this app has a `$$` helper).
  let html = pageHtml
    .replace('<link rel="stylesheet" href="/styles.css" />', () => `<style>\n${css}\n</style>`)
    .replace('<script type="module" src="/js/app.js"></script>', () => `${standaloneFlag}\n<script>\n${runtime}\n</script>`)
    .replace('<title>Teen Patti Arena · Indian Poker</title>', () => '<title>Teen Patti Arena · Offline</title>');

  if (!html.includes('<style>')) throw new Error('stylesheet was not inlined — did index.html change?');
  if (!html.includes('__TEEN_PATTI_STANDALONE__')) throw new Error('bundle was not inlined — did index.html change?');
  // Regression guard: the bundler must never mangle dollar signs in the source.
  for (const marker of ['const $$ =', '__exports.$$ = $$;']) {
    if (!html.includes(marker)) throw new Error(`bundling corrupted the source (missing "${marker}")`);
  }
  html = `${banner}\n${html}`;

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return { path: out, html, bytes: Buffer.byteLength(html), modules: order.length };
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT;
  const result = build({ out: target });
  const kb = (result.bytes / 1024).toFixed(0);
  console.log(`✅ Single-file build → ${result.path} (${result.modules} modules, ${kb} KB)`);
  console.log('   Open it in any browser and press “Practice vs AI”. No server needed.');
}
