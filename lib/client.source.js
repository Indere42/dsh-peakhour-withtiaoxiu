/**
 * Browser half of dsh-peakhour-withtiaoxiu — the hand-written ESM source.
 *
 * Edit THIS file; `npm run build` wraps it into the browser bundle that the
 * DSH combo route serves as lib/client.js.
 */
/**
 * Browser half of dsh-peakhour-withtiaoxiu.
 *
 * The DSH shell exposes no slot an external plugin can register a sidebar row
 * into, so — exactly like the sibling usage plugin — the row is injected as
 * plain DOM in the family block under the New Session button, and self-heals
 * when a React re-render displaces it. Nothing here is React: the row and the
 * policy modal are plain DOM, so they can never disturb the shell's
 * reconciliation.
 *
 * The row shows the current billing period, the model unit price for that
 * period, and a minute-resolution countdown to the next switch. Clicking it
 * opens the policy modal: the published windows, the current price table, and
 * a manual "sync from the official page" button.
 *
 * No credential and no third-party origin: every value comes from the host's
 * own `/api/dsh-peakhour/state` document.
 *
 * @module dsh-peakhour-withtiaoxiu/client
 */

/** Plugin name for the cordis client registry. */
export const name = 'dsh-peakhour-withtiaoxiu'

/** Services this half reads; both are optional-neighbours already in the shell. */
export const inject = ['locale']

/** Host route the row reads. */
const STATE_URL = '/api/dsh-peakhour/state'

/** Host route that forces a sync. */
const REFRESH_URL = '/api/dsh-peakhour/refresh'

/** Stable attribute identifying the injected row. */
const ROW_ATTR = 'data-dsh-peakhour-entry'

/** Row selector for the idempotency guard and the self-healing observer. */
const ROW_SELECTOR = `[${ROW_ATTR}]`

/** The usage plugin's row, the anchor this row is seated after. */
const USAGE_ROW_SELECTOR = '[data-dsh-usage-entry]'

/** Family rows this plugin orders against. */
const FAMILY_SELECTORS = [
  '[data-dsh-taskboard-entry]',
  '[data-dsh-ssh-entry]',
  '[data-dsh-skill-explorer-entry]',
  '[data-dsh-usage-entry]',
  ROW_SELECTOR,
]

/** Countdown refresh cadence while the page is visible. */
const TICK_MS = 5_000

/** State re-fetch cadence while the page is visible. */
const POLL_MS = 15_000

/** Inline icon: a clock face with a half-filled disc, matching the shell's 18px glyphs. */
const ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 8V4.6"/><path d="M8 8l2.6 1.7"/></svg>'

/** Reason codes the host sends, mapped to the copy shown under the chip. */
const REASON_LABELS = {
  'in-window': '正在高峰时段内',
  'lunch-break': '午间低谷（12:00–14:00）',
  'before-first-window': '高峰前低谷（00:00–09:00）',
  'after-last-window': '高峰后低谷（18:00–24:00）',
  weekend: '周末全天谷时',
  holiday: '法定节假日全天谷时',
}

/**
 * The stylesheet, injected once. Kept as a string so the client half is a
 * single self-contained module with no separate asset to serve.
 */
const CSS = `
[${ROW_ATTR}]{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:8px;display:flex;align-items:center;gap:8px;padding:0 10px;font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}
[${ROW_ATTR}]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
[${ROW_ATTR}] .pk-icon{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center}
[${ROW_ATTR}] .pk-icon svg{width:18px;height:18px;display:block}
[${ROW_ATTR}] .pk-text{text-overflow:ellipsis;overflow:hidden;min-width:0}
[${ROW_ATTR}] .pk-rate{flex:none;margin-left:auto;font-variant-numeric:tabular-nums;opacity:.72}
[${ROW_ATTR}][data-tone="peak"] .pk-rate{color:#b45309;opacity:1;font-weight:600}
[${ROW_ATTR}][data-tone="peak"] .pk-icon{color:#b45309}
[data-dsh-frame][data-sidebar-collapsed] [${ROW_ATTR}],[data-sidebar-collapsed] [${ROW_ATTR}]{border-radius:50%;width:36px;height:36px;margin:0 auto 12px;padding:0;justify-content:center}
[data-dsh-frame][data-sidebar-collapsed] [${ROW_ATTR}] .pk-text,[data-sidebar-collapsed] [${ROW_ATTR}] .pk-text,[data-dsh-frame][data-sidebar-collapsed] [${ROW_ATTR}] .pk-rate,[data-sidebar-collapsed] [${ROW_ATTR}] .pk-rate{display:none}
.pk-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(15,18,24,.44);display:flex;align-items:center;justify-content:center;padding:24px;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
.pk-modal{box-sizing:border-box;width:min(760px,100%);max-height:min(84vh,860px);overflow:auto;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);box-shadow:0 18px 48px rgba(15,18,24,.28);padding:18px 20px 20px}
.pk-modal h2{margin:0;font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px}
.pk-modal h3{margin:18px 0 8px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.6}
.pk-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.pk-close{appearance:none;background:0 0;border:1px solid var(--dsw-alias-border-l3,#d9dde3);color:inherit;border-radius:8px;cursor:pointer;font:inherit;padding:3px 10px;opacity:.8}
.pk-close:hover{opacity:1}
.pk-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;border:1px solid transparent}
.pk-chip[data-tone="peak"]{background:rgba(180,83,9,.12);color:#b45309;border-color:rgba(180,83,9,.3)}
.pk-chip[data-tone="offpeak"]{background:rgba(21,128,61,.12);color:#15803d;border-color:rgba(21,128,61,.3)}
.pk-now{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}
.pk-muted{opacity:.68}
.pk-count{font-variant-numeric:tabular-nums}
.pk-note{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,currentColor 6%,transparent);font-size:12px}
.pk-warn{margin:8px 0 0;font-size:12px;color:#b45309}
.pk-err{margin:8px 0 0;font-size:12px;color:#dc2626}
.pk-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.pk-table th,.pk-table td{border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);padding:6px 8px;text-align:right}
.pk-table th:first-child,.pk-table td:first-child{text-align:left}
.pk-table thead th{opacity:.6;font-weight:600}
.pk-table tr[data-active="true"]{background:color-mix(in srgb,currentColor 7%,transparent);font-weight:600}
.pk-row{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:6px;font-size:12px}
.pk-actions{display:flex;gap:8px;margin-top:14px}
.pk-btn{appearance:none;border:1px solid var(--dsw-alias-border-l3,#d9dde3);background:0 0;color:inherit;border-radius:8px;cursor:pointer;font:inherit;padding:5px 12px}
.pk-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}
.pk-btn:disabled{opacity:.5;cursor:default}
.pk-link{color:inherit;opacity:.8}
.pk-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-top:6px;font-size:12px}
.pk-kv dt{opacity:.6}
.pk-kv dd{margin:0}
`

/**
 * Format a duration in milliseconds as a minute-resolution countdown.
 * @param {number} ms Remaining milliseconds.
 * @returns {string} `3 小时 12 分钟` style text.
 */
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '不到 1 分钟'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return '不到 1 分钟'
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts = []
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} 分钟`)
  return parts.join(' ')
}

/**
 * Render a `HH:MM` Beijing clock label from minutes since Beijing midnight.
 * @param {number} minuteOfDay Minutes since Beijing midnight.
 * @returns {string} The label.
 */
export function formatBeijingClock(minuteOfDay) {
  const hours = Math.floor(minuteOfDay / 60)
  const minutes = minuteOfDay % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/**
 * Format a date key plus a clock as `MM-DD HH:MM`.
 * @param {number} ms Epoch milliseconds of the Beijing moment.
 * @returns {string} The label.
 */
export function formatBeijingMoment(ms) {
  const shifted = new Date(ms + 8 * 3_600_000)
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const hours = String(shifted.getUTCHours()).padStart(2, '0')
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}

/**
 * The one-line summary of the current period for the sidebar row.
 * @param {object} state Host state document.
 * @returns {{ label: string, rate: string }} Row text and the rate column.
 */
export function rowSummary(state) {
  const unit = state.policy?.models?.[0]?.unitPrice?.inputMiss
  const rate = typeof unit === 'number' ? `¥${trimNumber(unit)}/M` : ''
  const peak = state.period?.peak === true
  return { label: peak ? '峰时' : '谷时', rate }
}

/**
 * Trim a price to at most two decimals without trailing zeros.
 * @param {number} value Price in CNY per million tokens.
 * @returns {string} The formatted price.
 */
function trimNumber(value) {
  return String(Number(value.toFixed(2)))
}

/**
 * Build the policy modal for one state document.
 * @param {object} state Host state document.
 * @param {{ onRefresh: () => Promise<void>, onClose: () => void, refreshing: boolean, error?: string }} actions Modal actions.
 * @returns {HTMLElement} The backdrop element to append.
 */
export function renderModal(state, actions) {
  const backdrop = document.createElement('div')
  backdrop.className = 'pk-backdrop'
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', 'DeepSeek 峰谷计价政策')

  const modal = document.createElement('div')
  modal.className = 'pk-modal'
  backdrop.append(modal)

  const period = state.period ?? {}
  const peak = period.peak === true

  const head = document.createElement('div')
  head.className = 'pk-head'
  const title = document.createElement('h2')
  title.textContent = 'DeepSeek API 峰谷计价'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'pk-close'
  close.textContent = '关闭'
  close.addEventListener('click', () => actions.onClose())
  head.append(title, close)
  modal.append(head)

  const now = document.createElement('div')
  now.className = 'pk-now'
  const chip = document.createElement('span')
  chip.className = 'pk-chip'
  chip.dataset.tone = peak ? 'peak' : 'offpeak'
  chip.textContent = peak ? '高峰时段' : '空闲时段'
  const clock = document.createElement('span')
  clock.className = 'pk-muted pk-count'
  clock.textContent = `北京时间 ${formatBeijingClock(beijingMinuteNow(state))}`
  const boundary = document.createElement('span')
  boundary.className = 'pk-count'
  boundary.textContent = `${formatCountdown(period.boundaryMs - state.now)}后转${period.nextRate === 'peak' ? '高峰' : '空闲'}（${formatBeijingMoment(period.boundaryMs)}）`
  now.append(chip, clock, boundary)
  modal.append(now)

  const reason = document.createElement('p')
  reason.className = 'pk-note'
  reason.textContent = `${state.day?.label ?? ''}（${REASON_LABELS[period.reason] ?? period.reason ?? ''}）。`
    + (state.calendar?.overriddenDays?.length > 0 ? `已应用 ${state.calendar.overriddenDays.length} 天人工覆盖。` : '')
  modal.append(reason)

  modal.append(sectionTitle('计价时段（' + (state.policy?.wording ? '官方原文' : '内置快照') + '）'))
  const windowsTable = document.createElement('table')
  windowsTable.className = 'pk-table'
  const windowsHead = document.createElement('thead')
  const windowsHeadRow = document.createElement('tr')
  for (const text of ['时段', '北京时间', '计价倍率']) {
    const th = document.createElement('th')
    th.textContent = text
    windowsHeadRow.append(th)
  }
  windowsHead.append(windowsHeadRow)
  const windowsBody = document.createElement('tbody')
  const multiplier = state.policy?.offpeakMultiplier ?? 0.5
  for (const [index, window] of (state.policy?.windows ?? []).entries()) {
    const tr = document.createElement('tr')
    tr.dataset.active = String(peak && period.windowIndex === index)
    tr.append(
      cell(`高峰 ${index + 1}`),
      cell(`${formatBeijingClock(window.from)} – ${formatBeijingClock(window.to)}`),
      cell('×2（基准价）'),
    )
    windowsBody.append(tr)
  }
  const offpeakRow = document.createElement('tr')
  offpeakRow.dataset.active = String(!peak)
  const windowList = (state.policy?.windows ?? []).map((window) => `${formatBeijingClock(window.from)}–${formatBeijingClock(window.to)}`).join('、')
  offpeakRow.append(
    cell('空闲（其余时段）'),
    cell(`00:00 – ${windowList.split('、')[0] ?? '09:00'}、窗口之间、18:00 – 24:00`),
    cell(`×${trimNumber(multiplier)}`),
  )
  windowsBody.append(offpeakRow)
  windowsTable.append(windowsHead, windowsBody)
  modal.append(windowsTable)

  modal.append(sectionTitle('当前单价（人民币 / 百万 tokens）'))
  const priceTable = document.createElement('table')
  priceTable.className = 'pk-table'
  const priceHead = document.createElement('thead')
  const priceHeadRow = document.createElement('tr')
  for (const text of ['模型', '输入·缓存命中', '输入·缓存未命中', '输出']) {
    const th = document.createElement('th')
    th.textContent = text
    priceHeadRow.append(th)
  }
  priceHead.append(priceHeadRow)
  const priceBody = document.createElement('tbody')
  for (const model of state.policy?.models ?? []) {
    const unit = model.unitPrice ?? {}
    const tr = document.createElement('tr')
    tr.append(
      cell(`${model.id}${model.label ? `（${model.label}）` : ''}`),
      cell(trimNumber(unit.cacheHit ?? 0)),
      cell(trimNumber(unit.inputMiss ?? 0)),
      cell(trimNumber(unit.output ?? 0)),
    )
    priceBody.append(tr)
  }
  priceTable.append(priceHead, priceBody)
  modal.append(priceTable)

  const caveat = document.createElement('p')
  caveat.className = 'pk-note'
  caveat.textContent = '判定规则：高峰仅限“周一至周五（不含中国法定节假日）”的上述窗口；其余时段——包括周末与法定节假日全天——均为空闲时段。'
    + '因此调休产生的周末上班日仍按空闲计价，法定节假日落在工作日则当天全部按空闲计价。'
  modal.append(caveat)
  if (state.next?.dateKey !== undefined && !state.day?.workday) {
    const nextLine = document.createElement('p')
    nextLine.className = 'pk-note'
    nextLine.textContent = `下一个工作日：${state.next.dateKey}${state.next.firstWindow === undefined ? '' : ` 从 ${formatBeijingClock(state.next.firstWindow)} 起进入高峰`}。`
    modal.append(nextLine)
  }

  const meta = document.createElement('dl')
  meta.className = 'pk-kv'
  const sourceLabel = state.policy?.source === 'network' ? '官网同步' : state.policy?.source === 'disk' ? '本地缓存' : '内置快照'
  appendKeyValue(meta, '政策来源', state.policy?.sourceUrl ?? '—')
  appendKeyValue(meta, '数据状态', `${sourceLabel}${state.policy?.capturedAt === undefined ? '' : ` · 记录于 ${state.policy.capturedAt}`}${state.policy?.stale === true ? ' · 已超过 30 天，建议刷新' : ''}`)
  appendKeyValue(meta, '节假日日历', state.calendar?.years?.length > 0 ? `${state.calendar.years.join(' / ')} 年（${state.calendar.source}）` : '未同步')
  appendKeyValue(meta, '解析说明', (state.policy?.notes ?? []).join(' '))
  modal.append(meta)

  for (const [label, message] of [['政策同步', state.errors?.policy], ['日历同步', state.errors?.calendar]]) {
    if (typeof message !== 'string' || message === '') continue
    const line = document.createElement('p')
    line.className = 'pk-warn'
    line.textContent = `${label}：${message}`
    modal.append(line)
  }
  for (const warning of state.warnings ?? []) {
    const line = document.createElement('p')
    line.className = 'pk-warn'
    line.textContent = `提示：${warning}`
    modal.append(line)
  }
  if (typeof actions.error === 'string' && actions.error !== '') {
    const line = document.createElement('p')
    line.className = 'pk-err'
    line.textContent = actions.error
    modal.append(line)
  }

  const actionsRow = document.createElement('div')
  actionsRow.className = 'pk-actions'
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'pk-btn'
  refresh.textContent = actions.refreshing ? '正在从官网更新…' : '从官网更新政策'
  refresh.disabled = actions.refreshing
  refresh.addEventListener('click', () => { void actions.onRefresh() })
  const site = document.createElement('a')
  site.className = 'pk-btn pk-link'
  site.href = state.policy?.sourceUrl ?? 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
  site.target = '_blank'
  site.rel = 'noreferrer noopener'
  site.textContent = '打开官网价目表 ↗'
  actionsRow.append(refresh, site)
  modal.append(actionsRow)

  return backdrop
}

/** A section heading element. */
function sectionTitle(text) {
  const heading = document.createElement('h3')
  heading.textContent = text
  return heading
}

/** A table cell element. */
function cell(text) {
  const td = document.createElement('td')
  td.textContent = text
  return td
}

/** Append one definition pair. */
function appendKeyValue(list, key, value) {
  const dt = document.createElement('dt')
  dt.textContent = key
  const dd = document.createElement('dd')
  dd.textContent = value === undefined || value === '' ? '—' : String(value)
  list.append(dt, dd)
}

/** The current Beijing minute-of-day for the state's own instant. */
function beijingMinuteNow(state) {
  const shifted = new Date((state.now ?? Date.now()) + 8 * 3_600_000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/** Inject the stylesheet once. */
function ensureStyles() {
  if (document.querySelector('style[data-dsh-peakhour-css]') !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-dsh-peakhour-css', '')
  style.textContent = CSS
  document.head.append(style)
}

/** The sidebar column element, or undefined while the shell is not mounted. */
function sidebarRoot() {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild ?? undefined)
}

/** The New Session button the family block is anchored to. */
function newSessionButton(root) {
  const nested = root.querySelector('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) if (child.tagName === 'BUTTON') return child
  return undefined
}

/**
 * Build the row element.
 * @param {() => void} onActivate Click handler.
 * @returns {HTMLButtonElement} The detached row.
 */
function createRow(onActivate) {
  const row = document.createElement('button')
  row.type = 'button'
  row.setAttribute(ROW_ATTR, '')
  row.setAttribute('data-dsh-plugin', 'peakhour')
  row.setAttribute('data-dsh-part', 'sidebar-entry')
  const icon = document.createElement('span')
  icon.className = 'pk-icon'
  icon.innerHTML = ICON
  const text = document.createElement('span')
  text.className = 'pk-text'
  text.textContent = '峰谷 ——'
  const rate = document.createElement('span')
  rate.className = 'pk-rate'
  row.append(icon, text, rate)
  row.addEventListener('click', onActivate)
  return row
}

/** Whether the shell currently renders the sidebar collapsed. */
export function sidebarCollapsed() {
  return document.querySelector('[data-sidebar-collapsed]') !== null
}

/**
 * Client plugin body.
 * @param {object} ctx Client cordis context (only `locale` is read).
 */
export function apply(ctx) {
  if (typeof document === 'undefined' || document.querySelector(ROW_SELECTOR) !== null) return
  ensureStyles()

  /** @type {object | undefined} */
  let state
  let refreshing = false
  let modalError
  /** @type {HTMLElement | undefined} */
  let backdrop
  /** @type {HTMLElement | undefined} */
  let row

  const rerenderRow = () => {
    if (row === undefined) return
    if (state === undefined) {
      row.querySelector('.pk-text').textContent = '峰谷 ——'
      row.querySelector('.pk-rate').textContent = ''
      row.removeAttribute('data-tone')
      row.title = '正在读取峰谷计价状态…'
      return
    }
    const summary = rowSummary(state)
    const countdown = formatCountdown(state.period.boundaryMs - Date.now())
    row.querySelector('.pk-text').textContent = `${summary.label} · ${countdown}后转${state.period.nextRate === 'peak' ? '峰' : '谷'}`
    row.querySelector('.pk-rate').textContent = summary.rate
    row.dataset.tone = state.period.peak ? 'peak' : 'offpeak'
    row.title = `${state.day?.label ?? ''}｜点击查看峰谷计价政策`
  }

  const closeModal = () => {
    backdrop?.remove()
    backdrop = undefined
    document.removeEventListener('keydown', onKeyDown)
  }

  /** Escape closes the modal. */
  function onKeyDown(event) {
    if (event.key === 'Escape') closeModal()
  }

  const openModal = () => {
    if (state === undefined) return
    closeModal()
    const render = () => {
      if (state === undefined) return
      backdrop = renderModal(state, {
        refreshing,
        error: modalError,
        onClose: closeModal,
        onRefresh: async () => {
          refreshing = true
          modalError = undefined
          render()
          try {
            const response = await fetch(REFRESH_URL, { method: 'POST' })
            const body = await response.json()
            if (body?.state !== undefined) state = body.state
            else modalError = body?.error ?? '刷新失败'
          } catch (error) {
            modalError = error instanceof Error ? error.message : String(error)
          } finally {
            refreshing = false
            render()
            rerenderRow()
          }
        },
      })
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) closeModal()
      })
      document.body.append(backdrop)
      document.addEventListener('keydown', onKeyDown)
    }
    render()
  }

  /** Fetch the state document once. */
  const fetchState = async () => {
    try {
      const response = await fetch(STATE_URL)
      if (!response.ok) throw new Error(`state request failed: ${response.status}`)
      const body = await response.json()
      if (body?.state !== undefined) state = body.state
    } catch {
      // A failed poll keeps the last good state; the row simply stops moving.
    }
    rerenderRow()
  }

  row = createRow(() => { openModal() })

  /** Place the row after the family block, self-healing across re-renders. */
  let root
  let placed = false
  const place = () => {
    if (root !== undefined && !root.isConnected) {
      observer.disconnect()
      root = undefined
      placed = false
    }
    if (placed && row.isConnected) return
    root ??= sidebarRoot()
    if (root === undefined) return
    const button = newSessionButton(root)
    if (button === undefined) return
    const logoRow = button.closest('[class*="logoRow"]')
    const base = logoRow !== null && logoRow.parentElement === root ? logoRow : button
    const family = Array.from(root.children).filter(
      (element) => element instanceof HTMLElement && element.matches(FAMILY_SELECTORS.join(', ')),
    )
    const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
    root.insertBefore(row, anchor)
    placed = true
    observer.observe(root, { childList: true, subtree: true })
    rerenderRow()
  }

  const observer = new MutationObserver(() => { place() })

  const onBodyMutations = () => { place() }
  const bodyObserver = new MutationObserver(onBodyMutations)
  bodyObserver.observe(document.body, { childList: true, subtree: true })

  place()
  void fetchState()

  let tick
  let poll
  const startTimers = () => {
    if (tick !== undefined) return
    tick = window.setInterval(() => { rerenderRow() }, TICK_MS)
    poll = window.setInterval(() => { void fetchState() }, POLL_MS)
  }
  const stopTimers = () => {
    if (tick !== undefined) window.clearInterval(tick)
    if (poll !== undefined) window.clearInterval(poll)
    tick = undefined
    poll = undefined
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      void fetchState()
      startTimers()
    } else {
      stopTimers()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  if (document.visibilityState === 'visible') startTimers()

  ctx?.effect?.(() => () => {
    stopTimers()
    closeModal()
    observer.disconnect()
    bodyObserver.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    row?.remove()
  }, 'dsh-peakhour-withtiaoxiu: sidebar row')
}

