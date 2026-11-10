import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { eastAsianWidth, eastAsianWidthType } from 'get-east-asian-width'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import { visibleWidth } from '../../src/ui/wrap.js'
import type { ConfigInfo } from '../../src/native/contracts/config-info.js'
import { handleSelectorControl } from '../../src/term/app/selector/selector-control.js'
import { modelEffort, modelSelectorItems } from '../../src/features/models/options.js'
import { createModelWindow } from '../../src/term/app/selector/selector-windows.js'
import { carryModelEfforts } from '../../src/features/models/options.js'
import {
  createSelectorState,
  selectorAdjustEffort,
  selectorBackspace,
  selectorClearQuery,
  selectorEffortLevel,
  selectorType,
  type SelectorItem,
  type SelectorState,
} from '../../src/ui/selector.js'
import { buildSelectorRegionLines } from '../../src/term/viewmodel/selector.js'
import { effortCellHex, effortLevelHex } from '../../src/term/viewmodel/model-effort.js'
import { getTheme } from '../../src/ui/theme/index.js'

/** A theme hex as the truecolor SGR sequence the renderer emits for it. */
function fg(hex: string): string {
  const [red, green, blue] = hex.slice(1).match(/.{2}/g)!.map(part => Number.parseInt(part, 16))
  return `\x1b[38;2;${red};${green};${blue}m`
}

function bgSgr(hex: string): string {
  const [red, green, blue] = hex.slice(1).match(/.{2}/g)!.map(part => Number.parseInt(part, 16))
  return `\x1b[48;2;${red};${green};${blue}m`
}

const LADDER = ['off', 'low', 'medium', 'high', 'max']

const config: ConfigInfo = {
  provider: 'evot-pro', protocol: 'anthropic', envPath: '', hasApiKey: true, baseUrl: null,
  thinkingLevel: 'high',
  availableModels: [
    {
      provider: 'evot-pro', model: 'claude-sonnet-5', spec: 'evot-pro:claude-sonnet-5',
      group_label: 'Evot Premium', group_order: 0, sort_order: 9,
      thinking_levels: LADDER, thinking_level: 'medium',
    },
    {
      provider: 'evot-pro', model: 'claude-haiku', spec: 'evot-pro:claude-haiku',
      group_label: 'Evot Premium', group_order: 0, sort_order: 8,
      thinking_levels: ['off', 'low', 'medium'], thinking_level: 'low',
    },
    {
      provider: 'evot-pro', model: 'adaptive', spec: 'evot-pro:adaptive',
      group_label: 'Evot Premium', group_order: 0, sort_order: 7,
    },
  ],
}

const key = (type: 'left' | 'right' | 'enter' | 'down') => ({ type }) as const

function modelWindow(active = 'claude-sonnet-5'): SelectorState {
  return createModelWindow(config, active, true)
}

function rows(state: SelectorState, width = 80, active = true): string[] {
  return buildSelectorRegionLines(state, width, 24, active)
    .map(row => stripAnsi(row).replaceAll('\x1b_pi:c\x07', ''))
}

/** Locate the focused model without depending on terminal color support.
 * Styling assertions below explicitly enable truecolor in their own suite. */
function focusedRow(state: SelectorState, width = 80, active = true): string {
  const selected = state.items[state.focusIndex]
  const raw = buildSelectorRegionLines(state, width, 24, active)
    .find(row => selected && stripAnsi(row).includes(selected.label) && stripAnsi(row).includes('\u25fc'))
  return stripAnsi(raw ?? '').replaceAll('\x1b_pi:c\x07', '')
}

function rawRows(state: SelectorState, width = 80, active = true): string[] {
  return buildSelectorRegionLines(state, width, 24, active)
}

/** Column where a rendered row's gauge starts, or -1 when it has none. */
function gaugeColumn(row: string): number {
  const at = [...row].findIndex(char => char === '◼')
  return at
}

describe('per-model effort ladders', () => {
  test('the active row starts on the live session level, not the published default', () => {
    // The published default is `medium`, but the session is on `high` — the row
    // the user is already running must not appear to contradict the footer.
    const active = modelEffort(config.availableModels[0]!, 'high')
    expect(active).toEqual({ levels: LADDER, index: 3 })
    // Other rows keep their own resolved level.
    expect(modelEffort(config.availableModels[0]!)).toEqual({ levels: LADDER, index: 2 })
  })

  test('models with no selectable reasoning get no ladder', () => {
    expect(modelEffort(config.availableModels[2]!)).toBeUndefined()
    expect(modelEffort({ provider: 'p', model: 'm', spec: 'p:m', thinking_levels: [] })).toBeUndefined()
  })

  test('an unpublished or unknown tier falls back instead of being invented', () => {
    const option = { provider: 'p', model: 'm', spec: 'p:m', thinking_levels: LADDER, thinking_level: 'low' }
    // Live level absent from the ladder → the model's own resolved level.
    expect(modelEffort(option, 'xhigh')).toEqual({ levels: LADDER, index: 1 })
    // Neither published nor live → the bottom of the ladder, never a guess.
    expect(modelEffort({ provider: 'p', model: 'm', spec: 'p:m', thinking_levels: LADDER }))
      .toEqual({ levels: LADDER, index: 0 })
  })

  test('rows carry the ladder and the active row reflects the live level', () => {
    const items = modelSelectorItems(config.availableModels, 'evot-pro:claude-sonnet-5', 'high')
    const byId = new Map(items.map(item => [item.id, item]))
    expect(byId.get('evot-pro:claude-sonnet-5')?.effort).toEqual({ levels: LADDER, index: 3 })
    expect(byId.get('evot-pro:claude-haiku')?.effort).toEqual({ levels: ['off', 'low', 'medium'], index: 1 })
    expect(byId.get('evot-pro:adaptive')?.effort).toBeUndefined()
  })
})

describe('adjusting a tier', () => {
  test('moves one tier per keypress and clamps at both ends', () => {
    let state = modelWindow()
    expect(selectorEffortLevel(state.items[state.focusIndex])).toBe('high')

    state = selectorAdjustEffort(state, 1)
    expect(selectorEffortLevel(state.items[state.focusIndex])).toBe('max')

    // At the ceiling the state is returned unchanged, so a caller can treat
    // "unchanged" as "not handled" rather than repainting for nothing.
    expect(selectorAdjustEffort(state, 1)).toBe(state)

    for (let i = 0; i < 4; i++) state = selectorAdjustEffort(state, -1)
    expect(selectorEffortLevel(state.items[state.focusIndex])).toBe('off')
    // Clamped, never wrapped: one keypress must not jump max → off.
    expect(selectorAdjustEffort(state, -1)).toBe(state)
  })

  test('a row can never be pushed past its own ladder', () => {
    let state = modelWindow('claude-haiku')
    // claude-haiku stops at `medium`; the neighbouring row goes to `max`.
    for (let i = 0; i < 10; i++) state = selectorAdjustEffort(state, 1)
    expect(selectorEffortLevel(state.items[state.focusIndex])).toBe('medium')
  })

  test('an adjusted tier survives filtering and clearing the query', () => {
    let state = selectorAdjustEffort(modelWindow(), -2)
    expect(selectorEffortLevel(state.items[state.focusIndex])).toBe('low')

    // Filtering rebuilds the visible list from the unfiltered pool, so a tier
    // that lived only in `items` would silently reset on the next keystroke.
    for (const char of 'haiku') state = selectorType(state, char)
    // The group heading stays above its match, so only model rows are compared.
    expect(state.items.filter(item => !item.header).map(item => item.id))
      .toEqual(['evot-pro:claude-haiku'])

    state = selectorClearQuery(state)
    const sonnet = state.items.find(item => item.id === 'evot-pro:claude-sonnet-5')
    expect(selectorEffortLevel(sonnet)).toBe('low')

    // And it is still there after a round trip through backspace.
    for (const char of 'haiku') state = selectorType(state, char)
    for (let i = 0; i < 'haiku'.length; i++) state = selectorBackspace(state)
    expect(state.query).toBe('')
    expect(selectorEffortLevel(state.items.find(item => item.id === 'evot-pro:claude-sonnet-5')))
      .toBe('low')
  })

  test('rows without a ladder and headers are never adjusted', () => {
    const state = modelWindow('adaptive')
    expect(selectorAdjustEffort(state, 1)).toBe(state)

    const headerFocused = { ...modelWindow(), focusIndex: 0 }
    expect(headerFocused.items[0]?.header).toBe(true)
    expect(selectorAdjustEffort(headerFocused, 1)).toBe(headerFocused)
  })
})

describe('effort keys in the selector controller', () => {
  test('left and right move the focused row one tier', () => {
    const right = handleSelectorControl(modelWindow(), key('right'))
    expect(right.kind).toBe('update')
    if (right.kind !== 'update') return
    expect(selectorEffortLevel(right.state.items[right.state.focusIndex])).toBe('max')

    const left = handleSelectorControl(right.state, key('left'))
    expect(left.kind).toBe('update')
    if (left.kind === 'update') {
      expect(selectorEffortLevel(left.state.items[left.state.focusIndex])).toBe('high')
    }
  })

  test('a ladder end reports unhandled rather than repainting', () => {
    let state = modelWindow()
    state = selectorAdjustEffort(state, 1)
    expect(handleSelectorControl(state, key('right')).kind).toBe('none')
  })

  test('selectors without ladders keep left/right unhandled', () => {
    // Resume/skill/queue rows never carry effort, so an open selector must not
    // start swallowing arrows that previously did nothing.
    const plain = createSelectorState('Sessions', [{ label: 'one', id: 's1' }])
    expect(handleSelectorControl(plain, key('left')).kind).toBe('none')
    expect(handleSelectorControl(plain, key('right')).kind).toBe('none')
    expect(handleSelectorControl(modelWindow('adaptive'), key('right')).kind).toBe('none')
  })

  test('an armed delete is not disarmed by a key the row cannot use', () => {
    const armed = {
      ...createSelectorState('Sessions', [{ label: 'one', id: 's1' }]),
      pendingDeleteId: 's1',
    }
    expect(handleSelectorControl(armed, key('left')).kind).toBe('none')
  })

  test('confirming carries the adjusted tier alongside the model', () => {
    const adjusted = selectorAdjustEffort(modelWindow(), -1)
    const action = handleSelectorControl(adjusted, key('enter'))
    expect(action).toEqual({
      kind: 'select-model',
      spec: 'evot-pro:claude-sonnet-5',
      thinkingLevel: 'medium',
    })
  })

  test('a model with no ladder names no tier on confirm', () => {
    const action = handleSelectorControl(modelWindow('adaptive'), key('enter'))
    expect(action).toEqual({ kind: 'select-model', spec: 'evot-pro:adaptive' })
  })
})

describe('effort column rendering', () => {
  test('every gauge and label shares one column regardless of ladder length', () => {
    const painted = rows(modelWindow()).filter(row => row.includes('◼'))
    expect(painted.length).toBe(2)

    const columns = new Set(painted.map(gaugeColumn))
    expect(columns.size).toBe(1)
    const labelColumns = new Set(painted.map(row => row.search(/(High|Max|Low|Medium|Off)\s*$/)))
    expect(labelColumns.size).toBe(1)
  })

  test('the gauge shows one cell per tier on that row own ladder', () => {
    // Filled and empty are the same glyph separated only by colour (Devin's own
    // rendering), so plain text carries the ladder *length*; which cells are lit
    // is asserted in the colour suite below.
    const focused = focusedRow(modelWindow())
    expect(focused).toContain('◼◼◼◼◼')
    expect(focused).toMatch(/High\s*$/)

    const shorter = rows(modelWindow()).find(row => row.includes('claude-haiku'))!
    // A 3-tier model shows three cells, not the widest ladder's five.
    expect([...shorter].filter(char => char === '◼')).toHaveLength(3)
    expect(shorter).toMatch(/Low\s*$/)
  })

  test('affordances appear only on the focused row, and only at a movable end', () => {
    const focused = focusedRow(modelWindow())
    expect(focused).toContain('←')
    expect(focused).toContain('→')

    const idle = rows(modelWindow()).find(row => row.includes('claude-haiku'))!
    expect(idle).not.toContain('←')
    expect(idle).not.toContain('→')

    const atFloor = focusedRow(selectorAdjustEffort(modelWindow(), -3))
    expect(atFloor).not.toContain('←')
    expect(atFloor).toContain('→')

    const atCeiling = focusedRow(selectorAdjustEffort(modelWindow(), 1))
    expect(atCeiling).toContain('←')
    expect(atCeiling).not.toContain('→')
  })

  test('a preview offers no affordances while the composer owns input', () => {
    const focused = focusedRow(createModelWindow(config, 'claude-sonnet-5'), 80, false)
    expect(focused).toContain('◼')
    expect(focused).not.toContain('←')
    expect(focused).not.toContain('→')
  })

  test('the footer names the model and tier, and offers ←→ only on a row with a ladder', () => {
    const withLadder = rows(modelWindow()).join('\n')
    expect(withLadder).toContain('Model: claude-sonnet-5 · High')
    expect(withLadder).toContain('↑↓ select · ←→ reasoning effort · ↵ confirm · esc close')
    const noLadder = rows(modelWindow('adaptive')).join('\n')
    expect(noLadder).toContain('Model: adaptive')
    expect(noLadder).not.toContain('reasoning effort')
    expect(noLadder).toContain('↑↓ select · ↵ confirm · esc close')
  })

  test('a preview reports the tier but names no gesture it cannot serve', () => {
    const preview = rows(createModelWindow(config, 'claude-sonnet-5'), 80, false).join('\n')
    expect(preview).toContain('Model: claude-sonnet-5 · High')
    expect(preview).not.toContain('reasoning effort')
    expect(preview).not.toContain('↵ confirm')
  })

  test('the footer height does not change as focus crosses rows with and without ladders', () => {
    for (const active of [true, false]) {
      const heights = new Set<number>()
      for (const model of ['claude-sonnet-5', 'claude-haiku', 'adaptive']) {
        heights.add(buildSelectorRegionLines(createModelWindow(config, model, active), 80, 24, active).length)
      }
      expect(heights.size).toBe(1)
    }
  })

  test('the whole column drops rather than truncating a gauge', () => {
    for (const width of [1, 2, 20, 30, 36]) {
      const painted = rows(modelWindow(), width)
      // A cut gauge would read as a different tier than the one selected.
      expect(painted.some(row => row.includes('◼'))).toBe(false)
      expect(painted.every(row => stringWidth(row) <= Math.max(width, 2))).toBe(true)
    }
    expect(rows(modelWindow(), 60).some(row => row.includes('◼'))).toBe(true)
  })

  test('rows never overflow the terminal at any width', () => {
    for (const width of [37, 40, 60, 80, 120]) {
      for (const row of rows(modelWindow(), width)) {
        expect(stringWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })

  test('a model without a ladder renders no gauge and no trailing padding', () => {
    const row = rows(modelWindow()).find(text => text.includes('adaptive'))!
    // `· ` gutter marks it as a choice; no gauge, and no padding left behind
    // by a column it does not participate in.
    expect(row).toBe('· adaptive')
  })
})

describe('gauge glyph width safety', () => {
  test('every gauge glyph is Neutral width, never Ambiguous', () => {
    // The bug this guards: `■` U+25A0 is East-Asian *Ambiguous*, so a
    // CJK-configured terminal draws it two columns wide while `visibleWidth`
    // counts it as one. Each cell then overruns its column, butts against its
    // neighbour, and the ladder renders as one fused bar instead of a scale.
    const glyphs = new Set<string>()
    for (const row of rows(modelWindow())) {
      for (const char of row) {
        if (/[\u25a0-\u25ff\u2580-\u259f]/.test(char)) glyphs.add(char)
      }
    }
    expect(glyphs.size).toBeGreaterThan(0)
    for (const glyph of glyphs) {
      const cp = glyph.codePointAt(0)!
      expect(eastAsianWidthType(cp), `${glyph} U+${cp.toString(16)}`).toBe('neutral')
      // Narrow and wide must agree, or the terminal and our width math diverge.
      expect(eastAsianWidth(cp, { ambiguousAsWide: true })).toBe(1)
      expect(visibleWidth(glyph)).toBe(1)
    }
  })

  test('a full ladder occupies exactly one column per tier', () => {
    // Width math and glyph width agreeing is what keeps cells discrete.
    const row = focusedRow(modelWindow())
    const cells = [...row].filter(char => char === '◼')
    expect(cells).toHaveLength(5)
    expect(visibleWidth(cells.join(''))).toBe(5)
  })
})

describe('effort column colours', () => {
  const { brandHex, mutedHex, subtleHex, accentHex, selectionBgHex, selectionMutedHex, effortRampHex } = getTheme()

  // Asserting SGR requires a colour level; bun test has no TTY, so chalk would
  // otherwise emit bare text and every colour assertion would pass vacuously.
  // Restored afterwards so this file cannot tint another one in the same run.
  let previousLevel: typeof chalk.level
  beforeAll(() => { previousLevel = chalk.level; chalk.level = 3 })
  afterAll(() => { chalk.level = previousLevel })

  /** The styled row for a model, located by its visible label. */
  function rawRowFor(state: SelectorState, label: string): string {
    return rawRows(state).find(row => stripAnsi(row).includes(label))!
  }

  test('the focused row paints lit cells along the ramp on the selection band', () => {
    const row = rawRowFor(modelWindow(), 'claude-sonnet-5')
    expect(row).toContain(bgSgr(selectionBgHex))
    // Five tiers at `high`: cells 0..3 sample ramp stops 0, 1, 3 and 4.
    for (const stop of [0, 1, 3, 4]) expect(row).toContain(fg(effortRampHex[stop]!))
    expect(row).not.toContain(fg(effortRampHex[5]!))
    // Secondary cells sit on the band, where plain dim gray goes too dark.
    expect(row).toContain(fg(selectionMutedHex))
  })

  test('the tier label takes the hue of its top cell, in the row and the footer', () => {
    const high = fg(effortCellHex(3, 5))
    const row = rawRowFor(modelWindow(), 'claude-sonnet-5')
    expect(row.slice(0, row.indexOf('High'))).toEndWith(high)
    const footer = rawRows(modelWindow()).find(text => stripAnsi(text).includes('Model: claude-sonnet-5'))!
    expect(footer.slice(0, footer.indexOf('High'))).toEndWith(high)
    expect(fg(effortLevelHex({ levels: LADDER, index: 4 }))).toBe(fg(effortRampHex.at(-1)!))
    expect(fg(effortLevelHex({ levels: LADDER, index: 0 }))).toBe(fg(effortRampHex[0]!))
  })

  test('a short ladder reaches the same top hue as a long one', () => {
    expect(effortCellHex(2, 3)).toBe(effortCellHex(4, 5))
    expect(effortCellHex(0, 1)).toBe(effortRampHex[0])
  })

  test('an idle gauge stays gray so blue reads as "this is the current row"', () => {
    const row = rawRowFor(modelWindow(), 'claude-haiku')
    expect(row).toContain(fg(mutedHex))
    expect(row).not.toContain(fg(brandHex))
    expect(row).not.toContain(bgSgr(selectionBgHex))
  })

  test('no gauge row uses the gold structural accent', () => {
    // Gold belongs to group headings; a gauge borrowing it would read as
    // another heading rather than as a reading on a scale.
    for (const row of rawRows(modelWindow())) {
      if (!stripAnsi(row).includes('◼')) continue
      expect(row).not.toContain(fg(accentHex))
    }
    // The heading itself keeps it.
    expect(rawRowFor(modelWindow(), 'Evot Premium')).toContain(fg(accentHex))
  })

  test('the affordances keep the brand hue', () => {
    const row = rawRowFor(modelWindow(), 'claude-sonnet-5')
    const arrowAt = row.indexOf('←')
    expect(row.slice(0, arrowAt)).toEndWith(fg(brandHex))
  })

  test('idle rows carry a muted gutter and a full-strength label', () => {
    const row = rawRowFor(modelWindow(), 'claude-haiku')
    expect(stripAnsi(row)).toStartWith('· ')
    // The gutter is muted, but the label is not dimmed down with it: the accent
    // alone says which row is current.
    expect(row).toContain(fg(mutedHex))
    const labelAt = row.indexOf('claude-haiku')
    expect(row.slice(0, labelAt)).toEndWith('\x1b[39m')
  })

  test('the gauge keeps a two-tone contrast so an idle row is still readable', () => {
    // `dim` is itself mutedHex in this renderer, so filled and empty would
    // collapse into one flat block of grey without a tone below muted.
    const idle = rawRowFor(modelWindow(), 'claude-haiku')
    expect(idle).toContain(fg(mutedHex))
    expect(idle).toContain(fg(subtleHex))
    expect(mutedHex).not.toBe(subtleHex)

    // On the current row the filled cells take the ramp, empty stays subtle.
    const focused = rawRowFor(modelWindow(), 'claude-sonnet-5')
    expect(focused).toContain(fg(effortRampHex[0]!))
    expect(focused).toContain(fg(subtleHex))
  })

  test('one glyph, two tones: the lit count is the tier, not the glyph', () => {
    // Filled and empty are both `◼`, so the reading lives entirely in colour.
    // Devin does the same; a hollow `□` would break the ladder's even pitch.
    const lit = (row: string, hex: string): number => {
      let total = 0
      for (const chunk of row.split(fg(hex)).slice(1)) {
        const upToNextStyle = chunk.split('\x1b')[0] ?? ''
        total += [...upToNextStyle].filter(char => char === '◼').length
      }
      return total
    }
    const litOnRamp = (row: string): number =>
      effortRampHex.reduce((sum, hex) => sum + lit(row, hex), 0)

    // claude-sonnet-5 sits at `high`: 4 of 5 cells lit along the ramp.
    const focused = rawRowFor(modelWindow(), 'claude-sonnet-5')
    expect(litOnRamp(focused)).toBe(4)
    expect(lit(focused, subtleHex)).toBe(1)

    // Moving down a tier moves one cell from lit to unlit, same total.
    const lower = rawRowFor(selectorAdjustEffort(modelWindow(), -1), 'claude-sonnet-5')
    expect(litOnRamp(lower)).toBe(3)
    expect(lit(lower, subtleHex)).toBe(2)
  })
})

describe('carrying tiers across a catalog refresh', () => {
  const previous: SelectorItem[] = [
    { label: 'sonnet', id: 'evot-pro:claude-sonnet-5', effort: { levels: LADDER, index: 0 } },
  ]

  test('an adjusted tier survives a background sync', () => {
    const next = modelSelectorItems(config.availableModels, 'evot-pro:claude-sonnet-5', 'high')
    const carried = carryModelEfforts(previous, next)
    expect(carried.find(item => item.id === 'evot-pro:claude-sonnet-5')?.effort)
      .toEqual({ levels: LADDER, index: 0 })
  })

  test('a changed ladder defers to the server rather than keeping a stale index', () => {
    const next: SelectorItem[] = [
      { label: 'sonnet', id: 'evot-pro:claude-sonnet-5', effort: { levels: ['off', 'low'], index: 1 } },
    ]
    expect(carryModelEfforts(previous, next)[0]?.effort).toEqual({ levels: ['off', 'low'], index: 1 })
  })

  test('rows that gained or lost a ladder are left to the server', () => {
    const gained: SelectorItem[] = [{ label: 'sonnet', id: 'evot-pro:claude-sonnet-5' }]
    expect(carryModelEfforts(previous, gained)[0]?.effort).toBeUndefined()
    expect(carryModelEfforts([{ label: 'x', id: 'x' }], gained)).toEqual(gained)
  })
})
