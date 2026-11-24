import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

const root = new URL('../../../src/app/assets/console/', import.meta.url)
const source = await Bun.file(new URL('ui/rail.js', root)).text()

type Rail = { dataset: Record<string, string>; innerHTML: string; connectedCallback(): void }

/** Run rail.js against a stub page and return one upgraded <evot-rail>. */
function mountRail(path: string, { theme = '' } = {}) {
  const [pathname, search = ''] = path.split('?')
  const store: Record<string, string> = {}
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
  rail.connectedCallback()
  return { rail, fetches }
}

test('the rail is settings only: no chat, session list or account row, and no requests', () => {
  for (const path of ['/models', '/feishu', '/sessions/a1/trace']) {
    const { rail, fetches } = mountRail(path, { theme: 'light' })
    expect(rail.innerHTML).toContain('<a href="/models"')
    expect(rail.innerHTML).toContain('<a href="/feishu"')
    expect(rail.innerHTML).toContain('<span>Appearance</span><button class="theme-toggle"')
    expect(rail.innerHTML).toContain('>Dark mode</button>')
    for (const gone of ['/chat', 'recentSessions', 'newChat', 'openSearch', 'authBox']) expect(rail.innerHTML).not.toContain(gone)
    expect(fetches).toEqual([])
  }
  expect(mountRail('/models').rail.innerHTML).toContain('<a href="/models" class="active" aria-current="page">Models</a>')
})

test('every page declares the rail statically; no late chrome relocation', async () => {
  const trace = await Bun.file(new URL('trace/index.html', root)).text()
  const app = await Bun.file(new URL('ui/app.js', root)).text()
  expect(trace).toContain('<script src="/ui/rail.js"></script>')
  expect(trace).not.toContain('/ui/chrome.js')
  expect(trace.indexOf('<evot-rail')).toBeLessThan(trace.indexOf('<div class="main">'))
  expect(trace).toContain('<evot-rail class="sidenav"></evot-rail>')
  expect(app).toContain('<evot-rail class="sidenav"></evot-rail>')
  for (const name of ['ui/models.html', 'ui/feishu.html']) {
    expect(await Bun.file(new URL(name, root)).text()).toContain('<script src="/ui/rail.js"></script>')
  }
})
