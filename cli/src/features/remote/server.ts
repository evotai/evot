import { phoneBuild, phonePage, phoneScriptHash, phoneStyleHash } from './assets.js'
import { reviewPage } from './review-page.js'
import { stateStream } from './state-stream.js'
import { validTerminal } from './discovery.js'
import type { DeviceAccess } from './pairing.js'
import { remoteDeviceKind } from './presence.js'
import type { CloudGate } from './cloud-connect.js'
import { validKey } from './devices.js'
import { parseRemoteAction, parseRemoteImage, RemoteConflict, REMOTE_IMAGE_LIMITS, type RemoteHost } from './protocol.js'
import { PHOTO_EXPIRED, PhotoStash } from './photo-stash.js'

export const ACTION_BODY_LIMIT = REMOTE_IMAGE_LIMITS.base64Total + 64 * 1024
const PHOTO_BODY_LIMIT = REMOTE_IMAGE_LIMITS.base64Each + 64 * 1024
import type { PhoneWorkspace } from './workspace.js'

/** Always loopback; no trust in forwarded headers. Device management has no HTTP routes. */
export function listenRemote(
  host: RemoteHost,
  access: DeviceAccess,
  options: {
    port?: number
    cloud?: CloudGate
    workspace?: PhoneWorkspace
    active?: () => boolean
  } = {},
) {
  const { workspace, cloud } = options
  let closed = false, streams = 0
  const photos = new PhotoStash()
  const headers = {
    'Cache-Control': 'no-store, no-transform',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Evot-Build': phoneBuild,
    'Content-Security-Policy': `default-src 'none'; frame-src 'self'; script-src ${phoneScriptHash}; connect-src 'self'; style-src ${phoneStyleHash}; img-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  }
  const fail = (status: number, msg: string) => new Response(msg, { status, headers })
  const handler = {
    development: false,
    // Photos ride on /action; every other route keeps the small limit below.
    maxRequestBodySize: ACTION_BODY_LIMIT,
    async fetch(req: Request, listener: Bun.Server<undefined>) {
      const expected = cloud?.origin ?? `http://127.0.0.1:${listener.port}`,
        authority = new URL(expected).host,
        origin = req.headers.get('origin')
      const peer = listener.requestIP(req)?.address
      if (
        (!cloud && peer !== '127.0.0.1') ||
        (options.active && !options.active()) ||
        req.headers.get('host') !== authority ||
        (origin !== null && origin !== expected)
      )
        return fail(403, 'Forbidden')
      const url = new URL(req.url),
        path = url.pathname
      if (req.method === 'GET' && path === '/') {
        // The page is static; revalidate it (304) and send it compressed. no-transform stays:
        // the tunnel must not rewrite it, so the compression is ours.
        const page = { ...headers, 'Cache-Control': 'no-cache, no-transform', ETag: phonePage.etag, Vary: 'Accept-Encoding' }
        if (req.headers.get('if-none-match') === phonePage.etag) return new Response(null, { status: 304, headers: page })
        const gzip = /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')
        return new Response(gzip ? phonePage.gzip : phonePage.html, { headers: { ...page, 'Content-Type': 'text/html; charset=utf-8', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) } })
      }
      // Public shell only. The snapshot is separately device- and terminal-authorized.
      if (path === '/changes' && req.method === 'GET') return new Response(reviewPage.html, { headers: {
        ...headers, 'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':reviewPage.csp,
      } })
      const enrollment = ['/device/challenge', '/device/prove', '/device/poll'].includes(path)
      if (!enrollment && !['/state', '/action', '/photos', '/changes/snapshot', '/sessions', '/sessions/delete', '/folders', '/open'].includes(path)) return fail(404, 'Not found')
      const auth = req.headers.get('authorization'),
        authorized = () => !closed && (!options.active || options.active()) && access.authorized(auth)
      const unauthorized = () => fail(401, 'Pair again on the computer.')
      if (!enrollment && !authorized()) return unauthorized()
      const target = req.headers.get('x-evot-terminal')
      if (target !== null && (!workspace || !validTerminal(target))) return fail(400, 'Invalid target terminal.')
      const other = workspace && target && target !== workspace.bus.id ? target : null
      const shared = () => !workspace || !!other || workspace.bus.shared
      if ((path === '/state' || path === '/action') && !shared()) return fail(409, 'Terminal no longer shared.')
      if (path === '/changes/snapshot') {
        if (req.method !== 'GET') return fail(405,'Method not allowed')
        if (!target || !workspace || !shared()) return fail(409,'Window no longer shared.')
        const response = other ? await workspace.bus.request(other,'/changes') : host.changes ? Response.json(await host.changes()) : null
        if (!authorized() || !shared()) return unauthorized()
        if (!response || response.status === 404) return fail(404,'Update the selected evot window to review changes.')
        if (!response.ok) return fail(response.status,'Window no longer available.')
        const gzip = /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')
        const data = gzip && response.body ? response.body.pipeThrough(new CompressionStream('gzip')) : response.body
        return new Response(data,{headers:{...headers,'Content-Type':'application/json',Vary:'Accept-Encoding',...(gzip ? {'Content-Encoding':'gzip'} : {})}})
      }
      if (path === '/sessions' && req.method === 'GET') {
        const page = url.searchParams.has('limit') ? {
          limit: Math.max(1, Math.min(10000, Number(url.searchParams.get('limit')) || 40)),
          query: (url.searchParams.get('q') ?? '').trim().slice(0, 256).toLowerCase(),
        } : undefined
        if (url.searchParams.has('catalog')) {
          const catalog = await workspace?.catalog(page ?? { limit: 40, query: '' }) ?? {
            count: 0, more: false, rows: [], online: [], privateWindows: [], unavailable: false, failed: false,
          }
          if (!authorized()) return unauthorized()
          access.observe(auth, remoteDeviceKind(req.headers))
          // Format on the phone for its locale, but in this computer's time zone.
          const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
          return Response.json(catalog, { headers: { ...headers, 'X-Evot-Time-Zone': timeZone } })
        }
        const rows = (await workspace?.list(url.searchParams.has('online'), page)) ?? {
          current: null,
          online: [],
          history: [],
        }
        if (!authorized()) return unauthorized()
        access.observe(auth, remoteDeviceKind(req.headers))
        return Response.json(rows, { headers })
      }
      if (path === '/folders' && req.method === 'GET') {
        const rows = (await workspace?.folders()) ?? []
        return authorized() ? Response.json({ folders: rows }, { headers }) : unauthorized()
      }
      if (path === '/state' && req.method === 'GET') {
        const bg = req.headers.get('x-evot-background') ?? undefined
        if (bg && bg !== 'list' && !validTerminal(bg)) return fail(400, 'Invalid task.')
        const kind = remoteDeviceKind(req.headers)
        if (req.headers.get('accept') === 'text/event-stream') {
          if (streams >= 16) return fail(429, 'Too many live views.')
          streams++
          const body = stateStream(async () => {
            if (!other) return host.snapshot(bg)
            const r = await workspace!.bus.request(other, '/state', undefined, bg)
            if (!r.ok) throw new RemoteConflict('Terminal no longer shared.')
            return r.json() as Promise<ReturnType<typeof host.snapshot>>
          }, () => !authorized() ? 401 : shared() ? 200 : 409, req.signal, () => { streams-- }, () => access.observe(auth, kind))
          return new Response(body, { headers: { ...headers, 'Cache-Control': 'no-store, no-transform', 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' } })
        }
        const response = other ? await workspace!.bus.request(other, '/state', undefined, bg) : Response.json(host.snapshot(bg))
        const body = await response.text()
        if (!authorized() || !shared()) return unauthorized()
        if (!response.ok) return fail(response.status, body)
        access.observe(auth, kind)
        const etag = `"${Bun.hash(body).toString(16)}"`
        return req.headers.get('if-none-match') === etag
          ? new Response(null, { status: 304, headers: { ...headers, etag } })
          : new Response(body, { headers: { ...headers, etag, 'Content-Type': 'application/json' } })
      }
      if (req.method !== 'POST' || path === '/state' || path === '/sessions' || path === '/folders') return fail(405, 'Method not allowed')
      const type = req.headers.get('content-type')?.split(';')[0]
      if (path === '/photos' && type === 'image/jpeg' && origin === expected) {
        const limit = Math.floor(REMOTE_IMAGE_LIMITS.base64Each / 4) * 3
        if (Number(req.headers.get('content-length')) > limit) return fail(413, 'Photo too large.')
        const bytes = Buffer.from(await req.arrayBuffer())
        if (!authorized()) return unauthorized()
        if (bytes.length > limit) return fail(413, 'Photo too large.')
        if (bytes.length < 3 || bytes.readUIntBE(0, 3) !== 0xffd8ff) return fail(400, 'Invalid JPEG.')
        return Response.json({ id: photos.put(auth!, { mimeType: 'image/jpeg', data: bytes.toString('base64') }) }, { headers })
      }
      if (origin !== expected || type !== 'application/json')
        return fail(403, 'Expected a same-origin JSON request')
      const limit = path === '/action' ? ACTION_BODY_LIMIT : path === '/photos' ? PHOTO_BODY_LIMIT : 64 * 1024
      if (Number(req.headers.get('content-length') ?? 0) > limit)
        return fail(413, path === '/action' || path === '/photos' ? 'Images are too large. Send fewer or smaller photos.' : 'Request too large.')
      let body: unknown
      try {
        const raw = await req.text() // a chunked body has no length header: measure what arrived
        if (raw.length > limit) return fail(413, path === '/action' || path === '/photos' ? 'Images are too large. Send fewer or smaller photos.' : 'Request too large.')
        body = JSON.parse(raw)
      } catch {
        return fail(400, 'Invalid JSON')
      }
      if (closed) return fail(410, 'Remote closed')
      if (enrollment) {
        if (!body || typeof body !== 'object') return fail(400, 'Invalid device request.')
        const b = body as Record<string, unknown>
        // The invite is only a notification destination, never an access grant.
        // Bind it to the challenge; neither proof nor poll may change it.
        let terminal: string | undefined
        if (path === '/device/challenge' && b.terminal !== undefined) {
          if (!workspace || !validTerminal(b.terminal)) return fail(400, 'Invalid approval window.')
          terminal = b.terminal
        }
        if (cloud && path === '/device/challenge') {
          if (!validKey(b.key)) return fail(400, 'Invalid device key.')
          if (!b.ticket) return Response.json({ login: cloud.login(b.key, terminal) }, { headers })
          if (!cloud.admit(b.key, b.ticket)) return fail(403, 'Account sign-in expired. Connect again.')
        }
        const result =
          path === '/device/challenge'
            ? access.challenge(b.key, terminal)
            : path === '/device/prove'
            // Cloudflare adds the visitor address; the loopback gateway sees only its peer.
            ? await access.prove(b.nonce, b.signature, (cloud ? req.headers.get('cf-connecting-ip') : peer) ?? undefined)
            : access.poll(b.receipt)
        if (closed || options.active?.() === false) return fail(410, 'Remote closed')
        if (result && 'unavailable' in result) return fail(409, 'The window that showed this QR is no longer available. Run /remote there and scan the new code.')
        if (!result) return fail(403, 'Device request denied, expired or busy.')
        return Response.json(
          'token' in result ? { ...result, current: workspace?.bus.shared ? workspace.bus.id : null } : result,
          { headers },
        )
      }
      if (!authorized()) return unauthorized()
      if (path === '/photos') {
        const image = parseRemoteImage(body)
        if (!image) return fail(400, 'Unsupported photo.')
        return Response.json({ id: photos.put(auth!, image) }, { headers })
      }
      if (path === '/open') {
        if (
          !workspace ||
          !body ||
          typeof body !== 'object' ||
          !('requestId' in body) ||
          !validTerminal(body.requestId) ||
          !('session' in body) ||
          (body.session !== null && (typeof body.session !== 'string' || !body.session || body.session.length > 128)) ||
          ('folder' in body && !(typeof body.folder === 'string' && /^[a-f0-9]{20}$/.test(body.folder)))
        )
          return fail(400, 'Invalid session request')
        const terminal = await workspace.open(body.requestId, body.session, authorized, 'folder' in body ? body.folder as string : undefined)
        return authorized() ? Response.json({ terminal }, { headers }) : unauthorized()
      }
      if (path === '/sessions/delete') {
        const session = body && typeof body === 'object' && 'session' in body ? body.session : null
        if (!workspace || typeof session !== 'string' || !session || session.length > 128) return fail(400, 'Invalid session request')
        const deleted = await workspace.remove(session)
        if (!authorized()) return unauthorized()
        return deleted ? new Response(null, { status: 204, headers }) : fail(404, 'Session no longer exists in this profile.')
      }
      if (!shared()) return fail(409, 'Terminal no longer shared.')
      const stashed = photos.resolve(auth!, body)
      if (!stashed) return fail(412, PHOTO_EXPIRED)
      const action = parseRemoteAction(stashed.body)
      if (!action) return fail(400, 'Invalid action')
      if (other) {
        const r = await workspace!.bus.request(other, '/action', action)
        if (!r.ok) return fail(r.status, await r.text())
      } else host.act(action)
      photos.release(stashed.refs)
      return new Response(null, { status: 204, headers })
    },
    error: (e: Error) =>
      e instanceof RemoteConflict ? fail(409, e.message) : fail(500, 'Remote unavailable; check the computer.'),
  }
  const server = cloud
    ? Bun.serve({ ...handler, unix: cloud.unix })
    : Bun.serve({ ...handler, hostname: '127.0.0.1', port: options.port ?? 0, idleTimeout: 20 })
  return {
    address: cloud?.origin ?? `http://127.0.0.1:${server.port}`,
    access,
    close() {
      closed = true
      photos.clear()
      access.close()
      void server.stop(true)
    },
  }
}
export type RemoteListener = ReturnType<typeof listenRemote>
