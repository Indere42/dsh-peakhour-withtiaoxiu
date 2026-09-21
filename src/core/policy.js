/**
 * Parser and source of truth for the official peak/off-peak policy.
 *
 * The official pricing page states the peak rule in prose and the prices in a
 * table, so this module does the reading: it derives the peak windows from the
 * published sentence and reads the per-model price rows out of the table's own
 * rows and columns.
 *
 * Two disciplines keep a page rewrite from turning into a silently wrong
 * policy:
 *
 *  - the peak WINDOWS are all-or-nothing. A page whose sentence can no longer
 *    be read is reported as `ok: false`, never guessed at, because a wrong
 *    window would mis-price every request.
 *  - the price TABLE is best-effort. A row that cannot be read keeps its
 *    previous value and raises a warning, because a missing row only costs a
 *    display detail.
 *
 * @module dsh-peakhour-withtiaoxiu/src/core/policy
 */

import {
  BUILT_IN_SNAPSHOT,
  CAPTURED_WORDING,
  OFFICIAL_PRICING_URL_ZH,
  SNAPSHOT_VERSION,
  cloneBuiltInSnapshot,
} from './snapshot.js'

/**
 * @typedef {import('./snapshot.js').PolicySnapshot} PolicySnapshot
 * @typedef {import('./snapshot.js').ModelPrice} ModelPrice
 */

/** DeepSeek's documented off-peak price as a fraction of the peak price. */
const DEFAULT_OFFPEAK_MULTIPLIER = 0.5

/** Peak windows accepted by the parser: sane, ordered, inside one day. */
const MAX_WINDOWS = 6

/** Chinese sentence forms that carry the peak windows. */
const ZH_WEEKDAY_SCOPE = /周一至周五/
const ZH_SCOPE_ANY = /周[一二三四五六日]至周[一二三四五六日]/

/** English mirror of the same scope. */
const EN_WEEKDAY_SCOPE = /Monday\s*(?:to|-|–|—|through)\s*Friday/i

/** `9:00 - 12:00` / `09:00–12:00` / `9：00 至 12：00`. */
const TIME_RANGE_PATTERN = /(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/g

/** Model rows the plugin knows how to label, in display order. */
const MODEL_ROWS = [
  { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro-0813' },
]

/**
 * Strip HTML down to text while keeping table cells separated, so prose is
 * readable one sentence per line. Table reading does NOT use this output — it
 * reads the real cells (see `parsePriceTable`) — this is for the rule sentence.
 * @param {string} html Raw page HTML.
 * @returns {string} Plain text with `\n` separators.
 */
export function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:td|th|tr|p|div|li|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
}

/** Collapse a table cell to one line of text. */
function cellText(cellHtml) {
  return htmlToText(cellHtml).replace(/\n+/g, ' ').trim()
}

/**
 * Read one `<tr>` into `{ text, colspan, rowspan }` cells.
 * @param {string} rowHtml Inner HTML of the row.
 * @returns {{ text: string, colspan: number, rowspan: number }[]} The row's cells.
 */
function rowCells(rowHtml) {
  const cells = []
  for (const cellMatch of rowHtml.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
    const attributes = cellMatch[1] ?? ''
    const body = cellMatch[2] ?? ''
    const colspan = Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(attributes)?.[1] ?? 1)
    const rowspan = Number(/\browspan\s*=\s*["']?(\d+)/i.exec(attributes)?.[1] ?? 1)
    cells.push({
      text: cellText(body),
      colspan: Number.isFinite(colspan) && colspan > 0 ? colspan : 1,
      rowspan: Number.isFinite(rowspan) && rowspan > 0 ? rowspan : 1,
    })
  }
  return cells
}

/**
 * Lay a table's rows out on a real grid, honouring `colspan` and `rowspan`.
 *
 * The official pricing table labels a cost class in a cell that spans its
 * off-peak and peak rows, which shifts every later row one column left. Reading
 * cells by raw index would therefore read the neighbouring model's prices, so
 * the spans are materialized into a padded grid first.
 *
 * @param {{ text: string, colspan: number, rowspan: number }[][]} rows Raw rows.
 * @returns {string[][]} Padded grid, one array per row.
 */
export function tableGrid(rows) {
  const width = rows.reduce(
    (max, row) => Math.max(max, row.reduce((sum, cell) => sum + cell.colspan, 0)),
    0,
  )
  // Pre-allocate every row so a rowspan can write into a row that has not been
  // visited yet.
  /** @type {string[][]} */
  const grid = rows.map(() => new Array(width).fill(undefined))
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const line = grid[rowIndex]
    if (line === undefined) continue
    let column = 0
    for (const cell of rows[rowIndex] ?? []) {
      // Place at the first column this row has not already filled — either by
      // an earlier cell of this row or by a rowspan from a row above. This is
      // the step that keeps each model's prices in that model's column.
      while (column < width && line[column] !== undefined) column += 1
      for (let span = 0; span < cell.colspan && column < width; span += 1) {
        line[column] = cell.text
        if (cell.rowspan > 1) {
          for (let down = 1; down < cell.rowspan && rowIndex + down < rows.length; down += 1) {
            const target = grid[rowIndex + down]
            if (target !== undefined && target[column] === undefined) target[column] = cell.text
          }
        }
        column += 1
      }
    }
  }
  // A hole that survives means a span pointed past the table's last row; an
  // empty cell is the honest reading of that.
  for (const row of grid) {
    for (let index = 0; index < row.length; index += 1) {
      if (row[index] === undefined) row[index] = ''
    }
  }
  return grid
}

/**
 * Read the pricing table into a padded grid.
 *
 * @param {string} html Raw page HTML.
 * @returns {{ header: string[], rows: string[][] } | undefined} The first table
 *   carrying a price row, or undefined when none is found.
 */
export function parsePriceTable(html) {
  for (const tableMatch of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const body = tableMatch[1] ?? ''
    /** @type {{ text: string, colspan: number, rowspan: number }[][]} */
    const rawRows = []
    for (const rowMatch of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = rowCells(rowMatch[1] ?? '')
      if (cells.length > 0) rawRows.push(cells)
    }
    // A price table is the one whose cells mention 元; anything else on the
    // page (feature matrices, concurrency limits) is skipped.
    if (!rawRows.some((row) => row.some((cell) => cell.text.includes('元')))) continue
    const rows = tableGrid(rawRows)
    return { header: rows[0] ?? [], rows }
  }
  return undefined
}

/**
 * Read the two amounts out of a price table's data cells.
 *
 * Each model column reports `空闲时段 <amount>元` then `高峰时段 <amount>元`,
 * in that documented order; rows where a single cell already carries both
 * amounts are handled too.
 *
 * @param {string[]} cells Data cells of one model column.
 * @returns {{ offpeak: number, peak: number } | undefined} The amounts.
 */
export function readColumnAmounts(cells) {
  const joined = cells.join(' | ')
  const amountPattern = /(\d+(?:\.\d+)?)\s*元/g
  const amounts = [...joined.matchAll(amountPattern)].map((hit) => Number(hit[1]))
  if (amounts.length < 2) return undefined
  const offpeakIndex = joined.indexOf('空闲时段')
  const peakIndex = joined.indexOf('高峰时段')
  if (offpeakIndex >= 0 && peakIndex > offpeakIndex) {
    // Read each class inside its own labelled span so a column that reports
    // them out of order still lands correctly.
    const offpeakSpan = joined.slice(offpeakIndex, peakIndex)
    const peakSpan = joined.slice(peakIndex)
    const offpeakAmount = [...offpeakSpan.matchAll(amountPattern)][0]
    const peakAmount = [...peakSpan.matchAll(amountPattern)][0]
    if (offpeakAmount !== undefined && peakAmount !== undefined) {
      return { offpeak: Number(offpeakAmount[1]), peak: Number(peakAmount[1]) }
    }
  }
  return { offpeak: amounts[0] ?? 0, peak: amounts[1] ?? 0 }
}

/**
 * Locate one model's column in a parsed price table.
 *
 * @param {{ header: string[], rows: string[][] }} table Parsed table.
 * @param {string} modelId Model id as published in the header.
 * @param {string} label Model version label, the fallback header match.
 * @returns {number} The column index, or -1 when the model has no column.
 */
export function modelColumnIndex(table, modelId, label) {
  const byId = table.header.findIndex((cell) => cell === modelId)
  if (byId >= 0) return byId
  return table.header.findIndex((cell) => cell.includes(label))
}

/**
 * Classify a grid's price rows into the three price rows of one table column.
 *
 * The cost class is labelled in the row's first column (usually in a cell that
 * spans the off-peak and peak rows) while the amounts live in the column of
 * the model being read, so the rows must be walked in order: the first row of
 * a class carries its off-peak amount and the next one its peak amount.
 *
 * @param {string[][]} grid The padded price table grid.
 * @param {number} column Index of the model column to read.
 * @returns {{ cacheHit: { offpeak: number, peak: number }, inputMiss: { offpeak: number, peak: number }, output: { offpeak: number, peak: number } } | undefined} The rows.
 */
export function classifyColumnRows(grid, column) {
  /**
   * Which price class a row's label cell names.
   * @param {string} label Label cell text.
   * @returns {'cacheHit' | 'inputMiss' | 'output' | undefined} The class.
   */
  const kindOf = (label) => {
    if (label.includes('缓存未命中')) return 'inputMiss'
    if (label.includes('缓存命中')) return 'cacheHit'
    if (label.includes('输出')) return 'output'
    return undefined
  }

  /** @type {Record<string, { offpeak: number, peak: number } | undefined>} */
  const found = {}
  /** @type {'cacheHit' | 'inputMiss' | 'output' | undefined} */
  let currentKind
  /** @type {number | undefined} */
  let pendingOffpeak

  for (const row of grid) {
    const label = row[0] ?? ''
    const kind = kindOf(label)
    if (kind !== undefined && kind !== currentKind) {
      currentKind = kind
      pendingOffpeak = undefined
    }
    if (currentKind === undefined || found[currentKind] !== undefined) continue
    const value = row[column]
    if (value === undefined) continue
    const amounts = readColumnAmounts([value]) ?? amountsInCell(value)
    if (amounts === undefined) continue
    if (pendingOffpeak === undefined) {
      // First row of the class: its label cell says 空闲时段; if the label
      // names 高峰时段 instead, the row is already the peak row.
      if (label.includes('高峰时段') || value.includes('高峰时段')) {
        found[currentKind] = { offpeak: 0, peak: amounts.peak }
      } else {
        pendingOffpeak = amounts.offpeak
      }
      continue
    }
    found[currentKind] = { offpeak: pendingOffpeak, peak: amounts.peak }
    pendingOffpeak = undefined
  }

  if (found.cacheHit === undefined || found.inputMiss === undefined || found.output === undefined) {
    return undefined
  }
  return { cacheHit: found.cacheHit, inputMiss: found.inputMiss, output: found.output }
}

/**
 * Read one or two amounts out of a single cell, returning both when the cell
 * carries an explicit 空闲时段/高峰时段 pair.
 *
 * @param {string} value Cell text.
 * @returns {{ offpeak: number, peak: number } | undefined} The amounts.
 */
function amountsInCell(value) {
  const numbers = [...value.matchAll(/(\d+(?:\.\d+)?)\s*元/g)].map((hit) => Number(hit[1]))
  if (numbers.length === 0) return undefined
  if (numbers.length === 1) {
    return { offpeak: numbers[0], peak: numbers[0] }
  }
  return { offpeak: numbers[0], peak: numbers[1] }
}

/**
 * Parse the per-model price rows out of the pricing page HTML.
 *
 * @param {string} html Raw page HTML.
 * @returns {{ models: ModelPrice[], warnings: string[] }} Parsed rows plus per-row warnings.
 */
export function parsePriceModels(html) {
  /** @type {ModelPrice[]} */
  const models = []
  const warnings = []
  const table = parsePriceTable(html)
  if (table === undefined) {
    return { models, warnings: ['the pricing page has no price table; keeping the previous price rows'] }
  }
  for (const { id, label } of MODEL_ROWS) {
    const column = modelColumnIndex(table, id, label)
    const rows = column < 0 ? undefined : classifyColumnRows(table.rows, column)
    if (rows === undefined) {
      warnings.push(`price row for ${id} could not be read; keeping the previous row`)
      continue
    }
    models.push({
      id,
      label,
      peak: { cacheHit: rows.cacheHit.peak, inputMiss: rows.inputMiss.peak, output: rows.output.peak },
      offpeak: { cacheHit: rows.cacheHit.offpeak, inputMiss: rows.inputMiss.offpeak, output: rows.output.offpeak },
    })
  }
  return { models, warnings }
}

/**
 * Find the published peak/off-peak sentence in page text.
 *
 * The page may split the rule across elements (a short lead-in sentence and
 * the substantive one), so candidates are ranked: a sentence naming Beijing
 * time wins, then any sentence naming the peak hours. The lead-in ("空闲时段
 * 价格为高峰时段价格的一半") is a valid answer of the second rank, which is what
 * makes the split-page case degrade safely.
 *
 * @param {string} text Page text.
 * @returns {string | undefined} The sentence, when found.
 */
export function findRuleSentence(text) {
  const sentences = text
    .split(/[。\n]/)
    .map((part) => part.replace(/^[(（]\d+[)）]\s*/, '').trim())
    .filter((part) => part !== '' && part.includes('高峰时段'))
  return sentences.find((sentence) => sentence.includes('北京时间') || /Beijing/i.test(sentence)) ?? sentences[0]
}

/**
 * Parse peak windows (minutes since Beijing midnight) out of a rule sentence.
 * @param {string} sentence The published rule sentence.
 * @returns {{ windows: { from: number, to: number }[], weekdaysOnly: boolean } | undefined} Windows plus whether the rule is weekday-scoped.
 */
export function parsePeakWindows(sentence) {
  const scopeMatch = ZH_SCOPE_ANY.exec(sentence) ?? /(Monday[^.;]*?Friday)/i.exec(sentence)
  const weekdaysOnly = ZH_WEEKDAY_SCOPE.test(sentence) || EN_WEEKDAY_SCOPE.test(sentence)

  /** @type {{ from: number, to: number }[]} */
  const windows = []
  TIME_RANGE_PATTERN.lastIndex = 0
  for (let hit = TIME_RANGE_PATTERN.exec(sentence); hit !== null; hit = TIME_RANGE_PATTERN.exec(sentence)) {
    const from = Number(hit[1]) * 60 + Number(hit[2])
    const to = Number(hit[3]) * 60 + Number(hit[4])
    if (to > from && from < 24 * 60 && to <= 24 * 60) windows.push({ from, to })
  }
  if (windows.length === 0 || windows.length > MAX_WINDOWS) return undefined
  if (scopeMatch === null && windows.length === 0) return undefined
  windows.sort((a, b) => a.from - b.from)
  return { windows, weekdaysOnly }
}

/**
 * Detect whether the page still excludes statutory holidays from peak hours.
 * @param {string} text Page text.
 * @returns {boolean} True when the holiday exclusion is present.
 */
export function detectHolidayExclusion(text) {
  return text.includes('不含中国法定节假日')
    || text.includes('法定节假日全天均为空闲')
    || /excluding\s+(?:Chinese\s+)?(?:public\s+)?holidays/i.test(text)
}

/**
 * Detect whether the page still bills weekends off-peak.
 * @param {string} text Page text.
 * @returns {boolean} True when weekends are named as off-peak.
 */
export function detectWeekendOffpeak(text) {
  return text.includes('包括周末') || /including\s+weekends/i.test(text)
}

/**
 * @typedef {object} ParseResult
 * @property {boolean} ok Whether every required fact was read.
 * @property {string[]} warnings Non-fatal findings (an unreadable price row, a changed scope).
 * @property {string | undefined} error Fatal reason when `ok` is false.
 * @property {PolicySnapshot | undefined} snapshot The parsed policy when `ok`.
 */

/**
 * Parse the official pricing page HTML into a policy snapshot.
 *
 * @param {string} html Raw pricing page HTML.
 * @param {{ source?: string, now?: number, fallbackModels?: ModelPrice[] }} [options] Parse options.
 * @returns {ParseResult} The parse outcome.
 */
export function parsePolicy(html, options = {}) {
  const source = options.source ?? OFFICIAL_PRICING_URL_ZH
  const now = options.now ?? Date.now()
  const warnings = []
  const text = htmlToText(html)

  const sentence = findRuleSentence(text)
  if (sentence === undefined) {
    return { ok: false, warnings, error: 'the pricing page no longer contains a peak-hour sentence', snapshot: undefined }
  }
  const parsed = parsePeakWindows(sentence)
  if (parsed === undefined) {
    return {
      ok: false,
      warnings,
      error: `could not read peak windows from: ${sentence.slice(0, 120)}`,
      snapshot: undefined,
    }
  }
  if (!parsed.weekdaysOnly) {
    warnings.push('the published rule no longer names 周一至周五; re-check the weekday scope before trusting the clock')
  }
  if (!detectHolidayExclusion(text)) {
    warnings.push('the published rule no longer excludes 法定节假日 from peak hours')
  }
  if (!detectWeekendOffpeak(text)) {
    warnings.push('the published rule no longer names weekends as off-peak')
  }

  const previousModels = options.fallbackModels ?? cloneBuiltInSnapshot().models
  const tableResult = parsePriceModels(html)
  /** @type {ModelPrice[]} */
  const models = []
  for (const { id } of MODEL_ROWS) {
    const parsedRow = tableResult.models.find((model) => model.id === id)
    const previous = previousModels.find((model) => model.id === id)
    if (parsedRow !== undefined) {
      models.push({ ...parsedRow, aliases: previous?.aliases ?? [] })
      continue
    }
    warnings.push(`price row for ${id} could not be read; keeping the previous row`)
    if (previous !== undefined) models.push(previous)
  }
  for (const warning of tableResult.warnings) {
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  if (models.length === 0) {
    warnings.push('no price rows could be read; keeping the built-in price table')
    models.push(...previousModels)
  }

  return {
    ok: true,
    warnings,
    error: undefined,
    snapshot: {
      version: SNAPSHOT_VERSION,
      capturedAt: new Date(now).toISOString(),
      source,
      wording: sentence,
      windows: parsed.windows,
      offpeakMultiplier: DEFAULT_OFFPEAK_MULTIPLIER,
      models,
      notes: [
        'Parsed from the official pricing page by dsh-peakhour-withtiaoxiu.',
        'The peak rule keys off the weekday (Mon-Fri), so a 调休 makeup workday on a weekend stays off-peak.',
      ],
    },
  }
}

/**
 * Apply a user override layer on top of a snapshot.
 *
 * The override form is deliberately small: whole windows, the off-peak
 * multiplier, or an edit to one model's prices. Anything present in the
 * override wins outright — it is the escape hatch for a user who knows better
 * than the parser.
 *
 * @param {PolicySnapshot} snapshot Base snapshot.
 * @param {{ windows?: { from: number, to: number }[], offpeakMultiplier?: number, models?: Partial<ModelPrice>[] }} [override] User override.
 * @returns {PolicySnapshot} The merged snapshot.
 */
export function applyOverride(snapshot, override) {
  if (override === undefined) return snapshot
  const merged = JSON.parse(JSON.stringify(snapshot))
  if (Array.isArray(override.windows) && override.windows.length > 0) {
    merged.windows = [...override.windows].sort((a, b) => a.from - b.from)
    merged.notes = [...(merged.notes ?? []), 'Peak windows are overridden by plugin config.']
  }
  if (typeof override.offpeakMultiplier === 'number' && override.offpeakMultiplier > 0) {
    merged.offpeakMultiplier = override.offpeakMultiplier
  }
  if (Array.isArray(override.models) && override.models.length > 0) {
    for (const patch of override.models) {
      if (patch === undefined || typeof patch.id !== 'string') continue
      const existing = merged.models.find((model) => model.id === patch.id)
      if (existing === undefined) {
        merged.models.push({ ...patch })
        continue
      }
      Object.assign(existing, patch, {
        peak: { ...existing.peak, ...(patch.peak ?? {}) },
        offpeak: { ...existing.offpeak, ...(patch.offpeak ?? {}) },
      })
    }
    merged.notes = [...(merged.notes ?? []), 'One or more price rows are overridden by plugin config.']
  }
  return merged
}

/**
 * Validate a snapshot loaded from disk or the network before it is trusted.
 * @param {unknown} value Candidate snapshot.
 * @returns {{ ok: boolean, error?: string, snapshot?: PolicySnapshot }} Validation outcome.
 */
export function validateSnapshot(value) {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'snapshot is not an object' }
  const candidate = /** @type {Record<string, unknown>} */ (value)
  if (candidate.version !== SNAPSHOT_VERSION) {
    return { ok: false, error: `unsupported snapshot version ${String(candidate.version)}` }
  }
  if (!Array.isArray(candidate.windows) || candidate.windows.length === 0) {
    return { ok: false, error: 'snapshot has no peak windows' }
  }
  for (const window of candidate.windows) {
    if (typeof window !== 'object' || window === null) return { ok: false, error: 'a peak window is not an object' }
    const { from, to } = /** @type {{ from?: unknown, to?: unknown }} */ (window)
    if (typeof from !== 'number' || typeof to !== 'number' || !(to > from) || from < 0 || to > 24 * 60) {
      return { ok: false, error: `invalid peak window ${String(from)}-${String(to)}` }
    }
  }
  if (!Array.isArray(candidate.models)) return { ok: false, error: 'snapshot has no price table' }
  return { ok: true, snapshot: /** @type {PolicySnapshot} */ (value) }
}

export { BUILT_IN_SNAPSHOT, CAPTURED_WORDING, cloneBuiltInSnapshot }
