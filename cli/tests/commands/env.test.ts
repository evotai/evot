import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { runEnvCommand, USAGE, type EnvPort } from '../../src/commands/env/manage.js'
import { describe as describeValue, shortDate } from '../../src/commands/env/format.js'
import { isValidKey, parseEnvFile } from '../../src/commands/env/parse.js'
import { renderGet, renderList } from '../../src/commands/env/render.js'

interface Recorded {
  sets: Array<{ key: string; value: string }>
  dels: string[]
}

function port(
  initial: Array<{ key: string; value: string; updated_at?: string }> = [],
  options: { files?: Record<string, string>; failSet?: boolean } = {},
): { port: EnvPort; recorded: Recorded } {
  const rows = [...initial]
  const recorded: Recorded = { sets: [], dels: [] }
  return {
    recorded,
    port: {
      list: () => rows,
      set: async (key, value) => {
        if (options.failSet) throw new Error('disk full')
        recorded.sets.push({ key, value })
        const existing = rows.find((row) => row.key === key)
        if (existing) existing.value = value
        else rows.push({ key, value, updated_at: '2026-09-03T00:00:00Z' })
      },
      del: async (key) => {
        recorded.dels.push(key)
        const index = rows.findIndex((row) => row.key === key)
        if (index === -1) return false
        rows.splice(index, 1)
        return true
      },
      readFile: async (path) => {
        const file = options.files?.[path]
        if (file === undefined) throw new Error('ENOENT: no such file')
        return file
      },
    },
  }
}

describe('describe', () => {
  test('shows two characters at each end and hides the middle', () => {
    const secret = '855ffdca2b3d5bdf79535dc047e47fbc'
    const shown = describeValue(secret)
    expect(shown).toBe('85******bc  32 chars')
    // The interior is what must not travel: everything between the endpoints.
    expect(shown).not.toContain('ffdca')
    expect(shown).not.toContain('47e47f')
  })

  test('the star run is fixed width, so it is not a second length readout', () => {
    // Otherwise the mask itself would leak length, and the column would ragged
    // out on long values. The count beside it is the length answer.
    const short = describeValue('a'.repeat(9))
    const long = describeValue('a'.repeat(400))
    const stars = (text: string) => text.slice(2, text.indexOf('  ')).replace(/a+$/, '')
    expect(stars(short)).toBe(stars(long))
    expect(long).toContain('400 chars')
  })

  test('endpoints tell two similar values apart', () => {
    // The point of the change: with only a length, two pasted tokens of the
    // same shape were indistinguishable and you could not tell which was live.
    const a = describeValue('bendcloud://o:tokenone@api.databend.com/warehouse1')
    const b = describeValue('xendcloud://p:tokentwo@api.databend.com/warehouse2')
    expect(a).not.toBe(b)
    // Still no interior: the credential itself never appears.
    expect(a).not.toContain('tokenone')
    expect(b).not.toContain('tokentwo')
  })

  test('a value too short to mask shows no ends at all', () => {
    // Four of eight characters is most of the secret, so short values get
    // nothing but stars.
    expect(describeValue('abc')).toBe('******  3 chars')
    expect(describeValue('12345678')).toBe('******  8 chars')
    expect(describeValue('123456789')).toBe('12******89  9 chars')
  })

  test('empty is labelled, not measured', () => {
    expect(describeValue('')).toBe('(empty)')
  })

  test('length still answers "did my paste get truncated"', () => {
    expect(describeValue('abc')).toContain('3 chars')
    expect(describeValue('a'.repeat(120))).toContain('120 chars')
  })

  test('an escape sequence in a value never reaches the transcript', () => {
    // A value is arbitrary pasted bytes, and the mask copies two of its
    // characters into a line that is supposed to be inert text.
    // `\x1b[31mSECRETVALUE\x1b[0m` masked to `\x1b[******0m`: a live escape byte
    // plus `0m`, which the terminal can read back as a real SGR sequence and
    // restyle the row. Endpoints come from the printable remainder instead.
    const shown = describeValue('\x1b[31mSECRETVALUE\x1b[0m')
    expect(shown).toBe('SE******UE  20 chars')
    expect(shown).not.toContain('\x1b')

    // OSC 8 is the same hazard wearing a hyperlink: it must not survive either.
    const link = describeValue('AB\x1b]8;;https://evil.example\x07click\x1b]8;;\x07YZ')
    expect(link).not.toContain('\x1b')
    expect(link).not.toContain(']8;;')
  })

  test('control characters cannot break the row apart', () => {
    // A newline would split one masked row into two; a carriage return would let
    // later text overwrite what was already drawn.
    expect(describeValue('AB\nmiddle\nYZ')).toBe('AB******YZ  12 chars')
    expect(describeValue('ABmiddle\rOVERWRITTEN')).toBe('AB******EN  20 chars')
    expect(describeValue('AB\tmid\tYZ')).not.toContain('\t')
  })

  test('an emoji endpoint is not cut in half', () => {
    // slice(-2) counted UTF-16 units, so it split a surrogate pair and emitted a
    // lone surrogate — not valid text, and it renders as a replacement glyph.
    const shown = describeValue('🔑🔑secretmiddle🗝️🗝️')
    expect(shown).toContain('🔑🔑')
    const withoutPairs = shown.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')
    expect(/[\ud800-\udfff]/.test(withoutPairs)).toBe(false)
  })

  test('a value that is only control characters shows nothing but stars', () => {
    // Nothing printable is left to take endpoints from, and the length still
    // reports what was stored.
    expect(describeValue('\x1b[31m\x1b[0m')).toBe('******  9 chars')
    expect(describeValue('A\x1b[31mB')).toBe('******  7 chars')
  })

  test('length counts what was stored, not what survived sanitizing', () => {
    // The count answers "did my paste arrive whole", so stripping escapes for
    // display must not make a complete value look truncated.
    expect(describeValue('\x1b[31mSECRETVALUE\x1b[0m')).toContain('20 chars')
    expect(describeValue('🔑🔑secretmiddle🗝️🗝️')).toContain('18 chars')
  })
})

describe('shortDate', () => {
  test('renders an ISO timestamp as a date', () => {
    expect(shortDate('2026-09-03T02:11:34.598Z')).toBe('2026-09-03')
  })

  test('missing or malformed values fall back to a dash', () => {
    expect(shortDate(undefined)).toBe('-')
    expect(shortDate('not a date')).toBe('-')
  })
})

describe('parseEnvFile', () => {
  test('reads plain assignments and keeps the last duplicate', () => {
    const { entries, skipped } = parseEnvFile('A=1\nB=2\nA=3\n')
    expect(entries).toEqual([
      { key: 'A', value: '3' },
      { key: 'B', value: '2' },
    ])
    expect(skipped).toBe(0)
  })

  test('ignores comments and blank lines', () => {
    expect(parseEnvFile('# note\n\n  \nA=1\n').entries).toEqual([{ key: 'A', value: '1' }])
  })

  test('tolerates a leading export and surrounding quotes', () => {
    const { entries } = parseEnvFile('export A="1"\nexport B=\'two\'\n')
    expect(entries).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two' },
    ])
  })

  test('keeps values containing = and : intact', () => {
    expect(parseEnvFile('DSN=bendcloud://o:t@h/w?x=1\n').entries).toEqual([
      { key: 'DSN', value: 'bendcloud://o:t@h/w?x=1' },
    ])
  })

  test('counts malformed lines and invalid keys as skipped', () => {
    const { entries, skipped } = parseEnvFile('novalue\n=orphan\n1BAD=x\nA B=y\nGOOD=1\n')
    expect(entries).toEqual([{ key: 'GOOD', value: '1' }])
    expect(skipped).toBe(4)
  })
})

describe('isValidKey', () => {
  test('accepts shell-style names', () => {
    for (const key of ['A', 'BENDCLOUD_DSN', '_x', 'A1']) expect(isValidKey(key)).toBe(true)
  })

  test('rejects names bash could not export', () => {
    for (const key of ['1A', 'A-B', 'A B', '', 'A=B']) expect(isValidKey(key)).toBe(false)
  })
})

describe('renderList', () => {
  test('masks every value and shows when it changed', () => {
    const out = renderList([
      { key: 'BENDCLOUD_DSN', value: 'bendcloud://o:secrettoken1@h/w', updated_at: '2026-09-03T00:00:00Z' },
      { key: 'A', value: 'shortish', updated_at: '2026-09-01T00:00:00Z' },
    ])
    expect(out).toContain('Variables (2)')
    expect(out).not.toContain('secrettoken1')
    expect(out).toContain('2026-09-03')
    expect(out.indexOf('  A ')).toBeLessThan(out.indexOf('BENDCLOUD_DSN'))
    expect(out).toContain('--reveal')
  })

  test('empty state says so without the reveal hint', () => {
    expect(renderList([])).toBe('  no variables set')
  })
})

describe('renderGet', () => {
  test('masks, with no option to do otherwise', () => {
    // The reveal was removed from this renderer on purpose. A value has to be
    // committed on the timed, unlogged path, so a renderer that could return one
    // here would be reachable by any future caller that forgot — the secret would
    // land in the screen log with no timer to take it back.
    const row = { key: 'K', value: 'supersecretvalue', updated_at: '2026-09-03T00:00:00Z' }
    const out = renderGet(row, 'K')
    expect(out).not.toContain('supersecretvalue')
    expect(out).toContain('su******ue')
    expect(out).toContain('2026-09-03')
  })

  test('unknown key is reported plainly', () => {
    expect(renderGet(undefined, 'NOPE')).toBe('  not set: NOPE')
  })
})

describe('runEnvCommand', () => {
  test('bare invocation and list are the same view', async () => {
    const { port: p } = port([{ key: 'A', value: 'value-one' }])
    expect(await runEnvCommand(p, '')).toBe(await runEnvCommand(p, 'list'))
  })

  test('set stores the value but never echoes it', async () => {
    const { port: p, recorded } = port()
    const out = await runEnvCommand(p, 'set BENDCLOUD_DSN=bendcloud://o:secrettoken@h/w')
    expect(recorded.sets).toEqual([
      { key: 'BENDCLOUD_DSN', value: 'bendcloud://o:secrettoken@h/w' },
    ])
    expect(out).not.toContain('secrettoken')
    expect(out).toContain('29 chars')
  })

  test('set keeps = and spaces inside the value', async () => {
    const { port: p, recorded } = port()
    await runEnvCommand(p, 'set Q=a=b c')
    expect(recorded.sets[0]!.value).toBe('a=b c')
  })

  test('set rejects keys bash could not export', async () => {
    const { port: p, recorded } = port()
    expect(await runEnvCommand(p, 'set 1BAD=x')).toContain('invalid key')
    expect(recorded.sets).toEqual([])
  })

  test('set without = explains itself', async () => {
    const { port: p } = port()
    expect(await runEnvCommand(p, 'set JUSTKEY')).toContain('Usage: /env set')
  })

  test('a failing write propagates instead of reporting success', async () => {
    const { port: p } = port([], { failSet: true })
    await expect(runEnvCommand(p, 'set A=1')).rejects.toThrow('disk full')
  })

  test('del distinguishes a real deletion from a missing key', async () => {
    const { port: p, recorded } = port([{ key: 'A', value: 'x' }])
    expect(await runEnvCommand(p, 'del A')).toBe('  deleted A')
    expect(await runEnvCommand(p, 'del A')).toBe('  not set: A')
    expect(recorded.dels).toEqual(['A', 'A'])
  })

  test('no path through this router prints a value, --reveal included', async () => {
    // The reveal is intercepted by the REPL, which owns the erase timer. This
    // router is the logged path, so a value reaching it would be written to the
    // screen log with nothing to take it back. Parsing is pinned in
    // env-reveal.test.ts (parseRevealTarget); what matters here is that the flag
    // buys nothing if it ever falls through.
    const { port: p } = port([{ key: 'K', value: 'plainsecret' }])
    for (const args of ['get K', 'get K --reveal', 'get --reveal K']) {
      const out = await runEnvCommand(p, args)
      expect(out).not.toContain('plainsecret')
      expect(out).toContain('pl******et')
    }
  })

  test('unknown subcommand shows the full usage', async () => {
    const { port: p } = port()
    expect(await runEnvCommand(p, 'bogus')).toBe(USAGE)
    expect(USAGE).toContain('list')
    expect(USAGE).toContain('load FILE')
  })

  test('load imports each entry and reports names only', async () => {
    const { port: p, recorded } = port([], {
      files: { '/tmp/x.env': 'A=secretone\nB=secrettwo\n# c\nbroken\n' },
    })
    const out = await runEnvCommand(p, 'load /tmp/x.env')
    expect(recorded.sets).toEqual([
      { key: 'A', value: 'secretone' },
      { key: 'B', value: 'secrettwo' },
    ])
    expect(out).toContain('loaded 2 variable(s)')
    expect(out).toContain('1 line(s) skipped')
    expect(out).toContain('A, B')
    expect(out).not.toContain('secretone')
  })

  test('load reports an unreadable file without throwing', async () => {
    const { port: p } = port()
    expect(await runEnvCommand(p, 'load /nope.env')).toContain('cannot read /nope.env')
  })

  test('load says so when a readable file has nothing usable', async () => {
    const { port: p } = port([], { files: { '/tmp/e.env': '# only comments\n' } })
    expect(await runEnvCommand(p, 'load /tmp/e.env')).toContain('no KEY=VALUE lines')
  })

  test('load reads a real file from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evot-env-'))
    const file = join(dir, 'creds.env')
    writeFileSync(file, 'BENDCLOUD_DSN=bendcloud://o:t@h/w\n')
    const { port: p, recorded } = port([], {})
    const real: EnvPort = {
      ...p,
      readFile: async (path) => (await import('fs/promises')).readFile(path, 'utf8'),
    }
    expect(await runEnvCommand(real, `load ${file}`)).toContain('loaded 1 variable(s)')
    expect(recorded.sets[0]!.key).toBe('BENDCLOUD_DSN')
  })

  test('subcommands each explain themselves when given no argument', async () => {
    const { port: p } = port()
    expect(await runEnvCommand(p, 'get')).toContain('Usage: /env get')
    expect(await runEnvCommand(p, 'del')).toContain('Usage: /env del')
    expect(await runEnvCommand(p, 'load')).toContain('Usage: /env load')
  })
})
