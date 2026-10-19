import { getTheme } from '../../render/theme/index.js'
import type { StyledSpan, ViewBlock } from './types.js'
import { joinLeftRight, spansWidth } from './width.js'

export interface UpdateNoticeInput {
  status: string
  version: string | null
  availableVersion: string | null
  visible: boolean
  busy: boolean
}

export function updateNoticeSpans(input: UpdateNoticeInput): StyledSpan[] | null {
  if (!input.visible) return null
  if (input.status === 'staged' && input.version) return [
    { text: '✔ ', hex: getTheme().brandHex },
    { text: `Update ready v${input.version}`, hex: getTheme().brandHex },
    { text: ' · /restart to apply', dim: true },
  ]
  if (input.status === 'downloading' && input.version) return [{ text: `⬇ Auto-updating to v${input.version}…`, dim: true }]
  if (input.status === 'idle' && input.availableVersion && !input.busy) return [
    { text: `↑ evot v${input.availableVersion} available`, dim: true },
    { text: ' — run /update', dim: true },
  ]
  return null
}

/** Inline status retains its row count; narrow widths use the shared layout. */
export function attachUpdateNotice(status: ViewBlock, notice: StyledSpan[], columns: number): ViewBlock {
  const last = status.lines.length - 1
  return {
    ...status,
    lines: [...status.lines.slice(0, last), { spans: joinLeftRight(status.lines[last]?.spans ?? [], notice, columns) }],
  }
}

export function standaloneUpdateNotice(notice: StyledSpan[], columns: number, hasContentAbove: boolean): ViewBlock {
  const pad = Math.max(0, columns - spansWidth(notice))
  return { lines: [{ spans: [{ text: ' '.repeat(pad) }, ...notice] }], marginTop: hasContentAbove ? 0 : 1 }
}
