/**
 * The Chinese statutory-holiday calendar, and its 调休 makeup workdays.
 *
 * Peak hours exclude statutory holidays, so the billing clock needs the State
 * Council calendar, not just weekdays. This module fetches it from the
 * `NateScarlet/holiday-cn` dataset (derived from the State Council's own
 * notices, with the source notice URL in each file) and normalizes it.
 *
 * The makeup-workday flag is recorded because it is the fact users ask about,
 * but it does NOT change the answer: the published DeepSeek rule keys off the
 * weekday, so a makeup workday on a weekend still bills off-peak. `classifyDay`
 * in `clock.js` is where that decision lives.
 *
 * A fetched year that cannot be parsed, or that returns a year other than the
 * one requested, is rejected: a wrong calendar would silently mis-price whole
 * days, which is worse than showing a stale calendar with a visible warning.
 *
 * @module dsh-peakhour-withtiaoxiu/src/core/calendar
 */

/**
 * @typedef {import('./clock.js').CalendarEntry} CalendarEntry
 * @typedef {import('./clock.js').BillingCalendar} BillingCalendar
 */

/** Where one year's holiday JSON lives. */
export const HOLIDAY_SOURCE_URL = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json'

/** Human label for the dataset, surfaced in the UI's data-source line. */
export const HOLIDAY_SOURCE_LABEL = 'NateScarlet/holiday-cn (国务院办公厅通知)'

/**
 * Build the URL for one year.
 * @param {number} year Four-digit year.
 * @returns {string} The dataset URL.
 */
export function holidayUrlForYear(year) {
  return HOLIDAY_SOURCE_URL.replace('{year}', String(year))
}

/**
 * Parse and validate one year's holiday JSON.
 * @param {unknown} body Parsed JSON body.
 * @param {number} expectedYear Year the caller asked for.
 * @returns {{ ok: boolean, error?: string, year?: number, papers?: string[], entries?: Record<string, CalendarEntry>, holidays?: string[], workdays?: string[] }} Parse outcome.
 */
export function parseHolidayYear(body, expectedYear) {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'holiday data is not an object' }
  const root = /** @type {Record<string, unknown>} */ (body)
  if (root.year !== expectedYear) {
    return { ok: false, error: `holiday data is for ${String(root.year)}, expected ${expectedYear}` }
  }
  if (!Array.isArray(root.days)) return { ok: false, error: 'holiday data has no days array' }

  /** @type {Record<string, CalendarEntry>} */
  const entries = {}
  /** @type {string[]} */
  const holidays = []
  /** @type {string[]} */
  const workdays = []
  for (const raw of root.days) {
    if (typeof raw !== 'object' || raw === null) continue
    const day = /** @type {Record<string, unknown>} */ (raw)
    if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue
    if (typeof day.isOffDay !== 'boolean') continue
    const name = typeof day.name === 'string' ? day.name : undefined
    entries[day.date] = { date: day.date, name: name ?? '', isOffDay: day.isOffDay }
    if (day.isOffDay) holidays.push(day.date)
    else workdays.push(day.date)
  }
  if (Object.keys(entries).length === 0) return { ok: false, error: 'holiday data has no usable days' }

  const papers = Array.isArray(root.papers) ? root.papers.filter((paper) => typeof paper === 'string') : []
  return { ok: true, year: expectedYear, papers, entries, holidays, workdays }
}

/**
 * Merge several parsed years into one date-keyed calendar.
 * @param {{ entries?: Record<string, CalendarEntry>, holidays?: string[], workdays?: string[], papers?: string[], year?: number }[]} years Parsed years.
 * @param {{ holidays?: string[], workdays?: string[] }} [override] User override date lists.
 * @returns {BillingCalendar & { years: number[], papers: string[], overriddenDays: string[] }} The merged calendar.
 */
export function mergeCalendars(years, override) {
  /** @type {Record<string, CalendarEntry>} */
  const entries = {}
  /** @type {Set<number>} */
  const yearSet = new Set()
  /** @type {Set<string>} */
  const papers = new Set()
  for (const year of years) {
    if (year.entries !== undefined) Object.assign(entries, year.entries)
    if (typeof year.year === 'number') yearSet.add(year.year)
    for (const paper of year.papers ?? []) papers.add(paper)
  }
  const overriddenDays = []
  for (const date of override?.holidays ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    entries[date] = { date, name: '用户指定节假日', isOffDay: true }
    overriddenDays.push(date)
  }
  for (const date of override?.workdays ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    entries[date] = { date, name: '用户指定调休上班日', isOffDay: false }
    overriddenDays.push(date)
  }
  return {
    entries,
    years: [...yearSet].sort((a, b) => a - b),
    papers: [...papers],
    overriddenDays,
  }
}

/**
 * The years a clock at `ms` might need: the current year and the next one, so
 * a New Year boundary is covered without waiting for a refresh.
 * @param {number} ms Epoch milliseconds.
 * @param {number} [span] Extra years after the current one.
 * @returns {number[]} Years to load, ascending.
 */
export function neededYears(ms, span = 1) {
  const year = new Date(ms + 8 * 3_600_000).getUTCFullYear()
  const years = []
  for (let offset = 0; offset <= span; offset += 1) years.push(year + offset)
  return years
}
