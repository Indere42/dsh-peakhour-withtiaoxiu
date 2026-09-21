/**
 * The built-in policy snapshot.
 *
 * This is the offline fallback: the value the plugin uses before its first
 * successful sync, and again whenever a sync fails. It is a faithful copy of
 * what the official pricing page said on `capturedAt`, including the exact
 * sentence the parser keys off, so a reviewer can diff it against the live
 * page without leaving the repository.
 *
 * Keep this file in sync with the live page when the parser's output changes;
 * `npm test` asserts that the parser re-derives the same windows from
 * `wording`.
 *
 * @module dsh-peakhour-withtiaoxiu/src/core/snapshot
 */

/** The snapshot format version this plugin writes and reads. */
export const SNAPSHOT_VERSION = 1

/**
 * Copy of the peak/off-peak sentence on the official pricing page at capture
 * time. The parser must reproduce `windows` from it verbatim.
 */
export const CAPTURED_WORDING = '空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。'

/** The official pricing page this policy is read from. */
export const OFFICIAL_PRICING_URL_ZH = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** The English mirror of the pricing page, used as a cross-check source. */
export const OFFICIAL_PRICING_URL_EN = 'https://api-docs.deepseek.com/quick_start/pricing'

/**
 * CNY per million tokens for one model, split by billing column.
 * @typedef {object} ModelPrice
 * @property {string} id Model id as published on the pricing page.
 * @property {string} label Human label.
 * @property {{ cacheHit: number, inputMiss: number, output: number }} peak
 * @property {{ cacheHit: number, inputMiss: number, output: number }} offpeak
 * @property {string[]} [aliases] Retired ids the provider still routes here.
 */

/**
 * @typedef {object} PolicySnapshot
 * @property {number} version
 * @property {string} capturedAt ISO instant this snapshot describes.
 * @property {string} source URL the snapshot was read from.
 * @property {string} wording The peak/off-peak sentence as published.
 * @property {{ from: number, to: number }[]} windows Peak windows, minutes since Beijing midnight.
 * @property {number} offpeakMultiplier Off-peak price as a fraction of peak price.
 * @property {ModelPrice[]} models
 * @property {string[]} notes Reviewer-facing notes about the interpretation.
 */

/**
 * The built-in snapshot: DeepSeek pricing effective 2026-09-10 12:00 Beijing,
 * as published after the V4.1 Flash release.
 * @type {PolicySnapshot}
 */
export const BUILT_IN_SNAPSHOT = Object.freeze({
  version: SNAPSHOT_VERSION,
  capturedAt: '2026-09-21T00:00:00.000Z',
  source: OFFICIAL_PRICING_URL_ZH,
  wording: CAPTURED_WORDING,
  windows: Object.freeze([
    Object.freeze({ from: 9 * 60, to: 12 * 60 }),
    Object.freeze({ from: 14 * 60, to: 18 * 60 }),
  ]),
  offpeakMultiplier: 0.5,
  models: Object.freeze([
    Object.freeze({
      id: 'deepseek-flash',
      label: 'DeepSeek-V4.1-Flash',
      peak: Object.freeze({ cacheHit: 0.04, inputMiss: 2, output: 8 }),
      offpeak: Object.freeze({ cacheHit: 0.02, inputMiss: 1, output: 4 }),
      aliases: Object.freeze(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']),
    }),
    Object.freeze({
      id: 'deepseek-v4-pro',
      label: 'DeepSeek-V4-Pro-0813',
      peak: Object.freeze({ cacheHit: 0.3, inputMiss: 9, output: 27 }),
      offpeak: Object.freeze({ cacheHit: 0.15, inputMiss: 4.5, output: 13.5 }),
      aliases: Object.freeze([]),
    }),
  ]),
  notes: Object.freeze([
    'The peak rule keys off the WEEKDAY (Mon-Fri), not off the government work calendar.',
    'A 调休 makeup workday that lands on a weekend therefore still bills off-peak all day.',
    'Model ids not listed here fall back to the deepseek-flash row, matching the retired-flash routing note.',
  ]),
})

/**
 * Deep clone the built-in snapshot into a plain, mutable structure.
 * @returns {PolicySnapshot} A detached copy safe to merge overrides into.
 */
export function cloneBuiltInSnapshot() {
  return JSON.parse(JSON.stringify(BUILT_IN_SNAPSHOT))
}
