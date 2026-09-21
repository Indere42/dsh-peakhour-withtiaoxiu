/**
 * The plugin's HTTP routes.
 *
 * The state document is fenced like the other personal-data routes in this
 * family: a loopback request always passes, and a request from a paired LAN
 * browser passes only when the remote-web-ui pairing service says so. The
 * plugin exposes no credentials and holds no API key, so the fence exists to
 * keep the endpoint off an unpaired network rather than to protect a secret.
 *
 * @module dsh-peakhour-withtiaoxiu/src/host/routes
 */

/** Prefix every route of this plugin lives under. */
export const API_PREFIX = '/api/dsh-peakhour'

/**
 * Whether one request may read the state document.
 * @param {object} ctx Host context; may expose a pairing service.
 * @param {import('node:http').IncomingMessage} req Incoming request.
 * @returns {boolean} True when the request is allowed.
 */
export function isAllowed(ctx, req) {
  const paired = typeof ctx?.get === 'function' ? ctx.get('remoteWebUiPairing', false) : undefined
  if (paired !== undefined && typeof paired?.isPaired === 'function' && paired.isPaired(req) === true) return true
  return isLoopbackRequest(req)
}

/**
 * Whether the request arrived over the loopback interface AND addressed a
 * loopback host. Both halves matter: a loopback socket with a foreign Host
 * header is a rebinding attempt, not a local caller.
 * @param {import('node:http').IncomingMessage} req Incoming request.
 * @returns {boolean} True when both halves hold.
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!local) return false
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === ''
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res Response to own.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON-serializable body.
 * @param {Record<string, string>} [headers] Extra headers.
 */
export function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/**
 * The state route: everything the sidebar row and the policy modal render.
 * @param {object} ctx Host context.
 * @param {import('./service.js').PeakHourService} service The clock service.
 * @returns {import('@deepseek-ai/dsh-host-webserver').WebRoute} The route.
 */
export function makeStateRoute(ctx, service) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (!isAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      writeJson(res, 200, { ok: true, state: service.state() })
    },
  }
}

/**
 * The refresh route: forces one sync, then answers with the fresh state. Only
 * the sync itself is expensive (two small HTTP GETs), and no DeepSeek request
 * is involved, so a user-triggered refresh costs no tokens.
 * @param {object} ctx Host context.
 * @param {import('./service.js').PeakHourService} service The clock service.
 * @returns {import('@deepseek-ai/dsh-host-webserver').WebRoute} The route.
 */
export function makeRefreshRoute(ctx, service) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/refresh`,
    handler: async (req, res) => {
      if (!isAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const state = await service.refreshAndState()
        writeJson(res, 200, { ok: true, state })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'refresh failed' })
      }
    },
  }
}
