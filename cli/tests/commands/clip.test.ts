import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { clipMarkdown, _testing } from '../../src/commands/clip.js'

const { deriveDescription, slugify, resolveFilename } = _testing

describe('clip markdown metadata', () => {
  test('uses the first heading as description', () => {
    expect(deriveDescription('intro\n\n## **Share command** analysis\nbody'))
      .toBe('Share command analysis')
  })

  test('ignores headings inside code fences', () => {
    expect(deriveDescription('```bash\n# not a heading\nls\n```\n\nActual first line'))
      .toBe('Actual first line')
    expect(deriveDescription('```\n# only code\n```'))
      .toBe('Clipped assistant reply')
  })

  test('falls back to the first non-empty markdown line', () => {
    expect(deriveDescription('```\ncode\n```\n\n- Read the [guide](https://example.com) first'))
      .toBe('Read the guide first')
  })

  test('truncates descriptions to 80 characters', () => {
    expect(Array.from(deriveDescription('a'.repeat(100))).length).toBe(80)
  })

  test('creates bounded ASCII slugs', () => {
    expect(slugify('Crème brûlée: Share the Latest Assistant Reply Safely Today'))
      .toBe('creme-brulee-share-the-latest-assistant')
  })

  test('returns an empty slug for Chinese-only descriptions', () => {
    expect(slugify('保存最新一次回复')).toBe('')
  })
})

describe('clipMarkdown', () => {
  let vaultDir: string
  const now = new Date(2026, 6, 24, 14, 30, 52)

  beforeEach(() => {
    vaultDir = join(tmpdir(), `evot-clip-${process.pid}-${Date.now()}-${Math.random()}`)
  })

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true })
  })

  test('writes verbatim markdown with metadata and creates the index', () => {
    const markdown = '# Share command\n\nKeep **this** exactly.\n'
    const result = clipMarkdown(markdown, {
      sessionId: 'abcdef01-2345-6789-abcd-ef0123456789',
      cwd: '/tmp/project',
    }, vaultDir, now)

    expect(result.slug).toBe('share-command')
    expect(result.path).toBe(join(vaultDir, 'clips', '2026-07-24-share-command.md'))
    const saved = readFileSync(result.path, 'utf8')
    expect(saved).toContain('name: "share-command"')
    expect(saved).toContain('description: "Share command"')
    expect(saved).toContain('type: clip')
    expect(saved).toContain('date: 2026-07-24')
    expect(saved).toContain('session: "abcdef01"')
    expect(saved).toContain('cwd: "/tmp/project"')
    expect(saved.endsWith(markdown)).toBe(true)

    const index = readFileSync(join(vaultDir, 'MEMORY.md'), 'utf8')
    expect(index).toBe('# Memory\n\n- [clips/2026-07-24-share-command.md](clips/2026-07-24-share-command.md) — Share command\n')
  })

  test('uses a timestamp fallback for Chinese-only descriptions', () => {
    const result = clipMarkdown('# 保存最新一次回复', {}, vaultDir, now)
    expect(result.slug).toBe('143052')
    expect(result.path).toBe(join(vaultDir, 'clips', '2026-07-24-143052.md'))
  })

  test('appends a numeric suffix and preserves an existing index', () => {
    const clipsDir = join(vaultDir, 'clips')
    mkdirSync(clipsDir, { recursive: true })
    writeFileSync(join(clipsDir, '2026-07-24-answer.md'), 'existing')
    writeFileSync(join(vaultDir, 'MEMORY.md'), '# Existing index')

    expect(resolveFilename(clipsDir, '2026-07-24-answer')).toBe('2026-07-24-answer-2.md')
    const result = clipMarkdown('# Answer', {}, vaultDir, now)
    expect(result.path.endsWith('2026-07-24-answer-2.md')).toBe(true)
    expect(readFileSync(join(vaultDir, 'MEMORY.md'), 'utf8'))
      .toBe('# Existing index\n- [clips/2026-07-24-answer-2.md](clips/2026-07-24-answer-2.md) — Answer\n')
  })

  test('rejects empty markdown without creating the vault', () => {
    expect(() => clipMarkdown('  \n', {}, vaultDir, now)).toThrow('empty assistant message')
    expect(existsSync(vaultDir)).toBe(false)
  })
})
