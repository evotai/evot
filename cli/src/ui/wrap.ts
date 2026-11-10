/**
 * ANSI-aware terminal wrapping — the single wrap primitive for all rendered
 * output (markdown, diffs, tool cards). Ported from pi's TUI (packages/tui).
 *
 * Design: text is kept raw and wrapped at render time to the real terminal
 * width. `wrapTextWithAnsi` word-wraps while preserving active SGR styles and
 * OSC 8 hyperlinks across line breaks; over-long tokens are broken by grapheme
 * so nothing is ever truncated. The renderer runs with auto-wrap OFF, so this
 * is the only thing standing between wide content and a hard terminal cut.
 */

import { eastAsianWidth } from 'get-east-asian-width'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v

// CJK scripts wrap per-grapheme (no inter-character spaces), so each such
// grapheme is treated as its own break opportunity.
const cjkBreakRegex =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u

const WIDTH_CACHE_SIZE = 512
const widthCache = new Map<string, number>()

function isPrintableAscii(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

function couldBeEmoji(segment: string): boolean {
  const cp = segment.codePointAt(0)!
  return (
    (cp >= 0x1f000 && cp <= 0x1fbff) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b50 && cp <= 0x2b55) ||
    segment.includes('\uFE0F') ||
    segment.length > 2
  )
}

function graphemeWidth(segment: string): number {
  if (segment === '\t') return 3
  if (zeroWidthRegex.test(segment)) return 0
  if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) return 2

  const base = segment.replace(leadingNonPrintingRegex, '')
  const cp = base.codePointAt(0)
  if (cp === undefined) return 0
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2

  let width = eastAsianWidth(cp)
  if (segment.length > 1) {
    for (const char of segment.slice(1)) {
      const c = char.codePointAt(0)!
      if (c >= 0xff00 && c <= 0xffef) width += eastAsianWidth(c)
      else if (c === 0x0e33 || c === 0x0eb3) width += 1
    }
  }
  return width
}

/** Visible width of a string in terminal columns (ANSI/OSC/APC stripped). */
export function visibleWidth(str: string): number {
  if (str.length === 0) return 0
  if (isPrintableAscii(str)) return str.length

  const cached = widthCache.get(str)
  if (cached !== undefined) return cached

  let clean = str
  if (str.includes('\t')) clean = clean.replace(/\t/g, '   ')
  if (clean.includes('\x1b')) {
    let stripped = ''
    let i = 0
    while (i < clean.length) {
      const ansi = extractAnsiCode(clean, i)
      if (ansi) {
        i += ansi.length
        continue
      }
      stripped += clean[i]
      i++
    }
    clean = stripped
  }

  let width = 0
  for (const { segment } of graphemeSegmenter.segment(clean)) {
    width += graphemeWidth(segment)
  }

  if (widthCache.size >= WIDTH_CACHE_SIZE) {
    const firstKey = widthCache.keys().next().value
    if (firstKey !== undefined) widthCache.delete(firstKey)
  }
  widthCache.set(str, width)
  return width
}

export function normalizeTerminalOutput(str: string): string {
  let normalized = str
  if (/[\u0e33\u0eb3]/.test(normalized)) {
    normalized = normalized.replace(/[\u0e33\u0eb3]/g, char =>
      char === '\u0e33' ? '\u0e4d\u0e32' : '\u0ecd\u0eb2')
  }
  if (!normalized.includes('\t')) return normalized

  let result = ''
  let i = 0
  while (i < normalized.length) {
    const ansi = extractAnsiCode(normalized, i)
    if (ansi) {
      result += ansi.code
      i += ansi.length
      continue
    }
    result += normalized[i] === '\t' ? '   ' : normalized[i]
    i++
  }
  return result
}

/** Extract an ANSI/OSC/APC escape sequence starting at `pos`, or null. */
function extractAnsiCode(str: string, pos: number): { code: string, length: number } | null {
  if (pos >= str.length || str[pos] !== '\x1b') return null
  const next = str[pos + 1]

  // CSI: ESC [ ... final byte (m/G/K/H/J)
  if (next === '[') {
    let j = pos + 2
    while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++
    if (j < str.length) return { code: str.substring(pos, j + 1), length: j + 1 - pos }
    return null
  }

  // OSC (hyperlinks, titles) / APC (cursor marker): ESC ]/_  ... BEL or ESC \
  if (next === ']' || next === '_') {
    let j = pos + 2
    while (j < str.length) {
      if (str[j] === '\x07') return { code: str.substring(pos, j + 1), length: j + 1 - pos }
      if (str[j] === '\x1b' && str[j + 1] === '\\') return { code: str.substring(pos, j + 2), length: j + 2 - pos }
      j++
    }
    return null
  }

  return null
}

type Osc8Terminator = '\x07' | '\x1b\\'

interface ActiveHyperlink {
  params: string
  url: string
  terminator: Osc8Terminator
}

function parseOsc8Hyperlink(ansiCode: string): ActiveHyperlink | null | undefined {
  if (!ansiCode.startsWith('\x1b]8;')) return undefined
  const terminator: Osc8Terminator = ansiCode.endsWith('\x07') ? '\x07' : '\x1b\\'
  const body = ansiCode.slice(4, terminator === '\x07' ? -1 : -2)
  const separatorIndex = body.indexOf(';')
  if (separatorIndex === -1) return undefined
  const params = body.slice(0, separatorIndex)
  const url = body.slice(separatorIndex + 1)
  if (!url) return null
  return { params, url, terminator }
}

function formatOsc8Hyperlink(link: ActiveHyperlink): string {
  return `\x1b]8;${link.params};${link.url}${link.terminator}`
}

function formatOsc8Close(terminator: Osc8Terminator): string {
  return `\x1b]8;;${terminator}`
}

/** Tracks active SGR codes + OSC 8 hyperlink so styling survives line breaks. */
class AnsiCodeTracker {
  private bold = false
  private dim = false
  private italic = false
  private underline = false
  private blink = false
  private inverse = false
  private hidden = false
  private strikethrough = false
  private fgColor: string | null = null
  private bgColor: string | null = null
  private activeHyperlink: ActiveHyperlink | null = null

  process(ansiCode: string): void {
    const hyperlink = parseOsc8Hyperlink(ansiCode)
    if (hyperlink !== undefined) {
      this.activeHyperlink = hyperlink
      return
    }
    if (!ansiCode.endsWith('m')) return

    const match = ansiCode.match(/\x1b\[([\d;]*)m/)
    if (!match) return
    const params = match[1]
    if (params === '' || params === '0') {
      this.reset()
      return
    }

    const parts = params!.split(';')
    let i = 0
    while (i < parts.length) {
      const code = Number.parseInt(parts[i]!, 10)
      if (code === 38 || code === 48) {
        if (parts[i + 1] === '5' && parts[i + 2] !== undefined) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`
          if (code === 38) this.fgColor = colorCode
          else this.bgColor = colorCode
          i += 3
          continue
        } else if (parts[i + 1] === '2' && parts[i + 4] !== undefined) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`
          if (code === 38) this.fgColor = colorCode
          else this.bgColor = colorCode
          i += 5
          continue
        }
      }
      switch (code) {
        case 0: this.reset(); break
        case 1: this.bold = true; break
        case 2: this.dim = true; break
        case 3: this.italic = true; break
        case 4: this.underline = true; break
        case 5: this.blink = true; break
        case 7: this.inverse = true; break
        case 8: this.hidden = true; break
        case 9: this.strikethrough = true; break
        case 21: this.bold = false; break
        case 22: this.bold = false; this.dim = false; break
        case 23: this.italic = false; break
        case 24: this.underline = false; break
        case 25: this.blink = false; break
        case 27: this.inverse = false; break
        case 28: this.hidden = false; break
        case 29: this.strikethrough = false; break
        case 39: this.fgColor = null; break
        case 49: this.bgColor = null; break
        default:
          if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.fgColor = String(code)
          else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.bgColor = String(code)
          break
      }
      i++
    }
  }

  private reset(): void {
    this.bold = false
    this.dim = false
    this.italic = false
    this.underline = false
    this.blink = false
    this.inverse = false
    this.hidden = false
    this.strikethrough = false
    this.fgColor = null
    this.bgColor = null
  }

  getActiveCodes(): string {
    const codes: string[] = []
    if (this.bold) codes.push('1')
    if (this.dim) codes.push('2')
    if (this.italic) codes.push('3')
    if (this.underline) codes.push('4')
    if (this.blink) codes.push('5')
    if (this.inverse) codes.push('7')
    if (this.hidden) codes.push('8')
    if (this.strikethrough) codes.push('9')
    if (this.fgColor) codes.push(this.fgColor)
    if (this.bgColor) codes.push(this.bgColor)
    let result = codes.length > 0 ? `\x1b[${codes.join(';')}m` : ''
    if (this.activeHyperlink) result += formatOsc8Hyperlink(this.activeHyperlink)
    return result
  }

  /** Reset codes to emit at line end: close underline + hyperlink so styling
   *  doesn't bleed into padding. Both are re-opened via getActiveCodes(). */
  getLineEndReset(): string {
    let result = ''
    if (this.underline) result += '\x1b[24m'
    if (this.activeHyperlink) result += formatOsc8Close(this.activeHyperlink.terminator)
    return result
  }
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
  let i = 0
  while (i < text.length) {
    const ansiResult = extractAnsiCode(text, i)
    if (ansiResult) {
      tracker.process(ansiResult.code)
      i += ansiResult.length
    } else {
      i++
    }
  }
}

/** Split text into word/space tokens, keeping ANSI codes attached to the next
 *  visible character. CJK graphemes become standalone tokens (per-char wrap). */
function splitIntoTokensWithAnsi(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let pendingAnsi = ''
  let currentKind: 'space' | 'word' | null = null
  let i = 0

  const flushCurrent = (): void => {
    if (!current) return
    tokens.push(current)
    current = ''
    currentKind = null
  }

  while (i < text.length) {
    const ansiResult = extractAnsiCode(text, i)
    if (ansiResult) {
      pendingAnsi += ansiResult.code
      i += ansiResult.length
      continue
    }

    let end = i
    while (end < text.length && !extractAnsiCode(text, end)) end++

    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const segmentIsSpace = segment === ' '
      if (!segmentIsSpace && cjkBreakRegex.test(segment)) {
        flushCurrent()
        const token = pendingAnsi + segment
        pendingAnsi = ''
        tokens.push(token)
        continue
      }

      const segmentKind = segmentIsSpace ? 'space' : 'word'
      if (current && currentKind !== segmentKind) flushCurrent()
      if (pendingAnsi) {
        current += pendingAnsi
        pendingAnsi = ''
      }
      currentKind = segmentKind
      current += segment
    }

    i = end
  }

  if (pendingAnsi) {
    if (current) current += pendingAnsi
    else if (tokens.length > 0) tokens[tokens.length - 1] += pendingAnsi
    else current = pendingAnsi
  }
  if (current) tokens.push(current)
  return tokens
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
  const lines: string[] = []
  let currentLine = tracker.getActiveCodes()
  let currentWidth = 0

  const segments: Array<{ type: 'ansi' | 'grapheme', value: string }> = []
  let i = 0
  while (i < word.length) {
    const ansiResult = extractAnsiCode(word, i)
    if (ansiResult) {
      segments.push({ type: 'ansi', value: ansiResult.code })
      i += ansiResult.length
    } else {
      let end = i
      while (end < word.length && !extractAnsiCode(word, end)) end++
      for (const seg of graphemeSegmenter.segment(word.slice(i, end))) {
        segments.push({ type: 'grapheme', value: seg.segment })
      }
      i = end
    }
  }

  for (const seg of segments) {
    if (seg.type === 'ansi') {
      currentLine += seg.value
      tracker.process(seg.value)
      continue
    }
    const grapheme = seg.value
    if (!grapheme) continue
    const gw = graphemeWidth(grapheme)
    if (currentWidth + gw > width) {
      const lineEndReset = tracker.getLineEndReset()
      if (lineEndReset) currentLine += lineEndReset
      lines.push(currentLine)
      currentLine = tracker.getActiveCodes()
      currentWidth = 0
    }
    currentLine += grapheme
    currentWidth += gw
  }

  if (currentLine) lines.push(currentLine)
  return lines.length > 0 ? lines : ['']
}

function wrapSingleLine(line: string, width: number): string[] {
  if (!line) return ['']
  if (visibleWidth(line) <= width) return [line]

  const wrapped: string[] = []
  const tracker = new AnsiCodeTracker()
  const tokens = splitIntoTokensWithAnsi(line)

  let currentLine = ''
  let currentVisibleLength = 0

  for (const token of tokens) {
    const tokenVisibleLength = visibleWidth(token)
    const isWhitespace = token.trim() === ''

    // Token itself is too long — break it grapheme by grapheme.
    if (tokenVisibleLength > width && !isWhitespace) {
      if (currentLine) {
        const lineEndReset = tracker.getLineEndReset()
        if (lineEndReset) currentLine += lineEndReset
        wrapped.push(currentLine)
        currentLine = ''
        currentVisibleLength = 0
      }
      const broken = breakLongWord(token, width, tracker)
      for (let i = 0; i < broken.length - 1; i++) wrapped.push(broken[i]!)
      currentLine = broken[broken.length - 1]!
      currentVisibleLength = visibleWidth(currentLine)
      continue
    }

    const totalNeeded = currentVisibleLength + tokenVisibleLength
    if (totalNeeded > width && currentVisibleLength > 0) {
      let lineToWrap = currentLine.trimEnd()
      const lineEndReset = tracker.getLineEndReset()
      if (lineEndReset) lineToWrap += lineEndReset
      wrapped.push(lineToWrap)
      if (isWhitespace) {
        currentLine = tracker.getActiveCodes()
        currentVisibleLength = 0
      } else {
        currentLine = tracker.getActiveCodes() + token
        currentVisibleLength = tokenVisibleLength
      }
    } else {
      currentLine += token
      currentVisibleLength += tokenVisibleLength
    }

    updateTrackerFromText(token, tracker)
  }

  if (currentLine) wrapped.push(currentLine)
  return wrapped.length > 0 ? wrapped.map(l => l.trimEnd()) : ['']
}

/**
 * Wrap text to `width` visible columns, preserving ANSI styling and OSC 8
 * hyperlinks across breaks and breaking over-long tokens by grapheme.
 * Does NOT pad. Newlines in the input are honored as hard breaks.
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
  if (!text) return ['']
  if (width <= 0) return [text]

  const inputLines = text.split(/\r\n|\r|\n/)
  const result: string[] = []
  const tracker = new AnsiCodeTracker()

  for (const inputLine of inputLines) {
    const prefix = result.length > 0 ? tracker.getActiveCodes() : ''
    const wrappedLines = wrapSingleLine(prefix + inputLine, width)
    for (const wrappedLine of wrappedLines) result.push(wrappedLine)
    updateTrackerFromText(inputLine, tracker)
  }

  return result.length > 0 ? result : ['']
}

/** Visible graphemes in `str`, ignoring ANSI/OSC/APC. Newlines count. */
export function visibleGraphemeCount(str: string): number {
  if (!str) return 0
  let count = 0
  let i = 0
  while (i < str.length) {
    const ansi = extractAnsiCode(str, i)
    if (ansi) {
      i += ansi.length
      continue
    }
    let end = i
    while (end < str.length && !extractAnsiCode(str, end)) end++
    for (const _ of graphemeSegmenter.segment(str.slice(i, end))) count++
    i = end
  }
  return count
}

/** Keep the first `maxGraphemes` visible graphemes of an ANSI string, closing
 *  any still-open styles so the slice can sit next to unstyled UI chrome. */
export function sliceVisibleAnsi(text: string, maxGraphemes: number): string {
  if (!text || maxGraphemes <= 0) return ''
  const tracker = new AnsiCodeTracker()
  let count = 0
  let i = 0
  let out = ''
  while (i < text.length && count < maxGraphemes) {
    const ansi = extractAnsiCode(text, i)
    if (ansi) {
      tracker.process(ansi.code)
      out += ansi.code
      i += ansi.length
      continue
    }
    let end = i
    while (end < text.length && !extractAnsiCode(text, end)) end++
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      if (count >= maxGraphemes) break
      out += segment
      count++
    }
    i = end
  }
  const lineEnd = tracker.getLineEndReset()
  if (lineEnd) out += lineEnd
  if (tracker.getActiveCodes()) out += '\x1b[0m'
  return out
}

/** Keep the head of an ANSI string so it fits `width` columns, appending an
 *  ellipsis when truncated. Newlines are treated as visible characters. */
/**
 * Split an ANSI string into one entry per terminal column.
 *
 * Escape sequences carry no width, so they ride along on the next visible cell
 * rather than becoming cells of their own: colour state then flows through the
 * row in terminal order, and OSC 8 hyperlinks stay intact instead of being cut
 * into per-cell links. A double-width glyph yields its cell followed by an
 * empty filler entry, so entry count still equals column count — except for
 * input that is nothing but escapes, which yields a single zero-width entry so
 * the colour state is not silently dropped.
 */
export function splitAnsiIntoCells(text: string): string[] {
  const cells: string[] = []
  let pendingCodes = ''
  let i = 0
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i)
    if (ansi) {
      pendingCodes += ansi.code
      i += ansi.length
      continue
    }
    let end = i
    while (end < text.length && !extractAnsiCode(text, end)) end++
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      cells.push(pendingCodes + segment)
      pendingCodes = ''
      // Wide glyphs own two columns; the filler keeps indices aligned to cells.
      for (let pad = 1; pad < graphemeWidth(segment); pad++) cells.push('')
    }
    i = end
  }
  // Trailing codes (a hyperlink close, a reset) belong to the last cell —
  // as their own entry they would inflate the count past the column count.
  if (pendingCodes) {
    if (cells.length > 0) cells[cells.length - 1] += pendingCodes
    else cells.push(pendingCodes)
  }
  return cells
}

export function truncateAnsiToWidth(text: string, width: number): string {
  if (width <= 0 || !text) return ''
  if (visibleWidth(text) <= width) return text
  if (width <= 1) return '…'.slice(0, width)

  const tracker = new AnsiCodeTracker()
  let used = 0
  let i = 0
  let out = ''
  const limit = width - 1
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i)
    if (ansi) {
      tracker.process(ansi.code)
      out += ansi.code
      i += ansi.length
      continue
    }
    let end = i
    while (end < text.length && !extractAnsiCode(text, end)) end++
    let stop = false
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const gw = graphemeWidth(segment)
      if (used + gw > limit) {
        stop = true
        break
      }
      out += segment
      used += gw
    }
    if (stop) break
    i = end
  }
  const lineEnd = tracker.getLineEndReset()
  if (lineEnd) out += lineEnd
  if (tracker.getActiveCodes()) out += '\x1b[0m'
  return `${out}…`
}
