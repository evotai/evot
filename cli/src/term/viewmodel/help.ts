import { backgroundChordLabel } from '../../ui/key-hints.js'
import { overlaySize } from '../../ui/overlay-size.js'
import { visibleWidth, wrapTextWithAnsi } from '../../ui/wrap.js'
import { truncateToWidth } from './width.js'
import { selectorHints } from './selector-chrome.js'
import { line, block, plain, dim, bold, colored, styledLineToAnsi, type StyledLine, type ViewBlock } from './types.js'

const INDENT = 2
const KEY_GAP = 2

type Entry = [key: string, description: string]

const KEYS: Entry[] = [
  ['Enter', 'Send now / steer the active task'],
  ['Alt+Enter', 'Insert newline'],
  ['Ctrl+C', 'Clear / Exit (×2)'],
  ['Esc', 'Dismiss / Pull back pending prompt / Clear input / Interrupt (×2)'],
  [backgroundChordLabel(), 'Run in background, keeping the work alive'],
  ['Ctrl+G', 'Manage pending prompts / explicitly resume paused work'],
  ['↓ / Ctrl+T', 'Background task panel when shells are running'],
  ['↑ / ↓', 'History navigation / multi-line'],
  ['Tab', 'Complete locally / send draft after the running turn'],
  ['Ctrl+N', 'Request / cycle AI input assistance'],
  ['Ctrl+Z', 'Suspend to shell; fg resumes (Unix)'],
  ['Shift+Tab', 'Cycle thinking level for the next model request'],
  ['Ctrl+O', 'Expand/collapse output'],
  ['Ctrl+Y', 'Copy last reply (Markdown source) to clipboard'],
  ['Ctrl+U', 'Clear line before cursor'],
  ['Ctrl+K', 'Clear line after cursor'],
  ['Ctrl+W', 'Delete word before cursor'],
  ['Ctrl+D', 'Delete char / Exit if empty'],
  ['Ctrl+A/E', 'Move to start/end of line'],
  ['Ctrl+L', 'Clear all input'],
]

const COMMANDS: Entry[] = [
  ['/help', 'Show this help'],
  ['/model <name>', 'Switch model'],
  ['/resume, /sessions', 'Resume session or find one by description'],
  ['/remote on', 'Turn on Remote and show its QR code; /remote also works'],
  ['/remote off', 'Turn off Remote for this profile and stop automatic takeover'],
  ['/remote hide', 'Hide only this window; /remote on shows it again'],
  ['/remote devices', 'List approved devices and their revoke commands'],
  ['/new', 'Start new session'],
  ['/compact', 'Compact session context'],
  ['/clear', 'Clear session context'],
  ['/env', 'Manage variables'],
  ['/skill', 'Manage skills'],
  ['/clip [all|copy]', 'Clip last reply to vault; all = distill; copy = clipboard'],
  ['/share [public|team|private|off]', 'List shared sessions; public/team/private shares this session'],
  ['/login', 'Log in to evot cloud'],
  ['/logout', 'Log out of evot cloud'],
  ['/version', 'Show current version'],
  ['/exit', 'Exit'],
]

/** Two-column table; each section aligns its own description column, so the
 *  one long `/share` signature does not push every keyboard row apart. */
function section(title: string, entries: Entry[]): StyledLine[] {
  const keyWidth = Math.max(...entries.map(([key]) => key.length))
  return [
    line(dim(`${' '.repeat(INDENT)}${title}`)),
    ...entries.map(([key, description]) => line(
      colored(`${' '.repeat(INDENT)}${key.padEnd(keyWidth + KEY_GAP)}`, 'cyan'),
      dim(description),
    )),
  ]
}

function sectionWidth(entries: Entry[]): number {
  const keyWidth = Math.max(...entries.map(([key]) => key.length))
  return INDENT + keyWidth + KEY_GAP + Math.max(...entries.map(([, description]) => description.length))
}

const TITLE = 'Keyboard Shortcuts & Commands'
const TABLE_WIDTH = Math.max(sectionWidth(KEYS), sectionWidth(COMMANDS))

function helpBody(): StyledLine[] {
  return [...section('Keys', KEYS), line(plain('')), ...section('Commands', COMMANDS)]
}

function centred(row: StyledLine, width: number): StyledLine {
  const cells = visibleWidth(row.spans.map(span => span.text).join(''))
  return line(plain(' '.repeat(Math.max(0, Math.floor((width - cells) / 2)))), ...row.spans)
}

export function buildHelpBlocks(columns: number): ViewBlock[] {
  const footer = selectorHints([{ keys: 'escape', action: 'close' }], Math.max(1, columns - INDENT))
  return [block([
    centred(line(bold(TITLE)), TABLE_WIDTH), line(plain('')), ...helpBody(), line(plain('')),
    ...footer.map(row => centred(row, TABLE_WIDTH)),
  ], 1)]
}

/** Page physical rows, not bindings: a description can wrap several times in tmux. */
export function buildHelpPage(columns: number, rows: number, requested = 0) {
  const { width, height } = overlaySize(columns, rows)
  const body = helpBody().flatMap(row => wrapTextWithAnsi(styledLineToAnsi(row), width))
  const room = Math.max(1, height - 2) // title and navigation, when there is room
  const count = Math.ceil(body.length / room)
  const page = Math.max(0, Math.min(requested, count - 1))
  const lines = body.slice(page * room, (page + 1) * room)
  // Keep the header and navigation on the same screen rows on the last page.
  if (count > 1) while (lines.length < room) lines.push('')
  const blockWidth = Math.min(width, TABLE_WIDTH)
  if (height >= 3) lines.unshift(styledLineToAnsi(centred(line(bold(truncateToWidth(TITLE, width))), blockWidth)))
  if (height >= 2) {
    const hint = count > 1 ? `${page + 1}/${count}  ↑↓ page  esc close` : 'esc close'
    lines.push(styledLineToAnsi(centred(line(dim(truncateToWidth(hint, width))), blockWidth)))
  }
  return { lines, page, count }
}
