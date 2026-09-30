import { describe, test, expect, beforeAll } from 'bun:test'
import { createAppSelectorState } from '../src/term/app/selector-identity.js'
import {
  createSelectorState,
  selectorUp,
  selectorDown,
  selectorFocusList,
  selectorSelect,
  selectorType,
  selectorBackspace,
  selectorExpandItems,
  selectorFocusOn,
  selectorRemoveItem,
  warmSearchableText,
  SELECTOR_VIEWPORT,
  type SelectorState,
} from '../src/term/selector.js'
import { buildOverlayBlocks } from '../src/term/viewmodel/overlays.js'
import { buildSelectorRegionLines } from '../src/term/viewmodel/selector.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { getTheme } from '../src/render/theme/index.js'
import { blocksToLines } from '../src/term/viewmodel/types.js'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import chalk from 'chalk'

beforeAll(() => { chalk.level = 3 })

const items = [
  { label: 'claude-opus', detail: 'Anthropic' },
  { label: 'gpt-4o', detail: 'OpenAI' },
  { label: 'gemini-pro', detail: 'Google' },
]

test('cloud session scope survives navigation, searching and asynchronous expansion', () => {
  const cloudRows = [{ id: 'a', label: 'alpha' }, { id: 'b', label: 'beta' }]
  let state: SelectorState = {
    ...createAppSelectorState('resume', 'Cloud sessions', cloudRows),
    sessionScope: 'cloud',
  }
  for (const step of [selectorFocusList, selectorDown, selectorUp,
    (s: SelectorState) => selectorType(s, 'a'), selectorBackspace,
    (s: SelectorState) => selectorExpandItems(s, cloudRows)]) {
    state = step(state)
    expect(state.sessionScope).toBe('cloud')
    expect(state.allItems.map(row => row.id)).toEqual(['a', 'b'])
  }
})

describe('createSelectorState', () => {
  test('creates state with focus at 0', () => {
    const state = createSelectorState('Pick model', items)
    expect(state.focusIndex).toBe(0)
    expect(state.title).toBe('Pick model')
    expect(state.items).toBe(items)
  })
})

describe('selectorUp', () => {
  test('moves focus up', () => {
    let state = createSelectorState('T', items)
    state = { ...state, focusIndex: 2 }
    state = selectorUp(state)
    expect(state.focusIndex).toBe(1)
  })

  test('does not go below 0', () => {
    const state = createSelectorState('T', items)
    const next = selectorUp(state)
    expect(next.focusIndex).toBe(0)
    expect(next).toBe(state)
  })

  test('wraps from the first choice to the last when circular navigation is enabled', () => {
    const grouped = [
      { label: 'anthropic', header: true, focusable: false },
      { label: 'claude-opus' },
      { label: '', header: true, focusable: false },
      { label: 'openai', header: true, focusable: false },
      { label: 'gpt-5.5' },
    ]
    const state = { ...createSelectorState('Models', grouped), circularNavigation: true }
    const next = selectorUp(state)
    expect(next.focusIndex).toBe(4)
    expect(next.items[next.focusIndex]?.label).toBe('gpt-5.5')
  })
})

describe('selectorDown', () => {
  test('moves focus down', () => {
    const state = createSelectorState('T', items)
    const next = selectorDown(state)
    expect(next.focusIndex).toBe(1)
  })

  test('does not exceed last item', () => {
    let state = createSelectorState('T', items)
    state = { ...state, focusIndex: 2 }
    const next = selectorDown(state)
    expect(next.focusIndex).toBe(2)
    expect(next).toBe(state)
  })

  test('wraps from the last choice to the first and restores its header', () => {
    const grouped = [
      { label: 'anthropic', header: true, focusable: false },
      { label: 'claude-opus' },
      { label: '', header: true, focusable: false },
      { label: 'openai', header: true, focusable: false },
      { label: 'gpt-5.5' },
    ]
    let state = { ...createSelectorState('Models', grouped), circularNavigation: true, focusIndex: 4 }
    state = selectorDown(state)
    expect(state.focusIndex).toBe(1)
    expect(state.scrollOffset).toBe(0)
  })
})

describe('selectorSelect', () => {
  test('returns focused item', () => {
    let state = createSelectorState('T', items)
    state = { ...state, focusIndex: 1 }
    const selected = selectorSelect(state)
    expect(selected).toEqual({ label: 'gpt-4o', detail: 'OpenAI' })
  })

  test('returns first item by default', () => {
    const state = createSelectorState('T', items)
    const selected = selectorSelect(state)
    expect(selected).toEqual({ label: 'claude-opus', detail: 'Anthropic' })
  })

  test('returns null for empty items', () => {
    const state = createSelectorState('T', [])
    const selected = selectorSelect(state)
    expect(selected).toBeNull()
  })
})

describe('renderSelector via viewmodel', () => {
  test('renders the pi model selector as a full-width editor replacement', () => {
    const state = {
      ...createSelectorState('Models', [
        { label: 'openai', header: true, focusable: false, group: 'openai' },
        { label: 'grok-4.5', group: 'openai', selected: true },
        { label: 'droid', header: true, focusable: false, group: 'droid' },
        { label: 'gpt-5.6-sol', group: 'droid' },
      ]),
      presentation: 'model' as const,
      circularNavigation: true,
    }
    const lines = buildSelectorRegionLines(state, 40)
      .map(line => stripAnsi(line).replaceAll('\x1b_pi:c\x07', ''))

    expect(lines[0]).toBe('')
    expect(lines[1]).toBe('─'.repeat(40))
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe('Only showing models from configured')
    expect(lines[4]).toBe('providers. Run /login to add cloud')
    expect(lines[5]).toBe('models.')
    expect(lines[7]).toStartWith('>  ')
    expect(lines[9]).toBe('  openai')
    expect(lines[10]).toBe('· grok-4.5 ✓')
    expect(lines[11]).toBe('')
    expect(lines[12]).toBe('  droid')
    // Idle model rows carry a `·` gutter; only group headings keep two spaces.
    expect(lines[13]).toBe('· gpt-5.6-sol')
    expect(lines[15]).toBe('  Model Name: grok-4.5')
    expect(lines.at(-1)).toBe('─'.repeat(40))
    expect(lines.join('\n')).not.toContain('Models  2')
    expect(lines.join('\n')).not.toContain('enter select')
  })

  test('model selector uses the brand palette instead of cyan and yellow', () => {
    const state = {
      ...createSelectorState('Models', [
        { label: 'Evot Premium', header: true, focusable: false, group: 'pro' },
        { label: 'GPT 5.6 Sol', group: 'pro', selected: true },
      ]),
      presentation: 'model' as const,
    }
    const raw = buildSelectorRegionLines(state, 80).join('\n')
    expect(raw).toContain('\x1b[38;2;240;198;116m') // accent gold heading
    expect(raw).toContain('\x1b[38;2;181;188;249m') // brand periwinkle focus
    expect(raw).not.toContain('\x1b[36m') // no cyan
    expect(raw).not.toContain('\x1b[33m') // no yellow banner
  })

  test('model filtering keeps provider groups without repeated badges', () => {
    let state = {
      ...createSelectorState('Models', [
        { label: 'openai', header: true, focusable: false, group: 'openai' },
        { label: 'grok-4.5', group: 'openai', searchText: 'grok-4.5 openai' },
        { label: 'droid', header: true, focusable: false, group: 'droid' },
        { label: 'gpt-5.6-sol', group: 'droid', searchText: 'gpt-5.6-sol droid' },
      ]),
      presentation: 'model' as const,
    }
    for (const char of 'droid') state = selectorType(state, char)

    const text = buildSelectorRegionLines(state, 80)
      .map(line => stripAnsi(line).replaceAll('\x1b_pi:c\x07', ''))
      .join('\n')
    // Typing keeps focus in the search input, but the current row retains the
    // same complete visual state used by every selector. The match still sits
    // under its own provider heading, named once.
    expect(text).toContain('  droid\n· gpt-5.6-sol')
    expect(text).not.toContain('[droid]')
  })

  test('model selector renders one weak header per group with blank separators', () => {
    // Headings are explicit rows, so a group name is shown once, verbatim.
    const state = {
      ...createSelectorState('Models', [
        { label: 'openai', header: true, focusable: false, group: 'openai' },
        { label: 'gpt-5.6-sol', group: 'openai', selected: true },
        { label: 'grok-4.5', group: 'openai' },
        { label: 'anthropic', header: true, focusable: false, group: 'anthropic' },
        { label: 'claude-opus-4-8', group: 'anthropic' },
        { label: 'claude-sonnet-5', group: 'anthropic' },
      ]),
      presentation: 'model' as const,
    }
    const lines = buildSelectorRegionLines(state, 80)
      .map(line => stripAnsi(line).replaceAll('\x1b_pi:c\x07', ''))
    const listStart = lines.indexOf('  openai')

    expect(lines.slice(listStart, listStart + 8)).toEqual([
      '  openai',
      '· gpt-5.6-sol ✓',
      '· grok-4.5',
      '',
      '  anthropic',
      '· claude-opus-4-8',
      '· claude-sonnet-5',
      '',
    ])
    expect(lines.join('\n')).not.toContain('[openai]')
    expect(lines.join('\n')).not.toContain('[anthropic]')
  })

  test('model selector keeps a blank separator when a group header scrolls into view', () => {
    const state = {
      ...createSelectorState('Models', [
        { label: 'Evot Free', header: true, focusable: false, group: 'free' },
        ...Array.from({ length: 11 }, (_, index) => ({ label: `free-${index + 1}`, group: 'free' })),
        { label: 'anthropic · Anthropic Messages', header: true, focusable: false, group: 'anthropic' },
        { label: 'claude-opus-5', group: 'anthropic' },
      ]),
      presentation: 'model' as const,
      focusIndex: 9,
    }
    const lines = buildSelectorRegionLines(state, 80)
      .map(line => stripAnsi(line).replaceAll('\x1b_pi:c\x07', ''))
    const headerIndex = lines.indexOf('  anthropic · Anthropic Messages')

    expect(headerIndex).toBeGreaterThan(0)
    expect(lines[headerIndex - 1]).toBe('')
  })

  test('model filtering uses fuzzy matching and quality ordering within a provider', () => {
    let state = {
      ...createSelectorState('Models', [
        { label: 'alpha-gpt', group: 'provider', searchText: 'alpha-gpt provider' },
        { label: 'gpt-alpha', group: 'provider', searchText: 'gpt-alpha provider' },
        { label: 'unrelated', group: 'provider', searchText: 'unrelated provider' },
      ]),
      presentation: 'model' as const,
    }
    for (const char of 'gpt') state = selectorType(state, char)

    expect(state.items.map(item => item.label)).toEqual(['gpt-alpha', 'alpha-gpt'])
  })

  test('model search input matches pi at extremely narrow widths', () => {
    const state = {
      ...createSelectorState('Models', [{ label: 'gpt', detail: 'openai' }]),
      presentation: 'model' as const,
    }

    for (const width of [1, 2]) {
      const lines = buildSelectorRegionLines(state, width)
        .map(line => stripAnsi(line).replaceAll('\x1b_pi:c\x07', ''))
      expect(lines).toContain('> ')
      expect(lines.filter(line => line !== '> ').every(line => stringWidth(line) <= width)).toBe(true)
    }
  })

  test('contains title', () => {
    const state = createSelectorState('Pick model', items)
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('Pick model')
  })

  test('contains all item labels', () => {
    const state = createSelectorState('T', items)
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('claude-opus')
    expect(text).toContain('gpt-4o')
    expect(text).toContain('gemini-pro')
  })

  test('contains detail text', () => {
    const state = createSelectorState('T', items)
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('Anthropic')
    expect(text).toContain('OpenAI')
  })

  test('shows focus indicator on current item', () => {
    const state = createSelectorState('T', items)
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('· claude-opus')
  })

  test('shows navigation hint', () => {
    const state = createSelectorState('T', items)
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('move')
    expect(text).toContain('Enter select')
    expect(text).toContain('esc close')
  })

  test('shows queue actions with the shared Ctrl+D remove shortcut', () => {
    const state = createAppSelectorState('queue', 'Prompt queue', items)
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('Enter edit')
    expect(text).toContain('Ctrl+D remove')
    expect(text).not.toContain('del remove')
  })

  test('shows search query when filtering', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'g')
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('Filter')
    expect(text).toContain('g')
  })

  test('shows empty-filter state when filter yields nothing', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'z')
    state = selectorType(state, 'z')
    state = selectorType(state, 'z')
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('No matching items')
  })

  test('renders provider as part of the model identity', () => {
    const state = createSelectorState('Models', [
      { label: 'gpt-5.6-sol@droid', selected: true },
      { label: 'gpt-5.6-sol@cursor' },
    ])
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('gpt-5.6-sol@droid ✓')
    expect(text).toContain('gpt-5.6-sol@cursor')
  })

  test('renders provider group headers the same way every list does', () => {
    const state = createSelectorState('Models', [
      { label: 'anthropic', header: true, focusable: false },
      { label: 'claude-opus' },
      { label: '', header: true, focusable: false },
      { label: 'openai', header: true, focusable: false },
      { label: 'gpt-5.5' },
    ])
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const text = lines.map(l => stripAnsi(l)).join('\n')
    // One heading treatment across /model, /skill and /resume: indented accent
    // label, blank line between groups. No per-list divider rule.
    expect(text).toContain('  anthropic\n· claude-opus\n\n  openai')
    expect(text).not.toContain('── ')
    expect(text).toContain('· claude-opus')
    // Headers and spacing rows do not count as selectable items in the title tally.
    expect(text).toContain('Models  2')
  })

  test('highlights matching query in items', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'gpt')
    const lines = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80))
    const raw = lines.join('')
    // Should contain ANSI bold+yellow around "gpt"
    expect(raw).toContain('\x1b[1m')
    expect(raw).toContain('gpt')
    // Plain text should still have the label
    const text = lines.map(l => stripAnsi(l)).join('\n')
    expect(text).toContain('gpt-4o')
  })
  test('model command preview highlights the default row before list focus', () => {
    const state = {
      ...createSelectorState('Models', [{ label: 'gpt-4o', selected: true }]),
      presentation: 'model' as const,
      listFocused: false,
    }
    const preview = buildSelectorRegionLines(state, 80, 24, false).join('\n')
    const [red, green, blue] = getTheme().selectionBgHex
      .slice(1)
      .match(/.{2}/g)!
      .map(part => Number.parseInt(part, 16))

    expect(preview).toContain(`\x1b[48;2;${red};${green};${blue}m`)
    expect(stripAnsi(preview)).toContain('· gpt-4o ✓')
  })

  test('model preview omits the selector cursor while the composer is focused', () => {
    const state = {
      ...createSelectorState('Models', [{ label: 'gpt-4o', selected: true }]),
      presentation: 'model' as const,
    }
    const active = buildSelectorRegionLines(state, 80, 24, true).join('\n')
    const preview = buildSelectorRegionLines(state, 80, 24, false).join('\n')

    expect(active).toContain(CURSOR_MARKER)
    expect(preview).not.toContain(CURSOR_MARKER)
    expect(stripAnsi(preview)).toContain('Model Name:')
  })

  test('a promoted model window drops its search caret, leaving one cursor', () => {
    // `/mo` + ↓ hands focus to the list. Leaving the search input's caret drawn
    // would show two active cursors and imply typing still went to the composer.
    const state = {
      ...createSelectorState('Models', [{ label: 'gpt-4o', selected: true }]),
      presentation: 'model' as const,
      listFocused: true,
    }
    const promoted = buildSelectorRegionLines(state, 80, 24, true).join('\n')

    expect(promoted).not.toContain(CURSOR_MARKER)
    expect(stripAnsi(promoted)).toContain('Model Name:')
  })

  test('generic selector transfers its cursor without changing row geometry', () => {
    const state = createSelectorState('Resume session', items)
    const active = buildSelectorRegionLines(state, 100, 24, true)
    const preview = buildSelectorRegionLines(state, 100, 24, false)

    expect(active).toHaveLength(preview.length)
    expect(active.join('\n')).toContain(CURSOR_MARKER)
    expect(preview.join('\n')).not.toContain(CURSOR_MARKER)
    expect(active.map(stripAnsi).join('\n')).toContain('type to search')
  })

  test('resume preview and focused selector share the complete current-row style', () => {
    const state = {
      ...createSelectorState('Resume session', [{
        label: '01a06b6f',
        detail: 'repl  current session',
        preview: ['current session', 'gpt-5.6-sol · 21 turns · just now'],
      }]),
      listFocused: false,
    }
    const preview = buildSelectorRegionLines(state, 120, 24, false).join('\n')
    const focused = buildSelectorRegionLines({ ...state, listFocused: true }, 120, 24, true).join('\n')
    const [red, green, blue] = getTheme().selectionBgHex
      .slice(1)
      .match(/.{2}/g)!
      .map(part => Number.parseInt(part, 16))
    const background = `\x1b[48;2;${red};${green};${blue}m`

    expect(preview).toContain(background)
    expect(focused).toContain(background)
    expect(stripAnsi(preview)).toContain('· 01a06b6f  repl  current session')
    expect(stripAnsi(focused)).toContain('· 01a06b6f  repl  current session')
  })
})

describe('filter hint', () => {
  test('empty query shows a search hint on the filter line', () => {
    const state = createSelectorState('Resume session', items)
    const text = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 120))
      .map(l => stripAnsi(l)).join('\n')

    expect(text).toContain('Filter')
    expect(text).toContain('type to search')
  })

  test('typing replaces the hint with the query', () => {
    let state = createSelectorState('Resume session', items)
    for (const char of 'gpt') state = selectorType(state, char)
    const text = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 120))
      .map(l => stripAnsi(l)).join('\n')

    expect(text).toContain('Filter  gpt')
    expect(text).not.toContain('type to search')
  })
})

describe('preview pane', () => {
  const paneItems = [
    {
      label: 'aaaaaaaa',
      detail: 'repl   first session',
      id: 'session-a',
      searchText: 'aaaaaaaa first session /work repl m1 we tuned the retry budget',
      preview: ['first session', 'm1 · 4 turns · 2h ago', '', '› we tuned the retry budget'],
    },
    {
      label: 'bbbbbbbb',
      detail: 'repl   second session',
      id: 'session-b',
      searchText: 'bbbbbbbb second session /work repl m1 payment timeout triage',
      preview: ['second session', 'm1 · 9 turns · 5d ago', '', '› payment timeout triage'],
    },
  ]

  function rows(state: SelectorState, columns: number): string[] {
    return blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, columns)).map(l => stripAnsi(l))
  }

  test('renders the focused row preview beside the list', () => {
    const state = createSelectorState('Resume session', paneItems)
    const text = rows(state, 120).join('\n')

    expect(text).toContain('│')
    expect(text).toContain('we tuned the retry budget')
    // Only the focused row's preview is shown.
    expect(text).not.toContain('payment timeout triage')
  })

  test('follows focus to the next row', () => {
    const state = selectorDown(createSelectorState('Resume session', paneItems))
    const text = rows(state, 120).join('\n')

    expect(text).toContain('payment timeout triage')
    expect(text).not.toContain('we tuned the retry budget')
  })

  test('every row keeps the divider in the same column', () => {
    const state = createSelectorState('Resume session', paneItems)
    const dividerColumns = new Set(
      rows(state, 120).filter(row => row.includes('│')).map(row => row.indexOf('│')),
    )

    expect(dividerColumns.size).toBe(1)
  })

  test('keeps the same pane height when focus moves between short and long previews', () => {
    const state = createSelectorState('Resume session', [
      { label: 'aaaaaaaa', preview: ['short', 'm1 · 1 turn · 1h ago'] },
      {
        label: 'bbbbbbbb',
        preview: [
          'long session',
          'm1 · 40 turns · 1h ago',
          '',
          '# Started with', '› the original goal',
          '',
          '# Latest', '› later turn 1', '› later turn 2', '› later turn 3',
          '',
          '# Changed 3 files', '  a.ts · b.ts · c.ts',
        ],
      },
    ])
    const height = (focus: number) => rows({ ...state, focusIndex: focus }, 120)
      .filter(row => row.includes('│')).length
    expect(height(0)).toBe(height(1))
    expect(height(0)).toBeGreaterThanOrEqual(SELECTOR_VIEWPORT)
  })

  test('stays within the terminal width without wrapping rows', () => {
    const wide = {
      label: 'cccccccc',
      detail: 'repl   '.padEnd(200, 'x'),
      preview: ['a title that is quite long and will need wrapping inside the narrow pane'],
    }
    const state = createSelectorState('Resume session', [wide])

    for (const columns of [80, 120, 200]) {
      const rendered = buildSelectorRegionLines(state, columns).map(l => stripAnsi(l))
      for (const row of rendered) {
        expect(stringWidth(row)).toBeLessThanOrEqual(columns)
      }
      // A row wrapped by the renderer would add divider-less continuation rows
      // below the pane; every pane row carries exactly one divider.
      const paneRows = rendered.filter(row => row.includes('│'))
      expect(paneRows.length).toBeGreaterThan(0)
      expect(paneRows.every(row => row.split('│').length === 2)).toBe(true)
    }
  })

  test('keeps the header pinned and shows the newest entries when the body overflows', () => {
    const state = createSelectorState('Resume session', [{
      label: 'dddddddd',
      preview: [
        'long session',
        'm1 · 40 turns · 1h ago',
        '',
        ...Array.from({ length: 30 }, (_, i) => `› turn number ${i + 1}`),
      ],
    }])
    const text = rows(state, 120).join('\n')

    expect(text).toContain('long session')
    expect(text).toContain('m1 · 40 turns · 1h ago')
    expect(text).toContain('⋮')
    // Oldest-first entries, so the tail is what survives the cut.
    expect(text).toContain('turn number 30')
    expect(text).not.toContain('turn number 1 ')
  })

  test('moves the body window to the first filter hit', () => {
    let state = createSelectorState('Resume session', [{
      label: 'dddddddd',
      searchText: 'dddddddd NEBULA-4729 page cache eviction',
      preview: [
        'long session',
        'm1 · 40 turns · 1h ago',
        '',
        '› look at NEBULA-4729 first',
        ...Array.from({ length: 30 }, (_, i) => `› later turn ${i + 1}`),
      ],
    }])
    for (const char of 'nebula') state = selectorType(state, char)
    const text = rows(state, 120).join('\n')

    expect(text).toContain('NEBULA-4729')
    expect(text).not.toContain('later turn 30')
  })

  test('a long title cannot squeeze the body out of the pane', () => {
    const state = createSelectorState('Resume session', [{
      label: 'eeeeeeee',
      preview: [
        'a session title so long that wrapping it alone would fill the entire preview pane and leave no room at all for the conversation below it',
        'm1 · 4 turns · 2h ago',
        '',
        '› the turn that must stay visible',
      ],
    }])
    const text = rows(state, 120).join('\n')

    expect(text).toContain('the turn that must stay visible')
  })

  test('sections trim by priority: Latest tail first, Changed dropped, Started with pinned', () => {
    const sectioned = [
      'sectioned session',
      'm1 · 20 turns · 2d ago → 1h ago',
      '',
      '# Started with', '› the original goal',
      '',
      '# Latest', '› later turn 10', '› later turn 11', '› later turn 12',
      '',
      '# Changed 3 files', '  a.ts · b.ts · c.ts',
    ]
    const items = [
      { label: 'hhhhhhhh', preview: sectioned },
      ...Array.from({ length: 8 }, (_, i) => ({ label: `row-${i}`, preview: ['other'] })),
    ]
    const state = createSelectorState('Resume session', items)
    const pane = rows(state, 160)
      .filter(row => row.includes('│'))
      .map(row => row.slice(row.indexOf('│') + 1).trim())

    // The pinned opening ask survives; the list keeps its tail behind a cut and
    // the optional Changed section is dropped before anything is truncated.
    expect(pane).toContain('Started with')
    expect(pane).toContain('› the original goal')
    expect(pane).toContain('Latest')
    expect(pane).toContain('⋮')
    expect(pane).toContain('› later turn 12')
    expect(pane).not.toContain('› later turn 10')
    expect(pane).not.toContain('Changed 3 files')
    expect(pane.indexOf('Started with')).toBeLessThan(pane.indexOf('Latest'))
  })

  test('caps one entry so a single long turn cannot fill the pane', () => {
    // A pasted draft arrives as one turn with its newlines already collapsed.
    const draft = 'polish this tweet and make it shorter '.repeat(20)
    const state = createSelectorState('Resume session', [{
      label: 'ffffffff',
      preview: ['long turn session', 'm1 · 7 turns · 21h ago', '', `› ${draft}`, '› drop the emoji'],
    }])
    const paneRows = rows(state, 160)
      .filter(row => row.includes('│'))
      .map(row => row.slice(row.indexOf('│') + 1).trimEnd())

    // The draft keeps its marker and a bounded excerpt, marked as cut.
    const marked = paneRows.filter(row => row.trimStart().startsWith('›'))
    expect(marked.length).toBe(2)
    expect(marked[0]).toContain('polish this tweet')
    expect(marked[0]).not.toContain('drop the emoji')
    expect(paneRows.some(row => row.endsWith('…'))).toBe(true)
    // The later turn is still reachable rather than pushed out.
    expect(paneRows.some(row => row.includes('drop the emoji'))).toBe(true)
  })

  test('never orphans a continuation row from its marker', () => {
    // Regression: windowing by wrapped row could cut a multi-row entry in half,
    // leaving indented text on screen with no `›` to attribute it.
    //
    // Entry heights from the end are 2, 1, 2, 2, 2 — suffix sums 2, 3, 5, 7, 9.
    // The post-cut body budget is 6, which no suffix hits, so a row-based cut
    // has to land inside an entry while an entry-based one cannot.
    const words = Array.from({ length: 24 }, (_, i) => `w${i}`).join(' ')
    const twoRows = (label: string) => `› ${label} ${words}`
    const state = createSelectorState('Resume session', [{
      label: 'gggggggg',
      preview: [
        'wrapped turns session',
        'm1 · 9 turns · 21h ago',
        '',
        twoRows('alpha'), twoRows('bravo'), twoRows('charlie'), '› delta', twoRows('echo'),
      ],
    }])
    const paneRows = rows(state, 160)
      .filter(row => row.includes('│'))
      .map(row => row.slice(row.indexOf('│') + 1).trim())
      .filter(row => row.length > 0)

    const cut = paneRows.findIndex(row => row.startsWith('⋮'))
    expect(cut).toBeGreaterThanOrEqual(0)

    // Everything below the cut is body. The first row must open an entry, and
    // each wrapped entry must keep the continuation that belongs to it.
    const body = paneRows.slice(cut + 1)
    expect(body[0]!.startsWith('›')).toBe(true)
    expect(body.some(row => !row.startsWith('›'))).toBe(true)
    for (const [index, row] of body.entries()) {
      if (!row.startsWith('›') || !row.includes('w0')) continue
      expect(body[index + 1]?.startsWith('w')).toBe(true)
    }
  })

  test('narrow terminals keep the single-column list', () => {
    const state = createSelectorState('Resume session', paneItems)
    const text = rows(state, 60).join('\n')

    expect(text).not.toContain('│')
    expect(text).toContain('aaaaaaaa')
  })

  test('items without a preview render without a pane', () => {
    const state = createSelectorState('Pick model', items)
    expect(rows(state, 120).join('\n')).not.toContain('│')
  })
})

describe('selectorType', () => {
  test('filters items by label', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'g')
    expect(state.query).toBe('g')
    expect(state.items.map(i => i.label)).toEqual(['gpt-4o', 'gemini-pro'])
    expect(state.focusIndex).toBe(0)
  })

  test('filters items by detail', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'o')
    state = selectorType(state, 'p')
    state = selectorType(state, 'e')
    state = selectorType(state, 'n')
    expect(state.items.map(i => i.label)).toEqual(['gpt-4o'])
  })

  test('is case insensitive', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'G')
    expect(state.items.map(i => i.label)).toEqual(['gpt-4o', 'gemini-pro'])
  })

  test('resets focus on filter change', () => {
    let state = createSelectorState('T', items)
    state = selectorDown(state)
    expect(state.focusIndex).toBe(1)
    state = selectorType(state, 'g')
    expect(state.focusIndex).toBe(0)
  })
})

describe('selectorBackspace', () => {
  test('removes last char and widens filter', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'g')
    state = selectorType(state, 'p')
    state = selectorType(state, 't')
    expect(state.items.map(i => i.label)).toEqual(['gpt-4o'])
    state = selectorBackspace(state)
    expect(state.query).toBe('gp')
    expect(state.items.map(i => i.label)).toEqual(['gpt-4o', 'gemini-pro'])
  })

  test('clears filter restores all items', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'g')
    state = selectorBackspace(state)
    expect(state.query).toBe('')
    expect(state.items).toEqual(items)
  })

  test('noop when query is empty', () => {
    const state = createSelectorState('T', items)
    const next = selectorBackspace(state)
    expect(next).toBe(state)
  })
})

describe('fuzzy subsequence matching', () => {
  test('subsequence match finds non-contiguous chars', () => {
    let state = createSelectorState('T', items)
    state = selectorType(state, 'c')
    state = selectorType(state, 'o')
    state = selectorType(state, 'p')
    // "cop" is a subsequence of "claude-opus" (c...o...p) but not a substring
    expect(state.items.map(i => i.label)).toContain('claude-opus')
  })

  test('exact substring matches come before subsequence matches', () => {
    const testItems = [
      { label: 'deploy-service' },
      { label: 'deep-learning' },
      { label: 'data-pipeline' },
    ]
    let state = createSelectorState('T', testItems)
    state = selectorType(state, 'd')
    state = selectorType(state, 'p')
    // "dp" is substring of none, but subsequence of all three
    // "deploy-service" and "deep-learning" and "data-pipeline" all match as subsequence
    expect(state.items.length).toBeGreaterThan(0)
  })

  test('substring matches rank before subsequence matches', () => {
    const testItems = [
      { label: 'abc-xyz', detail: 'no match here' },
      { label: 'hello', detail: 'contains op inside' },
      { label: 'opus', detail: 'exact' },
    ]
    let state = createSelectorState('T', testItems)
    state = selectorType(state, 'o')
    state = selectorType(state, 'p')
    // "op" is substring of "opus" and "contains op inside"
    // "abc-xyz" has no match at all
    const labels = state.items.map(i => i.label)
    expect(labels).toContain('opus')
    expect(labels).toContain('hello')
    expect(labels).not.toContain('abc-xyz')
  })
})

describe('searchText field', () => {
  test('searches searchText when provided', () => {
    const testItems = [
      { label: 'abc12345', detail: 'My Project', searchText: 'abc12345 My Project /home/user/myproject rust' },
      { label: 'def67890', detail: 'Other Work', searchText: 'def67890 Other Work /tmp/job golang' },
    ]
    let state = createSelectorState('T', testItems)
    state = selectorType(state, 'r')
    state = selectorType(state, 'u')
    state = selectorType(state, 's')
    state = selectorType(state, 't')
    expect(state.items.map(i => i.label)).toEqual(['abc12345'])
  })

  test('multi-keyword filter requires every whitespace-separated token', () => {
    const testItems = [
      {
        label: 'aaa11111',
        detail: 'Payment retry',
        searchText: 'aaa11111 Payment retry timeout on checkout /work/shop rust',
      },
      {
        label: 'bbb22222',
        detail: 'Payment success',
        searchText: 'bbb22222 Payment success path /work/shop rust',
      },
      {
        label: 'ccc33333',
        detail: 'Auth timeout',
        searchText: 'ccc33333 Auth timeout login flow /work/auth golang',
      },
    ]
    let state = createSelectorState('Resume session', testItems)
    for (const char of 'payment timeout') state = selectorType(state, char)

    expect(state.query).toBe('payment timeout')
    expect(state.items.map(i => i.label)).toEqual(['aaa11111'])
  })

  test('multi-keyword filter is order-independent', () => {
    const testItems = [
      {
        label: 'aaa11111',
        detail: 'Payment retry',
        searchText: 'aaa11111 Payment retry timeout on checkout',
      },
      {
        label: 'bbb22222',
        detail: 'Unrelated',
        searchText: 'bbb22222 something else entirely',
      },
    ]
    let state = createSelectorState('Resume session', testItems)
    for (const char of 'timeout payment') state = selectorType(state, char)

    expect(state.items.map(i => i.label)).toEqual(['aaa11111'])
  })

  test('falls back to label+detail when no searchText', () => {
    const mixed = [
      { label: 'with-search', detail: 'visible', searchText: 'hidden keyword' },
      { label: 'no-search', detail: 'keyword here' },
    ]
    let state = createSelectorState('T', mixed)
    state = selectorType(state, 'k')
    state = selectorType(state, 'e')
    state = selectorType(state, 'y')
    expect(state.items.map(i => i.label)).toEqual(['with-search', 'no-search'])
  })

  test('typing stays responsive when rows carry whole transcripts', () => {
    // Resume rows put full transcript text in searchText. Lowercasing every row
    // on every keystroke is what made the filter feel laggy on a large history,
    // so the conversion is cached per item. This asserts the budget rather than
    // the mechanism: a regression to per-keystroke lowercasing blows past it.
    const bulk = Array.from({ length: 400 }, (_, index) => ({
      label: `session-${index}`,
      detail: 'title',
      searchText: `session-${index} ${'Payment Timeout On Checkout '.repeat(400)}${index === 7 ? 'NEEDLE' : ''}`,
    }))
    let state = createSelectorState('Resume session', bulk)

    const started = performance.now()
    for (const char of 'needle') state = selectorType(state, char)
    const elapsed = performance.now() - started

    expect(state.items.map(i => i.label)).toEqual(['session-7'])
    expect(elapsed).toBeLessThan(400)
  })

  test('snippets are built for rows that are read, not for every match', () => {
    const prefixReads = Array<number>(12).fill(0)
    const bulk = prefixReads.map((_, index) => ({
      label: `session-${index}`,
      detail: 'title',
      searchText: `session-${index} Payment timeout on checkout`,
      get contextPrefix() {
        prefixReads[index] = prefixReads[index]! + 1
        return 'Resume: '
      },
    }))
    const state = selectorType(createSelectorState('Resume session', bulk), 'p')

    expect(state.items).toHaveLength(bulk.length)
    // Copying each row reads its prefix once; resolving a snippet reads it again.
    expect(prefixReads).toEqual(Array(12).fill(1))

    const first = state.items[0]!
    expect(first.detail).toContain('Resume: ')
    expect(first.detail).toContain('Payment')
    expect(prefixReads).toEqual([2, ...Array(11).fill(1)])
    expect({ ...first }.detail).toBe(first.detail)
    expect(prefixReads).toEqual([2, ...Array(11).fill(1)])

    expect(state.items[1]!.detail).toContain('Payment')
    expect(prefixReads).toEqual([2, 2, ...Array(10).fill(1)])
  })

  test('warmSearchableText yields between slices and is cancellable', async () => {
    const bulk = Array.from({ length: 600 }, (_, index) => ({
      label: `session-${index}`,
      searchText: `session-${index} ${'Payment Timeout '.repeat(500)}`,
    }))

    // Warming must not monopolise the loop: a timer scheduled alongside it
    // still fires promptly, which is what keeps keystrokes responsive.
    const cancel = warmSearchableText(bulk)
    const started = performance.now()
    await new Promise(resolve => setTimeout(resolve, 0))
    const firstTurnaround = performance.now() - started
    cancel()
    expect(firstTurnaround).toBeLessThan(60)

    // Cancelling stops further slices, and filtering still works afterwards
    // because the cache is only ever an optimisation.
    let state = createSelectorState('Resume session', bulk)
    state = selectorType(state, 'p')
    expect(state.items.length).toBe(600)
  })

  test('caching preserves case-insensitive matching and snippets', () => {
    const mixedCase = [
      { label: 'abc12345', detail: 'Original Title', searchText: 'abc12345 Databend Documentation' },
    ]
    let state = createSelectorState('Resume session', mixedCase)
    for (const char of 'DATABEND') state = selectorType(state, char)
    expect(state.items.map(i => i.label)).toEqual(['abc12345'])
    expect(state.items[0]!.detail).toContain('Databend')

    // A second pass over the same items reads the cache; results must not drift.
    for (let i = 0; i < 'DATABEND'.length; i++) state = selectorBackspace(state)
    for (const char of 'documentation') state = selectorType(state, char)
    expect(state.items.map(i => i.label)).toEqual(['abc12345'])
    expect(state.items[0]!.detail).toContain('Documentation')
  })
})

describe('context extraction on match', () => {
  test('replaces detail with searchText context when matched', () => {
    const testItems = [
      { label: 'abc12345', detail: 'Original Title', searchText: 'abc12345 some long text about databend documentation and queries' },
    ]
    let state = createSelectorState('T', testItems)
    state = selectorType(state, 'd')
    state = selectorType(state, 'a')
    state = selectorType(state, 't')
    state = selectorType(state, 'a')
    state = selectorType(state, 'b')
    state = selectorType(state, 'e')
    state = selectorType(state, 'n')
    state = selectorType(state, 'd')
    expect(state.items.length).toBe(1)
    expect(state.items[0]!.detail).toContain('databend')
    expect(state.items[0]!.detail).not.toBe('Original Title')
  })

  test('restores original detail when query cleared', () => {
    const testItems = [
      { label: 'abc12345', detail: 'Original Title', searchText: 'abc12345 databend docs' },
    ]
    let state = createSelectorState('T', testItems)
    state = selectorType(state, 'd')
    state = selectorType(state, 'a')
    state = selectorType(state, 't')
    state = selectorBackspace(state)
    state = selectorBackspace(state)
    state = selectorBackspace(state)
    expect(state.items[0]!.detail).toBe('Original Title')
  })

  test('keeps original detail when no searchText', () => {
    const testItems = [
      { label: 'gpt-4o', detail: 'OpenAI' },
    ]
    let state = createSelectorState('T', testItems)
    state = selectorType(state, 'g')
    state = selectorType(state, 'p')
    state = selectorType(state, 't')
    expect(state.items[0]!.detail).toBe('OpenAI')
  })
})

describe('selectorExpandItems', () => {
  test('replaces allItems and re-filters with current query', () => {
    const initial = [
      { label: 'abc', detail: 'old' },
    ]
    let state = createSelectorState('T', initial)
    state = selectorType(state, 'x')
    expect(state.items.length).toBe(0)

    const expanded = [
      { label: 'abc', detail: 'old' },
      { label: 'xyz', detail: 'new', searchText: 'xyz new extra' },
    ]
    state = selectorExpandItems(state, expanded)
    expect(state.items.length).toBe(1)
    expect(state.items[0]!.label).toBe('xyz')
  })

  test('shows all expanded items when no query', () => {
    const initial = [{ label: 'a' }]
    let state = createSelectorState('T', initial)
    const expanded = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
    state = selectorExpandItems(state, expanded)
    expect(state.items.length).toBe(3)
  })

  test('keeps the focused row when an async refresh prepends items', () => {
    const initial = [
      { label: 'Evot Free', header: true, focusable: false, group: 'free' },
      { label: 'north-mini', id: 'evot-free:north-mini', group: 'free' },
      { label: 'openai', header: true, focusable: false, group: 'openai' },
      { label: 'grok-4.5', id: 'openai:grok-4.5', group: 'openai' },
    ]
    let state = { ...createSelectorState('Models', initial), presentation: 'model' as const }
    state = selectorFocusOn(state, item => item.id === 'openai:grok-4.5')
    expect(state.items[state.focusIndex]?.id).toBe('openai:grok-4.5')

    const expanded = [
      { label: 'Evot Premium', header: true, focusable: false, group: 'pro' },
      { label: 'claude-sonnet-5', id: 'evot-pro:claude-sonnet-5', group: 'pro' },
      ...initial,
    ]
    state = selectorExpandItems(state, expanded)
    expect(state.items[state.focusIndex]?.id).toBe('openai:grok-4.5')
    expect(state.query).toBe('')
  })

  test('keeps a typed query after an async refresh', () => {
    const initial = [
      { label: 'grok-4.5', id: 'openai:grok-4.5', group: 'openai', searchText: 'grok-4.5 openai' },
      { label: 'gpt-5.6-sol', id: 'droid:gpt-5.6-sol', group: 'droid', searchText: 'gpt-5.6-sol droid' },
    ]
    let state = { ...createSelectorState('Models', initial), presentation: 'model' as const }
    for (const char of 'grok') state = selectorType(state, char)
    expect(state.items.map(item => item.id)).toEqual(['openai:grok-4.5'])

    const expanded = [
      { label: 'north-mini', id: 'evot-free:north-mini', group: 'free', searchText: 'north-mini evot-free' },
      ...initial,
    ]
    state = selectorExpandItems(state, expanded)
    expect(state.query).toBe('grok')
    expect(state.items.map(item => item.id)).toEqual(['openai:grok-4.5'])
  })
})

describe('focusable items', () => {
  const mixed = [
    { label: '#1', detail: 'user  hello', focusable: true },
    { label: '…', detail: 'assistant  reply', focusable: false },
    { label: '#3', detail: 'user  thanks', focusable: true },
    { label: '…', detail: 'assistant  bye', focusable: false },
  ]

  test('createSelectorState focuses first focusable item', () => {
    const nonFocusFirst = [
      { label: 'a', focusable: false },
      { label: 'b', focusable: true },
      { label: 'c', focusable: true },
    ]
    const state = createSelectorState('T', nonFocusFirst)
    expect(state.focusIndex).toBe(1)
  })

  test('selectorDown skips non-focusable items', () => {
    let state = createSelectorState('T', mixed)
    expect(state.focusIndex).toBe(0)
    state = selectorDown(state)
    expect(state.focusIndex).toBe(2)
  })

  test('selectorUp skips non-focusable items', () => {
    let state = createSelectorState('T', mixed)
    state = { ...state, focusIndex: 2 }
    state = selectorUp(state)
    expect(state.focusIndex).toBe(0)
  })

  test('selectorDown stays if no focusable item below', () => {
    let state = createSelectorState('T', mixed)
    state = { ...state, focusIndex: 2 }
    const next = selectorDown(state)
    expect(next.focusIndex).toBe(2)
    expect(next).toBe(state)
  })

  test('selectorUp stays if no focusable item above', () => {
    const state = createSelectorState('T', mixed)
    const next = selectorUp(state)
    expect(next.focusIndex).toBe(0)
    expect(next).toBe(state)
  })

  test('items without focusable field are focusable by default', () => {
    const plain = [
      { label: 'a' },
      { label: 'b' },
    ]
    let state = createSelectorState('T', plain)
    expect(state.focusIndex).toBe(0)
    state = selectorDown(state)
    expect(state.focusIndex).toBe(1)
  })
})

describe('smooth scrolling window', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ label: `model-${i}` }))

  test('scrollOffset stays put while focus moves inside the window', () => {
    let state = createSelectorState('T', many)
    expect(state.scrollOffset).toBe(0)
    for (let i = 0; i < 9; i++) state = selectorDown(state)
    expect(state.focusIndex).toBe(9)
    expect(state.scrollOffset).toBe(0)
  })

  test('window slides one row at a time when focus passes the bottom edge', () => {
    let state = createSelectorState('T', many)
    for (let i = 0; i < 10; i++) state = selectorDown(state)
    expect(state.focusIndex).toBe(10)
    expect(state.scrollOffset).toBe(1)
    state = selectorDown(state)
    expect(state.scrollOffset).toBe(2)
  })

  test('moving back up keeps the window until focus hits the top edge', () => {
    let state = createSelectorState('T', many)
    for (let i = 0; i < 14; i++) state = selectorDown(state)
    expect(state.scrollOffset).toBe(5)
    // Focus walks up inside the window without any scroll.
    for (let i = 0; i < 9; i++) state = selectorUp(state)
    expect(state.focusIndex).toBe(5)
    expect(state.scrollOffset).toBe(5)
    // The next step crosses the top edge: slide exactly one row.
    state = selectorUp(state)
    expect(state.scrollOffset).toBe(4)
  })

  test('reaching the first model scrolls its group header into view', () => {
    const grouped = [
      { label: 'anthropic', header: true, focusable: false },
      ...Array.from({ length: 24 }, (_, i) => ({ label: `m-${i}` })),
    ]
    let state = createSelectorState('T', grouped)
    for (let i = 0; i < 15; i++) state = selectorDown(state)
    while (state.focusIndex > 1) state = selectorUp(state)
    expect(state.scrollOffset).toBe(0)
  })

  test('selectorFocusOn jumps focus and keeps it visible', () => {
    let state = createSelectorState('T', many)
    state = selectorFocusOn(state, item => item.label === 'model-20')
    expect(state.focusIndex).toBe(20)
    expect(state.scrollOffset).toBe(11)
  })

  test('filtering drops unassociated group headers from results', () => {
    let state = createSelectorState('T', [
      { label: 'anthropic', header: true, focusable: false },
      { label: 'claude-opus' },
      { label: 'openai', header: true, focusable: false },
      { label: 'gpt-5.5' },
    ])
    state = selectorType(state, 'a')
    expect(state.items.every(i => !i.header)).toBe(true)
    expect(state.items.map(i => i.label)).toContain('claude-opus')
  })

  test('filtering retains headers for matching associated groups', () => {
    let state = createSelectorState('T', [
      { label: 'Current cwd', header: true, focusable: false, group: 'current' },
      { label: 'aaaaaaaa', searchText: 'current alpha', group: 'current' },
      { label: 'Other cwd', header: true, focusable: false, group: 'other' },
      { label: 'bbbbbbbb', searchText: 'other payment timeout', group: 'other', contextPrefix: '/other · ' },
    ])
    state = selectorType(state, 'p')
    state = selectorType(state, 'a')
    state = selectorType(state, 'y')

    expect(state.items.map(item => item.label)).toEqual(['Other cwd', 'bbbbbbbb'])
    expect(state.focusIndex).toBe(1)
    expect(state.items[1]!.detail).toStartWith('/other · ')
  })

  test('removing the last item in a group also removes its header', () => {
    let state = createSelectorState('T', [
      { label: 'Current cwd', header: true, focusable: false, group: 'current' },
      { label: 'aaaaaaaa', id: 'session-a', group: 'current' },
      { label: 'Other cwd', header: true, focusable: false, group: 'other' },
      { label: 'bbbbbbbb', id: 'session-b', group: 'other' },
    ])
    state = selectorRemoveItem(state, 1)

    expect(state.items.map(item => item.label)).toEqual(['Other cwd', 'bbbbbbbb'])
    expect(state.focusIndex).toBe(1)
  })
})
