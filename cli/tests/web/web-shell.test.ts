import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

const root = new URL('../../../src/app/assets/console/', import.meta.url)
const source = await Bun.file(new URL('ui/rail.js', root)).text()

type Rail = { dataset: Record<string, string>; innerHTML: string; connectedCallback(): void }

/** Run rail.js against a stub page and return one upgraded <evot-rail>. */
function mountRail(path: string, { mode = '', cache = {} as Record<string, unknown>, theme = '' } = {}) {
  const [pathname, search = ''] = path.split('?')
  const store: Record<string, string> = {}
  for (const [key, value] of Object.entries(cache)) store[key] = JSON.stringify(value)
  let Element: (new () => Rail) | undefined
  const fetches: string[] = []
  const context = {
    HTMLElement: class { dataset: Record<string, string> = {}; innerHTML = ''; querySelector() { return null } },
    customElements: { get: () => undefined, define: (_name: string, cls: new () => Rail) => { Element = cls } },
    document: { documentElement: { dataset: theme ? { theme } : {} } },
    URLSearchParams,
    fetch: async (url: string) => { fetches.push(url); return { ok: false } },
    window: {
      location: { pathname, search: search ? '?' + search : '' },
      localStorage: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = value },
      },
    } as Record<string, unknown>,
  }
  runInNewContext(source, context)
  if (!Element) throw new Error('evot-rail was not defined')
  const rail = new Element()
  if (mode) rail.dataset.mode = mode
  rail.connectedCallback()
  return { rail, store, fetches, api: context.window.evotRail as Record<string, (...args: unknown[]) => unknown> }
}

const sessions = [
  { session_id: 'a1', title: 'Fix the light theme', updated_at: new Date().toISOString() },
  { session_id: 'b2', custom_title: 'Release notes', updated_at: new Date().toISOString() },
]

test('trace paints the same rail at once: cached sessions, active row, Chat highlighted', () => {
  const { rail, fetches } = mountRail('/sessions/a1/trace', {
    cache: { 'evot-rail-sessions': sessions, 'evot-rail-account': { email: 'dev@example.com' } },
  })
  const html = rail.innerHTML
  expect(html).toContain('<a href="/chat" class="active" aria-current="page">Chat</a>')
  expect(html).toContain('<div class="recent-item active"><a class="recent-open" href="/chat?session=a1">')
  expect(html).toContain('Release notes')
  expect(html).toContain('dev@example.com')
  expect(html).not.toContain('aria-busy')
  // Settings group sits at the bottom with Appearance.
  expect(html.indexOf('rail-settings')).toBeGreaterThan(html.indexOf('recentSessions'))
  expect(html).toContain('<a href="/models">Models</a><a href="/feishu">Feishu</a>')
  expect(html).toContain('<span>Appearance</span><button class="theme-toggle"')
  // Outside Chat the rail refreshes its own list and account row.
  expect(fetches).toEqual(['/api/sessions?limit=30&offset=0'])
})

test('chat mode renders chat.js-compatible rows and leaves fetching to chat.js', () => {
  const { rail, fetches } = mountRail('/chat', { mode: 'chat', cache: { 'evot-rail-sessions': sessions } })
  expect(rail.innerHTML).toContain('<button type="button" class="recent-open" data-session="a1">')
  expect(rail.innerHTML).toContain('id="newChat"')
  expect(rail.innerHTML).toContain('id="openSearch"')
  expect(fetches).toEqual([])
})

test('settings pages highlight their own entry; empty cache shows a skeleton, not a jump', () => {
  const { rail } = mountRail('/models', { theme: 'light' })
  expect(rail.innerHTML).toContain('<a href="/models" class="active" aria-current="page">Models</a>')
  expect(rail.innerHTML).toContain('<a href="/chat">Chat</a>')
  expect(rail.innerHTML).toContain('aria-busy="true"')
  expect(rail.innerHTML).toContain('>Dark mode</button>')
})

test('cache keeps only what a row renders', () => {
  const { api, store } = mountRail('/chat', { mode: 'chat' })
  api.rememberSessions([{ ...sessions[0], cwd: '/secret/path', user_prompts: ['first', 'second'], search_text: 'x' }])
  expect(JSON.parse(store['evot-rail-sessions'])).toEqual([
    { session_id: 'a1', custom_title: '', title: 'Fix the light theme', user_prompts: ['first'], updated_at: sessions[0].updated_at },
  ])
})

test('every page declares the rail statically; no late chrome relocation', async () => {
  const chat = await Bun.file(new URL('index.html', root)).text()
  const trace = await Bun.file(new URL('trace/index.html', root)).text()
  const app = await Bun.file(new URL('ui/app.js', root)).text()
  for (const page of [chat, trace]) {
    expect(page).toContain('<script src="/ui/rail.js"></script>')
    expect(page).not.toContain('/ui/chrome.js')
    expect(page.indexOf('<evot-rail')).toBeLessThan(page.indexOf('<div class="main">'))
  }
  expect(chat).toContain('<evot-rail class="sidenav" data-mode="chat"></evot-rail>')
  expect(chat).not.toContain('<aside class="chat-sidebar"')
  expect(trace).toContain('<evot-rail class="sidenav"></evot-rail>')
  expect(app).toContain('<evot-rail class="sidenav"></evot-rail>')
  for (const name of ['ui/models.html', 'ui/feishu.html']) {
    expect(await Bun.file(new URL(name, root)).text()).toContain('<script src="/ui/rail.js"></script>')
  }
})
