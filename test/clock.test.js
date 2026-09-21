/**
 * Tests for the peak/off-peak billing clock. Times are written in Beijing
 * local terms through `at()` so the cases read like the published policy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REASONS,
  beijingMinuteToMs,
  classifyDay,
  periodAt,
  reasonForGap,
} from '../src/core/clock.js'

/** Official peak windows: Beijing weekday 09:00-12:00 and 14:00-18:00. */
const WINDOWS = [
  { from: 9 * 60, to: 12 * 60 },
  { from: 14 * 60, to: 18 * 60 },
]

/** 2026 statutory holiday/makeup facts, taken from NateScarlet/holiday-cn 2026.json. */
const CALENDAR = {
  entries: Object.fromEntries(
    [
      ['2026-09-20', '国庆节', false],
      ['2026-09-25', '中秋节', true],
      ['2026-09-26', '中秋节', true],
      ['2026-09-27', '中秋节', true],
      // The full 2026 National Day golden week, plus its makeup workday.
      ['2026-10-01', '国庆节', true],
      ['2026-10-02', '国庆节', true],
      ['2026-10-03', '国庆节', true],
      ['2026-10-04', '国庆节', true],
      ['2026-10-05', '国庆节', true],
      ['2026-10-06', '国庆节', true],
      ['2026-10-07', '国庆节', true],
      ['2026-10-10', '国庆节', false],
      ['2026-05-01', '劳动节', true],
      ['2026-05-09', '劳动节', false],
    ].map(([date, name, isOffDay]) => [date, { date, name, isOffDay }]),
  ),
}

const POLICY = { windows: WINDOWS, calendar: CALENDAR }

/**
 * Epoch milliseconds for a Beijing wall-clock moment.
 * @param {string} dateKey `YYYY-MM-DD`.
 * @param {number} hour Beijing hour.
 * @param {number} minute Beijing minute.
 * @returns {number} Epoch milliseconds.
 */
function at(dateKey, hour, minute = 0) {
  return beijingMinuteToMs(dateKey, hour * 60 + minute)
}

test('a Monday inside a peak window bills peak', () => {
  // 2026-09-21 is a Monday.
  const state = periodAt(at('2026-09-21', 10, 30), POLICY)
  assert.equal(state.peak, true)
  assert.equal(state.rate, 'peak')
  assert.equal(state.reason, REASONS.inWindow)
  assert.equal(state.boundaryMinuteOfDay, 12 * 60)
  assert.equal(state.boundaryMs, at('2026-09-21', 12, 0))
  assert.equal(state.nextRate, 'offpeak')
})

test('the lunch break between the two windows is off-peak', () => {
  const state = periodAt(at('2026-09-21', 13, 0), POLICY)
  assert.equal(state.peak, false)
  assert.equal(state.reason, REASONS.lunchBreak)
  // Next flip is the afternoon window opening at 14:00.
  assert.equal(state.boundaryMs, at('2026-09-21', 14, 0))
  assert.equal(state.nextRate, 'peak')
})

test('before the first window and after the last one are both off-peak', () => {
  const early = periodAt(at('2026-09-21', 7, 15), POLICY)
  assert.equal(early.reason, REASONS.beforeFirstWindow)
  assert.equal(early.boundaryMs, at('2026-09-21', 9, 0))

  const late = periodAt(at('2026-09-21', 22, 5), POLICY)
  assert.equal(late.reason, REASONS.afterLastWindow)
  // After the last window the clock rolls to tomorrow's first window.
  assert.equal(late.boundaryMs, at('2026-09-22', 9, 0))
})

test('a plain Saturday is off-peak all day', () => {
  // 2026-09-19 is a Saturday.
  const state = periodAt(at('2026-09-19', 10, 30), POLICY)
  assert.equal(state.peak, false)
  assert.equal(state.reason, REASONS.weekend)
  assert.equal(state.day.weekend, true)
  assert.equal(state.boundaryMs, at('2026-09-21', 9, 0))
})

test('a 调休 makeup workday on a Sunday is STILL off-peak (the official rule keys off the weekday)', () => {
  // 2026-09-20 is a Sunday that the State Council designated a makeup workday.
  const state = periodAt(at('2026-09-20', 10, 30), POLICY)
  assert.equal(state.day.makeupWorkday, true)
  assert.equal(state.day.holiday, false)
  assert.equal(state.day.workday, false)
  assert.equal(state.peak, false)
  assert.equal(state.reason, REASONS.weekend)
})

test('a 调休 makeup workday on a Saturday is off-peak too', () => {
  // 2026-10-10 is a Saturday designated a makeup workday.
  const state = periodAt(at('2026-10-10', 15, 0), POLICY)
  assert.equal(state.day.makeupWorkday, true)
  assert.equal(state.peak, false)
  assert.equal(state.reason, REASONS.weekend)
})

test('a statutory holiday on a weekday skips that day\'s peak windows entirely', () => {
  // 2026-10-01 is a Thursday and National Day.
  const state = periodAt(at('2026-10-01', 10, 30), POLICY)
  assert.equal(state.day.holiday, true)
  assert.equal(state.holidayName, '国庆节')
  assert.equal(state.peak, false)
  assert.equal(state.reason, REASONS.holiday)
  // The next peak opening is the first window of the next billable weekday.
  assert.equal(state.boundaryMs, at('2026-10-08', 9, 0))
})

test('a holiday running across a weekend finds the next workday', () => {
  // 2026-09-25 (Fri) .. 2026-09-27 (Sun) is 中秋节; Mon 09-28 is a workday.
  const friday = periodAt(at('2026-09-25', 10, 0), POLICY)
  assert.equal(friday.reason, REASONS.holiday)
  assert.equal(friday.boundaryMs, at('2026-09-28', 9, 0))

  const sunday = periodAt(at('2026-09-27', 20, 0), POLICY)
  assert.equal(sunday.reason, REASONS.holiday)
  assert.equal(sunday.boundaryMs, at('2026-09-28', 9, 0))
})

test('the last peak window of a Friday rolls past the weekend to Monday', () => {
  // 2026-09-18 is a Friday. After 18:00 the next peak opening is Monday 09:00.
  const state = periodAt(at('2026-09-18', 19, 30), POLICY)
  assert.equal(state.reason, REASONS.afterLastWindow)
  assert.equal(state.boundaryMs, at('2026-09-21', 9, 0))
})

test('an empty holiday calendar degrades to the plain weekday rule', () => {
  const plain = { windows: WINDOWS }
  assert.equal(periodAt(at('2026-09-21', 10, 0), plain).peak, true)
  assert.equal(periodAt(at('2026-09-20', 10, 0), plain).peak, false)
  assert.equal(periodAt(at('2026-09-20', 10, 0), plain).day.holidayKnown, false)
})

test('window edges are half-open: 09:00 is peak, 12:00 is not', () => {
  assert.equal(periodAt(at('2026-09-21', 9, 0), POLICY).peak, true)
  assert.equal(periodAt(at('2026-09-21', 11, 59), POLICY).peak, true)
  const noon = periodAt(at('2026-09-21', 12, 0), POLICY)
  assert.equal(noon.peak, false)
  assert.equal(noon.reason, REASONS.lunchBreak)
  assert.equal(periodAt(at('2026-09-21', 14, 0), POLICY).peak, true)
  const six = periodAt(at('2026-09-21', 18, 0), POLICY)
  assert.equal(six.peak, false)
  assert.equal(six.reason, REASONS.afterLastWindow)
})

test('the boundary instant is exclusive: the state flips exactly at it', () => {
  const before = periodAt(at('2026-09-21', 11, 59) + 59_000, POLICY)
  assert.equal(before.peak, true)
  assert.equal(before.boundaryMs, at('2026-09-21', 12, 0))
  assert.equal(periodAt(before.boundaryMs, POLICY).peak, false)
})

test('classifyDay exposes the reason behind each classification', () => {
  // 2026-09-21 is a Monday (weekday ordinal 1).
  assert.deepEqual(classifyDay('2026-09-21', 1, CALENDAR), {
    weekend: false,
    holiday: false,
    makeupWorkday: false,
    workday: true,
    holidayKnown: false,
    holidayName: undefined,
  })
  const makeup = classifyDay('2026-09-20', 0, CALENDAR)
  assert.equal(makeup.weekend, true)
  assert.equal(makeup.makeupWorkday, true)
  assert.equal(makeup.workday, false)
})

test('reasonForGap covers the gaps of a two-window schedule', () => {
  assert.equal(reasonForGap(0, WINDOWS), REASONS.beforeFirstWindow)
  assert.equal(reasonForGap(13 * 60, WINDOWS), REASONS.lunchBreak)
  assert.equal(reasonForGap(23 * 60, WINDOWS), REASONS.afterLastWindow)
  assert.equal(reasonForGap(600, []), REASONS.afterLastWindow)
})
