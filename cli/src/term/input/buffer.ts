import { StringDecoder } from 'node:string_decoder'
import {
  parseInput,
  parseTerminalControlSequence,
  type KeyEvent,
  type TerminalControlEvent,
} from '../../ui/keys.js'

const ESC = '\x1b'
const BP_OPEN = '\x1b[200~'
const BP_CLOSE = '\x1b[201~'

export interface TerminalInputBufferOptions {
  onEmptyPaste?: () => void
  onControl?: (event: TerminalControlEvent) => void
}

interface InputUnit {
  length: number
  parse: boolean
}

/**
 * Reassembles terminal input independently of Node stream chunk boundaries.
 * UTF-8 code points, CSI/Kitty sequences, and bracketed pastes are emitted only
 * after their complete byte/string representation has arrived.
 */
export class TerminalInputBuffer {
  private readonly decoder = new StringDecoder('utf8')
  private readonly onEmptyPaste: (() => void) | undefined
  private readonly onControl: ((event: TerminalControlEvent) => void) | undefined
  private pending = ''
  private pasteContent: string | null = null

  constructor(options: TerminalInputBufferOptions = {}) {
    this.onEmptyPaste = options.onEmptyPaste
    this.onControl = options.onControl
  }

  get hasPending(): boolean {
    return this.pending.length > 0 || this.pasteContent !== null
  }

  get hasAmbiguousEscape(): boolean {
    return this.pasteContent === null && this.pending === ESC
  }

  write(chunk: Buffer | string): KeyEvent[] {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    return this.drain(false)
  }

  /** Resolve an ambiguous trailing escape as a bare Escape key. */
  flushPending(): KeyEvent[] {
    return this.drain(true)
  }

  end(): KeyEvent[] {
    this.pending += this.decoder.end()
    return this.drain(true)
  }

  /** Drop incomplete input during teardown without emitting keys or paste callbacks. */
  discard(): void {
    this.decoder.end()
    this.pending = ''
    this.pasteContent = null
  }

  private drain(force: boolean): KeyEvent[] {
    const events: KeyEvent[] = []

    while (this.pending.length > 0) {
      if (this.pasteContent !== null) {
        const closeIndex = this.pending.indexOf(BP_CLOSE)
        if (closeIndex < 0) {
          if (force) {
            this.pasteContent += this.pending
            this.pending = ''
            if (this.pasteContent.length > 0) events.push({ type: 'paste', text: this.pasteContent })
            else this.onEmptyPaste?.()
            this.pasteContent = null
          }
          break
        }

        this.pasteContent += this.pending.slice(0, closeIndex)
        this.pending = this.pending.slice(closeIndex + BP_CLOSE.length)
        if (this.pasteContent.length > 0) events.push({ type: 'paste', text: this.pasteContent })
        else this.onEmptyPaste?.()
        this.pasteContent = null
        continue
      }

      if (this.pending.startsWith(BP_OPEN)) {
        this.pending = this.pending.slice(BP_OPEN.length)
        this.pasteContent = ''
        continue
      }
      if (!force && BP_OPEN.startsWith(this.pending)) break

      const unit = nextInputUnit(this.pending, force)
      if (!unit) break
      const text = this.pending.slice(0, unit.length)
      this.pending = this.pending.slice(unit.length)
      const control = parseTerminalControlSequence(text)
      if (control) {
        this.onControl?.(control)
      } else if (unit.parse) {
        events.push(...parseInput(Buffer.from(text, 'utf8')))
      }
    }

    return events
  }
}

function nextInputUnit(input: string, force: boolean): InputUnit | null {
  if (!input.startsWith(ESC)) {
    const codePoint = input.codePointAt(0)
    return { length: codePoint !== undefined && codePoint > 0xffff ? 2 : 1, parse: true }
  }

  if (input.length === 1) return force ? { length: 1, parse: true } : null

  const introducer = input[1]!
  if (introducer === '[') {
    const finalIndex = findSequenceFinal(input)
    if (finalIndex < 0) return force ? { length: input.length, parse: false } : null
    return { length: finalIndex + 1, parse: true }
  }

  if (introducer === ']') return controlStringUnit(input, force, true)
  if (introducer === 'P' || introducer === '_' || introducer === '^') {
    return controlStringUnit(input, force, false)
  }

  if (introducer === 'O') {
    const finalIndex = findSequenceFinal(input)
    if (finalIndex < 0) return force ? { length: input.length, parse: false } : null
    return { length: finalIndex + 1, parse: true }
  }

  const codePoint = input.codePointAt(1)
  const characterLength = codePoint !== undefined && codePoint > 0xffff ? 2 : 1
  return { length: 1 + characterLength, parse: true }
}

function findSequenceFinal(input: string): number {
  for (let index = 2; index < input.length; index++) {
    const code = input.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index
    if (code < 0x20 || code > 0x3f) return index
  }
  return -1
}

function controlStringUnit(input: string, force: boolean, allowBel: boolean): InputUnit | null {
  const belIndex = allowBel ? input.indexOf('\x07', 2) : -1
  const stIndex = input.indexOf(`${ESC}\\`, 2)
  let end = -1
  if (belIndex >= 0 && stIndex >= 0) end = Math.min(belIndex + 1, stIndex + 2)
  else if (belIndex >= 0) end = belIndex + 1
  else if (stIndex >= 0) end = stIndex + 2
  if (end >= 0) return { length: end, parse: false }
  // A truncated terminal response is still not a bare Escape press.
  return force ? { length: input.length, parse: false } : null
}
