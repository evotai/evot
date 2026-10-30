import { backgroundChordLabel } from '../design/key-hints.js'
import { selectorHints } from './selector-chrome.js'
import { line, block, plain, dim, bold, colored, type StyledLine, type ViewBlock } from './types.js'

const INDENT = 2
const KEY_GAP = 2

type Entry = [key: string, description: string]

const KEYS: Entry[] = [
  ['Enter', 'Submit message'],
  ['Alt+Enter', 'Insert newline'],
  ['Ctrl+C', 'Clear / Exit (×2)'],
  ['Esc', 'Clear input / Dismiss / Interrupt (×2)'],
  [backgroundChordLabel(), 'Run in background, keeping the work alive'],
  ['Ctrl+G', 'Focus queued prompts when non-empty'],
  ['↓ / Ctrl+T', 'Background task panel when shells are running'],
  ['↑ / ↓', 'History navigation / multi-line'],
  ['Tab', 'Complete command / path'],
  ['Shift+Tab', 'Cycle thinking level'],
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

/** Pure help surface: independent of selectors, ask state and terminal I/O. */
export function buildHelpBlocks(columns: number): ViewBlock[] {
  const TITLE = 'Keyboard Shortcuts & Commands'
  const blockWidth = Math.max(sectionWidth(KEYS), sectionWidth(COMMANDS), INDENT + TITLE.length)
  const centred = (width: number): string => ' '.repeat(Math.max(0, Math.floor((blockWidth - width) / 2)))
  const footer = selectorHints([{ keys: 'escape', action: 'close' }], Math.max(1, columns - INDENT))
  return [block([
    line(bold(`${centred(TITLE.length)}${TITLE}`)),
    line(plain('')),
    ...section('Keys', KEYS),
    line(plain('')),
    ...section('Commands', COMMANDS),
    line(plain('')),
    ...footer.map(row => line(plain(centred(spansLength(row))), ...row.spans)),
  ], 1)]
}

function spansLength(row: StyledLine): number {
  return row.spans.reduce((total, span) => total + span.text.length, 0)
}
