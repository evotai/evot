import { describe, expect, test } from 'bun:test'
import { buildAskBlocks } from '../../../src/term/viewmodel/ask.js'
import { buildHelpBlocks } from '../../../src/term/viewmodel/help.js'
import { buildOverlayBlocks } from '../../../src/term/viewmodel/overlays.js'
import { createAskState, handleAskKeyEvent } from '../../../src/term/widgets/ask.js'

const questions = [
  { header: 'Scope', question: 'Which scope?', options: [{ label: 'Small', description: 'One feature' }, { label: 'Large', description: 'All features' }] },
  { header: 'Tests', question: 'Which tests?', options: [{ label: 'Targeted', description: '' }] },
]

describe('independent TUI surfaces', () => {
  test('ask surface agrees with shell composition throughout interaction', () => {
    let state = createAskState(questions)
    for (const key of ['down', 'enter', 'down', 'char', 'enter', 'left', 'right'] as const) {
      for (const columns of [20, 80, 160]) {
        expect(buildAskBlocks(state, columns)).toEqual(buildOverlayBlocks({ kind: 'ask-user', state }, columns))
      }
      state = handleAskKeyEvent(state, key, key === 'char' ? 'custom' : undefined).state
    }
  })

  test('help surface agrees with shell composition', () => {
    for (const columns of [20, 80, 160]) expect(buildHelpBlocks(columns)).toEqual(buildOverlayBlocks({ kind: 'help' }, columns))
  })

  test('surfaces cannot import the application host or selector routing', async () => {
    for (const name of ['ask', 'help']) {
      const source = await Bun.file(new URL(`../../../src/term/viewmodel/${name}.ts`, import.meta.url)).text()
      for (const forbidden of ['native/', 'repl.js', 'selector-identity', 'process.stdout', 'setInterval(']) expect(source).not.toContain(forbidden)
    }
    const shell = await Bun.file(new URL('../../../src/term/viewmodel/overlays.ts', import.meta.url)).text()
    expect(shell).not.toContain('function buildAskBlocks')
    expect(shell).not.toContain('function buildHelpBlocks')
  })
})
