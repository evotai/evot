import { describe, test, expect } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import { resolveCommand, isSlashCommand, buildHardenPrompt } from '../src/commands/index.js'
import { getSkillEntries, skillListFromDirs, resolveSkillsDirs, skillList } from '../src/commands/skill.js'

describe('isSlashCommand', () => {
  test('recognizes slash commands', () => {
    expect(isSlashCommand('/help')).toBe(true)
    expect(isSlashCommand('/h')).toBe(true)
    expect(isSlashCommand('/model gpt-4')).toBe(true)
  })

  test('ignores case so caps lock does not send the command to the model', () => {
    expect(isSlashCommand('/NEW')).toBe(true)
    expect(isSlashCommand('/Resume abc')).toBe(true)
    expect(resolveCommand('/NEW')).toEqual({ kind: 'resolved', name: '/new', args: '' })
    expect(resolveCommand('/SESSIONS 小红书')).toEqual({ kind: 'resolved', name: '/resume', args: '小红书' })
  })

  test('rejects non-commands', () => {
    expect(isSlashCommand('hello')).toBe(false)
    expect(isSlashCommand('')).toBe(false)
    expect(isSlashCommand('/')).toBe(false)
  })

  test('rejects double-slash paths', () => {
    expect(isSlashCommand('//some/path')).toBe(false)
  })

  test('rejects pasted file paths', () => {
    expect(isSlashCommand('/some/path.rs')).toBe(false)
    expect(isSlashCommand('/usr/local/bin')).toBe(false)
  })
})

describe('resolveCommand', () => {
  test('resolves exact command names', () => {
    const result = resolveCommand('/help')
    expect(result).toEqual({ kind: 'resolved', name: '/help', args: '' })
  })

  test('resolves command with args', () => {
    const result = resolveCommand('/model gpt-4o')
    expect(result).toEqual({ kind: 'resolved', name: '/model', args: 'gpt-4o' })
  })

  test('resolves /task command', () => {
    expect(resolveCommand('/task')).toEqual({ kind: 'resolved', name: '/task', args: '' })
    expect(resolveCommand('/task send a daily report')).toEqual({
      kind: 'resolved',
      name: '/task',
      args: 'send a daily report',
    })
  })

  test('resolves /harden command', () => {
    const result = resolveCommand('/harden plan')
    expect(result).toEqual({ kind: 'resolved', name: '/harden', args: 'plan' })
    expect(isSlashCommand('/harden')).toBe(true)
  })

  test('visible commands own prefixes shared with hidden commands', () => {
    expect(resolveCommand('/re')).toEqual({ kind: 'resolved', name: '/resume', args: '' })
    expect(resolveCommand('/res')).toEqual({ kind: 'resolved', name: '/resume', args: '' })
    expect(resolveCommand('/rest')).toEqual({ kind: 'resolved', name: '/restart', args: '' })
  })

  test('resolves /restart', () => {
    expect(resolveCommand('/restart')).toEqual({ kind: 'resolved', name: '/restart', args: '' })
    expect(isSlashCommand('/restart')).toBe(true)
  })

  test('background work has no slash commands', () => {
    // Managed only through the TUI panel (ctrl+t, or ↓ on an empty composer).
    // Keeping a command surface too would mean two presentations to keep in sync.
    expect(resolveCommand('/tasks')).toEqual({ kind: 'unknown' })
    expect(resolveCommand('/ps')).toEqual({ kind: 'unknown' })
    expect(resolveCommand('/stop')).toEqual({ kind: 'unknown' })
  })

  test('resolves aliases', () => {
    const result = resolveCommand('/q')
    expect(result).toEqual({ kind: 'resolved', name: '/exit', args: '' })
  })

  test('resolves /sessions to /resume, with and without args', () => {
    expect(resolveCommand('/sessions')).toEqual({ kind: 'resolved', name: '/resume', args: '' })
    expect(resolveCommand('/sessions auth bug')).toEqual({
      kind: 'resolved',
      name: '/resume',
      args: 'auth bug',
    })
    expect(isSlashCommand('/sessions')).toBe(true)
  })

  test('resolves the /sessions alias by prefix', () => {
    // `/se` is unique to the alias, so it must resolve rather than dead-end.
    expect(resolveCommand('/se')).toEqual({ kind: 'resolved', name: '/resume', args: '' })
  })

  test('resolves by prefix when unambiguous', () => {
    const result = resolveCommand('/he')
    expect(result).toEqual({ kind: 'resolved', name: '/help', args: '' })
  })

  test('returns ambiguous for multiple prefix matches', () => {
    // `/s` still spans several commands. Retired /plan no longer owns /p.
    const result = resolveCommand('/s')
    expect(result.kind).toBe('ambiguous')
    expect(resolveCommand('/p')).toEqual({ kind: 'unknown' })
  })

  test('routes removed /plan command to the unknown-command handler', () => {
    expect(resolveCommand('/plan')).toEqual({ kind: 'unknown' })
    expect(resolveCommand('/plan review changes')).toEqual({ kind: 'unknown' })
    expect(isSlashCommand('/plan')).toBe(true)
  })

  test('routes removed /history command to the unknown-command handler', () => {
    expect(resolveCommand('/history')).toEqual({ kind: 'unknown' })
    expect(isSlashCommand('/history')).toBe(true)
    expect(isSlashCommand('/history 10')).toBe(true)
  })

  test('returns unknown for unrecognized commands', () => {
    const result = resolveCommand('/foobar')
    expect(result).toEqual({ kind: 'unknown' })
  })

  test('resolves /compact with optional instructions', () => {
    expect(resolveCommand('/compact')).toEqual({ kind: 'resolved', name: '/compact', args: '' })
    expect(resolveCommand('/compact preserve implementation details')).toEqual({
      kind: 'resolved',
      name: '/compact',
      args: 'preserve implementation details',
    })
  })

  test('resolves /clip with its subcommands', () => {
    expect(resolveCommand('/clip')).toEqual({ kind: 'resolved', name: '/clip', args: '' })
    expect(resolveCommand('/clip all')).toEqual({ kind: 'resolved', name: '/clip', args: 'all' })
    expect(resolveCommand('/clip copy')).toEqual({ kind: 'resolved', name: '/clip', args: 'copy' })
    expect(resolveCommand('/copy')).toEqual({ kind: 'unknown' })
    expect(isSlashCommand('/clip')).toBe(true)
  })

  test('resolves /share for upload and management', () => {
    expect(resolveCommand('/share')).toEqual({ kind: 'resolved', name: '/share', args: '' })
    expect(resolveCommand('/share abcdef01')).toEqual({ kind: 'resolved', name: '/share', args: 'abcdef01' })
    expect(resolveCommand('/share list')).toEqual({
      kind: 'resolved',
      name: '/share',
      args: 'list',
    })
    expect(isSlashCommand('/share')).toBe(true)
  })

  test('resolves /login', () => {
    expect(resolveCommand('/login')).toEqual({ kind: 'resolved', name: '/login', args: '' })
    expect(isSlashCommand('/login')).toBe(true)
  })

  test('resolves /logout', () => {
    expect(resolveCommand('/logout')).toEqual({ kind: 'resolved', name: '/logout', args: '' })
    expect(isSlashCommand('/logout')).toBe(true)
  })

  test('/c is ambiguous between /clip, /compact, and /clear', () => {
    const result = resolveCommand('/c')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toContain('/clip')
      expect(result.candidates).toContain('/clear')
    }
  })

  test('is case insensitive', () => {
    const result = resolveCommand('/HELP')
    expect(result).toEqual({ kind: 'resolved', name: '/help', args: '' })
  })

  test('handles extra whitespace in args', () => {
    const result = resolveCommand('/resume   abc123')
    expect(result).toEqual({ kind: 'resolved', name: '/resume', args: 'abc123' })
  })
})

describe('buildHardenPrompt', () => {
  test('defaults to previous plan or conclusion with git diff as supporting context', () => {
    const prompt = buildHardenPrompt('')

    expect(prompt).toContain('immediately preceding conversation context')
    expect(prompt).toContain('If local git changes exist')
    expect(prompt).toContain('supporting context')
    expect(prompt).toContain('do not default to hardening the diff')
    expect(prompt).not.toBe('harden current git changes')
  })

  test('keeps explicit changes subject focused on git changes', () => {
    expect(buildHardenPrompt('changes')).toBe('harden current git changes')
  })

  test('keeps explicit plan subject focused on previous context', () => {
    expect(buildHardenPrompt('plan')).toContain('immediately preceding conversation context')
  })

  test('keeps explicit arch subject focused on architecture', () => {
    const prompt = buildHardenPrompt('arch')
    expect(prompt).toContain('architecture')
    expect(prompt).toContain('simplicity')
    expect(prompt).toContain('annotated file tree')
  })

  test('passes custom subject through as strategy', () => {
    expect(buildHardenPrompt('retry rollout')).toBe('harden this strategy: retry rollout')
  })
})
describe('skillListFromDirs', () => {
  test('lists skills from evotai and claude directories', () => {
    const home = join(tmpdir(), `evot-skill-list-${Date.now()}`)
    const evotai = join(home, '.evotai', 'skills')
    const claude = join(home, '.claude', 'skills')

    try {
      mkdirSync(join(evotai, 'evot-skill'), { recursive: true })
      mkdirSync(join(claude, 'claude-skill'), { recursive: true })
      writeFileSync(join(evotai, 'evot-skill', 'SKILL.md'), '---\ndescription: evot\n---\n')
      writeFileSync(join(claude, 'claude-skill', 'SKILL.md'), '---\ndescription: claude\n---\n')

      const out = stripAnsi(skillListFromDirs([evotai, claude], { columns: 80 }))
      expect(out).toContain('[Skills]  2 · 2 units')
      // Lone skills are ○ rows carrying the directory they live in.
      expect(out).toContain(`○ claude-skill  ${claude}`)
      expect(out).toContain(`○ evot-skill    ${evotai}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('groups nested skills under the group directory', () => {
    const root = join(tmpdir(), `evot-skill-group-${Date.now()}`)
    try {
      for (const name of ['lark-im', 'lark-shared']) {
        mkdirSync(join(root, 'lark', name), { recursive: true })
        writeFileSync(join(root, 'lark', name, 'SKILL.md'), `---\ndescription: ${name}\n---\n`)
      }
      mkdirSync(join(root, 'databend-cloud'), { recursive: true })
      writeFileSync(join(root, 'databend-cloud', 'SKILL.md'), '---\ndescription: db\n---\n')

      const out = stripAnsi(skillListFromDirs([root], { columns: 80 }))
      expect(out).toContain('● lark/')
      // Groups stay collapsed to one unit row; child skills are intentionally hidden.
      expect(out).not.toContain('lark-im')
      expect(out).not.toContain('im | shared')
      expect(out).toContain('○ databend-cloud')
      expect(out).not.toContain('● lark ')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('official installs show one catalog section with commit and repository', () => {
    const root = join(tmpdir(), `evot-skill-origin-${Date.now()}`)
    try {
      mkdirSync(join(root, 'lark', 'lark-im'), { recursive: true })
      writeFileSync(join(root, 'lark', 'lark-im', 'SKILL.md'), '---\ndescription: im\n---\n')
      writeFileSync(
        join(root, 'lark', '.evot-source.json'),
        JSON.stringify({
          version: 1,
          repo: 'evotai/evot-skills',
          ref: 'main',
          path: 'skills/lark',
          commit: '40b5130',
          installedAt: '2024-01-01T00:00:00.000Z',
        }),
      )

      const out = stripAnsi(skillListFromDirs([root], { columns: 80, env: {} }))
      expect(out).toContain('[Official]  auto-updated · https://github.com/evotai/evot-skills')
      expect(out).toContain('● lark/  @40b5130  1')
      expect(out).not.toContain('[official]')
      expect(out.match(/evotai\/evot-skills/g)?.length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('third-party installs keep the repo in the origin', () => {
    const root = join(tmpdir(), `evot-skill-third-${Date.now()}`)
    try {
      mkdirSync(join(root, 'pack', 'one'), { recursive: true })
      writeFileSync(join(root, 'pack', 'one', 'SKILL.md'), '---\ndescription: one\n---\n')
      writeFileSync(
        join(root, 'pack', '.evot-source.json'),
        JSON.stringify({
          version: 1,
          repo: 'acme/pack',
          ref: 'main',
          path: '',
          commit: '1a2b3c4',
          installedAt: '2024-01-01T00:00:00.000Z',
        }),
      )

      expect(stripAnsi(skillListFromDirs([root], { columns: 80, env: {} }))).toContain('acme/pack@1a2b3c4')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an empty set of directories says so', () => {
    expect(stripAnsi(skillListFromDirs(['/path/that/does/not/exist']))).toBe('  no skills installed')
  })
})

describe('resolveSkillsDirs', () => {
  const builtinDir = join(homedir(), '.evotai', 'builtin-skills')
  const evotaiDir = join(homedir(), '.evotai', 'skills')
  const claudeDir = join(homedir(), '.claude', 'skills')

  test('defaults to builtin + global + claude dirs when EVOT_SKILLS_DIRS is unset', () => {
    expect(resolveSkillsDirs({})).toEqual([builtinDir, evotaiDir, claudeDir])
  })

  test('inserts EVOT_SKILLS_DIRS entries between global and claude, in order', () => {
    expect(resolveSkillsDirs({ EVOT_SKILLS_DIRS: '/abs/one:/abs/two' })).toEqual([
      builtinDir,
      evotaiDir,
      '/abs/one',
      '/abs/two',
      claudeDir,
    ])
  })

  test('expands a leading ~ in EVOT_SKILLS_DIRS entries', () => {
    expect(resolveSkillsDirs({ EVOT_SKILLS_DIRS: '~/work/skills' })).toEqual([
      builtinDir,
      evotaiDir,
      join(homedir(), 'work', 'skills'),
      claudeDir,
    ])
  })

  test('trims whitespace and skips empty segments', () => {
    expect(resolveSkillsDirs({ EVOT_SKILLS_DIRS: ' /a : : /b ' })).toEqual([
      builtinDir,
      evotaiDir,
      '/a',
      '/b',
      claudeDir,
    ])
  })

  test('de-duplicates while preserving order', () => {
    // Repeating the global dir must not produce a duplicate entry.
    expect(resolveSkillsDirs({ EVOT_SKILLS_DIRS: evotaiDir })).toEqual([
      builtinDir,
      evotaiDir,
      claudeDir,
    ])
  })
})

describe('skill discovery', () => {
  // The agent resolves EVOT_SKILLS_DIRS from ~/.evotai/evot.env, which
  // resolveSkillsDirs() (process.env only) cannot see. Callers with a live
  // agent must pass its resolved directories through unchanged.
  test('scans explicit directories instead of process.env', () => {
    const home = join(tmpdir(), `evot-skill-override-${Date.now()}`)
    const envFileDir = join(home, 'from-env-file', 'skills')
    try {
      mkdirSync(join(envFileDir, 'env-skill'), { recursive: true })
      writeFileSync(join(envFileDir, 'env-skill', 'SKILL.md'), '---\ndescription: x\n---\n')

      const entries = getSkillEntries([envFileDir])
      expect(entries).toEqual([{
        name: 'env-skill',
        dir: join(envFileDir, 'env-skill'),
      }])
      // The row names the directory the skill lives in, not the skill's own dir.
      expect(stripAnsi(skillList([envFileDir], { columns: 120 }))).toContain(`○ env-skill  ${envFileDir}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('uses the later directory when skill names overlap', () => {
    const home = join(tmpdir(), `evot-skill-precedence-${Date.now()}`)
    const builtinDir = join(home, 'builtin')
    const overrideDir = join(home, 'override')
    try {
      for (const dir of [builtinDir, overrideDir]) {
        mkdirSync(join(dir, 'shared'), { recursive: true })
        writeFileSync(join(dir, 'shared', 'SKILL.md'), '---\n---\n')
      }

      expect(getSkillEntries([builtinDir, overrideDir])).toEqual([{
        name: 'shared',
        dir: join(overrideDir, 'shared'),
      }])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('skips missing directories', () => {
    expect(getSkillEntries(['/path/that/does/not/exist'])).toEqual([])
  })
})
