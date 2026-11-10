import { describe, expect, test } from 'bun:test'
import { previewScene, SCENES } from '../../../scripts/tui-scenes.js'
import { buildShellFrame } from '../../../src/term/viewmodel/shell.js'
import { TermRenderer } from '../../../src/term/screen/renderer.js'
import { ScreenHarness } from '../../helpers/screen.js'

describe('offline product scene catalog', () => {
  test('every scene renders in a real emulator at compact and full sizes', async () => {
    for (const scene of SCENES) {
      for (const [columns, rows] of [[30, 12], [80, 24], [120, 40]]) {
        const screen = new ScreenHarness(columns, rows)
        const renderer = new TermRenderer({ stdout: screen.stdout })
        try {
          renderer.init()
          renderer.setRenderCallback(() => buildShellFrame(previewScene(scene, columns, rows)))
          renderer.requestRender(true)
          await new Promise<void>(resolve => process.nextTick(resolve))
          await screen.settle()
          expect(screen.viewport().some(line => line.trim().length > 0)).toBe(true)
          expect(screen.viewport().join('\n')).not.toContain('undefined')
        } finally {
          renderer.destroy()
          await screen.settle()
          screen.terminal.dispose()
        }
      }
    }
  })

  test('fixture module cannot load native binding or live user state', async () => {
    const source = await Bun.file(new URL('../../../scripts/tui-scenes.ts', import.meta.url)).text()
    expect(source).not.toContain('native/index')
    expect(source).not.toContain('process.env')
    expect(source).not.toContain('readFile')
    expect(source).not.toContain('fetch(')
  })
})
