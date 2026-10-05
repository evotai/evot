/**
 * The status line below the prompt editor.
 *
 * Everything on this line is optional except the working directory. Terminals
 * get narrow, so the footer picks the first layout in a fixed priority order
 * that fits the available columns, dropping detail rather than wrapping or
 * overflowing.
 */

import stringWidth from 'string-width'
import { confirmationHint } from './confirmation-hint.js'
import { line, block, plain, dim, colored, type ViewBlock, type StyledLine, type StyledSpan } from './types.js'
import { finiteSize, spansWidth, truncateTailToWidth, truncateToWidth } from './width.js'
import { BACKGROUND_PANEL_HINT_CHORD } from '../app/background-panel.js'
import { FORK_GLYPH, formatForkTrail } from './fork-trail.js'

/** The subset of prompt state the footer reads. */
export interface PromptFooterVM {
  columns: number
  model: string
  provider: string
  thinkingLevel: string
  planning: boolean
  logMode: boolean
  dashboardUrl: string | null
  cwd: string
  /** Fork ancestry titles, root → current; empty or absent for non-forks. */
  forkTrail?: string[]
  /** `☁` / `🌐` while the session is on the cloud; leads the location. */
  cloudBadge?: string
  gitBranch: string | null
  contextTokens: number
  contextWindow: number
  /** Judge model the catalog publishes; set = judge-driven context pruning
   *  is on. Shown as a badge so the user knows the context is being pruned,
   *  not only summarised. */
  judge?: string
  backgroundProcessCount: number
  backgroundStopHint?: string
  backgroundStopPending?: boolean
  /**
   * True when ↓ at the prompt opens the background panel.
   *
   * The chip names the gesture that works at this moment: ↓ is only wired up on
   * an empty composer, so advertising it mid-sentence would be a lie.
   */
  backgroundPanelDownAvailable: boolean
}

export interface PromptFooterOptions {
  /**
   * True when the composer border above already names the input mode. The
   * footer then drops its `[plan]` prefix rather than repeating the same word
   * two rows apart. It stays authoritative whenever nothing above it carries
   * the mode: overlays replace the composer, and short terminals drop the
   * border entirely.
   */
  modeShownAbove?: boolean
}

export function buildPromptFooterBlocks(
  input: PromptFooterVM,
  options: PromptFooterOptions = {},
): ViewBlock[] {
  const blocks: ViewBlock[] = []
  const chip = buildBackgroundChip(
    input.backgroundProcessCount,
    input.backgroundPanelDownAvailable,
    finiteSize(input.columns, 80),
    input.backgroundStopHint,
    input.backgroundStopPending,
  )
  if (chip) blocks.push(block([chip]))
  blocks.push(buildFooter(input, finiteSize(input.columns, 80), options.modeShownAbove ?? false))
  const trail = buildForkTrail(input.forkTrail ?? [], finiteSize(input.columns, 80))
  if (trail) blocks.push(block([trail]))
  blocks.push(block([line(plain(''))]))
  return blocks
}

/**
 * The fork row under the status line: `└─ fork of <parent>`.
 *
 * It only exists for forked sessions and says just two things: this is a
 * fork, and what it hangs off. The edge glyph is the one the `/sessions`
 * graph uses, so the row reads in the same language as the tree there.
 */
function buildForkTrail(trail: readonly string[], columns: number): StyledLine | null {
  const prefix = `${FORK_GLYPH} `
  const text = formatForkTrail(trail, Math.max(1, columns - stringWidth(prefix)))
  if (!text) return null
  return line(colored(FORK_GLYPH, 'cyan'), dim(` ${text}`))
}

/**
 * The background-work chip above the footer.
 *
 * The count is the actionable part, so it carries the colour while the gesture
 * stays dim: the line is a pointer to the panel, not a status report.
 *
 * The label names the background because that is what the count means: it comes
 * from `runningCount()`, which counts only `RunningBackground` shells. A bare
 * "1 shell running" left the user to guess whether it referred to the command
 * they were watching in the foreground.
 *
 * ↓ is advertised whenever it is live, because it sits one key away from the
 * cursor. With text in the composer ↓ still moves the caret, so the chip falls
 * back to the count alone. Ctrl+T remains an unadvertised alternate shortcut.
 *
 * Narrowing sheds words in order of expendability: the gesture first, then the
 * word "background", and only then characters. Truncating the long label
 * directly produced "…ound shells running", which drops the count — the one
 * part of the line that is actionable.
 */
function buildBackgroundChip(
  count: number,
  downAvailable: boolean,
  columns: number,
  stopHint?: string,
  stopPending = false,
): StyledLine | null {
  if (count <= 0) return null
  const noun = count === 1 ? 'shell' : 'shells'
  const label = `${count} background ${noun} running`
  const shortLabel = `${count} ${noun} running`
  const hint = `${BACKGROUND_PANEL_HINT_CHORD} to manage`
  if (stopHint) {
    const manage = downAvailable ? ` · ${hint}` : ''
    const full = `${label} · ${stopHint}${manage}`
    const compact = `${count} bg · ${stopHint}`
    const text = stringWidth(full) <= columns ? full : stringWidth(`${label} · ${stopHint}`) <= columns
      ? `${label} · ${stopHint}` : compact
    const clipped = truncateToWidth(text, columns)
    const start = clipped.indexOf(stopHint)
    if (start < 0) return line(confirmationHint(truncateToWidth(stopHint, columns), stopPending))
    return line(
      colored(clipped.slice(0, start), 'cyan'),
      confirmationHint(stopHint, stopPending),
      dim(clipped.slice(start + stopHint.length)),
    )
  }
  if (downAvailable && stringWidth(`${label} · ${hint}`) <= columns) {
    return line(colored(label, 'cyan'), dim(' · '), dim(hint))
  }
  if (stringWidth(label) <= columns) return line(colored(label, 'cyan'))
  if (stringWidth(shortLabel) <= columns) return line(colored(shortLabel, 'cyan'))
  return line(colored(truncateTailToWidth(shortLabel, columns), 'cyan'))
}

function buildFooter(input: PromptFooterVM, columns: number, modeShownAbove: boolean): ViewBlock {
  const cloud = input.cloudBadge ? `${input.cloudBadge} ` : ''
  const modeWords = modeShownAbove
    ? ''
    : `${input.logMode ? '[log] ' : ''}${input.planning ? '[plan] ' : ''}`
  const mode = `${cloud}${modeWords}`
  const cwd = compactCwd(input.cwd)
  const contextPercent = input.contextWindow > 0
    ? input.contextTokens / input.contextWindow * 100
    : 0

  for (const layout of FOOTER_LAYOUTS) {
    const candidate = buildFooterCandidate(input, mode, cwd, contextPercent, layout, columns)
    if (footerCandidateWidth(candidate) <= columns) return block([renderFooterCandidate(candidate, columns)])
  }

  return block([line(dim(truncateTailToWidth(`${mode}${cwd}`, columns)))])
}

type FooterContextDetail = 'full' | 'compact' | 'hidden'

interface FooterLayout {
  dashboard: 'full' | 'port' | false
  context: FooterContextDetail
  branch: boolean
  thinking: boolean
  model: boolean
  truncateCwd: boolean
}

/** Widest first: the first entry that fits wins, so detail sheds in this order. */
const FOOTER_LAYOUTS: FooterLayout[] = [
  { dashboard: 'full', context: 'full', branch: true, thinking: true, model: true, truncateCwd: false },
  { dashboard: 'port', context: 'full', branch: true, thinking: true, model: true, truncateCwd: false },
  { dashboard: 'port', context: 'compact', branch: true, thinking: true, model: true, truncateCwd: false },
  { dashboard: 'port', context: 'compact', branch: false, thinking: true, model: true, truncateCwd: true },
  { dashboard: 'port', context: 'hidden', branch: false, thinking: true, model: true, truncateCwd: true },
  { dashboard: 'port', context: 'hidden', branch: false, thinking: false, model: true, truncateCwd: true },
  { dashboard: 'port', context: 'hidden', branch: false, thinking: false, model: false, truncateCwd: true },
  { dashboard: false, context: 'hidden', branch: false, thinking: false, model: false, truncateCwd: true },
]

interface FooterCandidate {
  left: StyledSpan[]
  dashboard: StyledSpan[] | null
}

function buildFooterCandidate(
  input: PromptFooterVM,
  mode: string,
  cwd: string,
  contextPercent: number,
  layout: FooterLayout,
  columns: number,
): FooterCandidate {
  const dashboard = layout.dashboard && input.dashboardUrl
    ? [
        { text: 'dashboard ', dim: true } satisfies StyledSpan,
        { text: layout.dashboard === 'port' ? dashboardPort(input.dashboardUrl) : input.dashboardUrl, dim: true, link: input.dashboardUrl } satisfies StyledSpan,
      ]
    : null

  const buildLeft = (location: string): StyledSpan[] => {
    const groups: StyledSpan[][] = [[dim(location)]]
    if (layout.model && input.model) {
      const identity: StyledSpan[] = [dim(input.model)]
      if (layout.thinking && input.thinkingLevel) {
        const thinking = input.thinkingLevel === 'off' ? 'thinking off' : input.thinkingLevel
        identity.push(dim(` • ${thinking}`))
      }
      groups.push(identity)
    }
    if (layout.context !== 'hidden' && contextPercent > 0) {
      const warning = contextPercent > 90 ? ' ⚠' : ''
      const detail = layout.context === 'full'
        ? ` (${formatContextTokens(input.contextTokens)}/${formatContextTokens(input.contextWindow)})`
        : ''
      const text = `context: ${contextPercent.toFixed(1)}%${detail}${warning}`
      const context: StyledSpan[] = [
        contextPercent > 90
          ? colored(text, 'red')
          : contextPercent > 70
            ? colored(text, 'yellow')
            : dim(text),
      ]
      // The badge rides with the context number it acts on.
      if (input.judge) context.push(dim(' • '), colored('jev prune', 'cyan'))
      groups.push(context)
    } else if (layout.context !== 'hidden' && input.judge) {
      // Before the first call there is no context number yet; the badge still
      // tells the user the branch is on.
      groups.push([colored('jev prune', 'cyan')])
    }
    return groups.flatMap((group, index) => index === 0 ? group : [dim(' │ '), ...group])
  }

  const branch = layout.branch && input.gitBranch ? ` (${input.gitBranch})` : ''
  const fullLocation = `${mode}${cwd}${branch}`
  let left = buildLeft(fullLocation)
  let candidate = { left, dashboard }
  if (!layout.truncateCwd || footerCandidateWidth(candidate) <= columns) return candidate

  const fixedWidth = footerCandidateWidth(candidate) - stringWidth(fullLocation)
  const availableLocationWidth = Math.max(1, columns - fixedWidth)
  left = buildLeft(truncateTailToWidth(`${mode}${cwd}`, availableLocationWidth))
  candidate = { left, dashboard }
  return candidate
}

function footerCandidateWidth(candidate: FooterCandidate): number {
  const left = spansWidth(candidate.left)
  return candidate.dashboard ? left + 2 + spansWidth(candidate.dashboard) : left
}

function renderFooterCandidate(candidate: FooterCandidate, columns: number): StyledLine {
  if (!candidate.dashboard) return line(...candidate.left)
  const padding = columns - spansWidth(candidate.left) - spansWidth(candidate.dashboard)
  return line(...candidate.left, plain(' '.repeat(Math.max(2, padding))), ...candidate.dashboard)
}

function dashboardPort(address: string): string {
  try {
    const url = new URL(address)
    return `:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return address
  }
}

function compactCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

function formatContextTokens(count: number): string {
  if (count < 1000) return `${count}`
  if (count < 1000000) {
    const k = count / 1000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
  }
  const m = count / 1000000
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
}
