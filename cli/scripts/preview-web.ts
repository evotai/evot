// Offline browser fixture: serves actual console assets and deterministic APIs.
// No real Agent, credentials, user sessions or remote requests are involved.
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../../src/app/src/surface/gateway/channels/http/static')
const sessions = ['slow', 'fast'].map(id => ({ session_id: id, title: `Fixture ${id}`, model: 'fixture', cwd: '/fixture', turns: 1, updated_at: '2026-01-01T00:00:00Z' }))
let finish: (() => void) | null = null
const json = (value: unknown) => Response.json(value)
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(req) {
  const url = new URL(req.url)
  if (url.pathname === '/api/chat/options') return json({ current: { provider: 'fixture', model: 'fixture' }, providers: [{ name: 'fixture', models: [{ id: 'fixture', thinking_levels: [] }] }] })
  if (url.pathname === '/api/auth/session') return json({ logged_in: false })
  if (url.pathname === '/api/notices') return json({ notices: [] })
  if (url.pathname === '/api/workspace') return json({ cwd: '/fixture' })
  if (url.pathname === '/api/sessions') return json({ items: sessions, total: sessions.length, has_more: false })
  if (url.pathname.startsWith('/api/sessions/')) {
    const id = url.pathname.split('/').at(-1)
    if (id === 'slow') await Bun.sleep(300)
    return json({ session: sessions.find(session => session.session_id === id), nodes: [{ type: 'user', text: `Transcript ${id}` }] })
  }
  if (url.pathname === '/api/chat/steer') return new Response('fixture offline', { status: 503 })
  if (url.pathname === '/api/chat/abort') { finish?.(); return json({ ok: true }) }
  if (url.pathname === '/api/chat') {
    const body = new ReadableStream({ start(controller) {
      const emit = (node: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(node)}\n\n`))
      emit({ type: 'session', session_id: 'live' })
      emit({ type: 'assistant', status: 'delta', content_index: 0, blocks: [{ kind: 'text', text: 'Fixture response' }] })
      finish = () => { emit({ type: 'assistant', status: 'interrupted', stop_reason: 'aborted', blocks: [{ kind: 'text', text: 'Fixture response' }] }); controller.close(); finish = null }
    }, cancel() { finish = null } })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  if (url.pathname.startsWith('/api/')) return json({})
  const file = resolve(root, url.pathname === '/chat' || url.pathname === '/' ? 'index.html' : '.' + url.pathname)
  if (!file.startsWith(root + '/')) return new Response('not found', { status: 404 })
  const resource = Bun.file(file)
  return await resource.exists() ? new Response(resource) : new Response('not found', { status: 404 })
} })
console.log(`Browser fixture: http://127.0.0.1:${server.port}/chat`)
