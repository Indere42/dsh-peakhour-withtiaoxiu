/**
 * End-to-end test of the host service against a local stand-in for the two
 * upstream sources. Nothing is mocked inside the plugin: a real HTTP server
 * serves the pricing page and the holiday calendar, the service fetches them
 * over the loopback, parses them, and the resulting state document is asserted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PeakHourService } from '../src/host/service.js'
import { CAPTURED_WORDING } from '../src/core/snapshot.js'

const PRICING_HTML = `<!doctype html><html><body>
<p>(2) ${CAPTURED_WORDING}</p>
<table>
  <tr><th>模型</th><th>deepseek-flash</th><th>deepseek-v4-pro</th></tr>
  <tr><td></td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr>
  <tr><td rowspan="2">百万tokens输入（缓存命中）</td><td>空闲时段 0.02元</td><td>空闲时段 0.15元</td></tr>
  <tr><td>高峰时段 0.04元</td><td>高峰时段 0.30元</td></tr>
  <tr><td rowspan="2">百万tokens输入（缓存未命中）</td><td>空闲时段 1元</td><td>空闲时段 4.5元</td></tr>
  <tr><td>高峰时段 2元</td><td>高峰时段 9.0元</td></tr>
  <tr><td rowspan="2">百万tokens输出</td><td>空闲时段 4元</td><td>空闲时段 13.5元</td></tr>
  <tr><td>高峰时段 8元</td><td>高峰时段 27.0元</td></tr>
</table></body></html>`

/** A `YYYY-MM-DD` key offset from today by whole days, in Beijing terms. */
function beijingKeyIn(days) {
  const shifted = new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${month}-${day}`
}

/**
 * The next date with the given Beijing weekday, at least one day out.
 * @param {number} target Weekday ordinal.
 * @returns {string} The date key.
 */
function nextWeekdayKey(target) {
  for (let offset = 1; offset < 15; offset += 1) {
    const key = beijingKeyIn(offset)
    const weekday = new Date(`${key}T00:00:00Z`).getUTCDay()
    if (weekday === target) return key
  }
  return beijingKeyIn(1)
}

/** The next Sunday's date key. */
function nextSundayKey() {
  return nextWeekdayKey(0)
}

/** The next Monday's date key. */
function nextMondayKey() {
  return nextWeekdayKey(1)
}

/** One year of holiday facts, shaped like the holiday-cn dataset. */
const HOLIDAY_JSON = JSON.stringify({
  year: new Date().getUTCFullYear(),
  papers: ['https://www.gov.cn/example'],
  days: [
    { name: '测试节', date: nextSundayKey(), isOffDay: false },
    { name: '测试节', date: nextMondayKey(), isOffDay: true },
  ],
})

/**
 * Start a local server for the two upstream documents.
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>} Server handle.
 */
async function startUpstream() {
  const server = createServer((req, res) => {
    if (req.url === '/pricing') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PRICING_HTML)
      return
    }
    if (req.url?.startsWith('/holiday-')) {
      const year = Number(req.url.slice('/holiday-'.length).replace('.json', ''))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(HOLIDAY_JSON.replace(`"year":${new Date().getUTCFullYear()}`, `"year":${year}`))
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    close: () => new Promise((resolve) => { server.close(() => resolve()) }),
  }
}

test('the service syncs from upstream and renders a complete state document', async () => {
  const upstream = await startUpstream()
  const home = await mkdtemp(join(tmpdir(), 'peakhour-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // Point the plugin's two sources at the local stand-in.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = String(input)
    const mapped = url.includes('api-docs.deepseek.com')
      ? `${upstream.origin}/pricing`
      : url.includes('holiday-cn')
        ? `${upstream.origin}/holiday-${url.slice(url.lastIndexOf('/') + 1)}`
        : url
    return originalFetch(mapped, init)
  }

  try {
    const service = new PeakHourService({
      enabled: true,
      autoSync: true,
      syncIntervalMinutes: 180,
      pollIntervalSec: 15,
      offpeakMultiplier: 0.5,
      override: undefined,
      holidays: [],
      workdays: [],
    })
    await service.start()
    service.stop()

    const state = service.state()
    assert.equal(state.errors.policy, undefined, String(state.errors.policy))
    assert.deepEqual(state.policy.windows, [
      { from: 9 * 60, to: 12 * 60 },
      { from: 14 * 60, to: 18 * 60 },
    ])
    assert.equal(state.policy.source, 'network')
    assert.equal(state.policy.offpeakMultiplier, 0.5)
    const flash = state.policy.models.find((model) => model.id === 'deepseek-flash')
    assert.deepEqual(flash.peak, { cacheHit: 0.04, inputMiss: 2, output: 8 })
    assert.deepEqual(flash.offpeak, { cacheHit: 0.02, inputMiss: 1, output: 4 })
    // The unit price column follows the current period.
    assert.deepEqual(
      state.policy.models[0].unitPrice,
      state.period.peak ? state.policy.models[0].peak : state.policy.models[0].offpeak,
    )
    // The calendar arrived and recorded the makeup workday.
    assert.equal(state.calendar.source, 'holiday-cn')
    assert.ok(state.calendar.years.length >= 1)
    assert.equal(state.calendar.overriddenDays.length, 0)

    // The clock answers with a reason and a future boundary.
    assert.ok(['peak', 'offpeak'].includes(state.period.rate))
    assert.ok(state.period.boundaryMs > state.now - 60_000)
    assert.equal(typeof state.day.label, 'string')
    assert.equal(state.config.pollIntervalSec, 15)
  } finally {
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await upstream.close()
  }
})

test('a config holiday override reaches the calendar and the day classification', async () => {
  const upstream = await startUpstream()
  const home = await mkdtemp(join(tmpdir(), 'peakhour-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = String(input)
    const mapped = url.includes('api-docs.deepseek.com')
      ? `${upstream.origin}/pricing`
      : url.includes('holiday-cn')
        ? `${upstream.origin}/holiday-${url.slice(url.lastIndexOf('/') + 1)}`
        : url
    return originalFetch(mapped, init)
  }
  // Declare today a statutory holiday through config.
  const today = beijingKeyIn(0)

  try {
    const service = new PeakHourService({
      enabled: true,
      autoSync: true,
      syncIntervalMinutes: 180,
      pollIntervalSec: 15,
      offpeakMultiplier: 0.5,
      override: undefined,
      holidays: [today],
      workdays: [],
    })
    await service.start()
    service.stop()
    const state = service.state()
    assert.ok(state.calendar.overriddenDays.includes(today))
    // A holiday is off-peak all day, whatever the weekday and time.
    assert.equal(state.day.holiday, true)
    assert.equal(state.period.peak, false)
    assert.equal(state.period.reason, 'holiday')
  } finally {
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await upstream.close()
  }
})

test('a failed sync keeps the built-in policy and reports the error', async () => {
  const home = await mkdtemp(join(tmpdir(), 'peakhour-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network down') }

  try {
    const service = new PeakHourService({
      enabled: true,
      autoSync: true,
      syncIntervalMinutes: 180,
      pollIntervalSec: 15,
      offpeakMultiplier: 0.5,
      override: undefined,
      holidays: [],
      workdays: [],
    })
    await service.start()
    service.stop()
    const state = service.state()
    // The clock still answers from the built-in snapshot...
    assert.equal(state.policy.source, 'builtin')
    assert.deepEqual(state.policy.windows, [
      { from: 9 * 60, to: 12 * 60 },
      { from: 14 * 60, to: 18 * 60 },
    ])
    // ...and the failure is reported rather than hidden.
    assert.match(String(state.errors.policy), /官网同步失败/)
    assert.match(String(state.errors.calendar), /节假日日历同步失败/)
  } finally {
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
