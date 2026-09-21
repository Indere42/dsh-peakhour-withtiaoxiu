// Wrap the hand-written ESM half (`lib/client.source.js`) into the browser
// bundle format DSH's combo route requires (`lib/client.js`).
//
// Why a build step exists at all
// ------------------------------
// DSH serves every client 半区 through one combo script and expects each
// module to register itself by calling `window.__ModuleLoader__.load({ id,
// factory })` at top level, where `factory(require)` returns that module's
// exports (see the official `@deepseek-ai/dsh-client-modules` and the shipped
// bundles of `dshmarket` / `@linxin666/dsh-web-all` for the shape).
//
// A bare ESM file cannot be concatenated into that combo: the `export`
// statements are syntax errors in the combo's script context, and a single
// failing module takes the whole combo (and therefore the whole UI) down with
// it. So the source stays as readable ESM and this script rewrites it.
//
// The rewrite is deliberately narrow — it understands exactly the forms this
// package's client half uses and fails loudly on anything else, because a
// silently half-transformed bundle is exactly the failure this script exists
// to prevent.
//
// Usage: edit `lib/client.source.js`, then run `npm run build`.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const srcPath = path.join(root, 'lib', 'client.source.js');
const outPath = path.join(root, 'lib', 'client.js');

/** The id the combo route addresses this module by (must equal the package name). */
const ID = 'dsh-peakhour-withtiaoxiu';

/** Names exported through the factory's `exports` object. */
const EXPORTED = [
  'name',
  'inject',
  'apply',
  'formatCountdown',
  'formatBeijingClock',
  'formatBeijingMoment',
  'rowSummary',
  'renderModal',
  'sidebarCollapsed',
];

/**
 * Rewrite the ESM module body into a CommonJS factory body.
 * @param {string} body ESM source.
 * @returns {string} CommonJS source.
 */
function toCommonJs(body) {
  let out = body;

  // Named imports of the module system's own table are not available inside the
  // factory; this package deliberately imports nothing, so reject imports
  // loudly rather than emitting a broken bundle.
  if (/^\s*import\s/m.test(out)) {
    throw new Error(
      'lib/client.source.js uses `import`, which the DSH combo factory cannot resolve.\n'
      + 'Keep the client half dependency-free (no imports) or add an explicit factory shim here.',
    );
  }

  // `export async function f()` / `export function f()` -> `async function f()` / `function f()`
  out = out.replace(/^export\s+(async\s+function|function)\s+/gm, '$1 ');
  // `export const X` / `export let X` -> `const X` / `let X`
  out = out.replace(/^export\s+(const|let|var)\s+/gm, '$1 ');
  // `export { a, b }` (own-line re-export form) -> removed; EXPORTED publishes them.
  out = out.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');

  if (/^\s*export\s/m.test(out)) {
    throw new Error(
      'lib/client.source.js still contains an `export` form this wrapper does not understand.\n'
      + 'Add the form to toCommonJs() rather than shipping a bundle with ESM syntax in it.',
    );
  }
  return out;
}

const source = fs.readFileSync(srcPath, 'utf8');
const body = toCommonJs(source);

// Every exported name must exist, or the bundle publishes `undefined` silently.
for (const name of EXPORTED) {
  const declared = new RegExp(`^(?:async\\s+)?function\\s+${name}\\b|^(?:const|let|var)\\s+${name}\\b`, 'm');
  if (!declared.test(body)) {
    throw new Error(`lib/client.source.js does not declare the exported name "${name}"`);
  }
}

const exportsBlock = EXPORTED.map((name) => `\t\texports.${name} = ${name};`).join('\n');

const out = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {
\tvar module = { exports: {} };
\tvar exports = module.exports;
${body}
${exportsBlock}
\treturn module.exports;
} });
`;

fs.writeFileSync(outPath, out, 'utf8');
console.log(`wrapped lib/client.source.js -> lib/client.js (${out.length} bytes, id ${ID})`);
