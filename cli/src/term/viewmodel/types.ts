import { getTheme } from '../../ui/theme/index.js'
import chalk from 'chalk'
import { wrapHyperlink } from '../../ui/hyperlink.js'

export interface StyledSpan {
  text: string
  fg?: 'red' | 'green' | 'yellow' | 'cyan' | 'magenta' | 'gray' | 'white'
  /** Custom foreground hex (e.g. '#8fbf8f'). Takes precedence over `fg`. */
  hex?: string
  /** Custom background hex. Rendered as truecolor SGR 48;2. */
  bg?: string
  dim?: boolean
  bold?: boolean
  inverse?: boolean
  italic?: boolean
  /** When set, the rendered span is wrapped in an OSC 8 hyperlink to this URL.
   *  `text` stays the visible label, so width math is unaffected. */
  link?: string
}

export interface StyledLine {
  spans: StyledSpan[]
  /**
   * Row fill. `styledLineToAnsi` paints it under every span and re-arms it
   * after any embedded SGR reset, so a line that carries pre-styled ANSI
   * (markdown, syntax highlight, wrapped text ending in `\x1b[0m`) still reads
   * as one continuous band. Layout code that pads to a fixed width (frame rows,
   * transcript blocks) extends the fill across the padding too.
   */
  bg?: string
}

export interface ViewBlock {
  lines: StyledLine[]
  marginTop?: number
}

/**
 * Paint `hex` behind `text`, surviving inner resets.
 *
 * chalk closes a background with `49` and every foreground style with its
 * own close code, so nested spans are safe. What is not safe is a bare
 * `\x1b[0m` (the wrap primitive emits one when it has to cut an open style at
 * a line break, and pre-rendered tool output may carry them): it drops the
 * fill for the rest of the row. Re-arm the fill after each such reset so the
 * band never has a hole. Honours chalk's colour level — at level 0 the text
 * comes back untouched.
 */
export function paintBackground(text: string, hex: string): string {
  const probe = chalk.bgHex(hex)('\u0000')
  const marker = probe.indexOf('\u0000')
  if (marker < 0) return text
  const open = probe.slice(0, marker)
  const close = probe.slice(marker + 1)
  if (!open) return text
  const rearmed = text.replace(/\x1b\[0m/g, `\x1b[0m${open}`).replace(/\x1b\[49m/g, open)
  return `${open}${rearmed}${close}`
}

export function styledLineToAnsi(line: StyledLine): string {
  const rendered = spansToAnsi(line.spans)
  return line.bg ? paintBackground(rendered, line.bg) : rendered
}

function spansToAnsi(spans: StyledSpan[]): string {
  return spans.map(span => {
    let s = span.text
    if (!s) return ''

    let result = s
    if (span.hex) {
      result = chalk.hex(span.hex)(result)
    } else if (span.fg) {
      switch (span.fg) {
        // Failure ink is themed, not the terminal's ANSI red; see `errorHex`.
        case 'red': result = chalk.hex(getTheme().errorHex)(result); break
        case 'green': result = chalk.green(result); break
        case 'yellow': result = chalk.yellow(result); break
        case 'cyan': result = chalk.cyan(result); break
        case 'magenta': result = chalk.magenta(result); break
        case 'gray': result = chalk.gray(result); break
        case 'white': result = chalk.white(result); break
      }
    }
    if (span.bold) result = chalk.bold(result)
    if (span.dim) result = chalk.hex(getTheme().mutedHex)(result)
    if (span.italic) result = chalk.italic(result)
    if (span.inverse) result = `\x1b[7m${s}\x1b[27m`
    // Background wraps last so it survives the inner foreground resets emitted
    // by the styles above, and covers the span's full cell range.
    if (span.bg) result = chalk.bgHex(span.bg)(result)
    if (span.link) result = wrapHyperlink(span.link, result)
    return result
  }).join('')
}

export function blocksToLines(blocks: ViewBlock[]): string[] {
  const result: string[] = []
  for (const block of blocks) {
    if (block.marginTop) {
      for (let i = 0; i < block.marginTop; i++) result.push('')
    }
    for (const line of block.lines) {
      const rendered = styledLineToAnsi(line)
      // Safety: if a span contains embedded newlines, split so the renderer
      // treats each physical line independently (needed for CLEAR_LINE).
      if (rendered.includes('\n') || rendered.includes('\r')) {
        for (const sub of rendered.split(/\r\n|\r|\n/)) result.push(sub)
      } else {
        result.push(rendered)
      }
    }
  }
  return result
}

export function plain(text: string): StyledSpan {
  return { text }
}

// Raw passthrough — used when `text` already contains ANSI escape sequences
// that must be preserved as-is. Identical to `plain` structurally, but
// named distinctly so call sites document the intent and don't accidentally
// wrap already-styled content in chalk (which would nest reset codes).
export function ansi(text: string): StyledSpan {
  return { text }
}

export function dim(text: string): StyledSpan {
  return { text, dim: true }
}

export function bold(text: string, fg?: StyledSpan['fg']): StyledSpan {
  return { text, bold: true, fg }
}

export function colored(text: string, fg: StyledSpan['fg'], opts?: { bold?: boolean; dim?: boolean }): StyledSpan {
  return { text, fg, bold: opts?.bold, dim: opts?.dim }
}

export function inverse(text: string): StyledSpan {
  return { text, inverse: true }
}

export function line(...spans: StyledSpan[]): StyledLine {
  return { spans }
}

export function block(lines: StyledLine[], marginTop?: number): ViewBlock {
  return { lines, marginTop }
}
