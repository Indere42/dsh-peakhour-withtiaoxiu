/**
 * Host half of dsh-peakhour-withtiaoxiu.
 *
 * The host owns everything stateful: the policy snapshot (built-in, then synced
 * from the official pricing page, then overridden by config), the Chinese
 * holiday/调休 calendar, the sync schedule, and the two read-only routes the
 * browser reads. The browser half never fetches a third-party origin itself and
 * never holds a credential — it only renders the document this half serves.
 *
 * @module dsh-peakhour-withtiaoxiu
 */

import { PeakHourService } from '../src/host/service.js'
import { makeRefreshRoute, makeStateRoute } from '../src/host/routes.js'

/** Cordis plugin name. */
export const name = 'dsh-peakhour-withtiaoxiu'

/**
 * Services required before mounting. `webServer` is the route registry (the
 * same one every other web-facing plugin registers into). `settings` is
 * injected separately and is optional: without it the plugin still runs, it
 * just cannot be configured from the settings page.
 */
export const inject = ['webServer']

/** Settings namespace this plugin edits when the settings service is present. */
export const SETTINGS_NAMESPACE = 'dsh-peakhour-withtiaoxiu'

/**
 * Config fields and their defaults, offered to the settings service so its
 * generated form matches what `resolveConfig` accepts. Declared as plain
 * defaults (not a schema object) so the plugin stays valid whether the host
 * settings service expects a schemastery schema or a token gate.
 */
const CONFIG_SHAPE = {
  enabled: true,
  autoSync: true,
  syncIntervalMinutes: 180,
  pollIntervalSec: 15,
  offpeakMultiplier: 0.5,
  holidays: [],
  workdays: [],
}

/**
 * Fill in every unset config field.
 * @param {object | undefined} config Raw plugin config.
 * @returns {import('../src/host/service.js').ServiceOptions} Resolved options.
 */
export function resolveConfig(config) {
  const raw = config ?? {}
  return {
    enabled: raw.enabled !== false,
    autoSync: raw.autoSync !== false,
    syncIntervalMinutes: numberOr(raw.syncIntervalMinutes, 180),
    pollIntervalSec: numberOr(raw.pollIntervalSec, 15),
    offpeakMultiplier: numberOr(raw.offpeakMultiplier, 0.5),
    override:
      raw.override !== undefined && typeof raw.override === 'object'
        ? raw.override
        : raw.peakWindows !== undefined || raw.models !== undefined
          ? { windows: raw.peakWindows, offpeakMultiplier: raw.offpeakMultiplier, models: raw.models }
          : undefined,
    holidays: stringArray(raw.holidays),
    workdays: stringArray(raw.workdays),
  }
}

/**
 * A finite number, or a fallback.
 * @param {unknown} value Candidate.
 * @param {number} fallback Value to use when the candidate is unusable.
 * @returns {number} The number to use.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A `YYYY-MM-DD` string array from an unknown value.
 * @param {unknown} value Candidate.
 * @returns {string[]} The usable dates.
 */
function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry))
}

/**
 * Host plugin body.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {object} [config] Plugin config from the profile layer.
 */
export function apply(ctx, config) {
  let options = resolveConfig(config)
  /** @type {PeakHourService | undefined} */
  let service
  /** @type {(() => void) | undefined} */
  let disposeRoutes
  /** @type {Promise<void> | undefined} */
  let pendingStop

  /** Mount or re-mount the service and its routes for the current options. */
  const rearm = () => {
    if (!options.enabled) {
      pendingStop = service?.stop()
      service = undefined
      disposeRoutes?.()
      disposeRoutes = undefined
      return
    }
    if (service !== undefined) {
      void service.applyOptions(options)
      return
    }
    const next = new PeakHourService(options)
    service = next
    const begin = () => {
      if (service !== next) return
      const disposers = [makeStateRoute(ctx, next), makeRefreshRoute(ctx, next)].map((route) => ctx.webServer.register(route))
      disposeRoutes = () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // A route already released by a teardown race is not an error.
          }
        }
      }
      void next.start()
    }
    if (pendingStop !== undefined) void pendingStop.then(begin, begin)
    else begin()
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = /** @type {{ installSection?: Function, register?: Function }} */ (settingsCtx.settings)
    try {
      if (typeof settings?.installSection === 'function') {
        settings.installSection(ctx, SETTINGS_NAMESPACE, CONFIG_SHAPE, config ?? {}, {
          setSource: (/** @type {() => object} */ next) => {
            options = resolveConfig(next())
            rearm()
          },
          onChange: () => { rearm() },
        })
        return
      }
      if (typeof settings?.register === 'function') {
        const scope = /** @type {{ get?: () => object, watch?: (cb: () => void) => void }} */ (
          settings.register(SETTINGS_NAMESPACE, CONFIG_SHAPE, { base: config ?? {} })
        )
        options = resolveConfig(scope?.get?.())
        scope?.watch?.(() => {
          options = resolveConfig(scope?.get?.())
          rearm()
        })
      }
    } catch {
      // Settings registration is a convenience, never a reason to lose the
      // clock: fall through to the config-block-only path.
    }
    rearm()
  })

  // Without a settings service the config block is the only source, so mount
  // right away; a later settings registration re-arms with the live value.
  rearm()

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      service?.stop()
      disposeRoutes?.()
    })
  }
}

/** The client module specifiers this plugin's browser half needs. */
export const clientInject = ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings']
