import { describe, test, expect } from 'bun:test'
import { complete, fileCompletionTarget, getGhostHint } from '../src/commands/completion.js'

describe('slash command completion', () => {
  test('completes single match with trailing space', () => {
    const result = complete('/he', 3)
    expect(result).not.toBeNull()
    expect(result!.replacement).toBe('/help ')
    expect(result!.candidates).toEqual(['/help'])
    expect(result!.wordStart).toBe(0)
  })

  test('completes uppercase input the same way', () => {
    const result = complete('/HE', 3)
    expect(result).not.toBeNull()
    expect(result!.replacement).toBe('/help ')
  })

  test('completes common prefix for multiple matches', () => {
    // /e matches /exit and /env — should show both candidates
    const result = complete('/e', 2)
    expect(result).not.toBeNull()
    expect(result!.candidates).toContain('/exit')
    expect(result!.candidates).toContain('/env')
  })

  test('returns null for no matches', () => {
    const result = complete('/zzz', 4)
    expect(result).toBeNull()
  })

  test('completes /ha to /harden', () => {
    const result = complete('/ha', 3)
    expect(result).not.toBeNull()
    expect(result!.replacement).toBe('/harden ')
    expect(result!.candidates).toEqual(['/harden'])
  })

  test('returns null when past the command word', () => {
    const result = complete('/model gpt', 10)
    expect(result).toBeNull()
  })

  test('visible /resume owns short prefixes over hidden /restart', () => {
    for (const prefix of ['/re', '/res']) {
      const result = complete(prefix, prefix.length)
      expect(result).not.toBeNull()
      expect(result!.replacement).toBe('/resume ')
      expect(result!.candidates).toEqual(['/resume'])
    }
  })

  test('completes /rest to /restart once /resume no longer matches', () => {
    const result = complete('/rest', 5)
    expect(result).not.toBeNull()
    expect(result!.replacement).toBe('/restart ')
    expect(result!.candidates).toEqual(['/restart'])
  })

  test('completes /q to /quit alias', () => {
    const result = complete('/qu', 3)
    expect(result).not.toBeNull()
    expect(result!.candidates).toContain('/quit')
  })

  test('shows multiple candidates for ambiguous prefix', () => {
    // /cl could match /clear
    const result = complete('/cl', 3)
    expect(result).not.toBeNull()
    expect(result!.candidates).toContain('/clear')
  })
})

describe('file path completion', () => {
  test('path routing is independent of filesystem matches and shared with suggestion routing', () => {
    for (const word of ['../evot/xx', './src/missing', '~/projects/none', '/tmp/missing', '/etc', 'nested/file.ts']) {
      const text = `inspect ${word}`
      expect(fileCompletionTarget(text, text.length)).toMatchObject({ word, wordStart: 'inspect '.length })
    }
    const text = '/loop check ../evot/xx then report'
    const cursor = '/loop check ../evot/xx'.length
    expect(fileCompletionTarget(text, cursor)).toMatchObject({ word: '../evot/xx', wordStart: '/loop check '.length })
    for (const text of ['plain prose', '/lo', '/loop', '/model', '/_dump', '/loop 5m run tests']) {
      expect(fileCompletionTarget(text, text.length)).toBeNull()
    }
  })

  test('paths also complete inside slash-command arguments', () => {
    const text = '/loop inspect ./tests'
    const result = complete(text, text.length)
    expect(result).not.toBeNull()
    expect(result!.wordStart).toBe('/loop inspect '.length)
    expect(result!.replacement).toBe('./tests/')
  })
  test('completes paths starting with ./', () => {
    const result = complete('./', 2)
    expect(result).not.toBeNull()
    expect(result!.candidates.length).toBeGreaterThan(0)
  })

  test('returns null for plain text', () => {
    const result = complete('hello world', 11)
    expect(result).toBeNull()
  })

  test('treats existing directory as a parent for descent (appends trailing /)', () => {
    // The cwd of the test runner is the cli/ directory, which contains a
    // `tests` subdirectory. Typing `./tests` (no slash) and pressing tab
    // should produce candidates that include a trailing slash, so a follow-up
    // tab descends into the directory rather than concatenating filenames
    // directly to the typed path.
    const result = complete('./tests', 7)
    expect(result).not.toBeNull()
    // Either a single match `./tests/` or, if multiple siblings begin with
    // `tests`, all of them must keep a clear separator before any filename.
    for (const cand of result!.candidates) {
      // No candidate should look like "./testsfoo" — the segment after
      // `./tests` must start with `/` (directory boundary) or the candidate
      // must be a sibling whose name begins with `tests`.
      if (cand.startsWith('./tests') && cand !== './tests/') {
        const after = cand.slice('./tests'.length)
        // Either it's a deeper path ("./tests/...") or a sibling name
        // ("./testsuite" — starts with extra letters then maybe `/`).
        // What we must never see is something like "./testsfile.ts" where
        // the original `./tests` was a real directory but got concatenated
        // with a child filename without a slash.
        if (after.length > 0 && after[0] !== '/' && /^[a-z]/i.test(after[0]!)) {
          // Allow only when this is genuinely a sibling, not a child of ./tests
          // For the tests/ directory in the cli workspace there is no sibling
          // entry whose name starts with "tests" other than `tests/` itself.
          throw new Error(`unexpected candidate without separator: ${cand}`)
        }
      }
    }
  })

  test('extracts path glued to CJK text without space', () => {
    // A path appended directly to non-Latin text still has its own start.
    const line = '\u770b\u4e0b./tests'
    const result = complete(line, line.length)
    expect(result).not.toBeNull()
    expect(result!.replacement.startsWith('./tests')).toBe(true)
    // wordStart must point at `.` of `./tests`, not the start of the line.
    expect(line.slice(result!.wordStart)).toBe('./tests')
  })

  test('extracts path mid-line preceded by ASCII text and space', () => {
    const line = 'edit ./tests rest'
    // cursor right after `./tests`
    const cursor = 'edit ./tests'.length
    const result = complete(line, cursor)
    expect(result).not.toBeNull()
    expect(line.slice(result!.wordStart, cursor)).toBe('./tests')
  })

  test('does not trigger for bare ~ without slash', () => {
    const result = complete('please look at ~', 16)
    expect(result).toBeNull()
  })
})

describe('ghost hints', () => {
  test('bare slash keeps resume visible and hides restart', () => {
    const hint = getGhostHint('/', 1)
    expect(hint).toContain('resume')
    expect(hint).not.toContain('restart')
  })

  test('bare slash offers back only once the session has a fork parent', () => {
    expect(getGhostHint('/', 1)).not.toContain('back')
    expect(getGhostHint('/', 1, { forked: false })).not.toContain('back')
    expect(getGhostHint('/', 1, { forked: true })).toContain('fork  back  model')
  })

  test('removed plan mode is absent from hints and prefix completion', () => {
    expect(getGhostHint('/', 1)).not.toContain('plan')
    expect(getGhostHint('/pl', 3)).toBe('')
    expect(complete('/pl', 3)).toBeNull()
  })

  test('back stays prefix-completable in a root session', () => {
    expect(getGhostHint('/ba', 3)).toContain('ck')
    expect(getGhostHint('/back ', 6)).toContain('<levels>')
  })

  test('short resume prefixes do not advertise hidden restart', () => {
    for (const prefix of ['/re', '/res']) {
      const hint = getGhostHint(prefix, prefix.length)
      expect(hint).toContain('ume')
      expect(hint).not.toContain('restart')
    }
  })

  test('shows clip all subcommand', () => {
    expect(getGhostHint('/clip ', 6)).toContain('all')
    expect(getGhostHint('/clip a', 7)).toBe('ll')
  })

  test('shows skill subcommands', () => {
    const hint = getGhostHint('/skill ', 7)
    expect(hint).toContain('install')
    expect(hint).toContain('list')
    expect(hint).toContain('remove')
  })

  test('hints the /sessions alias like the canonical command', () => {
    // Typing an alias must feel like typing the real name: same description on
    // the name, same argument hints after the space.
    expect(getGhostHint('/sessions', 9)).toContain('<id>')
    expect(getGhostHint('/sessions ', 10)).toContain('<request>')
    expect(getGhostHint('/SESSIONS ', 10)).toContain('<request>')
  })
})

describe('alias completion', () => {
  test('tab-completes /sessions', () => {
    const result = complete('/sess', 5)
    expect(result).not.toBeNull()
    expect(result!.replacement).toBe('/sessions ')
    expect(result!.candidates).toEqual(['/sessions'])
  })
})

describe('sub-command completion', () => {
  test('completes the sub-command under the cursor', () => {
    // The reported bug: `/harden chan` showed a `ges` ghost hint, but Tab
    // refused to apply it because completion stopped at the command name.
    const result = complete('/harden chan', 12)
    expect(result).not.toBeNull()
    expect(result!.replacement).toBe('changes ')
    expect(result!.candidates).toEqual(['changes'])
    // Splices the argument, leaving `/harden ` intact.
    expect(result!.wordStart).toBe(8)
  })

  test('applies to every command with literal sub-commands', () => {
    for (const [input, expected] of [
      ['/skill inst', 'install '],
      ['/log sh', 'shot '],
      ['/env li', 'list '],
      ['/clip a', 'all '],
      ['/help mo', 'model '],
    ] as const) {
      const result = complete(input, input.length)
      expect(result, input).not.toBeNull()
      expect(result!.replacement, input).toBe(expected)
    }
  })

  test('never completes a placeholder as literal text', () => {
    // `<name>` / `<query>` describe what to type; inserting them verbatim would
    // put angle brackets into the prompt.
    for (const input of ['/model ', '/resume ', '/sessions ', '/share x']) {
      expect(complete(input, input.length), input).toBeNull()
    }
  })

  test('declines an ambiguous prefix rather than applying nothing', () => {
    // `/env l` matches list+load; the common prefix adds no characters, so Tab
    // must report "not handled" instead of consuming the key for a no-op.
    expect(complete('/env l', 6)).toBeNull()
    // One more character disambiguates it.
    expect(complete('/env lo', 7)!.replacement).toBe('load ')
  })

  test('leaves free-form prompt text past the first argument alone', () => {
    expect(complete('/harden changes and more', 24)).toBeNull()
    expect(complete('harden chan', 11)).toBeNull()
    expect(complete('/nonexist foo', 13)).toBeNull()
  })

  test('a literal ghost hint is always applicable by Tab', () => {
    // The invariant that broke: the hint advertised a completion Tab could not
    // deliver. Anything the hint offers as literal text must be appliable.
    for (const input of [
      '/harden chan', '/harden pl', '/harden a', '/skill re',
      '/log sh', '/env lo', '/clip a', '/help mo',
    ]) {
      const hint = getGhostHint(input, input.length)
      // A literal hint has no bracketed candidate list.
      expect(hint, input).not.toBe('')
      expect(hint.startsWith('  ['), input).toBe(false)

      const result = complete(input, input.length)
      expect(result, input).not.toBeNull()
      // Applying the completion yields exactly what the hint promised.
      const partial = input.slice(result!.wordStart)
      expect(result!.replacement, input).toBe(`${partial}${hint.trimEnd()} `)
    }
  })
})
