// Recover the bare ESM client source from the previously wrapped bundle.
//
// An earlier build left lib/client.source.js holding the WRAPPED form, so there
// is no bare ESM file on disk. This reconstructs it by line index (no fragile
// regexes), validates every exported name, and only then writes the source.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'lib', 'client.source.js');
const bakPath = path.join(root, 'lib', 'client.source.js.bak');

/** Names the wrapper publishes; each must be declared in the recovered body. */
const EXPORTED = [
  'name', 'inject', 'apply', 'formatCountdown', 'formatBeijingClock',
  'formatBeijingMoment', 'rowSummary', 'renderModal', 'sidebarCollapsed',
];

/**
 * Recover the ESM body from a wrapped bundle text.
 * @param {string} text Wrapped bundle.
 * @returns {string} Bare ESM source.
 */
function recover(text) {
  const lines = text.split(/\r?\n/);

  const factoryIdx = lines.findIndex((line) => /factory:\s*\(require\)\s*=>\s*\{\s*$/.test(line));
  if (factoryIdx < 0) throw new Error('no factory line');

  // Walk back from the end to find the wrapper close, then the exports block.
  let closeIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === '});') { closeIdx = i; break; }
  }
  if (closeIdx < 0) throw new Error('no wrapper close "});"');
  let returnIdx = -1;
  for (let i = closeIdx - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === 'return module.exports;') { returnIdx = i; break; }
  }
  if (returnIdx < 0) throw new Error('no "return module.exports;"');
  // The factory close brace sits between them.
  let exportsEnd = -1;
  for (let i = returnIdx - 1; i >= 0; i -= 1) {
    if (/^\s*exports\.\w+\s*=/.test(lines[i])) { exportsEnd = i; continue; }
    break;
  }
  if (exportsEnd < 0) throw new Error('no exports block');

  // Skip the CJS preamble the wrapper injected. Scan forward while any
  // wrapper-injected line is still present, so a wrapper variant that emitted
  // fewer or more of them cannot leave one behind.
  let start = factoryIdx + 1;
  for (let guard = 0; guard < 6; guard += 1) {
    const line = lines[start] ?? '';
    const isPreamble = /^\s*var module = \{ exports: \{\} \};\s*$/.test(line)
      || /^\s*var exports = module\.exports;\s*$/.test(line);
    if (!isPreamble) break;
    start += 1;
  }

  // Exports start at the first export line in the trailing block, so the body
  // ends one line before the block begins.
  let exportsStart = exportsEnd;
  while (exportsStart - 1 >= start && /^\s*exports\.\w+\s*=/.test(lines[exportsStart - 1])) exportsStart -= 1;

  const body = lines.slice(start, exportsStart).join('\n').trim();
  if (body === '') throw new Error('recovered body is empty');

  let esm = body;
  esm = esm.replace(/^function (apply|renderModal|rowSummary|formatCountdown|formatBeijingClock|formatBeijingMoment|sidebarCollapsed)\b/gm, 'export function $1');
  esm = esm.replace(/^const (name|inject)\s*=/gm, 'export const $1 =');

  const header = `/**
 * Browser half of dsh-peakhour-withtiaoxiu — the hand-written ESM source.
 *
 * Edit THIS file; \`npm run build\` wraps it into the browser bundle that the
 * DSH combo route serves as lib/client.js.
 */`;

  // Publish any name the body does not already export; the wrapped form can
  // leave a trailing `export { sidebarCollapsed }` in place, and a duplicate
  // export is a syntax error.
  const needed = EXPORTED.filter((name) => !new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`, 'm').test(esm)
    && !new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b`, 'm').test(esm));
  const exportLine = needed.length > 0 ? `\nexport { ${needed.join(', ')} };\n` : '\n';

  return `${header}\n${esm}\n${exportLine}`;
}

const origin = fs.existsSync(sourcePath) ? sourcePath : bakPath;
const text = fs.readFileSync(origin, 'utf8');

if (!text.startsWith('window.__ModuleLoader__.load(')) {
  console.log('source is already bare ESM; nothing to recover.');
  process.exit(0);
}

const recovered = recover(text);

// Validate before adopting.
if (/__ModuleLoader__/.test(recovered)) throw new Error('recovered still mentions __ModuleLoader__');
if (/module\.exports/.test(recovered)) throw new Error('recovered still mentions module.exports');
for (const name of EXPORTED) {
  const declared = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`, 'm');
  if (!declared.test(recovered)) throw new Error(`recovered does not export "${name}"`);
}
const exportCount = (recovered.match(/^export\s/gm) || []).length;

const staging = path.join(root, 'lib', 'client.source.recovered.js');
fs.writeFileSync(staging, recovered, 'utf8');
console.log(`recovered ${text.length} -> ${recovered.length} bytes, ${exportCount} exports`);
console.log(`staged at lib/client.source.recovered.js (NOT yet adopted)`);
