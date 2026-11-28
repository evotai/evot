import { expect, test } from 'bun:test'
import { resolveRunInteraction } from '../../../src/term/app/run/run-interaction.js'
import { createFrameController, type FrameDeps } from '../../../src/term/host/frame.js'
import { createReplState } from '../../../src/term/host/state.js'
import { TermRenderer, type RendererDiagnostic } from '../../../src/term/screen/renderer.js'
import { HistoryRenderCache } from '../../../src/term/viewmodel/history-cache.js'
import { BannerCache } from '../../../src/term/widgets/banner-cache.js'
import { ScreenHarness } from '../../helpers/screen.js'

test('dashboard discovery cannot move a reader by removing and restoring the historical banner section', async () => {
  const screen = new ScreenHarness(135, 39)
  const events: RendererDiagnostic[] = []
  const renderer = new TermRenderer({ stdout: screen.stdout, onDiagnostic: e => events.push(e) })
  const st = createReplState('test', '/tmp')
  const compactLines = Array.from({ length: 1200 }, (_, i) => ({ id: `h${i}`, kind: 'system', text: `history ${i}` }))
  const server = { address: 'http://localhost:8080', port: 8080, owned: true, channels: [], startedAt: 0, envFile: '' }
  st.serverState = server
  const empty = () => undefined
  const frames = createFrameController(st, {
    renderer, compactLines, compactHistoryCache: new HistoryRenderCache(),
    bannerCache: new BannerCache('/tmp', [], () => ({ skills: { units: [], total: 0 }, contextFiles: [] })),
    agent: { cwd: '/tmp', model: 'test' }, appVersion: 'test', activity: { current: empty },
    commandWindow: { commandWindowMounted: () => false }, adSlotWakeup: { replace: empty },
    suggestions: { reconcile: empty, completing: empty, text: empty, position: empty, replacing: empty, feedback: empty, isExplicit: empty },
    suggestionTicker: { sync: empty }, suggest: { suggestionInventory: empty }, gitInfo: { getBranch: empty },
    backgroundTerminals: { runningCount: () => 0 }, runInteraction: { snapshot: resolveRunInteraction },
    runInteractionInput: () => ({ active: false, owner: null }),
  } as unknown as FrameDeps)
  renderer.init()
  renderer.setRenderCallback(frames.buildFrame)
  const paint = async () => { renderer.requestRender(); await Bun.sleep(30); await screen.settle() }
  try {
    await paint()
    screen.terminal.scrollToLine(60)
    const reading = screen.viewport()
    for (const status of [null, server, null, server]) {
      st.serverState = status
      await paint()
      expect(events.filter(e => e.kind === 'full_redraw')).toEqual([])
      expect(screen.terminal.buffer.active.viewportY).toBe(60)
      expect(screen.viewport()).toEqual(reading)
    }
    // A new screen gets current discovery data, not the old frozen snapshot.
    st.serverState = null
    renderer.clearScreen()
    compactLines.length = 0
    await paint()
    expect(screen.viewport().join('\n')).not.toContain('Dashboard')
    st.serverState = server
    await paint()
    expect(screen.viewport().join('\n')).toContain('Dashboard')
  } finally {
    renderer.destroy(); await screen.settle(); screen.terminal.dispose()
  }
})
