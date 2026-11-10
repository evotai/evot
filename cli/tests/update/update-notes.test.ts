import { describe, test, expect } from 'bun:test'
import { parseReleaseNotes } from '../../src/update/notes.js'

describe('parseReleaseNotes', () => {
  test('returns empty for undefined body', () => {
    expect(parseReleaseNotes(undefined)).toEqual([])
  })

  test('returns empty for empty body', () => {
    expect(parseReleaseNotes('')).toEqual([])
  })

  test('returns empty when no changelog section', () => {
    expect(parseReleaseNotes('Some release notes without changelog')).toEqual([])
  })

  test('extracts bullet points from ### Changelog', () => {
    const body = `## evot 2026.4.21

### Changelog
* feat(cli): replace Ink/React TUI with chalk-based terminal renderer
* fix(cli): add relative time to /resume session selector
* fix(engine): stop retrying auth errors (401/403)

### Assets
10 files`
    expect(parseReleaseNotes(body)).toEqual([
      'feat(cli): replace Ink/React TUI with chalk-based terminal renderer',
      'fix(cli): add relative time to /resume session selector',
      'fix(engine): stop retrying auth errors (401/403)',
    ])
  })

  test('supports dash bullets', () => {
    const body = `### Changelog
- docs: simplify community section to plain list
- docs: use markdown table with padding`
    expect(parseReleaseNotes(body)).toEqual([
      'docs: simplify community section to plain list',
      'docs: use markdown table with padding',
    ])
  })

  test('stops at next header', () => {
    const body = `### Changelog
* first item
* second item
## Next Section
* should not appear`
    expect(parseReleaseNotes(body)).toEqual([
      'first item',
      'second item',
    ])
  })

  test('stops at horizontal rule', () => {
    const body = `### Changelog
* first item
---
* should not appear`
    expect(parseReleaseNotes(body)).toEqual([
      'first item',
    ])
  })

  test('limits to 5 items', () => {
    const body = `### Changelog
* item 1
* item 2
* item 3
* item 4
* item 5
* item 6
* item 7`
    expect(parseReleaseNotes(body)).toEqual([
      'item 1', 'item 2', 'item 3', 'item 4', 'item 5',
    ])
  })

  test('skips empty bullets', () => {
    const body = `### Changelog
* valid item
* 
* another valid item`
    expect(parseReleaseNotes(body)).toEqual([
      'valid item',
      'another valid item',
    ])
  })
})
