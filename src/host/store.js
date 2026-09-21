/**
 * The plugin's on-disk state: the policy snapshot and the holiday calendar.
 *
 * Everything the clock needs is cached here so that the plugin keeps working
 * (and keeps its last known policy) when the network is unreachable. Writes are
 * atomic — a temp file plus a rename — so a crash mid-write cannot leave a
 * truncated policy that the next boot would reject.
 *
 * @module dsh-peakhour-withtiaoxiu/src/host/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Directory name under `$DSH_HOME` that holds this plugin's state. */
export const STATE_DIR_NAME = 'dsh-peakhour-withtiaoxiu'

/** File name of the cached policy snapshot. */
export const POLICY_FILE = 'policy.json'

/** File name of the cached holiday calendar. */
export const CALENDAR_FILE = 'calendar.json'

/**
 * Resolve the DSH home directory the way the host does.
 * @returns {string} Absolute path to the DSH home directory.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()
  return join(home, '.dsh')
}

/**
 * This plugin's state directory.
 * @returns {string} Absolute path.
 */
export function stateDir() {
  return join(dshHome(), STATE_DIR_NAME)
}

/**
 * Read and JSON-parse one state file.
 * @param {string} fileName File name inside the state directory.
 * @returns {Promise<{ found: boolean, value?: unknown, error?: string }>} The read outcome; a missing file is not an error.
 */
export async function readState(fileName) {
  const path = join(stateDir(), fileName)
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    if (code === 'ENOENT') return { found: false }
    return { found: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { found: true, value: JSON.parse(raw) }
  } catch (error) {
    return { found: true, error: `state file ${fileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Atomically write one state file.
 * @param {string} fileName File name inside the state directory.
 * @param {unknown} value JSON-serializable value.
 * @returns {Promise<{ ok: boolean, error?: string }>} The write outcome.
 */
export async function writeState(fileName, value) {
  const path = join(stateDir(), fileName)
  const temporary = `${path}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
