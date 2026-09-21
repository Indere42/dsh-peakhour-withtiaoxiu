/**
 * The DeepSeek official peak/off-peak billing clock, 调休-aware.
 *
 * Published policy (api-docs.deepseek.com/zh-cn/quick_start/pricing; the exact
 * wording is captured in data/policy.snapshot.json):
 *
 *   "空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
 *    9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日
 *    全天均为空闲时段。"
 *
 * Two consequences this module exists to get right:
 *
 *  1. The peak rule keys off the **weekday**, not off the government work
 *     calendar. A 调休 makeup workday that lands on a Saturday or Sunday is
 *     still a weekend day, so it bills off-peak the whole day. (2026-09-20, a
 *     Sunday designated as a makeup workday, is therefore off-peak.)
 *  2. A statutory holiday that lands on a weekday bills off-peak all day, so
 *     that day's peak windows are skipped entirely.
 *
 * Everything here is pure: the instant to evaluate and the policy inputs are
 * explicit parameters, so the logic is testable without a clock or a network.
 *
 * @module dsh-peakhour-withtiaoxiu/src/core/clock
 */

/** Minutes in a day. */
export const MINUTES_PER_DAY = 24 * 60

/** Beijing is UTC+8 year-round (the PRC observes no daylight saving), so a fixed shift is exact. */
export const BEIJING_UTC_OFFSET_MINUTES = 8 * 60

/** Weekday ordinals as reported by `Date.prototype.getUTCDay`. */
const SUNDAY = 0
const SATURDAY = 6

/** How many days the next-flip scan may walk before giving up on a malformed policy. */
const MAX_SCAN_DAYS = 8

/**
 * @typedef {object} PeakWindow
 * @property {number} from Inclusive start, minutes since Beijing midnight.
 * @property {number} to Exclusive end, minutes since Beijing midnight.
 */

/**
 * @typedef {object} CalendarEntry
 * @property {string} name Holiday name.
 * @property {string} date `YYYY-MM-DD`, Beijing.
 * @property {boolean} isOffDay True for a rest/holiday day, false for a makeup workday.
 */

/**
 * @typedef {object} BillingCalendar
 * @property {Record<string, CalendarEntry>} [entries] Date-keyed holiday facts.
 * @property {string[]} [holidays] Bare statutory-holiday date keys (manual override form).
 * @property {string[]} [workdays] Bare makeup-workday date keys (manual override form).
 */

/**
 * @typedef {object} PolicyInput
 * @property {PeakWindow[]} windows Peak windows in minutes since Beijing midnight.
 * @property {BillingCalendar} [calendar] Holiday facts.
 */

/**
 * @typedef {object} DayKind
 * @property {boolean} weekend Saturday or Sunday.
 * @property {boolean} holiday Statutory holiday, off all day.
 * @property {boolean} makeupWorkday 调休 makeup workday landing on a weekend.
 * @property {boolean} workday Billable on the weekday peak schedule.
 * @property {boolean} holidayKnown Whether the calendar had a fact for this date.
 * @property {string | undefined} holidayName
 */

/**
 * @typedef {object} PeriodState
 * @property {boolean} peak Whether the instant bills at peak rates.
 * @property {'peak' | 'offpeak'} rate The billing column in force.
 * @property {number} boundaryMs Instant the current period ends.
 * @property {number} boundaryMinuteOfDay Beijing minute-of-day of that instant.
 * @property {'peak' | 'offpeak'} nextRate Rate that takes effect at the boundary.
 * @property {string} reason Machine-readable reason code (see REASONS).
 * @property {string} dateKey Beijing calendar date, `YYYY-MM-DD`.
 * @property {boolean} workday Whether the day bills on the weekday peak schedule.
 * @property {boolean} holiday Statutory holiday (off all day).
 * @property {boolean} makeupWorkday 调休 makeup workday landing on a weekend.
 * @property {boolean} weekend Saturday or Sunday.
 * @property {string | undefined} holidayName Statutory holiday name, when one covers the day.
 * @property {DayKind} day Day classification behind the answer.
 */

/** Reason codes the UI maps to copy. */
export const REASONS = Object.freeze({
  inWindow: 'in-window',
  weekend: 'weekend',
  holiday: 'holiday',
  lunchBreak: 'lunch-break',
  beforeFirstWindow: 'before-first-window',
  afterLastWindow: 'after-last-window',
})

/**
 * Normalize a month/day pair into a `YYYY-MM-DD` key.
 * @param {number} year Full year.
 * @param {number} month 0-based month, as `Date` reports it.
 * @param {number} day Day of month.
 * @returns {string} The date key.
 */
export function dateKeyOf(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The Beijing calendar fields of an instant.
 * @param {number} ms Epoch milliseconds.
 * @returns {{ dateKey: string, weekday: number, minuteOfDay: number }} Beijing-local fields.
 */
export function beijingFields(ms) {
  const shifted = new Date(ms + BEIJING_UTC_OFFSET_MINUTES * 60_000)
  return {
    dateKey: dateKeyOf(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
    weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

/**
 * Start of a Beijing calendar day, as epoch milliseconds.
 * @param {string} dateKey `YYYY-MM-DD`.
 * @returns {number} Epoch milliseconds of 00:00 Beijing on that date.
 */
export function beijingDayStartMs(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return Date.UTC(year, month - 1, day) - BEIJING_UTC_OFFSET_MINUTES * 60_000
}

/**
 * The instant a Beijing minute-of-day begins on a given date.
 * @param {string} dateKey `YYYY-MM-DD`.
 * @param {number} minuteOfDay Minutes since Beijing midnight.
 * @returns {number} Epoch milliseconds.
 */
export function beijingMinuteToMs(dateKey, minuteOfDay) {
  return beijingDayStartMs(dateKey) + minuteOfDay * 60_000
}

/**
 * Shift a date key by whole days.
 * @param {string} dateKey `YYYY-MM-DD`.
 * @param {number} days Signed day offset.
 * @returns {string} The shifted date key.
 */
export function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return dateKeyOf(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
}

/**
 * Look one Beijing date up in the holiday calendar.
 * @param {BillingCalendar | undefined} calendar Holiday facts.
 * @param {string} dateKey `YYYY-MM-DD`.
 * @returns {{ known: boolean, offDay: boolean, name: string | undefined }} The day's holiday status.
 */
export function holidayLookup(calendar, dateKey) {
  if (calendar === undefined) return { known: false, offDay: false, name: undefined }
  const entry = calendar.entries?.[dateKey]
  if (entry !== undefined) {
    return { known: true, offDay: entry.isOffDay === true, name: entry.name }
  }
  if (Array.isArray(calendar.holidays) && calendar.holidays.includes(dateKey)) {
    return { known: true, offDay: true, name: undefined }
  }
  if (Array.isArray(calendar.workdays) && calendar.workdays.includes(dateKey)) {
    return { known: true, offDay: false, name: undefined }
  }
  return { known: false, offDay: false, name: undefined }
}

/**
 * Classify one Beijing day under the published rule.
 * @param {string} dateKey `YYYY-MM-DD`.
 * @param {number} weekday `Date` weekday ordinal of that date.
 * @param {BillingCalendar | undefined} calendar Holiday facts.
 * @returns {DayKind} The day's classification.
 */
export function classifyDay(dateKey, weekday, calendar) {
  const weekend = weekday === SATURDAY || weekday === SUNDAY
  const holiday = holidayLookup(calendar, dateKey)
  return {
    weekend,
    holiday: holiday.offDay,
    // Recorded for transparency: a weekend the government turned into a
    // workday. It does NOT make the day peak under the published rule.
    makeupWorkday: weekend && holiday.known && !holiday.offDay,
    workday: !weekend && !holiday.offDay,
    holidayKnown: holiday.known,
    holidayName: holiday.offDay ? holiday.name : undefined,
  }
}

/**
 * The billing period at an instant, plus the exact instant it next flips.
 *
 * The flip instant is exact (second precision) rather than minute-rounded, so
 * a caller can render a minute-resolution countdown from it without drift.
 *
 * @param {number} ms Epoch milliseconds to evaluate.
 * @param {PolicyInput} policy Peak windows and holiday facts.
 * @returns {PeriodState} The period state at `ms`.
 */
export function periodAt(ms, policy) {
  const windows = [...policy.windows].sort((a, b) => a.from - b.from)
  const fields = beijingFields(ms)
  const day = classifyDay(fields.dateKey, fields.weekday, policy.calendar)

  /**
   * Assemble a period state from a resolved boundary.
   * @param {boolean} peak Rate in force now.
   * @param {string} boundaryDateKey Beijing date the boundary falls on.
   * @param {number} boundaryMinuteOfDay Boundary minute-of-day.
   * @param {'peak' | 'offpeak'} nextRate Rate taking effect at the boundary.
   * @param {string} reason Reason code.
   * @returns {PeriodState} The period state.
   */
  const state = (peak, boundaryDateKey, boundaryMinuteOfDay, nextRate, reason) => ({
    peak,
    rate: peak ? 'peak' : 'offpeak',
    boundaryMs: beijingMinuteToMs(boundaryDateKey, boundaryMinuteOfDay),
    boundaryMinuteOfDay,
    nextRate,
    reason,
    dateKey: fields.dateKey,
    workday: day.workday,
    holiday: day.holiday,
    makeupWorkday: day.makeupWorkday,
    weekend: day.weekend,
    holidayName: day.holidayName,
    day,
  })

  // A rest day (weekend or statutory holiday) is off-peak until the next
  // billable weekday's first window opens.
  if (!day.workday) {
    const next = nextPeakStart(fields.dateKey, fields.minuteOfDay, windows, policy, true)
    return state(false, next.dateKey, next.minuteOfDay, 'peak', day.holiday ? REASONS.holiday : REASONS.weekend)
  }

  const open = windows.find((window) => fields.minuteOfDay >= window.from && fields.minuteOfDay < window.to)
  if (open !== undefined) {
    return state(true, fields.dateKey, open.to, 'offpeak', REASONS.inWindow)
  }

  const next = nextPeakStart(fields.dateKey, fields.minuteOfDay, windows, policy, false)
  return state(false, next.dateKey, next.minuteOfDay, 'peak', reasonForGap(fields.minuteOfDay, windows))
}

/**
 * The reason code for an off-peak instant inside a billable weekday.
 * @param {number} minuteOfDay Beijing minute-of-day.
 * @param {PeakWindow[]} windows Sorted peak windows.
 * @returns {string} Reason code.
 */
export function reasonForGap(minuteOfDay, windows) {
  if (windows.length === 0) return REASONS.afterLastWindow
  if (minuteOfDay < windows[0].from) return REASONS.beforeFirstWindow
  const last = windows[windows.length - 1]
  if (minuteOfDay >= last.to) return REASONS.afterLastWindow
  return REASONS.lunchBreak
}

/**
 * The next peak-window opening after a Beijing moment, walking forward across
 * days while honouring the weekend and holiday rules.
 *
 * @param {string} dateKey Starting Beijing date key.
 * @param {number} minuteOfDay Starting Beijing minute-of-day.
 * @param {PeakWindow[]} windows Sorted peak windows.
 * @param {PolicyInput} policy Policy input (for the holiday calendar).
 * @param {boolean} skipToday True when the rest of today is already known off-peak.
 * @returns {{ dateKey: string, minuteOfDay: number }} The next peak opening.
 */
export function nextPeakStart(dateKey, minuteOfDay, windows, policy, skipToday) {
  for (let dayOffset = 0; dayOffset < MAX_SCAN_DAYS; dayOffset += 1) {
    const cursor = shiftDateKey(dateKey, dayOffset)
    const startMs = beijingDayStartMs(cursor)
    const weekday = new Date(startMs + BEIJING_UTC_OFFSET_MINUTES * 60_000).getUTCDay()
    const day = classifyDay(cursor, weekday, policy.calendar)
    if (day.workday) {
      for (const window of windows) {
        if (dayOffset === 0 && (skipToday || window.from <= minuteOfDay)) continue
        return { dateKey: cursor, minuteOfDay: window.from }
      }
    }
  }
  // Unreachable for a sane policy (a full week always carries a workday).
  return { dateKey: shiftDateKey(dateKey, 1), minuteOfDay: 0 }
}
