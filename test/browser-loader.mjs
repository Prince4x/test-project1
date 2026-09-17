/**
 * Node loader hook used by the UI test: it teaches Node the same URL layout the
 * browser sees, so `/engine/table.js` and `/js/app.js` resolve to the real
 * files. Test-only — nothing in the app depends on it.
 */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = [
  ['/engine/', path.join(root, 'src', 'engine')],
  ['/shared/', path.join(root, 'src')],
  ['/js/', path.join(root, 'public', 'js')],
  ['/styles.css', path.join(root, 'public', 'styles.css')]
];

export async function resolve(specifier, context, nextResolve) {
  for (const [prefix, directory] of ROOTS) {
    if (specifier === prefix) return { url: pathToFileURL(directory).href, shortCircuit: true };
    if (specifier.startsWith(prefix)) {
      const rest = specifier.slice(prefix.length).split('?')[0];
      return { url: pathToFileURL(path.join(directory, rest)).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
