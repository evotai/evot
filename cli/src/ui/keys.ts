/**
 * Input — raw mode stdin handler for the terminal REPL.
 * Parses keypresses and emits structured events.
 */

import {
  parseOsc11BackgroundColor,
  parseTerminalColorSchemeReport,
  type RgbColor,
  type TerminalColorScheme,
} from './terminal-colors.js'

export type KeyEvent =
  | { type: 'char'; char: string }
  | { type: 'shift-char'; char: string }
  | { type: 'enter' }
  | { type: 'ctrl-enter' }
  | { type: 'shift-enter' }
  | { type: 'alt-enter' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'tab' }
  | { type: 'shift-tab' }
  | { type: 'escape' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'word-left' }
  | { type: 'word-right' }
  | { type: 'alt-backspace' }
  | { type: 'alt-d' }
  | { type: 'undo' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'page-up' }
  | { type: 'page-down' }
  | { type: 'ctrl'; key: string }
  | { type: 'paste'; text: string }
  /** Terminal reported a paste shortcut as a key, so the clipboard read is ours. */
  | { type: 'paste-clipboard' }

export type KeyHandler = (event: KeyEvent) => void

export type TerminalControlEvent =
  | { type: 'kitty-flags'; flags: number }
  | { type: 'device-attributes' }
  | { type: 'osc11-background'; rgb: RgbColor }
  | { type: 'color-scheme'; scheme: TerminalColorScheme }

export interface EnhancedKeyboardOptions {
  negotiationTimeoutMs?: number
}

export interface EnhancedKeyboardSession {
  /** Backward-compatible cleanup call. */
  (): void
  handleControl(event: TerminalControlEvent): void
  dispose(): void
}

const MOD_SHIFT = 1
const MOD_ALT = 2
const MOD_CTRL = 4
// Kitty super/meta bit (Cmd on macOS).
const MOD_SUPER = 8
const KITTY_KP_ENTER = 57414
const ENABLE_KITTY_DISAMBIGUATE = '\x1b[>1u'
const QUERY_KITTY_KEYBOARD = '\x1b[?u'
const QUERY_PRIMARY_DEVICE_ATTRIBUTES = '\x1b[c'
const DISABLE_KITTY_KEYBOARD = '\x1b[<u'
const ENABLE_MODIFY_OTHER_KEYS = '\x1b[>4;2m'
const DISABLE_MODIFY_OTHER_KEYS = '\x1b[>4;0m'
const DEFAULT_KEYBOARD_NEGOTIATION_TIMEOUT_MS = 150

/**
 * Parse a raw stdin buffer into key events.
 * Handles common ANSI escape sequences.
 */
export function parseInput(data: Buffer): KeyEvent[] {
  const events: KeyEvent[] = []
  const str = data.toString('utf-8')
  let i = 0

  while (i < str.length) {
    const ch = str[i]!

    // Ctrl+letter (0x01-0x1a) and Ctrl+_ (0x1f).
    const code = ch.charCodeAt(0)
    if ((code >= 1 && code <= 26) || code === 31) {
      switch (code) {
        case 3: // Ctrl+C
          events.push({ type: 'ctrl', key: 'c' })
          break
        case 4: // Ctrl+D
          events.push({ type: 'ctrl', key: 'd' })
          break
        case 9: // Tab
          events.push({ type: 'tab' })
          break
        case 10: // LF. Some terminals map Shift+Enter to a literal line feed.
          events.push({ type: 'shift-enter' })
          break
        case 12: // Ctrl+L
          events.push({ type: 'ctrl', key: 'l' })
          break
        case 13: // Enter
          events.push({ type: 'enter' })
          break
        case 22: // Ctrl+V
          events.push({ type: 'ctrl', key: 'v' })
          break
        case 23: // Ctrl+W
          events.push({ type: 'ctrl', key: 'w' })
          break
        case 31: // Ctrl+_ — traditional undo binding (pi uses Ctrl+-)
          events.push({ type: 'undo' })
          break
        default:
          events.push({ type: 'ctrl', key: String.fromCharCode(code + 96) })
      }
      i++
      continue
    }

    // Escape sequences
    if (ch === '\x1b') {
      // Check for raw bracketed paste sequences. TerminalInputBuffer normally
      // reassembles these first; this remains useful for direct parser callers.
      const BP_OPEN = '\x1b[200~'
      const BP_CLOSE = '\x1b[201~'
      if (str.slice(i, i + BP_OPEN.length) === BP_OPEN) {
        const contentStart = i + BP_OPEN.length
        const endIdx = str.indexOf(BP_CLOSE, contentStart)
        if (endIdx !== -1) {
          const text = str.slice(contentStart, endIdx)
          if (text.length > 0) {
            events.push({ type: 'paste', text })
          }
          i = endIdx + BP_CLOSE.length
          continue
        }
      }

      if (i + 1 < str.length && str[i + 1] === '[') {
        // CSI sequence
        const rest = str.slice(i + 2)

        const csiU = parseCsiU(rest)
        if (csiU) {
          if (csiU.event) events.push(csiU.event)
          i += 2 + csiU.length
          continue
        }

        const modifyOtherKeys = parseModifyOtherKeys(rest)
        if (modifyOtherKeys) {
          if (modifyOtherKeys.event) events.push(modifyOtherKeys.event)
          i += 2 + modifyOtherKeys.length
          continue
        }

        const modifiedCursor = parseModifiedCursor(rest)
        if (modifiedCursor) {
          if (modifiedCursor.event) events.push(modifiedCursor.event)
          i += 2 + modifiedCursor.length
          continue
        }

        if (rest.startsWith('A')) { events.push({ type: 'up' }); i += 3; continue }
        if (rest.startsWith('B')) { events.push({ type: 'down' }); i += 3; continue }
        if (rest.startsWith('C')) { events.push({ type: 'right' }); i += 3; continue }
        if (rest.startsWith('D')) { events.push({ type: 'left' }); i += 3; continue }
        if (rest.startsWith('H')) { events.push({ type: 'home' }); i += 3; continue }
        if (rest.startsWith('F')) { events.push({ type: 'end' }); i += 3; continue }
        if (rest.startsWith('Z')) { events.push({ type: 'shift-tab' }); i += 3; continue }
        if (rest.startsWith('13;2~')) { events.push({ type: 'shift-enter' }); i += 7; continue }
        if (rest.startsWith('3~')) { events.push({ type: 'delete' }); i += 4; continue }
        if (rest.startsWith('5~')) { events.push({ type: 'page-up' }); i += 4; continue }
        if (rest.startsWith('6~')) { events.push({ type: 'page-down' }); i += 4; continue }
        if (rest.startsWith('1~')) { events.push({ type: 'home' }); i += 4; continue }
        if (rest.startsWith('4~')) { events.push({ type: 'end' }); i += 4; continue }
        // Skip unknown CSI sequences
        let j = 0
        while (j < rest.length && rest.charCodeAt(j) >= 0x20 && rest.charCodeAt(j) <= 0x3f) j++
        i += 2 + j + 1
        continue
      }

      // Application-mode arrows and F1–F4 use SS3, not CSI. Consume the
      // whole sequence even when unsupported; its ESC is not an Escape key.
      if (str[i + 1] === 'O') {
        const sequence = str.slice(i + 2).match(/^[\x20-\x3f]*[\x40-\x7e]/)?.[0]
        if (sequence) {
          const cursor = parseModifiedCursor(sequence)
          const event = cursor?.event ?? (sequence.length === 1 ? modifiedArrowEvent(sequence, 0) : undefined)
          if (event) events.push(event)
        }
        i += sequence ? 2 + sequence.length : str.length - i
        continue
      }

      // Terminal responses/control strings must never become Escape keys,
      // including incomplete strings passed directly to this parser.
      if (']P_^'.includes(str[i + 1] ?? '\0')) {
        const rest = str.slice(i + 2)
        const end = rest.match(str[i + 1] === ']' ? /\x07|\x1b\\/ : /\x1b\\/)
        i = end ? i + 2 + (end.index ?? 0) + end[0].length : str.length
        continue
      }

      // Alt+Enter: ESC followed by CR (0x0d). Some terminals also use this
      // as a custom Shift+Enter mapping; both mean "insert newline" in evot.
      if (i + 1 < str.length && str.charCodeAt(i + 1) === 13) {
        events.push({ type: 'alt-enter' })
        i += 2
        continue
      }

      // Alt+letter / Alt+Backspace (ESC + char). Common for word ops without
      // Kitty: alt+b/f left/right, alt+d delete-word-forward, alt+BS delete-word-back.
      if (i + 1 < str.length) {
        const next = str[i + 1]!
        const nextCode = next.charCodeAt(0)
        if (next === 'b' || next === 'B') { events.push({ type: 'word-left' }); i += 2; continue }
        if (next === 'f' || next === 'F') { events.push({ type: 'word-right' }); i += 2; continue }
        if (next === 'd' || next === 'D') { events.push({ type: 'alt-d' }); i += 2; continue }
        if (nextCode === 0x7f || nextCode === 0x08) { events.push({ type: 'alt-backspace' }); i += 2; continue }
        // Unknown Alt combinations are not bare Escape presses. Preserve
        // consecutive actual Esc presses by consuming those one at a time.
        if (next !== '\x1b') {
          i += 1 + (str.codePointAt(i + 1)! > 0xffff ? 2 : 1)
          continue
        }
      }

      // Bare escape
      events.push({ type: 'escape' })
      i++
      continue
    }

    // Backspace (0x7f)
    if (ch === '\x7f') {
      events.push({ type: 'backspace' })
      i++
      continue
    }

    // Regular character. Advance by Unicode code point so non-BMP input is not
    // split into separate surrogate events; grapheme grouping happens in the editor.
    const codePoint = str.codePointAt(i)
    const char = codePoint === undefined ? ch : String.fromCodePoint(codePoint)
    events.push({ type: 'char', char })
    i += char.length
  }

  return events
}

/**
 * Enable raw mode on stdin and return a cleanup function.
 */
export function enableRawMode(stdin: NodeJS.ReadStream): () => void {
  if (stdin.isTTY) {
    stdin.setRawMode(true)
  }
  stdin.resume()
  stdin.setEncoding('utf-8')

  return () => {
    if (stdin.isTTY) {
      stdin.setRawMode(false)
    }
    stdin.pause()
  }
}

export function parseTerminalControlSequence(sequence: string): TerminalControlEvent | undefined {
  const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/)
  if (kittyFlags) {
    return { type: 'kitty-flags', flags: Number.parseInt(kittyFlags[1]!, 10) }
  }
  if (/^\x1b\[\?[\d;]*c$/.test(sequence)) return { type: 'device-attributes' }

  const rgb = parseOsc11BackgroundColor(sequence)
  if (rgb) return { type: 'osc11-background', rgb }
  const scheme = parseTerminalColorSchemeReport(sequence)
  if (scheme) return { type: 'color-scheme', scheme }
  return undefined
}

/**
 * Negotiate one enhanced-keyboard protocol. Kitty is requested first; terminals
 * without support answer the DA sentinel (or time out), then fall back to
 * modifyOtherKeys. The returned session consumes negotiation responses and
 * restores only the mode that was actually active.
 */
export function enableEnhancedKeyboard(
  stdout: NodeJS.WriteStream = process.stdout,
  options: EnhancedKeyboardOptions = {},
): EnhancedKeyboardSession {
  type Mode = 'negotiating' | 'kitty' | 'modify-other-keys' | 'disposed'
  let mode: Mode = 'negotiating'
  const timeoutMs = options.negotiationTimeoutMs ?? DEFAULT_KEYBOARD_NEGOTIATION_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }
  const useModifyOtherKeys = () => {
    if (mode !== 'negotiating') return
    clearTimer()
    // The Kitty push may already have changed terminal state even if its query
    // response was lost. Pop it before enabling the xterm fallback.
    stdout.write(DISABLE_KITTY_KEYBOARD)
    stdout.write(ENABLE_MODIFY_OTHER_KEYS)
    mode = 'modify-other-keys'
  }

  // Request Kitty flags, query the result, then issue DA as a widely-supported
  // sentinel. Supporting terminals answer Kitty before DA; others answer DA.
  stdout.write(`${ENABLE_KITTY_DISAMBIGUATE}${QUERY_KITTY_KEYBOARD}${QUERY_PRIMARY_DEVICE_ATTRIBUTES}`)
  timer = setTimeout(useModifyOtherKeys, Math.max(0, timeoutMs))

  const handleControl = (event: TerminalControlEvent) => {
    if (mode !== 'negotiating') return
    // Theme/DSR replies share the control channel; only keyboard negotiation
    // responses should resolve or abandon the Kitty push.
    if (event.type === 'kitty-flags') {
      if (event.flags > 0) {
        clearTimer()
        mode = 'kitty'
        return
      }
      useModifyOtherKeys()
      return
    }
    if (event.type === 'device-attributes') {
      useModifyOtherKeys()
    }
  }
  const dispose = () => {
    if (mode === 'disposed') return
    clearTimer()
    if (mode === 'kitty' || mode === 'negotiating') stdout.write(DISABLE_KITTY_KEYBOARD)
    else if (mode === 'modify-other-keys') stdout.write(DISABLE_MODIFY_OTHER_KEYS)
    mode = 'disposed'
  }

  return Object.assign(dispose, { handleControl, dispose })
}

interface ParsedSequence {
  length: number
  event?: KeyEvent
}

function parseCsiU(rest: string): ParsedSequence | null {
  // Kitty CSI-u:
  //   ESC [ <codepoint> u
  //   ESC [ <codepoint> ; <modifier> u
  //   ESC [ <codepoint> ; <modifier> : <event> u
  // Modifiers are 1-indexed, so 2 means Shift and 5 means Ctrl.
  const match = rest.match(/^(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::(\d+))?u/)
  if (!match) return null
  const codepoint = Number.parseInt(match[1]!, 10)
  const modValue = match[2] ? Number.parseInt(match[2], 10) : 1
  const modifier = modValue - 1
  const eventType = match[3] ? Number.parseInt(match[3], 10) : 1
  // A held Esc can generate repeats; one physical press must not satisfy
  // the two-press interrupt confirmation. Other keys still auto-repeat.
  const event = eventType === 3 || (codepoint === 27 && eventType !== 1)
    ? undefined
    : keyEventFromCodepoint(codepoint, modifier)
  return { length: match[0].length, event }
}

function parseModifyOtherKeys(rest: string): ParsedSequence | null {
  // xterm modifyOtherKeys: ESC [ 27 ; <modifier> ; <keycode> ~
  const match = rest.match(/^27;(\d+);(\d+)~/)
  if (!match) return null
  const modValue = Number.parseInt(match[1]!, 10)
  const codepoint = Number.parseInt(match[2]!, 10)
  return { length: match[0].length, event: keyEventFromCodepoint(codepoint, modValue - 1) }
}

function parseModifiedCursor(rest: string): ParsedSequence | null {
  // Modified arrows: ESC [ 1 ; <modifier> A/B/C/D
  // Modified Home/End: ESC [ 1 ; <modifier> H/F
  // Also CSI <code> ; <modifier> ~ for Delete (3~) with modifiers.
  const arrowMatch = rest.match(/^1;(\d+)(?::(\d+))?([ABCDFH])/)
  if (arrowMatch) {
    const modifier = Number.parseInt(arrowMatch[1]!, 10) - 1
    const eventType = arrowMatch[2] ? Number.parseInt(arrowMatch[2], 10) : 1
    if (eventType === 3) return { length: arrowMatch[0].length }
    const final = arrowMatch[3]!
    return { length: arrowMatch[0].length, event: modifiedArrowEvent(final, modifier) }
  }

  // Alt/Ctrl+Delete: ESC [ 3 ; <modifier> ~
  const deleteMatch = rest.match(/^3;(\d+)(?::(\d+))?~/)
  if (deleteMatch) {
    const modifier = Number.parseInt(deleteMatch[1]!, 10) - 1
    const eventType = deleteMatch[2] ? Number.parseInt(deleteMatch[2], 10) : 1
    if (eventType === 3) return { length: deleteMatch[0].length }
    if ((modifier & MOD_ALT) !== 0) return { length: deleteMatch[0].length, event: { type: 'alt-d' } }
    return { length: deleteMatch[0].length, event: { type: 'delete' } }
  }

  return null
}

function modifiedArrowEvent(final: string, modifier: number): KeyEvent | undefined {
  const normalized = modifier & ~(64 + 128)
  const wordMod = (normalized & MOD_ALT) !== 0 || (normalized & MOD_CTRL) !== 0
  switch (final) {
    case 'A': return { type: 'up' }
    case 'B': return { type: 'down' }
    case 'C': return { type: wordMod ? 'word-right' : 'right' }
    case 'D': return { type: wordMod ? 'word-left' : 'left' }
    case 'F': return { type: 'end' }
    case 'H': return { type: 'home' }
    default: return undefined
  }
}

function keyEventFromCodepoint(codepoint: number, modifier: number): KeyEvent | undefined {
  const normalizedModifier = modifier & ~(64 + 128) // ignore caps/num lock bits
  // Warp reports Cmd+V as a key event under kitty disambiguate; without this
  // branch the sequence was dropped and Cmd+V did nothing.
  if ((normalizedModifier & MOD_SUPER) !== 0) {
    if (codepoint === 118 || codepoint === 86) return { type: 'paste-clipboard' }
    return undefined
  }
  if (codepoint === 13 || codepoint === KITTY_KP_ENTER) {
    if ((normalizedModifier & MOD_CTRL) !== 0) return { type: 'ctrl-enter' }
    if ((normalizedModifier & MOD_SHIFT) !== 0) return { type: 'shift-enter' }
    if ((normalizedModifier & MOD_ALT) !== 0) return { type: 'alt-enter' }
    return { type: 'enter' }
  }
  if (codepoint === 9) {
    if ((normalizedModifier & MOD_SHIFT) !== 0) return { type: 'shift-tab' }
    return { type: 'tab' }
  }
  // Backspace / Delete with modifiers
  if (codepoint === 127 || codepoint === 8) {
    if ((normalizedModifier & MOD_ALT) !== 0) return { type: 'alt-backspace' }
    return { type: 'backspace' }
  }
  if (codepoint === 27) return normalizedModifier === 0 ? { type: 'escape' } : undefined

  // Kitty CSI-u encodes arrows as special codepoints 57348–57351 (or use modified cursor).
  // Also handle letter keys with alt for word ops (alt+b/f/d).
  if ((normalizedModifier & MOD_ALT) !== 0 && !(normalizedModifier & MOD_CTRL)) {
    const ch = codepoint >= 65 && codepoint <= 90
      ? String.fromCharCode(codepoint + 32)
      : codepoint >= 97 && codepoint <= 122
        ? String.fromCharCode(codepoint)
        : undefined
    if (ch === 'b') return { type: 'word-left' }
    if (ch === 'f') return { type: 'word-right' }
    if (ch === 'd') return { type: 'alt-d' }
  }

  if ((normalizedModifier & MOD_CTRL) !== 0) {
    const key = modifiedKeyFromCodepoint(codepoint)
    // Ctrl+- is undo (matches pi). Ctrl+_ (0x1f / codepoint 95) also maps to '-'.
    if (key === '-') return { type: 'undo' }
    if (key) return { type: 'ctrl', key }
  }
  if (normalizedModifier === MOD_SHIFT && codepoint >= 0x20 && codepoint <= 0x10ffff) {
    return { type: 'shift-char', char: String.fromCodePoint(codepoint).toLowerCase() }
  }
  if (normalizedModifier === 0 && codepoint >= 0x20 && codepoint <= 0x10ffff) {
    const char = String.fromCodePoint(codepoint)
    return { type: 'char', char }
  }
  return undefined
}

function modifiedKeyFromCodepoint(codepoint: number): string | undefined {
  if (codepoint >= 65 && codepoint <= 90) return String.fromCharCode(codepoint + 32)
  if (codepoint >= 97 && codepoint <= 122) return String.fromCharCode(codepoint)
  if (codepoint === 91) return '['
  if (codepoint === 92) return '\\'
  if (codepoint === 93) return ']'
  if (codepoint === 95 || codepoint === 45) return '-'
  return undefined
}
