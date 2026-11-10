/**
 * The load-bearing claim behind the timed reveal: rewriting a committed line
 * genuinely takes the secret off the terminal.
 *
 * Everything else about the feature is pure logic and tested as such. This is
 * the part that depends on renderer behavior, so it is asserted against a real
 * terminal emulator: the frame is rebuilt from `compactLines` each cycle, so the
 * masked text replaces the revealed row rather than being appended below it.
 *
 * The second case is the one worth having. A reveal that has scrolled out of the
 * visible window is no longer reachable by a differential patch, and a patch
 * that silently skipped it would leave the credential in the terminal's own
 * scrollback — erased on screen in principle, still there when you scroll up.
 */
import { describe, expect, test } from 'bun:test'
import { TermRenderer } from '../../../src/term/screen/renderer.js'
import { CURSOR_MARKER } from '../../../src/term/screen/render-frame.js'
import { ScreenHarness } from '../../helpers/screen.js'

const SECRET = 'K=supersecretvalue'
const MASKED = 'K=su******ue  (hidden after 10s)'

async function renderFrame(renderer: TermRenderer): Promise<void> {
  renderer.requestRender()
  await new Promise((resolve) => process.nextTick(resolve))
  await Bun.sleep(20)
}

/** Every row the emulator holds, scrollback included. */
function scrollback(screen: ScreenHarness): string {
  const buffer = screen.terminal.buffer.active
  let text = ''
  for (let row = 0; row < buffer.length; row++) {
    text += `${buffer.getLine(row)?.translateToString(true) ?? ''}\n`
  }
  return text
}

describe('a revealed secret leaves the screen', () => {
  test('erasing a visible reveal replaces the row in place', async () => {
    const screen = new ScreenHarness(80, 24)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    let revealLine = `  ${SECRET}`
    renderer.setRenderCallback(() => ({
      lines: ['evot v1', '\u276f /env get K --reveal', revealLine, `\u276f ${CURSOR_MARKER}`],
      bottomAnchor: true,
    }))

    await renderFrame(renderer)
    await screen.settle()
    expect(screen.rowOf(SECRET)).toBeGreaterThanOrEqual(0)

    // What the erase timer does: same line id, masked text.
    revealLine = `  ${MASKED}`
    await renderFrame(renderer)
    await screen.settle()

    expect(screen.rowOf(SECRET)).toBe(-1)
    expect(screen.rowOf('su******ue')).toBeGreaterThanOrEqual(0)
    // Replaced, not appended: the transcript keeps its shape.
    expect(screen.viewport().filter((row) => row.includes('K=')).length).toBe(1)
    renderer.destroy()
  })

  test('a reveal that scrolled out of view is still erased from scrollback', async () => {
    const screen = new ScreenHarness(80, 24)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    let revealLine = `  ${SECRET}`
    let filler: string[] = []
    renderer.setRenderCallback(() => ({
      lines: ['evot v1', revealLine, ...filler, `\u276f ${CURSOR_MARKER}`],
      bottomAnchor: true,
    }))

    await renderFrame(renderer)
    await screen.settle()

    // Ten seconds is long enough for output to push the reveal well past the
    // top of the window.
    filler = Array.from({ length: 60 }, (_, index) => `filler ${index}`)
    await renderFrame(renderer)
    await screen.settle()
    expect(screen.rowOf(SECRET)).toBe(-1)

    // The committer flags the in-place edit; streaming changes above the
    // viewport are otherwise left in scrollback untouched.
    revealLine = `  ${MASKED}`
    renderer.invalidateScrollback()
    await renderFrame(renderer)
    await screen.settle()

    // The flagged change above the viewport forces a full redraw that also
    // clears scrollback, so scrolling up cannot recover the value.
    const all = scrollback(screen)
    expect(all).not.toContain(SECRET)
    expect(all).toContain('su******ue')
    renderer.destroy()
  })
})
