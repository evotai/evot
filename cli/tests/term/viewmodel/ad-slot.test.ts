import { describe, test, expect } from 'bun:test'
import stripAnsi from 'strip-ansi'

import {
  createAdSlotState,
  tickAdSlot,
  triggerAdSlot,
  buildAdSlotBlocks,
  campaignFingerprint,
  AD_STEADY_MS,
  AD_GAP_MS,
  ERASE_STEP_MS,
} from '../../../src/term/viewmodel/ad-slot.js'
import type { AdContent } from '../../../src/term/viewmodel/ad-slot.js'
import { styledLineToAnsi } from '../../../src/term/viewmodel/types.js'

const notice: AdContent = { id: 'n1', kind: 'notice', priority: 10, title: 'New model: Kimi K3', body: 'fast inference' }
const ad1: AdContent = { id: 'a1', kind: 'ad', title: 'Ad One', body: 'try it' }
const ad2: AdContent = { id: 'a2', kind: 'ad', title: 'Ad Two', body: 'also try it' }
const markdownAd: AdContent = {
  id: 'md1',
  kind: 'ad',
  title: '**Pro** is live',
  body: 'try `evot login` or [docs](https://evot.ai)',
}

const T0 = 1_000_000

function slotText(blocks: ReturnType<typeof buildAdSlotBlocks>): string {
  return stripAnsi(blocks.flatMap(block => block.lines.map(styledLineToAnsi)).join('\n'))
}

function bodyText(blocks: ReturnType<typeof buildAdSlotBlocks>): string {
  const lines = blocks[0]?.lines ?? []
  return stripAnsi(lines.slice(1, -1).map(styledLineToAnsi).join('\n')).trim()
}


describe('ad slot lifecycle', () => {
  test('hidden until first trigger, then shows and keeps showing', () => {
    const state = createAdSlotState([notice, ad1])
    expect(tickAdSlot(state, T0).content).toBeNull()          // idle before login/task
    triggerAdSlot(state, T0)
    const tick = tickAdSlot(state, T0 + 1000)
    expect(tick.content?.id).toBe('n1')
    // Both items play once; stepping past them leaves the slot quiet.
    for (let t = T0; t < T0 + 6 * AD_STEADY_MS; t += 250) tickAdSlot(state, t)
    expect(tickAdSlot(state, T0 + 6 * AD_STEADY_MS).content).toBeNull()
  })

  test('progress advances monotonically through the steady phase', () => {
    const state = createAdSlotState([notice])
    triggerAdSlot(state, T0)
    let last = 0
    for (let t = T0; t <= T0 + AD_STEADY_MS / 2; t += AD_STEADY_MS / 20) {
      const { progress, phase } = tickAdSlot(state, t)
      if (phase === 'erasing') break
      expect(progress).toBeGreaterThanOrEqual(last)
      last = progress
    }
  })

  test('each item plays once, highest priority first, then the slot goes quiet', () => {
    const state = createAdSlotState([notice, ad1, ad2])
    triggerAdSlot(state, T0)
    const order: string[] = []
    let sawErasing = false
    for (let t = T0; t < T0 + AD_STEADY_MS * 8; t += 30) {
      const r = tickAdSlot(state, t)
      if (r.phase === 'erasing') sawErasing = true
      if (r.phase === 'steady' && r.content && order[order.length - 1] !== r.content.id) {
        order.push(r.content.id)
      }
    }
    expect(sawErasing).toBe(true)
    // Notice (priority 5) leads, then the ads in catalog order. Nothing repeats.
    expect(order).toEqual(['n1', 'a1', 'a2'])
    expect(tickAdSlot(state, T0 + AD_STEADY_MS * 8).content).toBeNull()
  })

  test('an unseen notice preempts a showing ad', () => {
    const state = createAdSlotState([ad1])
    triggerAdSlot(state, T0)
    expect(tickAdSlot(state, T0 + 1000).content?.id).toBe('a1')

    // A notice arriving mid-session outranks the ad once it has settled.
    state.notices.push({ id: 'n-urgent', kind: 'notice', priority: 99, title: 'urgent', body: '' })
    let seen: string | undefined
    for (let t = T0 + 2000; t < T0 + AD_STEADY_MS; t += 250) {
      const tick = tickAdSlot(state, t)
      if (tick.content?.id === 'n-urgent') { seen = tick.content.id; break }
    }
    expect(seen).toBe('n-urgent')
  })

  test('idle without trigger: slot stays hidden indefinitely', () => {
    const state = createAdSlotState([ad1])
    for (const t of [T0, T0 + 60_000, T0 + 600_000]) {
      expect(tickAdSlot(state, t).content).toBeNull()
    }
  })

  test('erase wipes the line character by character, then holds blank before the next item', () => {
    const state = createAdSlotState([notice, ad1])
    triggerAdSlot(state, T0)
    // let the notice type out and cross its window so a transition is queued
    let t = T0
    for (; t < T0 + AD_STEADY_MS + 100; t += 250) tickAdSlot(state, t)

    // sample the erase phase: rendered width must shrink monotonically
    const widths: number[] = []
    for (let u = t; u < t + 40 * ERASE_STEP_MS; u += ERASE_STEP_MS) {
      const tick = tickAdSlot(state, u)
      if (tick.phase !== 'erasing') break
      const blocks = buildAdSlotBlocks(state, tick, 200, u)
      widths.push(bodyText(blocks).length)
    }
    expect(widths.length).toBeGreaterThan(3)
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThanOrEqual(widths[i - 1]!)
    }
    expect(widths[widths.length - 1]!).toBe(0)   // ends blank
  })

  test('gap keeps the slot blank between two items', () => {
    const state = createAdSlotState([notice, ad1])
    triggerAdSlot(state, T0)
    let t = T0
    for (; t < T0 + AD_STEADY_MS + 100; t += 250) tickAdSlot(state, t)
    // find when erasing finished
    let eraseEnd = t
    for (let u = t; u < t + 60 * ERASE_STEP_MS; u += ERASE_STEP_MS) {
      if (tickAdSlot(state, u).phase !== 'erasing') { eraseEnd = u; break }
      eraseEnd = u
    }
    // mid-gap the line renders empty while the old content is still pinned
    const mid = tickAdSlot(state, eraseEnd - AD_GAP_MS / 2)
    if (mid.phase === 'erasing') {
      expect(bodyText(buildAdSlotBlocks(state, mid, 200, eraseEnd - AD_GAP_MS / 2))).toBe('')
    }
  })
})

describe('buildAdSlotBlocks rendering', () => {
  test('renders a single ticker line between two rules', () => {
    const state = createAdSlotState([notice, ad1])
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0)
    const tick = tickAdSlot(state, T0 + 15_000)
    expect(tick.phase).toBe('steady')
    const blocks = buildAdSlotBlocks(state, tick, 100)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.lines.length).toBe(3)   // rule + ticker + rule
    const text = slotText(blocks)
    expect(text).toContain('New model: Kimi K3')
    expect(text).toContain('fast inference')
    expect(text).not.toContain('Notice:')
  })

  test('ticker shows title and body, nothing else', () => {
    const state = createAdSlotState([ad1])
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0)
    const tick = tickAdSlot(state, T0 + 15_000)
    const text = slotText(buildAdSlotBlocks(state, tick, 200))
    expect(text).toContain('Ad One')
    expect(text).toContain('try it')
    // No kind label, no CTA arrow — just the copy.
    expect(text).not.toContain('Ad:')
    expect(text).not.toContain('\u2197')
  })

  test('typewriter reveals characters over time then holds', async () => {
    const { typedLength, TYPE_STEP_MS } = await import('../../../src/term/viewmodel/ad-slot.js')
    expect(typedLength(1000, 1000)).toBe(0)
    expect(typedLength(1000, 1000 + TYPE_STEP_MS * 5)).toBe(5)
    // monotonic
    let last = -1
    for (let t = 0; t <= 100; t += 10) {
      const len = typedLength(0, t)
      expect(len).toBeGreaterThanOrEqual(last)
      last = len
    }
  })

  test('typing starts empty and fills in as frames pass', async () => {
    const { typedLength, TYPE_STEP_MS } = await import('../../../src/term/viewmodel/ad-slot.js')
    const state = createAdSlotState([ad1])
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0)

    // early frame: only a few characters visible
    const early = buildAdSlotBlocks(state, tickAdSlot(state, T0 + TYPE_STEP_MS * 3), 200, T0 + TYPE_STEP_MS * 3)
    const earlyText = bodyText(early)
    expect(earlyText.length).toBeLessThan(20)

    // long after typing finished: the whole line is visible
    const later = buildAdSlotBlocks(state, tickAdSlot(state, T0 + TYPE_STEP_MS * 500), 200, T0 + TYPE_STEP_MS * 500)
    const laterText = bodyText(later)
    expect(laterText).toContain('Ad One')
    expect(laterText).toContain('try it')
    expect(laterText).not.toContain('Ad:')
  })

  test('short content fits without scrolling artifacts', () => {
    const state = createAdSlotState([notice])
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0)
    const tick = tickAdSlot(state, T0 + 15_000)
    const blocks = buildAdSlotBlocks(state, tick, 200)
    const text = bodyText(blocks)
    expect(text).toContain('New model: Kimi K3')
    expect(text).not.toContain('Notice:')
  })

  test('erasing keeps the rules and blanks only the text line', () => {
    const state = createAdSlotState([notice, ad1])
    triggerAdSlot(state, T0)
    const tick = { content: notice, phase: 'erasing' as const, progress: 0 }
    // shownAt is far in the past, so every character is already wiped
    const blocks = buildAdSlotBlocks(state, tick, 100, T0 + 60_000)
    expect(blocks[0]!.lines.length).toBe(3)   // rule + blank ticker + rule
    const text = bodyText(blocks)
    expect(text).toBe('')
  })

  test('gone renders nothing; narrow terminal renders nothing', () => {
    const state = createAdSlotState([notice, ad1])
    const gone = { content: null, phase: 'gone' as const, progress: 0 }
    expect(buildAdSlotBlocks(state, gone, 100)).toEqual([])
    const tick = tickAdSlot(state, T0 + 15_000)
    expect(buildAdSlotBlocks(state, tick, 20)).toEqual([])
  })

  test('renders markdown emphasis, code, and links without leaking markup', () => {
    const state = createAdSlotState([markdownAd])
    triggerAdSlot(state, T0)
    const tick = tickAdSlot(state, T0 + 15_000)
    const text = slotText(buildAdSlotBlocks(state, tick, 120, T0 + 15_000))
    expect(text).toContain('Pro is live')
    expect(text).toContain('evot login')
    expect(text).toContain('docs')
    expect(text).not.toContain('**Pro**')
    expect(text).not.toContain('`evot login`')
    expect(text).not.toContain('[docs](')
  })

  test('markdown body stays on one ticker line', () => {
    const campaign: AdContent = {
      id: 'list',
      kind: 'ad',
      title: 'Tips',
      body: '- **faster** replies\n- try `evot login`',
    }
    const state = createAdSlotState([campaign])
    triggerAdSlot(state, T0)
    const tick = tickAdSlot(state, T0 + 15_000)
    const blocks = buildAdSlotBlocks(state, tick, 80, T0 + 15_000)
    expect(blocks[0]!.lines.length).toBe(3)
    const text = slotText(blocks)
    expect(text).toContain('Tips')
    expect(text).toContain('faster')
    expect(text).toContain('evot login')
    expect(text).not.toContain('**faster**')
    expect(bodyText(blocks).includes('\n')).toBe(false)
  })

  test('emphasis keeps bold/italic SGR and hyperlinks stay balanced', async () => {
    // Common campaign markdown must render styled in the slot: bold, italic,
    // and links survive typing, flattening, and truncation — as OSC 8 on
    // hyperlink terminals, and as visible "text (url)" fallback elsewhere.
    const { default: chalk } = await import('chalk')
    const prevLevel = chalk.level
    const prevHyperlink = process.env.FORCE_HYPERLINK
    const prevTerm = process.env.TERM
    chalk.level = 3
    try {
      process.env.FORCE_HYPERLINK = '1'
      const state = createAdSlotState([{ id: 'em1', kind: 'notice', title: 'Announcement',
        body: 'Sponsored by **Databend** — read *more* at [EFF](https://eff.org)' }])
      triggerAdSlot(state, T0)
      const ansi = buildAdSlotBlocks(state, tickAdSlot(state, T0 + 15_000), 120, T0 + 15_000)
        .flatMap(block => block.lines.map(styledLineToAnsi)).join('\n')
      // Cells carry their own background, so emphasis opens on the first cell
      // and closes after the last rather than wrapping a contiguous run.
      expect(ansi).toContain('\x1b[38;2;240;198;116m\x1b[1mD')
      expect(ansi).toContain('\x1b[22m\x1b[39m')
      expect(ansi).toContain('\x1b[3mm')
      expect(ansi).toContain('\x1b[23m')
      expect(ansi).toContain('\x1b]8;;https://eff.org\x07')
      expect(ansi).toContain('\x1b]8;;\x07')
      expect(stripAnsi(ansi)).toContain('Sponsored by Databend')
      // Every cell is tinted, so the band reads as its own surface.
      expect(ansi).toContain('\x1b[48;2;')

      // A narrow terminal slices the line mid-link: every OSC 8 open it cuts
      // into must keep its closer, so the hyperlink state cannot leak.
      const cut = createAdSlotState([{ id: 'em2', kind: 'notice', title: 'Announcement',
        body: 'Read [the full announcement from EFF](https://eff.org) today' }])
      triggerAdSlot(cut, T0)
      const narrow = buildAdSlotBlocks(cut, tickAdSlot(cut, T0 + 15_000), 44, T0 + 15_000)
        .flatMap(block => block.lines.map(styledLineToAnsi)).join('\n')
      const opens = (narrow.match(/\x1b]8;;[^\x07]+\x07/g) ?? []).length
      const closes = (narrow.match(/\x1b\]8;;\x07/g) ?? []).length
      expect(opens).toBeGreaterThan(0)
      expect(opens).toBe(closes)

      delete process.env.FORCE_HYPERLINK
      process.env.TERM = 'dumb'
      const plain = createAdSlotState([{ id: 'em3', kind: 'notice', title: 'Announcement',
        body: 'Sponsored by **Databend** at [EFF](https://eff.org)' }])
      triggerAdSlot(plain, T0)
      const fallback = buildAdSlotBlocks(plain, tickAdSlot(plain, T0 + 15_000), 120, T0 + 15_000)
        .flatMap(block => block.lines.map(styledLineToAnsi)).join('\n')
      expect(fallback).toContain('\x1b[1mD')
      expect(stripAnsi(fallback)).toContain('Sponsored by Databend')
      expect(stripAnsi(fallback)).toContain('EFF (https://eff.org)')
      expect(fallback).not.toContain('\x1b]8;;')
    } finally {
      chalk.level = prevLevel
      if (prevHyperlink === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prevHyperlink
      if (prevTerm === undefined) delete process.env.TERM
      else process.env.TERM = prevTerm
    }
  })

  test('every rendered line passes styledLineToAnsi without crashing', async () => {
    const { styledLineToAnsi } = await import('../../../src/term/viewmodel/types.js')
    for (const cols of [100, 60, 31]) {
      const state = createAdSlotState([notice, ad1])
      triggerAdSlot(state, T0)
      for (const t of [T0 + 50, T0 + 15_000, T0 + AD_STEADY_MS - 100]) {
        const tick = tickAdSlot(state, t)
        for (const b of buildAdSlotBlocks(state, tick, cols)) {
          for (const l of b.lines) expect(() => styledLineToAnsi(l)).not.toThrow()
        }
      }
    }
  })
})

describe('premium accounts', () => {
  test('ads never enter the slot', () => {
    const state = createAdSlotState([notice, ad1, ad2], { premium: true })
    expect(state.ads).toEqual([])
    expect(state.notices.map(n => n.id)).toEqual(['n1'])
  })

  test('an ad-only catalog leaves the slot empty and hidden', () => {
    const state = createAdSlotState([ad1, ad2], { premium: true })
    triggerAdSlot(state, T0)
    expect(tickAdSlot(state, T0 + 1000).content).toBeNull()
  })

  test('copy already shown this session is not shown again', () => {
    const shown = campaignFingerprint(notice)
    const state = createAdSlotState([notice], { premium: true, played: [shown] })
    expect(triggerAdSlot(state, T0)).toBeNull()
    expect(tickAdSlot(state, T0 + 1000).content).toBeNull()
  })

  test('edited copy counts as new even under the same id', () => {
    const shown = campaignFingerprint(notice)
    const edited = { ...notice, body: 'fast inference — now cheaper' }
    const state = createAdSlotState([edited], { premium: true, played: [shown] })
    expect(state.notices.map(n => n.id)).toEqual(['n1'])
  })

  test('a shown notice retires instead of looping forever', () => {
    const state = createAdSlotState([notice], { premium: true })
    triggerAdSlot(state, T0)
    expect(tickAdSlot(state, T0 + 1000).content?.id).toBe('n1')
    expect(tickAdSlot(state, T0 + AD_STEADY_MS + 1).content).toBeNull()
  })

  test('going on screen records the copy, so quitting early still counts', () => {
    const state = createAdSlotState([notice], { premium: true })
    triggerAdSlot(state, T0)
    expect(Array.from(state.played)).toEqual([campaignFingerprint(notice)])
  })

  test('two new notices are shown one after the other, then the slot goes quiet', () => {
    const second: AdContent = { id: 'n2', kind: 'notice', priority: 5, title: 'Second', body: 'also new' }
    const state = createAdSlotState([notice, second], { premium: true })
    triggerAdSlot(state, T0)
    const seen: string[] = []
    for (let t = T0; t < T0 + AD_STEADY_MS * 4; t += 250) {
      const content = tickAdSlot(state, t).content
      if (content && seen[seen.length - 1] !== content.id) seen.push(content.id)
    }
    expect(seen).toEqual(['n1', 'n2'])
    expect(tickAdSlot(state, T0 + AD_STEADY_MS * 4).content).toBeNull()
  })

  test('a re-trigger while showing does not restart the clock or replay', () => {
    const state = createAdSlotState([notice, ad1])
    triggerAdSlot(state, T0)
    const shownAt = state.shownAt
    // Turn ends and syncs re-trigger the slot; the item on screen must hold.
    triggerAdSlot(state, T0 + 5000)
    expect(state.currentId).toBe('n1')
    expect(state.shownAt).toBe(shownAt)

    for (let t = T0; t < T0 + 6 * AD_STEADY_MS; t += 250) tickAdSlot(state, t)
    expect(tickAdSlot(state, T0 + 6 * AD_STEADY_MS).content).toBeNull()
    // Everything has played: another trigger stays quiet instead of starting over.
    expect(triggerAdSlot(state, T0 + 7 * AD_STEADY_MS)).toBeNull()
    expect(tickAdSlot(state, T0 + 7 * AD_STEADY_MS).content).toBeNull()
  })

  test('an ad plays once after the notice, then the slot goes quiet', () => {
    const state = createAdSlotState([notice, ad1])
    expect(state.ads.map(a => a.id)).toEqual(['a1'])
    triggerAdSlot(state, T0)
    const seen: string[] = []
    for (let t = T0; t < T0 + 6 * AD_STEADY_MS; t += 250) {
      const content = tickAdSlot(state, t).content
      if (content && seen[seen.length - 1] !== content.id) seen.push(content.id)
    }
    expect(seen).toEqual(['n1', 'a1'])
    expect(tickAdSlot(state, T0 + 6 * AD_STEADY_MS).content).toBeNull()
  })

  test('shown copy is skipped for a free account too', () => {
    const state = createAdSlotState([notice], { played: [campaignFingerprint(notice)] })
    expect(triggerAdSlot(state, T0)).toBeNull()
    expect(tickAdSlot(state, T0 + 1000).content).toBeNull()
  })
})

describe('premium re-trigger', () => {
  test('a retired notice does not come back when the slot is re-triggered', () => {
    // Reachable on every 15s sync: reloadCloudContent and syncCloudNow both
    // re-trigger the slot.
    const state = createAdSlotState([notice], { premium: true })
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0 + 1000)
    expect(tickAdSlot(state, T0 + AD_STEADY_MS + 1).content).toBeNull()

    expect(triggerAdSlot(state, T0 + AD_STEADY_MS + 2)).toBeNull()
    expect(tickAdSlot(state, T0 + AD_STEADY_MS + 3).content).toBeNull()
  })

  test('a free account still resumes its rotation on re-trigger', () => {
    const state = createAdSlotState([notice, ad1])
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0 + 1000)
    expect(triggerAdSlot(state, T0 + AD_STEADY_MS + 2)).not.toBeNull()
  })
})

describe('premium mid-session refresh', () => {
  // Mirrors reloadCloudContent: fresh catalog, runtime state carried across.
  function refresh(state: ReturnType<typeof createAdSlotState>, fresh: AdContent[]) {
    const keep = {
      triggered: state.triggered,
      currentId: state.currentId,
      shownAt: state.shownAt,
      rotationDueAt: state.rotationDueAt,
      queuedId: state.queuedId,
      played: state.played,
    }
    Object.assign(
      state,
      createAdSlotState(fresh, { premium: true, played: state.played }),
      keep,
    )
    return state
  }

  test('unchanged copy is not replayed by the 15s sync', () => {
    const state = createAdSlotState([notice], { premium: true })
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0 + 1000)
    tickAdSlot(state, T0 + AD_STEADY_MS + 1)

    refresh(state, [notice])
    triggerAdSlot(state, T0 + AD_STEADY_MS + 2)
    expect(tickAdSlot(state, T0 + AD_STEADY_MS + 3).content).toBeNull()
  })

  test('edited copy is announced without waiting for a rotation', () => {
    const state = createAdSlotState([notice], { premium: true })
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0 + 1000)
    tickAdSlot(state, T0 + AD_STEADY_MS + 1)
    expect(tickAdSlot(state, T0 + AD_STEADY_MS + 2).content).toBeNull()

    const edited = { ...notice, body: 'fast inference — extended through Sep 10' }
    refresh(state, [edited])
    const shown = tickAdSlot(state, T0 + AD_STEADY_MS + 3)
    expect(shown.content?.id).toBe('n1')
    expect(shown.content?.body).toContain('Sep 10')
  })

  test('a brand new notice arriving mid-session is announced', () => {
    const state = createAdSlotState([notice], { premium: true })
    triggerAdSlot(state, T0)
    tickAdSlot(state, T0 + 1000)
    tickAdSlot(state, T0 + AD_STEADY_MS + 1)

    const second: AdContent = { id: 'n2', kind: 'notice', priority: 5, title: 'Second', body: 'brand new' }
    refresh(state, [notice, second])
    expect(tickAdSlot(state, T0 + AD_STEADY_MS + 3).content?.id).toBe('n2')
  })

  test('an edit that arrives while the notice is still showing does not restart it', () => {
    const state = createAdSlotState([notice], { premium: true })
    triggerAdSlot(state, T0)
    expect(tickAdSlot(state, T0 + 1000).content?.id).toBe('n1')

    const edited = { ...notice, body: 'fast inference — now cheaper' }
    refresh(state, [edited])
    const still = tickAdSlot(state, T0 + 2000)
    expect(still.content?.id).toBe('n1')
    expect(still.phase).not.toBe('gone')
  })

  test('ads still never appear on a refresh', () => {
    const state = createAdSlotState([notice], { premium: true })
    triggerAdSlot(state, T0)
    refresh(state, [notice, ad1, ad2])
    expect(state.ads).toEqual([])
  })
})
