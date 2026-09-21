/**
 * The host-side billing-clock service.
 *
 * It owns three things:
 *   1. the current policy — the built-in snapshot, upgraded by a successful
 *      sync of the official pricing page, then overridden by plugin config;
 *   2. the Chinese holiday calendar that the peak rule excludes, refreshed
 *      from the `holiday-cn` dataset;
 *   3. the clock itself, computed on demand from `src/core/clock.js`.
 *
 * Syncs run on a schedule and in the background, but a sync is deliberately
 * cheap: one small HTML page and up to two small JSON files. No DeepSeek
 * request is made and no token is spent, so the schedule costs nothing beyond
 * ordinary outbound HTTP. Failures never replace a good snapshot — they are
 * recorded and surfaced to the UI, which keeps rendering the last known policy
 * with a visible staleness warning.
 *
 * @module dsh-peakhour-withtiaoxiu/src/host/service
 */

import { classifyDay, beijingDayStartMs, beijingFields, periodAt, shiftDateKey } from '../core/clock.js'
import { mergeCalendars, neededYears, parseHolidayYear, holidayUrlForYear } from '../core/calendar.js'
import { applyOverride, parsePolicy, validateSnapshot } from '../core/policy.js'
import {
  BUILT_IN_SNAPSHOT,
  OFFICIAL_PRICING_URL_EN,
  OFFICIAL_PRICING_URL_ZH,
  cloneBuiltInSnapshot,
} from '../core/snapshot.js'
import { CALENDAR_FILE, POLICY_FILE, readState, writeState } from './store.js'

/** Network timeout for one sync request. */
const FETCH_TIMEOUT_MS = 15_000

/** Colour tones the client maps to CSS classes. */
export const TONES = Object.freeze({ peak: 'peak', offpeak: 'offpeak' })

/**
 * @typedef {object} ServiceOptions
 * @property {boolean} enabled Master switch.
 * @property {number} pollIntervalSec How often the browser may ask for the state.
 * @property {number} syncIntervalMinutes How often the host re-reads the official page and calendar.
 * @property {boolean} autoSync Whether the host syncs on a schedule at all.
 * @property {number} offpeakMultiplier Fallback multiplier when the policy does not carry one.
 * @property {{ windows?: { from: number, to: number }[], offpeakMultiplier?: number, models?: object[] }} override User override layer.
 * @property {string[]} holidays Extra statutory-holiday dates (`YYYY-MM-DD`).
 * @property {string[]} workdays Extra makeup-workday dates (`YYYY-MM-DD`).
 */

/**
 * Fetch one URL as text with a hard timeout.
 * @param {string} url Absolute URL.
 * @returns {Promise<{ ok: boolean, status?: number, text?: string, error?: string }>} The fetch outcome.
 */
async function fetchText(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    })
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` }
    return { ok: true, status: response.status, text: await response.text() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** How long a snapshot is considered fresh before the UI calls it stale. */
const STALE_AFTER_MS = 30 * 24 * 3_600_000

export class PeakHourService {
  /**
   * @param {ServiceOptions} options Resolved plugin config.
   */
  constructor(options) {
    /** @type {ServiceOptions} */
    this.options = options
    // Two layers are kept apart on purpose: `base` is whatever the built-in
    // snapshot plus the latest successful sync produced, and `snapshot` is
    // that plus the config override. Keeping them separate means a later sync
    // can replace `base` without the override being applied twice.
    /** @type {import('../core/snapshot.js').PolicySnapshot} */
    this.base = cloneBuiltInSnapshot()
    this.recomputeEffective()
    /** @type {import('../core/clock.js').BillingCalendar} */
    this.calendar = { entries: {} }
    /** @type {string | undefined} */
    this.policyError = undefined
    /** @type {string[]} */
    this.warnings = []
    /** @type {string | undefined} */
    this.calendarError = undefined
    /** @type {'builtin' | 'disk' | 'network'} */
    this.policyOrigin = 'builtin'
    /** @type {boolean} */
    this.calendarFromNetwork = false
    /** @type {number} */
    this.calendarFetchedAt = 0
    /** @type {number} */
    this.policyFetchedAt = 0
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined
    /** @type {Promise<void> | undefined} */
    this.inFlight = undefined
    /** @type {boolean} */
    this.stopped = false
  }

  /** Rebuild the effective (override-applied) snapshot from `base`. */
  recomputeEffective() {
    this.snapshot = applyOverride(this.base, this.options.override)
  }

  /**
   * Load cached state, then run one sync if configured to.
   * @returns {Promise<void>} Resolves once the first sync attempt settled.
   */
  async start() {
    if (!this.options.enabled) return
    await this.loadFromDisk()
    if (this.options.autoSync) {
      await this.sync()
      this.armTimer()
    }
  }

  /** Stop the schedule. In-flight syncs finish and write their result. */
  stop() {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Schedule the next sync. */
  armTimer() {
    if (this.stopped || !this.options.autoSync) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    const delay = Math.max(1, this.options.syncIntervalMinutes) * 60_000
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sync().finally(() => { this.armTimer() })
    }, delay)
    this.timer.unref?.()
  }

  /** Read the cached policy and calendar, ignoring anything malformed. */
  async loadFromDisk() {
    const policyRead = await readState(POLICY_FILE)
    if (policyRead.found) {
      const validated = validateSnapshot(policyRead.value)
      if (validated.ok && validated.snapshot !== undefined) {
        this.base = validated.snapshot
        this.recomputeEffective()
        this.policyOrigin = 'disk'
        this.policyFetchedAt = Date.parse(validated.snapshot.capturedAt) || 0
      } else {
        this.warnings = [...this.warnings, `cached policy ignored: ${validated.error ?? 'invalid'}`]
      }
    }
    const calendarRead = await readState(CALENDAR_FILE)
    if (calendarRead.found && typeof calendarRead.value === 'object' && calendarRead.value !== null) {
      const cached = /** @type {{ entries?: object, years?: number[], papers?: string[], fetchedAt?: number }} */ (calendarRead.value)
      this.calendar = {
        entries: /** @type {Record<string, import('../core/clock.js').CalendarEntry>} */ (cached.entries ?? {}),
        years: cached.years ?? [],
        papers: cached.papers ?? [],
      }
      this.calendarFetchedAt = cached.fetchedAt ?? 0
      this.calendarFromNetwork = (cached.years ?? []).length > 0
    }
  }

  /**
   * Run one sync: official pricing page plus the holiday calendar.
   * Concurrent calls join the in-flight run instead of stacking up.
   * @returns {Promise<void>} Resolves when the run settled.
   */
  async sync() {
    if (this.inFlight !== undefined) return this.inFlight
    this.inFlight = this.runSync().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  /** The body of one sync run. */
  async runSync() {
    await this.syncPolicy()
    await this.syncCalendar()
  }

  /** Re-read the official pricing page and adopt it when it parses. */
  async syncPolicy() {
    const result = await fetchText(OFFICIAL_PRICING_URL_ZH)
    if (!result.ok) {
      // The English mirror is a genuine second chance: same policy, separate
      // page, so a Chinese-page outage or rewrite does not blind the plugin.
      const mirror = await fetchText(OFFICIAL_PRICING_URL_EN)
      if (!mirror.ok) {
        this.policyError = `官网同步失败：${result.error ?? 'unknown'}（镜像同样失败：${mirror.error ?? 'unknown'}）`
        return
      }
      this.adoptPolicy(mirror.text ?? '', OFFICIAL_PRICING_URL_EN)
      return
    }
    this.adoptPolicy(result.text ?? '', OFFICIAL_PRICING_URL_ZH)
  }

  /**
   * Parse a fetched pricing page and adopt it when it validates.
   * @param {string} html Raw page HTML.
   * @param {string} source URL it came from.
   */
  adoptPolicy(html, source) {
    const parsed = parsePolicy(html, { source, fallbackModels: this.snapshot.models })
    if (!parsed.ok || parsed.snapshot === undefined) {
      this.policyError = parsed.error ?? '解析官网政策失败'
      this.warnings = parsed.warnings
      return
    }
    const validated = validateSnapshot(parsed.snapshot)
    if (!validated.ok || validated.snapshot === undefined) {
      this.policyError = validated.error ?? '解析结果校验失败'
      return
    }
    this.base = validated.snapshot
    this.recomputeEffective()
    this.policyError = undefined
    this.warnings = parsed.warnings
    this.policyOrigin = 'network'
    this.policyFetchedAt = Date.now()
    void writeState(POLICY_FILE, this.base)
  }

  /** Re-read the holiday calendar for the years the clock can reach. */
  async syncCalendar() {
    const wanted = neededYears(Date.now(), 1)
    const current = /** @type {number[]} */ (this.calendar.years ?? [])
    const missing = wanted.filter((year) => !current.includes(year))
    if (missing.length === 0) return

    /** @type {object[]} */
    const years = []
    const problems = []
    for (const year of wanted) {
      const result = await fetchText(holidayUrlForYear(year))
      if (!result.ok) {
        problems.push(`${year}: ${result.error ?? 'unknown'}`)
        continue
      }
      let body
      try {
        body = JSON.parse(result.text ?? '')
      } catch (error) {
        problems.push(`${year}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const parsed = parseHolidayYear(body, year)
      if (!parsed.ok) {
        problems.push(`${year}: ${parsed.error ?? 'invalid'}`)
        continue
      }
      years.push(parsed)
    }
    if (years.length === 0) {
      this.calendarError = `节假日日历同步失败：${problems.join('；')}`
      return
    }
    this.calendarError = problems.length === 0 ? undefined : `部分年份同步失败：${problems.join('；')}`
    const merged = mergeCalendars(years, { holidays: this.options.holidays, workdays: this.options.workdays })
    this.calendar = merged
    this.calendarFromNetwork = true
    this.calendarFetchedAt = Date.now()
    void writeState(CALENDAR_FILE, {
      fetchedAt: this.calendarFetchedAt,
      years: merged.years,
      papers: merged.papers,
      entries: merged.entries,
    })
  }

  /** Swap in new options (a settings edit) and resync. */
  async applyOptions(options) {
    this.options = options
    this.recomputeEffective()
    // A newly configured calendar override has to be folded into the calendar
    // that is already in memory, not only into the next fetched one.
    this.calendar = mergeCalendars(
      [{ entries: this.calendar.entries, years: this.calendar.years, papers: this.calendar.papers }],
      { holidays: options.holidays, workdays: options.workdays },
    )
    if (options.autoSync) await this.sync()
    this.armTimer()
  }

  /**
   * Resolve the billing period at one instant.
   * @param {number} ms Epoch milliseconds.
   * @returns {{ period: import('../core/clock.js').PeriodState, peakWindow: { from: number, to: number } | undefined }} The period and the window it sits in.
   */
  resolve(ms) {
    const period = periodAt(ms, { windows: this.snapshot.windows, calendar: this.calendar })
    const peakWindow = period.peak
      ? this.snapshot.windows.find((window) => {
        const from = beijingDayStartMs(period.dateKey) + window.from * 60_000
        const to = beijingDayStartMs(period.dateKey) + window.to * 60_000
        return ms >= from && ms < to
      })
      : undefined
    return { period, peakWindow }
  }

  /**
   * The next date the clock changes anything, for the UI's "接下来" line.
   * @param {number} ms Epoch milliseconds.
   * @returns {{ dateKey: string, workday: boolean, holidayName: string | undefined, firstWindow: number | undefined }} The next interesting day.
   */
  nextInterestingDay(ms) {
    const { dateKey } = beijingFields(ms)
    for (let offset = 0; offset < 10; offset += 1) {
      const key = shiftKey(dateKey, offset)
      const weekday = new Date(beijingDayStartMs(key) + 8 * 3_600_000).getUTCDay()
      const day = classifyDay(key, weekday, this.calendar)
      if (!day.workday) continue
      if (offset === 0) return { dateKey: key, workday: true, holidayName: undefined, firstWindow: this.snapshot.windows[0]?.from }
      return { dateKey: key, workday: true, holidayName: day.holidayName, firstWindow: this.snapshot.windows[0]?.from }
    }
    return { dateKey, workday: false, holidayName: undefined, firstWindow: this.snapshot.windows[0]?.from }
  }

  /**
   * Build the document the browser reads.
   * @param {number} nowMs Evaluation instant.
   * @returns {object} The state document.
   */
  state(nowMs = Date.now()) {
    const { period, peakWindow } = this.resolve(nowMs)
    const rate = period.rate
    const models = this.snapshot.models.map((model) => ({
      id: model.id,
      label: model.label,
      aliases: model.aliases ?? [],
      unitPrice: rate === 'peak' ? model.peak : model.offpeak,
      peak: model.peak,
      offpeak: model.offpeak,
    }))
    const age = this.policyFetchedAt === 0 ? undefined : nowMs - this.policyFetchedAt
    return {
      now: nowMs,
      generator: 'dsh-peakhour-withtiaoxiu',
      timezone: { id: 'Asia/Shanghai', label: '北京时间', offsetMinutes: 480 },
      period: {
        peak: period.peak,
        rate,
        tone: period.peak ? TONES.peak : TONES.offpeak,
        reason: period.reason,
        windowIndex: peakWindow === undefined ? undefined : this.snapshot.windows.findIndex((window) => window.from === peakWindow.from),
        boundaryMs: period.boundaryMs,
        boundaryMinuteOfDay: period.boundaryMinuteOfDay,
        nextRate: period.nextRate,
      },
      day: {
        dateKey: period.dateKey,
        workday: period.workday,
        weekend: period.weekend,
        holiday: period.holiday,
        holidayName: period.holidayName,
        makeupWorkday: period.makeupWorkday,
        holidayKnown: period.day.holidayKnown,
        label: describeDay(period),
      },
      next: this.nextInterestingDay(nowMs),
      policy: {
        source: this.policyOrigin,
        sourceUrl: this.snapshot.source,
        capturedAt: this.snapshot.capturedAt,
        fetchedAt: this.policyFetchedAt === 0 ? undefined : new Date(this.policyFetchedAt).toISOString(),
        stale: age === undefined ? false : age > STALE_AFTER_MS,
        wording: this.snapshot.wording,
        windows: this.snapshot.windows,
        offpeakMultiplier: this.snapshot.offpeakMultiplier ?? this.options.offpeakMultiplier,
        models,
        notes: this.snapshot.notes ?? [],
      },
      calendar: {
        source: this.calendarFromNetwork ? 'holiday-cn' : 'none',
        years: this.calendar.years ?? [],
        papers: this.calendar.papers ?? [],
        fetchedAt: this.calendarFetchedAt === 0 ? undefined : new Date(this.calendarFetchedAt).toISOString(),
        overriddenDays: this.calendar.overriddenDays ?? [],
      },
      errors: {
        policy: this.policyError,
        calendar: this.calendarError,
      },
      warnings: this.warnings,
      config: {
        enabled: this.options.enabled,
        pollIntervalSec: this.options.pollIntervalSec,
        syncIntervalMinutes: this.options.syncIntervalMinutes,
        autoSync: this.options.autoSync,
      },
    }
  }

  /**
   * The Model Outcome of a forced sync, for the refresh route.
   * @returns {Promise<object>} The refreshed state document.
   */
  async refreshAndState() {
    await this.sync()
    return this.state()
  }
}

/**
 * Shift a date key by whole days.
 * @param {string} dateKey `YYYY-MM-DD`.
 * @param {number} days Signed offset.
 * @returns {string} The shifted key.
 */
function shiftKey(dateKey, days) {
  return shiftDateKey(dateKey, days)
}

/**
 * A short human label for the day type, in Chinese (the UI language here).
 * @param {import('../core/clock.js').PeriodState} period The resolved period.
 * @returns {string} The label.
 */
function describeDay(period) {
  if (period.holiday) return `法定节假日${period.holidayName === undefined ? '' : `・${period.holidayName}`}（全天谷时）`
  if (period.weekend) return period.makeupWorkday ? '周末（调休上班日，仍按谷时）' : '周末（全天谷时）'
  if (period.workday) return '工作日'
  return '非工作日'
}

/** Re-exported for the host plugin body. */
export { BUILT_IN_SNAPSHOT }
