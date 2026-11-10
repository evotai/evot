import { beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

import { inlineItemLines, sectionHeaderLines } from '../../src/ui/section.js'

beforeAll(() => {
  chalk.level = 3
})

describe('sectionHeaderLines', () => {
  test('keeps short metadata on the shared heading row', () => {
    expect(sectionHeaderLines('Official', 100, 'auto-updated · repo').map(stripAnsi)).toEqual([
      '  [Official]  auto-updated · repo',
    ])
  })

  test('moves long metadata to the shared content indent', () => {
    expect(sectionHeaderLines('Official', 24, 'https://github.com/evotai/evot-skills').map(stripAnsi)).toEqual([
      '  [Official]',
      '    https://github.com/evotai/evot-skills',
    ])
  })
})

describe('inlineItemLines', () => {
  test('packs items with compact pipe separators', () => {
    expect(inlineItemLines(['approval', 'apps', 'attendance'], 80).map(stripAnsi)).toEqual([
      '    approval | apps | attendance',
    ])
  })

  test('wraps only between complete items', () => {
    expect(inlineItemLines(['approval', 'calendar', 'workflow-report'], 25).map(stripAnsi)).toEqual([
      '    approval | calendar',
      '    workflow-report',
    ])
  })

  test('supports styled items without counting ANSI bytes', () => {
    const items = [chalk.blue('alpha'), chalk.blue('beta'), chalk.blue('gamma')]
    expect(inlineItemLines(items, 20).map(stripAnsi)).toEqual([
      '    alpha | beta',
      '    gamma',
    ])
  })
})
