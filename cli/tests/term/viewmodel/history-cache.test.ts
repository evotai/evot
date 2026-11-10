import { describe, test, expect, beforeAll } from 'bun:test'
import { HistoryRenderCache, advancePrevKind } from '../../../src/term/viewmodel/history-cache.js'
import { buildOutputBlocks } from '../../../src/term/viewmodel/output.js'
import { blocksToLines } from '../../../src/term/viewmodel/types.js'
import { buildThinkingLines, type OutputLine } from '../../../src/render/output.js'
import chalk from 'chalk'

beforeAll(() => {
  chalk.level = 3
})

/** Ground truth: flatten the full history in one pass, the same way the
 *  pre-cache renderer did. */
function fullRebuild(history: OutputLine[], columns: number): string[] {
  if (history.length === 0) return []
  return blocksToLines(buildOutputBlocks(history, { columns }))
}

const COLS = 100

function u(id: string, text: string): OutputLine { return { id, kind: 'user', text } }
function a(id: string, text: string): OutputLine { return { id, kind: 'assistant', text } }
function spacer(id: string): OutputLine { return { id, kind: 'assistant', text: '', isContinuationSpacer: true } }
function blank(id: string): OutputLine { return { id, kind: 'assistant', text: '' } }
function tool(id: string, text: string): OutputLine { return { id, kind: 'tool', text } }
function sys(id: string, text: string): OutputLine { return { id, kind: 'system', text } }

describe('HistoryRenderCache', () => {
  test('incremental append matches a full rebuild byte-for-byte', () => {
    const cache = new HistoryRenderCache()
    const history: OutputLine[] = []

    // A realistic interleaving: user turns, multi-line assistant blocks,
    // continuation spacers, tool cards + status lines, system notes.
    const commits: OutputLine[][] = [
      [u('u1', 'first question that is long enough to exercise the wrap path across the terminal width here')],
      [a('a1a', 'assistant line one'), a('a1b', 'assistant line two')],
      [tool('t1', '⌘ Bash  some-command --flag value'), tool('t1s', '  ✓ · 0.6s · 12 lines')],
      [spacer('sp1'), a('a1c', 'continued assistant after a tool')],
      [u('u2', 'second question')],
      [a('a2a', 'answer two')],
      [sys('s1', '  resumed session abcd1234')],
    ]

    for (const commit of commits) {
      history.push(...commit)
      const incremental = cache.sync(history, COLS)
      const full = fullRebuild(history, COLS)
      expect(incremental).toEqual(full)
    }
  })

  test('adjacent committed thoughts keep separate windows across append, resize and rebuild', () => {
    const text = Array.from({ length: 20 }, (_, i) => `reasoning row ${i + 1}`).join('\n\n')
    for (const expanded of [false, true]) {
      const cache = new HistoryRenderCache()
      const history: OutputLine[] = []
      for (const commit of [
        buildThinkingLines(text, { expanded }),
        buildThinkingLines(text.replaceAll('reasoning', 'next'), { expanded }),
      ]) {
        history.push(...commit)
        expect(cache.sync(history, COLS)).toEqual(fullRebuild(history, COLS))
      }
      for (const columns of [24, 80, COLS]) {
        expect(cache.sync(history, columns)).toEqual(fullRebuild(history, columns))
      }
      const before = [...cache.sync(history, COLS)]
      cache.reset()
      expect(cache.sync(history, COLS)).toEqual(before)
    }
  })

  test('empty non-spacer assistant line carries prevKind (block-start dot stays correct)', () => {
    const cache = new HistoryRenderCache()
    const history: OutputLine[] = []
    // A blank (non-spacer) assistant line must NOT make the next real assistant
    // line a fresh block; advancePrevKind carries the prior kind forward.
    for (const commit of [
      [u('u1', 'hi')],
      [a('a1', 'first')],
      [blank('b1')],
      [a('a2', 'second')],
    ]) {
      history.push(...commit)
      expect(cache.sync(history, COLS)).toEqual(fullRebuild(history, COLS))
    }
  })

  test('reset() forces a full rebuild after an in-place replacement', () => {
    const cache = new HistoryRenderCache()
    let history: OutputLine[] = [u('u1', 'one'), a('a1', 'first')]
    expect(cache.sync(history, COLS)).toEqual(fullRebuild(history, COLS))

    // Replace the array contents (e.g. /clear then resume a different session).
    history = [u('u9', 'totally different'), a('a9', 'other answer')]
    cache.reset()
    expect(cache.sync(history, COLS)).toEqual(fullRebuild(history, COLS))
  })

  test('shrinking history triggers a rebuild even without reset()', () => {
    const cache = new HistoryRenderCache()
    const history: OutputLine[] = [u('u1', 'a'), a('a1', 'b'), a('a2', 'c')]
    cache.sync(history, COLS)
    const shrunk = history.slice(0, 1)
    expect(cache.sync(shrunk, COLS)).toEqual(fullRebuild(shrunk, COLS))
  })

  test('column change rebuilds so wrapping is recomputed', () => {
    const cache = new HistoryRenderCache()
    const longLine = 'x'.repeat(300)
    const history: OutputLine[] = [u('u1', longLine)]
    const narrow = cache.sync(history, 40)
    expect(narrow).toEqual(fullRebuild(history, 40))
    const wide = cache.sync(history, 200)
    expect(wide).toEqual(fullRebuild(history, 200))
    expect(narrow).not.toEqual(wide)
  })

  test('empty history yields no lines', () => {
    const cache = new HistoryRenderCache()
    expect(cache.sync([], COLS)).toEqual([])
  })

  test('many small appends stay identical to full rebuild', () => {
    const cache = new HistoryRenderCache()
    const history: OutputLine[] = []
    for (let i = 0; i < 200; i++) {
      history.push(i % 3 === 0 ? u(`u${i}`, `q ${i}`) : a(`a${i}`, `line ${i}`))
      expect(cache.sync(history, COLS)).toEqual(fullRebuild(history, COLS))
    }
  })
})

describe('advancePrevKind', () => {
  test('tracks last non-empty kind', () => {
    expect(advancePrevKind(undefined, [u('u', 'x'), a('a', 'y')])).toBe('assistant')
    expect(advancePrevKind(undefined, [a('a', 'y'), u('u', 'x')])).toBe('user')
  })

  test('continuation spacer counts as assistant', () => {
    expect(advancePrevKind(undefined, [spacer('s')])).toBe('assistant')
  })

  test('blank non-spacer assistant line carries prior kind', () => {
    expect(advancePrevKind('tool', [blank('b')])).toBe('tool')
    expect(advancePrevKind(undefined, [blank('b')])).toBeUndefined()
  })
})
