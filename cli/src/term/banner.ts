import { existsSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'
import { renderSkillStartupLines, skillListView } from '../commands/skill.js'
import type { SkillListView } from '../commands/skill/render.js'
import type { ConfigInfo } from '../native/index.js'
import { getTheme } from '../render/theme/index.js'
import { inlineItemLines, sectionHeaderLines, SECTION_MUTED } from '../render/section.js'
import { wrapTextWithAnsi } from '../render/wrap.js'

const MUTED = SECTION_MUTED
const LOGO_MIN_COLUMNS = 50
const PROMPT_RESERVED_ROWS = 5
const PROJECT_CONTEXT_FILES = ['EVOT.md', 'CLAUDE.md', 'AGENTS.md']
const LOGO_SHADOW_CHARS = new Set(['╚', '═', '╝', '║', '╔', '╗', '╠', '╣', '╦', '╩', '╬'])
const EVOT_LOGO = [
  ' ███████╗██╗   ██╗ ██████╗ ████████╗',
  ' ██╔════╝██║   ██║██╔═══██╗╚══██╔══╝',
  ' █████╗  ██║   ██║██║   ██║   ██║   ',
  ' ██╔══╝  ╚██╗ ██╔╝██║   ██║   ██║   ',
  ' ███████╗ ╚████╔╝ ╚██████╔╝   ██║   ',
  ' ╚══════╝  ╚═══╝   ╚═════╝    ╚═╝   ',
]

function getContextFiles(cwd: string): string[] {
  return PROJECT_CONTEXT_FILES.filter(name => existsSync(join(cwd, name)))
}

function renderLogoLine(line: string): string {
  const theme = getTheme()
  const spans: string[] = []
  let run = ''
  let shadow = false

  const flush = () => {
    if (!run) return
    spans.push((shadow ? theme.accentBold : theme.brandBold).paint(run))
    run = ''
  }

  for (const char of line.trimEnd()) {
    const nextShadow = LOGO_SHADOW_CHARS.has(char)
    if (run && nextShadow !== shadow) flush()
    shadow = nextShadow
    run += char
  }
  flush()
  return spans.join('')
}

function renderLogo(version: string): string[] {
  return [
    ...EVOT_LOGO.map(renderLogoLine),
    `  ${chalk.dim(`v${version}`)}`,
  ]
}

function renderSection(title: string, values: string[], columns: number): string[] {
  if (values.length === 0) return []
  return [
    ...sectionHeaderLines(title, columns),
    ...inlineItemLines(values.map(value => chalk.hex(MUTED)(value)), columns),
  ]
}

/**
 * The `[Skills]` block.
 *
 * Pre-styled, unlike `renderSection`: the summary carries its own brand-hued
 * unit names, and re-tinting the whole line would flatten it back to the flat
 * gray comma list this replaced.
 */
function renderSkillSection(view: SkillListView, columns: number): string[] {
  if (view.units.length === 0) return []

  return renderSkillStartupLines(view, columns)
}

function appendBlock(lines: string[], block: string[]): void {
  if (block.length === 0) return
  if (lines.length > 0) lines.push('')
  lines.push(...block)
}

function wrapBannerLines(lines: string[], columns: number): string[] {
  const width = Math.max(1, columns)
  return lines.flatMap(line => wrapTextWithAnsi(line, width))
}

export interface BannerOptions {
  version: string
  model: string
  cwd: string
  configInfo: ConfigInfo | undefined
  columns: number
  rows?: number
  serverState?: { port: number; address: string; channels: string[] } | null
  quiet?: boolean
  /** Release notes to show after an update (What's New) */
  releaseNotes?: string[] | null
  /** Install bookkeeping mismatch worth surfacing (see update/state.ts). */
  installDrift?: string | null
  /** Non-fatal startup diagnostic from the agent (e.g. an ignored `--model`). */
  startupWarning?: string | null
  /** Fully resolved, ordered skill directories from the agent. */
  skillsDirs?: string[]
}

export interface BannerData {
  contextFiles: string[]
  skills: SkillListView
}

/** Disk discovery belongs to refresh events, not the frame-building path. */
export function loadBannerData(cwd: string, skillsDirs?: string[]): BannerData {
  return { contextFiles: getContextFiles(cwd), skills: skillListView(skillsDirs) }
}

export function renderBanner(opts: BannerOptions, data?: BannerData): string {
  if (opts.quiet) return ''

  const {
    version,
    cwd,
    configInfo,
    columns,
    rows = Number.POSITIVE_INFINITY,
    serverState,
    releaseNotes,
    installDrift,
    startupWarning,
    skillsDirs,
  } = opts

  const snapshot = data ?? loadBannerData(cwd, skillsDirs)
  const detailLines: string[] = []
  appendBlock(detailLines, renderSection('Context', snapshot.contextFiles, columns))
  appendBlock(detailLines, renderSkillSection(snapshot.skills, columns))
  if (serverState) {
    appendBlock(detailLines, renderSection('Dashboard', [serverState.address], columns))
  }

  if (detailLines.length > 0) detailLines.push('')
  detailLines.push(chalk.dim('  Esc interrupt  ·  / commands  ·  Ctrl+O expand  ·  Ctrl+D exit'))

  if (releaseNotes && releaseNotes.length > 0) {
    detailLines.push('')
    detailLines.push(chalk.bold.hex('#8abeb7')("  What's New:"))
    for (const note of releaseNotes) {
      detailLines.push(chalk.hex(MUTED)(`    • ${note}`))
    }
  }

  if (configInfo && !configInfo.hasApiKey) {
    detailLines.push('')
    detailLines.push(chalk.hex('#ffff00')('  ⚠ Not logged in — /login for cloud models, or add a key on the Models page'))
    const base = serverState?.address?.replace(/\/+$/, '')
    if (base) detailLines.push(chalk.hex(MUTED)(`    ${base}/models`))
  }

  if (installDrift) {
    detailLines.push('')
    detailLines.push(chalk.hex('#ffff00')(`  ⚠ Install mismatch: ${installDrift}`))
    detailLines.push(chalk.hex(MUTED)('    run /update to reinstall'))
  }

  if (startupWarning) {
    detailLines.push('')
    detailLines.push(chalk.hex('#ffff00')(`  ⚠ ${startupWarning}`))
    detailLines.push(chalk.hex(MUTED)('    pick another with /model, or drop --model'))
  }

  const fullBannerLines = wrapBannerLines(
    [...renderLogo(version), '', ...detailLines, ''],
    columns,
  )
  const showLogo = columns >= LOGO_MIN_COLUMNS &&
    fullBannerLines.length + PROMPT_RESERVED_ROWS <= rows
  const brandLines = showLogo
    ? renderLogo(version)
    : [`  ${getTheme().brandBold.paint('evot')} ${chalk.dim(`v${version}`)}`]

  return wrapBannerLines([...brandLines, '', ...detailLines, ''], columns).join('\n')
}
