/**
 * Finds `this.someMethod(...)` call sites whose method is not defined on any
 * class in the same file — the signature of a half-applied edit (the helper was
 * never added, so the call throws at runtime and takes the whole screen down).
 *
 * Heuristic, not a compiler: it reports candidates for a human to check.
 * Usage: node tools/audit-this-calls.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'js');

// Methods that legitimately come from somewhere else (inherited, aliased, or
// provided by the platform).
const ALLOWED = new Set([
  'toString', 'valueOf', 'hasOwnProperty', 'bind', 'call', 'apply', 'then', 'catch', 'finally'
]);

let problems = 0;
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
  const file = path.join(dir, name);
  const source = fs.readFileSync(file, 'utf8');

  const defined = new Set();
  for (const match of source.matchAll(/^\s{2}(?:static\s+|async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    defined.add(match[1]);
  }
  // Arrow-function properties on the class: `name: () => {}` / `name() {}` handled above.
  for (const match of source.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/gm)) {
    defined.add(match[1]);
  }

  // Properties assigned in a constructor (`this.onState = onState || (() => {})`)
  // count as defined: they are callbacks handed in from outside.
  const assigned = new Set();
  for (const match of source.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) assigned.add(match[1]);

  const called = new Set();
  for (const match of source.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) called.add(match[1]);

  const missing = [...called].filter((m) => !defined.has(m) && !assigned.has(m) && !ALLOWED.has(m)).sort();
  if (missing.length) {
    problems += missing.length;
    console.log(`\n${path.relative(root, file)}`);
    for (const m of missing) console.log(`  this.${m}(...) is called but not defined in this file`);
  }
}

console.log(problems ? `\n${problems} suspicious call site(s) to check.` : '\nNo undefined this.* call sites found.');
