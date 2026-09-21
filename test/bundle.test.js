// Execute the built client bundle the way the browser combo route does:
// define a capturing `window.__ModuleLoader__`, run the bundle, then assert it
// registered under the right id and produced the expected export surface.
//
// This exists because a bundle that registers nothing (or throws while
// evaluating) takes the whole combo script down and blanks the UI. Catching
// that here costs one Node run instead of one broken page load.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const bundlePath = join(root, 'lib', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/** What the fake loader captured. */
const registrations = []

// The combo route's loader contract: registration happens through a global.
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

// Evaluate the raw bundle text exactly as a classic script would. `new Function`
// keeps the module-scope semantics of a concatenated combo script (no ESM
// imports are legal there).
// eslint-disable-next-line no-new-func
new Function(source)()

assert.equal(registrations.length, 1, `expected exactly one registration, got ${registrations.length}`)

const [registration] = registrations
assert.equal(registration.id, 'dsh-peakhour-withtiaoxiu', 'registration id must equal the package name')
assert.equal(typeof registration.factory, 'function', 'registration must carry a factory')

// The loader calls the factory with a `require` that resolves sibling modules
// from its static table. This package imports nothing, so a require that throws
// proves the client half is dependency-free as intended.
const factoryRequire = (specifier) => {
  throw new Error(`unexpected require("${specifier}") — the client half must stay dependency-free`)
}
const exports = registration.factory(factoryRequire)

for (const name of ['name', 'inject', 'apply', 'formatCountdown', 'formatBeijingClock', 'formatBeijingMoment', 'rowSummary', 'renderModal', 'sidebarCollapsed']) {
  const value = exports[name]
  assert.ok(
    value !== undefined && value !== null,
    `export "${name}" must be present, got ${String(value)}`,
  )
}
assert.equal(exports.name, 'dsh-peakhour-withtiaoxiu')
assert.deepEqual(exports.inject, ['locale'])
assert.equal(typeof exports.apply, 'function')

// A tiny behaviour check on the pure helpers, so the bundle is proven alive
// rather than merely parseable.
assert.equal(exports.formatCountdown(0), '不到 1 分钟')
assert.equal(exports.formatCountdown(3 * 3_600_000 + 12 * 60_000), '3 小时 12 分钟')
assert.equal(exports.formatBeijingClock(9 * 60), '09:00')
assert.equal(exports.rowSummary({ period: { peak: true }, policy: { models: [{ unitPrice: { inputMiss: 2 } }] } }).label, '峰时')
assert.equal(exports.rowSummary({ period: { peak: false }, policy: { models: [{ unitPrice: { inputMiss: 1 } }] } }).rate, '¥1/M')

console.log('bundle registers and evaluates OK')
console.log('  id      :', registration.id)
console.log('  exports :', Object.keys(exports).join(', '))
