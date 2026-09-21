/**
 * Tests for the policy parser, the price-row reader, the override merge, and
 * the holiday-calendar normalizer.
 *
 * The HTML fixture reproduces the shape of the official pricing page's
 * "模型细节" table: the input label cell spans the cache-hit and cache-miss
 * rows, and each price row reads `<空闲时段 amount> <高峰时段 amount>`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyOverride,
  classifyColumnRows,
  detectHolidayExclusion,
  detectWeekendOffpeak,
  findRuleSentence,
  htmlToText,
  modelColumnIndex,
  parsePeakWindows,
  parsePolicy,
  parsePriceModels,
  parsePriceTable,
  readColumnAmounts,
  validateSnapshot,
} from '../src/core/policy.js'
import { BUILT_IN_SNAPSHOT, CAPTURED_WORDING, cloneBuiltInSnapshot } from '../src/core/snapshot.js'
import { mergeCalendars, neededYears, parseHolidayYear } from '../src/core/calendar.js'

const RULE = CAPTURED_WORDING

/**
 * Build a pricing-page-shaped HTML document.
 *
 * The table reproduces the official layout: each price row labels the cost
 * class in its first cell and then carries one column per model. The label
 * cell spans the cache-hit and cache-miss rows.
 *
 * @param {string} ruleSentence The peak/off-peak sentence to embed.
 * @param {{ withTables?: boolean }} [options] Fixture options.
 * @returns {string} HTML.
 */
function pricingHtml(ruleSentence, options = {}) {
  const tables = options.withTables === false ? '' : `
    <table>
      <tr><th>模型</th><th>deepseek-flash</th><th>deepseek-v4-pro</th></tr>
      <tr><td></td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr>
      <tr><td rowspan="2">百万tokens输入（缓存命中）</td><td>空闲时段 0.02元</td><td>空闲时段 0.15元</td></tr>
      <tr><td>高峰时段 0.04元</td><td>高峰时段 0.30元</td></tr>
      <tr><td rowspan="2">百万tokens输入（缓存未命中）</td><td>空闲时段 1元</td><td>空闲时段 4.5元</td></tr>
      <tr><td>高峰时段 2元</td><td>高峰时段 9.0元</td></tr>
      <tr><td rowspan="2">百万tokens输出</td><td>空闲时段 4元</td><td>空闲时段 13.5元</td></tr>
      <tr><td>高峰时段 8元</td><td>高峰时段 27.0元</td></tr>
    </table>`
  return `<!doctype html><html><body><h1>模型 &amp; 价格</h1><p>(2) ${ruleSentence}</p>${tables}</body></html>`
}

test('htmlToText separates table cells and decodes entities', () => {
  const text = htmlToText('<table><tr><td>a</td><td>b</td></tr></table><p>x &amp; y</p>')
  assert.ok(text.includes('a\nb'), `expected cells on separate lines, got: ${JSON.stringify(text)}`)
  assert.ok(text.includes('x & y'))
})

test('findRuleSentence recovers the substantive sentence from a real page, footnote marker removed', () => {
  const text = htmlToText(pricingHtml(RULE))
  const sentence = findRuleSentence(text)
  // The page renders the rule as two sentences: a lead-in, then the rule with
  // the footnote marker that carries the operative content.
  assert.equal(
    sentence,
    '北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段',
  )
  // The recovered sentence alone must still yield both windows.
  assert.deepEqual(parsePeakWindows(sentence ?? '')?.windows, [
    { from: 9 * 60, to: 12 * 60 },
    { from: 14 * 60, to: 18 * 60 },
  ])
})

test('findRuleSentence prefers the substantive sentence when the page splits the rule', () => {
  const split = '空闲时段价格为高峰时段价格的一半。\n' + RULE
  assert.equal(findRuleSentence(split)?.includes('9:00'), true)
})

test('findRuleSentence still answers from a lead-in-only page', () => {
  assert.equal(findRuleSentence('空闲时段价格为高峰时段价格的一半。'), '空闲时段价格为高峰时段价格的一半')
})

test('findRuleSentence returns undefined when the page never mentions peak hours', () => {
  assert.equal(findRuleSentence('价格随时可能调整。'), undefined)
})

test('parsePeakWindows reads both windows and the weekday scope', () => {
  const parsed = parsePeakWindows(RULE)
  assert.ok(parsed)
  assert.deepEqual(parsed.windows, [
    { from: 9 * 60, to: 12 * 60 },
    { from: 14 * 60, to: 18 * 60 },
  ])
  assert.equal(parsed.weekdaysOnly, true)
})

test('the captured wording still parses to the built-in snapshot windows', () => {
  const parsed = parsePeakWindows(CAPTURED_WORDING)
  assert.deepEqual(parsed?.windows, BUILT_IN_SNAPSHOT.windows.map((w) => ({ from: w.from, to: w.to })))
})

test('parsePeakWindows refuses a sentence with no window', () => {
  assert.equal(parsePeakWindows('北京时间周一至周五为高峰时段。'), undefined)
})

test('parsePeakWindows accepts full-width colons and en dashes', () => {
  const parsed = parsePeakWindows('北京时间周一至周五 9：00 – 12：00、14：00 – 18：00 为高峰时段；其余时段为谷时。')
  assert.deepEqual(parsed?.windows, [
    { from: 9 * 60, to: 12 * 60 },
    { from: 14 * 60, to: 18 * 60 },
  ])
})

test('detectHolidayExclusion and detectWeekendOffpeak read the published qualifiers', () => {
  const text = htmlToText(pricingHtml(RULE))
  assert.equal(detectHolidayExclusion(text), true)
  assert.equal(detectWeekendOffpeak(text), true)
  assert.equal(detectHolidayExclusion('北京时间周一至周五 9:00-12:00 为高峰时段'), false)
  assert.equal(detectWeekendOffpeak('北京时间周一至周五 9:00-12:00 为高峰时段'), false)
})

test('parsePriceTable reads rows and cells, and ignores tables with no price', () => {
  const table = parsePriceTable(pricingHtml(RULE))
  assert.ok(table, 'expected the price table to be found')
  assert.deepEqual(table.header.slice(0, 3), ['模型', 'deepseek-flash', 'deepseek-v4-pro'])
  assert.ok(table.rows.some((row) => row.includes('DeepSeek-V4.1-Flash')))
  assert.equal(parsePriceTable('<table><tr><td>a</td><td>b</td></tr></table>'), undefined)
})

test('modelColumnIndex isolates one model column', () => {
  const table = parsePriceTable(pricingHtml(RULE))
  assert.ok(table)
  assert.equal(modelColumnIndex(table, 'deepseek-flash', 'DeepSeek-V4.1-Flash'), 1)
  assert.equal(modelColumnIndex(table, 'deepseek-v4-pro', 'DeepSeek-V4-Pro-0813'), 2)
  assert.equal(modelColumnIndex(table, 'deepseek-v9', 'Nope'), -1)
})

test('the grid keeps rowspan labels in column 0 and each model in its own column', () => {
  const table = parsePriceTable(pricingHtml(RULE))
  assert.ok(table)
  // Row 3 is the peak row of the cache-hit class: the rowspan label carries
  // over, and the amounts stay in their model's columns.
  assert.equal(table.rows[3]?.[0], '百万tokens输入（缓存命中）')
  assert.equal(table.rows[3]?.[1], '高峰时段 0.04元')
  assert.equal(table.rows[3]?.[2], '高峰时段 0.30元')
})

test('readColumnAmounts prefers the labelled 空闲/高峰 order', () => {
  assert.deepEqual(readColumnAmounts(['空闲时段 0.02元', '高峰时段 0.04元']), { offpeak: 0.02, peak: 0.04 })
  assert.deepEqual(readColumnAmounts(['空闲时段 1元 高峰时段 2元']), { offpeak: 1, peak: 2 })
  assert.equal(readColumnAmounts(['空闲时段', '0.02元']), undefined)
})

test('classifyColumnRows maps a model column onto the three price rows', () => {
  const table = parsePriceTable(pricingHtml(RULE))
  assert.ok(table)
  const rows = classifyColumnRows(table.rows, 1)
  assert.ok(rows)
  assert.deepEqual(rows.cacheHit, { offpeak: 0.02, peak: 0.04 })
  assert.deepEqual(rows.inputMiss, { offpeak: 1, peak: 2 })
  assert.deepEqual(rows.output, { offpeak: 4, peak: 8 })
  // The neighbouring model's column must not bleed in.
  const pro = classifyColumnRows(table.rows, 2)
  assert.deepEqual(pro?.cacheHit, { offpeak: 0.15, peak: 0.3 })
})

test('parsePriceModels reads both published models with the right columns', () => {
  const { models, warnings } = parsePriceModels(pricingHtml(RULE))
  assert.deepEqual(warnings, [])
  const flash = models.find((model) => model.id === 'deepseek-flash')
  assert.deepEqual(flash?.peak, { cacheHit: 0.04, inputMiss: 2, output: 8 })
  assert.deepEqual(flash?.offpeak, { cacheHit: 0.02, inputMiss: 1, output: 4 })
  const pro = models.find((model) => model.id === 'deepseek-v4-pro')
  assert.deepEqual(pro?.peak, { cacheHit: 0.3, inputMiss: 9, output: 27 })
  assert.deepEqual(pro?.offpeak, { cacheHit: 0.15, inputMiss: 4.5, output: 13.5 })
})

test('parsePriceModels warns when the page has no price table', () => {
  const { models, warnings } = parsePriceModels('<html><body>no table</body></html>')
  assert.deepEqual(models, [])
  assert.ok(warnings.some((warning) => warning.includes('no price table')))
})

test('parsePolicy derives windows and prices, and keeps the wording', () => {
  const result = parsePolicy(pricingHtml(RULE), { now: Date.UTC(2026, 8, 21) })
  assert.equal(result.ok, true, result.error)
  assert.ok(result.snapshot?.wording.includes('周一至周五'))
  assert.deepEqual(result.snapshot?.windows, [
    { from: 9 * 60, to: 12 * 60 },
    { from: 14 * 60, to: 18 * 60 },
  ])
  assert.equal(result.snapshot?.offpeakMultiplier, 0.5)
  assert.equal(result.snapshot?.capturedAt, '2026-09-21T00:00:00.000Z')
  const flash = result.snapshot?.models.find((model) => model.id === 'deepseek-flash')
  assert.deepEqual(flash?.peak, { cacheHit: 0.04, inputMiss: 2, output: 8 })
  assert.deepEqual(flash?.offpeak, { cacheHit: 0.02, inputMiss: 1, output: 4 })
})

test('parsePolicy fails loudly when the page stops stating the rule', () => {
  const result = parsePolicy('<html><body><h1>模型 &amp; 价格</h1><p>价格随时可能调整。</p></body></html>')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /no longer contains a peak-hour sentence/)
  assert.equal(result.snapshot, undefined)
})

test('parsePolicy fails loudly when the sentence lost its window', () => {
  const result = parsePolicy(pricingHtml('北京时间周一至周五（不含中国法定节假日）为高峰时段；其余时段为谷时。'))
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /could not read peak windows/)
})

test('parsePolicy warns but still succeeds when only the price table is unreadable', () => {
  const result = parsePolicy(pricingHtml(RULE, { withTables: false }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.snapshot?.windows, [
    { from: 9 * 60, to: 12 * 60 },
    { from: 14 * 60, to: 18 * 60 },
  ])
  assert.ok(result.warnings.some((warning) => warning.includes('no price table')))
})

test('parsePolicy warns when the weekday scope disappears', () => {
  const result = parsePolicy(pricingHtml('北京时间 9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。'))
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((warning) => warning.includes('周一至周五')))
})

test('parsePolicy keeps the previous model row when a row cannot be read', () => {
  const previous = [{ id: 'deepseek-flash', label: 'prev', peak: { cacheHit: 1, inputMiss: 1, output: 1 }, offpeak: { cacheHit: 1, inputMiss: 1, output: 1 }, aliases: ['deepseek-v4-flash'] }]
  const result = parsePolicy(pricingHtml(RULE, { withTables: false }), { fallbackModels: previous })
  const flash = result.snapshot?.models.find((model) => model.id === 'deepseek-flash')
  assert.equal(flash?.label, 'prev')
  assert.deepEqual(flash?.aliases, ['deepseek-v4-flash'])
})

test('applyOverride replaces windows, multiplier and a single price row', () => {
  const base = cloneBuiltInSnapshot()
  const merged = applyOverride(base, {
    windows: [{ from: 10 * 60, to: 11 * 60 }],
    offpeakMultiplier: 0.4,
    models: [{ id: 'deepseek-flash', peak: { output: 99 } }],
  })
  assert.deepEqual(merged.windows, [{ from: 10 * 60, to: 11 * 60 }])
  assert.equal(merged.offpeakMultiplier, 0.4)
  const flash = merged.models.find((model) => model.id === 'deepseek-flash')
  assert.equal(flash?.peak.output, 99)
  // Untouched fields survive the row patch.
  assert.equal(flash?.peak.cacheHit, 0.04)
  assert.equal(flash?.offpeak.output, 4)
})

test('applyOverride adds an unknown model row instead of dropping it', () => {
  const merged = applyOverride(cloneBuiltInSnapshot(), {
    models: [{ id: 'deepseek-v5', peak: { cacheHit: 0, inputMiss: 1, output: 2 }, offpeak: { cacheHit: 0, inputMiss: 0.5, output: 1 } }],
  })
  assert.ok(merged.models.some((model) => model.id === 'deepseek-v5'))
})

test('applyOverride with nothing configured is a no-op', () => {
  const base = cloneBuiltInSnapshot()
  assert.deepEqual(applyOverride(base, undefined), base)
})

test('validateSnapshot rejects malformed and accepts well-formed input', () => {
  assert.equal(validateSnapshot(null).ok, false)
  assert.equal(validateSnapshot({ version: 99, windows: [], models: [] }).ok, false)
  assert.equal(validateSnapshot({ version: 1, windows: [{ from: 12 * 60, to: 9 * 60 }], models: [] }).ok, false)
  assert.equal(validateSnapshot({ version: 1, windows: [{ from: 9 * 60, to: 12 * 60 }], models: [] }).ok, true)
  assert.equal(validateSnapshot(cloneBuiltInSnapshot()).ok, true)
})

/* ------------------------------------------------------------------ calendar */

/** A trimmed copy of holiday-cn's 2026 file. */
const HOLIDAY_2026 = {
  year: 2026,
  papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-04', isOffDay: false },
    { name: '国庆节', date: '2026-09-20', isOffDay: false },
    { name: '中秋节', date: '2026-09-25', isOffDay: true },
    { name: '国庆节', date: '2026-10-01', isOffDay: true },
    { name: '国庆节', date: '2026-10-10', isOffDay: false },
  ],
}

test('parseHolidayYear normalizes days into entries plus both date lists', () => {
  const result = parseHolidayYear(HOLIDAY_2026, 2026)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.entries?.['2026-09-20']?.isOffDay, false)
  assert.equal(result.entries?.['2026-10-01']?.name, '国庆节')
  assert.deepEqual(result.holidays, ['2026-01-01', '2026-09-25', '2026-10-01'])
  assert.deepEqual(result.workdays, ['2026-01-04', '2026-09-20', '2026-10-10'])
  assert.equal(result.papers?.length, 1)
})

test('parseHolidayYear rejects a mismatched year', () => {
  const result = parseHolidayYear(HOLIDAY_2026, 2027)
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /expected 2027/)
})

test('parseHolidayYear rejects data with no usable days', () => {
  assert.equal(parseHolidayYear({ year: 2026, days: [{ date: 'nope', isOffDay: true }] }, 2026).ok, false)
  assert.equal(parseHolidayYear({ year: 2026, days: [] }, 2026).ok, false)
})

test('mergeCalendars layers years and then the user override on top', () => {
  const merged = mergeCalendars(
    [parseHolidayYear(HOLIDAY_2026, 2026)],
    { holidays: ['2026-09-21'], workdays: ['2026-09-19'] },
  )
  assert.deepEqual(merged.years, [2026])
  assert.equal(merged.entries?.['2026-09-21']?.isOffDay, true)
  assert.equal(merged.entries?.['2026-09-19']?.isOffDay, false)
  assert.deepEqual(merged.overriddenDays, ['2026-09-21', '2026-09-19'])
  // The override wins over a fetched fact for the same date.
  const overwritten = mergeCalendars([parseHolidayYear(HOLIDAY_2026, 2026)], { holidays: ['2026-10-01'] })
  assert.equal(overwritten.entries?.['2026-10-01']?.name, '用户指定节假日')
})

test('mergeCalendars ignores malformed override dates', () => {
  const merged = mergeCalendars([], { holidays: ['2026-9-1', 'garbage'] })
  assert.deepEqual(merged.overriddenDays, [])
})

test('neededYears covers the current Beijing year and the next one', () => {
  // 2026-12-31 23:00 Beijing is 2026-12-31T15:00Z, still 2026.
  assert.deepEqual(neededYears(Date.UTC(2026, 11, 31, 15, 0)), [2026, 2027])
  assert.deepEqual(neededYears(Date.UTC(2026, 0, 1, 0, 0)), [2026, 2027])
})
