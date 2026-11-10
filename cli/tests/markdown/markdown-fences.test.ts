/**
 * Fixture-driven fence repair cases.
 *
 * Each directory under tests/fixtures/fences/<case-id>/ holds:
 *   in.md   — raw model markdown
 *   out.md  — expected prepareMarkdownFences() output
 *
 * New screenshot bug workflow: drop a fixture → red → adjust one case in
 * cases.ts → green. Do not patch unrelated cases.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { prepareMarkdownFences } from '../../src/markdown/normalize/fences/index.js'
import { renderMarkdown } from '../../src/render/markdown.js'
import stripAnsi from 'strip-ansi'

const FIXTURES_ROOT = join(import.meta.dir, '../fixtures/fences')

function listFixtureCases(): string[] {
  return readdirSync(FIXTURES_ROOT)
    .filter(name => statSync(join(FIXTURES_ROOT, name)).isDirectory())
    .sort()
}

describe('prepareMarkdownFences fixtures', () => {
  for (const id of listFixtureCases()) {
    test(id, () => {
      const dir = join(FIXTURES_ROOT, id)
      const input = readFileSync(join(dir, 'in.md'), 'utf8')
      const expected = readFileSync(join(dir, 'out.md'), 'utf8')
      expect(prepareMarkdownFences(input)).toBe(expected)
    })
  }
})

describe('shell-close-before-md-boundary render', () => {
  test('heading and table after unclosed bash are not swallowed as code', () => {
    const md = [
      '```bash',
      'cursor-agent --model grok',
      '## Excluded projects',
      '| Project | Reason |',
      '|---|---|',
      '| foo | `bar` |',
    ].join('\n')

    const result = stripAnsi(renderMarkdown(md)).replace(/\u200b/g, '')

    expect(result).toContain('cursor-agent --model grok')
    expect(result).toContain('Excluded projects')
    expect(result).not.toMatch(/^ {2}## Excluded projects/m)
    expect(result).not.toContain('|---|---|')
    expect(result).toContain('┌')
    expect(result).toContain('bar')
  })

  test('bash # comments stay inside the fence (not ATX H1 early-close)', () => {
    const md = [
      '## Usage',
      '',
      '```bash',
      '# Edit config (auto-created on first run)',
      "$EDITOR ~/.db0/db0.env",
      '',
      '# Uncomment and fill in, for example:',
      '# DB0_MODEL=anthropic/claude-sonnet-4-6',
      '',
      '# Show resolved config (keys redacted)',
      'cargo run -- config',
      '```',
      '',
      '## Layout',
      '',
      '```text',
      'src/config/',
      '  mod.rs',
      '```',
    ].join('\n')

    const result = stripAnsi(renderMarkdown(md)).replace(/\u200b/g, '')

    expect(result).toContain('# Uncomment and fill in, for example:')
    expect(result).toContain('cargo run -- config')
    expect(result).toMatch(/^ {0,2}Layout/m)
    expect(result).not.toMatch(/^ {2,}## Layout/m)
    expect(result).toContain('src/config/')
    expect(result).toContain('mod.rs')
    const bareFenceLines = result.split('\n').filter(l => /^ {0,2}```\s*$/.test(l))
    expect(bareFenceLines.length).toBeLessThanOrEqual(4)
  })
})
