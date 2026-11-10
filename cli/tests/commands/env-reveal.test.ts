/**
 * A revealed secret must leave the screen, and must never reach the log.
 *
 * Two halves are tested here: the pure decision of what to reveal and what to
 * leave behind (parseRevealTarget / renderRevealed), and the Committer mechanics
 * that make an erase possible at all — scrollback is append-only for everything
 * else, so the in-place rewrite is the part worth pinning.
 */
import { describe, expect, test } from 'bun:test'
import { Committer } from '../../src/term/screen/committer.js'
import { handleEnvCommand, type ReplCommandContext } from '../../src/term/command-handlers.js'
import { parseRevealTarget } from '../../src/commands/env/manage.js'
import { renderRevealed, REVEAL_ERASE_MS } from '../../src/commands/env/render.js'
import type { OutputLine } from '../../src/render/output.js'

interface Committed { id: string; text: string; erasedText?: string; delayMs?: number }

function envContext(rows: Array<{ key: string; value: string }>) {
  const committed: Committed[] = []
  const ctx = {
    agent: {
      listVariables: () => rows,
      setVariable: async () => {},
      deleteVariable: async () => true,
    } as unknown as ReplCommandContext['agent'],
    getSessionId: () => null,
    getCompactLines: () => [],
    getConfigInfo: () => null,
    commitSystem: (id: string, text: string) => { committed.push({ id, text }) },
    commitRevealed: (id: string, text: string, erasedText: string, delayMs: number) => {
      committed.push({ id, text, erasedText, delayMs })
    },
    commitLines: () => {},
    replaceLine: () => false,
    columns: () => 80,
    requestRender: () => {},
  } satisfies ReplCommandContext
  return { ctx, committed }
}

function committer() {
  const compactLines: OutputLine[] = []
  const expandedLines: OutputLine[] = []
  const logged: string[] = []
  let invalidated = 0
  let renders = 0
  const instance = new Committer({
    compactLines,
    expandedLines,
    isExpanded: () => false,
    columns: () => 80,
    logLines: (lines) => logged.push(...lines),
    requestRender: () => { renders++ },
    invalidateHistory: () => { invalidated++ },
  })
  return {
    instance,
    compactLines,
    expandedLines,
    logged,
    counts: () => ({ invalidated, renders }),
  }
}

describe('parseRevealTarget', () => {
  test('names the key only when a get asks to reveal it', () => {
    expect(parseRevealTarget('get K --reveal')).toBe('K')
    expect(parseRevealTarget('get --reveal K')).toBe('K')
    expect(parseRevealTarget('get K')).toBeNull()
    expect(parseRevealTarget('list')).toBeNull()
    expect(parseRevealTarget('')).toBeNull()
  })

  test('a --reveal on another subcommand is not a reveal', () => {
    // Only `get` prints a value, so only `get` gets the timed treatment. A
    // set/del carrying the flag must stay on the ordinary logged path.
    expect(parseRevealTarget('set K=v --reveal')).toBeNull()
    expect(parseRevealTarget('del K --reveal')).toBeNull()
  })

  test('a bare --reveal has no key to show', () => {
    expect(parseRevealTarget('get --reveal')).toBeNull()
  })
})

describe('renderRevealed', () => {
  test('shows the value now and a masked line for after', () => {
    const { text, erasedText } = renderRevealed({ key: 'K', value: 'supersecretvalue' })
    expect(text).toBe('  K=supersecretvalue')
    expect(erasedText).not.toContain('supersecretvalue')
    expect(erasedText).toContain('K=')
    expect(erasedText).toContain('su******ue')
    // The replacement says why the value went away, so its absence does not
    // read as the command having failed.
    expect(erasedText).toContain('hidden after 10s')
  })

  test('the erase delay is the one the hint advertises', () => {
    expect(REVEAL_ERASE_MS).toBe(10_000)
  })

  test('terminal control bytes are shown as inert text', () => {
    // The raw forms would clear/restyle the screen or create a live OSC 8 link.
    const dangerous = 'A\x1b[31mRED\x1b[0m\x1b[2J\x1b]8;;https://evil.example\x07click\x1b]8;;\x07Z'
    const { text } = renderRevealed({ key: 'K', value: dangerous })
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain('\x07')
    expect(text).toContain('\\x1b[31mRED\\x1b[0m')
    expect(text).toContain('\\x1b[2J')
    expect(text).toContain('\\x1b]8;;https://evil.example\\x07click')
    expect(text).toContain('(escaped for terminal safety)')
  })

  test('row-shaping controls stay on one physical line', () => {
    const { text } = renderRevealed({ key: 'K', value: 'line1\nline2\rback\ttab' })
    expect(text).not.toContain('\n')
    expect(text).not.toContain('\r')
    expect(text).not.toContain('\t')
    expect(text).toContain('line1\\nline2\\rback\\ttab')
  })

  test('literal backslash escapes remain distinguishable from real controls', () => {
    // A real newline and the literal characters `\\n` must not render the same,
    // otherwise the escaped display is not reversible enough to inspect.
    const real = renderRevealed({ key: 'K', value: 'a\nb' }).text
    const literal = renderRevealed({ key: 'K', value: 'a\\nb' }).text
    expect(real).toContain('a\\nb')
    expect(literal).toContain('a\\\\nb')
    expect(real).not.toBe(literal)
  })

  test('bidi and zero-width format controls cannot spoof the revealed line', () => {
    const { text } = renderRevealed({ key: 'K', value: 'ab\u202ecdef\u200bgh' })
    expect(text).not.toContain('\u202e')
    expect(text).not.toContain('\u200b')
    expect(text).toContain('ab\\u{202e}cdef\\u{200b}gh')
  })

  test('ordinary Unicode remains readable', () => {
    const { text } = renderRevealed({ key: 'K', value: '密钥🔑value' })
    expect(text).toBe('  K=密钥🔑value')
    expect(text).not.toContain('escaped for terminal safety')
  })
})

describe('Committer.commitUnlogged', () => {
  test('reaches the screen but never the log', () => {
    // The log is a plain file that outlives the session and feeds /log. Writing
    // the secret there would make the on-screen erase cosmetic.
    const c = committer()
    c.instance.commitUnlogged([{ id: 'sys-env-reveal', kind: 'system', text: '  K=supersecretvalue' }])

    expect(c.compactLines.map((l) => l.text)).toEqual(['  K=supersecretvalue'])
    expect(c.expandedLines).toHaveLength(1)
    expect(c.logged.join('\n')).not.toContain('supersecretvalue')
    expect(c.logged).toEqual([])
    expect(c.counts().renders).toBe(1)
  })
})

describe('Committer.replaceById', () => {
  test('rewrites a committed line in both views and invalidates the cache', () => {
    // The render cache extends in place on append and would otherwise keep
    // serving the flattened secret from its prefix.
    const c = committer()
    c.instance.commitUnlogged([{ id: 'sys-env-reveal', kind: 'system', text: '  K=supersecretvalue' }])

    expect(c.instance.replaceById('sys-env-reveal', '  K=su******ue')).toBe(true)
    expect(c.compactLines[0]?.text).toBe('  K=su******ue')
    expect(c.expandedLines[0]?.text).toBe('  K=su******ue')
    expect(c.counts().invalidated).toBe(1)
  })

  test('a missing line is reported, not thrown', () => {
    // The normal outcome after /clear: there is nothing left to erase.
    const c = committer()
    expect(c.instance.replaceById('sys-env-reveal', 'masked')).toBe(false)
    expect(c.counts().invalidated).toBe(0)
  })

  test('leaves surrounding history untouched', () => {
    const c = committer()
    c.instance.system('sys-before', '  before')
    c.instance.commitUnlogged([{ id: 'sys-env-reveal', kind: 'system', text: '  K=secret' }])
    c.instance.system('sys-after', '  after')

    c.instance.replaceById('sys-env-reveal', '  K=masked')
    expect(c.compactLines.map((l) => l.text)).toEqual(['  before', '  K=masked', '  after'])
  })

  test('preserves the line kind, so the erase does not restyle the row', () => {
    const c = committer()
    c.instance.commitUnlogged([{ id: 'sys-env-reveal', kind: 'system', text: '  K=secret' }])
    c.instance.replaceById('sys-env-reveal', '  K=masked')
    expect(c.compactLines[0]?.kind).toBe('system')
  })

  test('distinct ids erase their own line', () => {
    // The counterpart to the routing test: unique ids are only useful if each
    // erase lands on its own row. With a shared id, findIndex hit the first line
    // twice and the second secret stayed visible.
    const c = committer()
    c.instance.commitUnlogged([{ id: 'sys-env-reveal-0', kind: 'system', text: '  A=secretAAAAAA' }])
    c.instance.commitUnlogged([{ id: 'sys-env-reveal-1', kind: 'system', text: '  B=secretBBBBBB' }])

    c.instance.replaceById('sys-env-reveal-0', '  A=se******AA')
    c.instance.replaceById('sys-env-reveal-1', '  B=se******BB')

    const texts = c.compactLines.map((l) => l.text)
    expect(texts).toEqual(['  A=se******AA', '  B=se******BB'])
    expect(texts.join('\n')).not.toContain('secretAAAAAA')
    expect(texts.join('\n')).not.toContain('secretBBBBBB')
  })
})

describe('handleEnvCommand routing', () => {
  test('a reveal takes the timed path with both forms', async () => {
    const { ctx, committed } = envContext([{ key: 'K', value: 'supersecretvalue' }])
    await handleEnvCommand(ctx, 'get K --reveal')
    expect(committed).toHaveLength(1)
    const entry = committed[0]!
    expect(entry.id).toStartWith('sys-env-reveal-')
    expect(entry.text).toContain('supersecretvalue')
    expect(entry.erasedText).not.toContain('supersecretvalue')
    expect(entry.delayMs).toBe(REVEAL_ERASE_MS)
  })

  test('two reveals get separate ids, so neither erase hits the wrong line', async () => {
    // With one shared id the second reveal masked the first line twice and left
    // its own value on screen for the rest of the session.
    const { ctx, committed } = envContext([
      { key: 'A', value: 'secretAAAAAA' },
      { key: 'B', value: 'secretBBBBBB' },
    ])
    await handleEnvCommand(ctx, 'get A --reveal')
    await handleEnvCommand(ctx, 'get B --reveal')
    expect(committed).toHaveLength(2)
    expect(committed[0]!.id).not.toBe(committed[1]!.id)
  })

  test('list stays on the ordinary logged path', async () => {
    const { ctx, committed } = envContext([{ key: 'K', value: 'supersecretvalue' }])
    await handleEnvCommand(ctx, 'list')
    expect(committed).toHaveLength(1)
    expect(committed[0]!.id).toBe('sys-env')
    expect(committed[0]!.delayMs).toBeUndefined()
    // The masked list is safe to log; only the interior is withheld.
    expect(committed[0]!.text).not.toContain('persecretval')
    expect(committed[0]!.text).toContain('su******ue')
  })

  test('revealing a key that is not set reports it, without a timer', async () => {
    // Otherwise a typo'd key would silently take the reveal path and commit
    // nothing worth erasing.
    const { ctx, committed } = envContext([{ key: 'K', value: 'v' }])
    await handleEnvCommand(ctx, 'get NOPE --reveal')
    expect(committed[0]!.id).toBe('sys-env')
    expect(committed[0]!.text).toContain('not set: NOPE')
    expect(committed[0]!.delayMs).toBeUndefined()
  })
})

describe('Committer.revealTemporarily', () => {
  test('shows the value now and erases it when the delay elapses', async () => {
    // The timer used to live in a REPL closure, where it could only be
    // type-checked. This is the erase actually running.
    const c = committer()
    c.instance.revealTemporarily('sys-env-reveal-0', '  K=supersecretvalue', '  K=su******ue', 20)

    expect(c.compactLines[0]?.text).toBe('  K=supersecretvalue')
    // Only the masked form is logged, so /log and the file cannot recover it.
    expect(c.logged.join('\n')).not.toContain('supersecretvalue')
    expect(c.logged.join('\n')).toContain('su******ue')

    await Bun.sleep(40)
    expect(c.compactLines[0]?.text).toBe('  K=su******ue')
    expect(c.expandedLines[0]?.text).toBe('  K=su******ue')
  })

  test('two reveals each erase their own line', async () => {
    const c = committer()
    c.instance.revealTemporarily('sys-env-reveal-0', '  A=secretAAAAAA', '  A=se******AA', 20)
    c.instance.revealTemporarily('sys-env-reveal-1', '  B=secretBBBBBB', '  B=se******BB', 20)

    await Bun.sleep(40)
    const texts = c.compactLines.map((l) => l.text).join('\n')
    expect(texts).not.toContain('secretAAAAAA')
    expect(texts).not.toContain('secretBBBBBB')
  })

  test('flushReveals cancels a pending erase, leaving nothing to fire later', async () => {
    // Shutdown path: a timer surviving the REPL would fire against discarded
    // state. The value stays as-is because the process is going away with it.
    const c = committer()
    c.instance.revealTemporarily('sys-env-reveal-0', '  K=supersecretvalue', '  K=su******ue', 20)
    c.instance.flushReveals()

    await Bun.sleep(40)
    expect(c.compactLines[0]?.text).toBe('  K=supersecretvalue')
    expect(c.counts().invalidated).toBe(0)
  })

  test('an erase after /clear is a no-op, not a crash', async () => {
    // /clear empties the arrays, so the line the timer targets is gone.
    const c = committer()
    c.instance.revealTemporarily('sys-env-reveal-0', '  K=supersecretvalue', '  K=su******ue', 20)
    c.compactLines.length = 0
    c.expandedLines.length = 0

    await Bun.sleep(40)
    expect(c.compactLines).toEqual([])
  })
})
