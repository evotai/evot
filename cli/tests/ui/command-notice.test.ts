import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import chalk from 'chalk'
import { renderCommandNotice, renderErrorNotice } from '../../src/ui/command-notice.js'
import { getTheme } from '../../src/ui/theme/index.js'
import { createCommandOutput } from '../../src/term/widgets/command-output.js'
import { handleUpdateCommand, type ReplCommandContext } from '../../src/term/command-handlers.js'
import type { OutputLine } from '../../src/render/output.js'
import type { RunResult } from '../../src/update/types.js'

function harness() {
  const lines: OutputLine[] = []
  const ctx: ReplCommandContext = {
    agent: {} as ReplCommandContext['agent'],
    getSessionId: () => null,
    getCompactLines: () => lines,
    getConfigInfo: () => null,
    commitSystem: () => { throw new Error('Expected pre-styled output') },
    commitRevealed: () => {},
    commitLines: rows => { lines.push(...rows) },
    replaceLine: (id, text) => {
      const row = lines.find(row => row.id === id)
      if (!row) return false
      row.text = text
      return true
    },
    columns: () => 80,
    requestRender: () => {},
  }
  return { ctx, lines }
}

describe('command notices', () => {
  test('shares markers, labels and indentation across states', () => {
    for (const [state, marker] of [['info', ''], ['progress', '⋯ '], ['success', '✓ '], ['error', '✗ ']] as const) {
      expect(stripAnsi(renderCommandNotice({ state, message: 'message' }))).toBe(`  ${marker}message`)
    }
    expect(stripAnsi(renderCommandNotice({ state: 'progress', label: 'update', message: 'checking...' })))
      .toBe('  ⋯ update  checking...')
    expect(stripAnsi(renderCommandNotice({ message: 'result', details: ['', 'detail'] })))
      .toBe('  result\n\n    detail')
  })

  test('progress slots are independent and recover after clearing history', () => {
    const { ctx, lines } = harness()
    const output = createCommandOutput(ctx, 'test')
    const first = output.progress()
    const second = output.progress()
    first.update('first')
    second.update('second')
    first.finish('done')
    expect(lines.map(row => row.text)).toEqual(['done', 'second'])
    expect(lines.every(row => row.preStyled)).toBe(true)
    lines.length = 0
    second.finish('recovered')
    expect(lines.map(row => row.text)).toEqual(['recovered'])
  })
})

describe('update command output', () => {
  test('replaces progress with each outcome, preserving details', async () => {
    const cases: { result: RunResult; expected: string }[] = [
      { result: { kind: 'up_to_date' }, expected: '  ✓ evot is up to date.' },
      {
        result: { kind: 'up_to_date', staleReason: 'offline', proxy: 'direct route' },
        expected: '  ✓ evot is up to date, per the last successful check (offline).\n    direct route',
      },
      {
        result: { kind: 'updated', from: '1', to: '2', notes: ['Faster startup'] },
        expected: "  ✓ updated 1 → 2. /restart to apply.\n\n    What's new in 2:\n    • Faster startup",
      },
      {
        result: { kind: 'error', message: 'Unavailable', proxy: 'direct route' },
        expected: '  ✗ Unavailable\n    direct route',
      },
    ]
    for (const { result, expected } of cases) {
      const { ctx, lines } = harness()
      await handleUpdateCommand(ctx, async () => {
        expect(lines).toHaveLength(1)
        expect(stripAnsi(lines[0]?.text ?? '')).toBe('  ⋯ update  checking for updates...')
        return result
      })
      expect(lines).toHaveLength(1)
      expect(lines[0]?.preStyled).toBe(true)
      expect(stripAnsi(lines[0]?.text ?? '')).toBe(expected)
    }
  })

  test('exceptions replace progress with a failure', async () => {
    const { ctx, lines } = harness()
    await handleUpdateCommand(ctx, async () => { throw new Error('offline') })
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0]?.text ?? '')).toBe('  ✗ update failed: offline')
  })
})

describe('error notices', () => {
  test('spend colour on the mark only and never use ANSI red', () => {
    chalk.level = 3
    const row = renderErrorNotice('Connection interrupted')
    expect(stripAnsi(row)).toBe('  ✗ Connection interrupted')
    expect(row).toContain(chalk.hex(getTheme().errorHex)('✗'))
    // The message is the terminal's default ink: no SGR wraps it.
    expect(row.endsWith('✗\x1b[39m Connection interrupted')).toBe(true)
    expect(row).not.toContain('\x1b[31m')
  })

  test('renderErrorNotice is renderCommandNotice in its error state', () => {
    expect(renderErrorNotice('boom')).toBe(renderCommandNotice({ state: 'error', message: 'boom' }))
  })
})
