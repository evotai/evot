import { describe, expect, test } from 'bun:test'
import {
  enableEnhancedKeyboard,
  parseTerminalControlSequence,
} from '../../src/ui/keys.js'

class CapturingStdout {
  readonly writes: string[] = []

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(String(chunk))
    return true
  }
}

const QUERY = '\x1b[>1u\x1b[?u\x1b[c'
const DISABLE_KITTY = '\x1b[<u'
const ENABLE_MODIFY_OTHER_KEYS = '\x1b[>4;2m'
const DISABLE_MODIFY_OTHER_KEYS = '\x1b[>4;0m'

describe('enhanced keyboard negotiation', () => {
  test('parses Kitty flags and device attributes responses', () => {
    expect(parseTerminalControlSequence('\x1b[?7u')).toEqual({ type: 'kitty-flags', flags: 7 })
    expect(parseTerminalControlSequence('\x1b[?1;2c')).toEqual({ type: 'device-attributes' })
    expect(parseTerminalControlSequence('\x1b[A')).toBeUndefined()
  })

  test('keeps Kitty active and remains callable as a cleanup function', () => {
    const stdout = new CapturingStdout()
    const session = enableEnhancedKeyboard(stdout as unknown as NodeJS.WriteStream, { negotiationTimeoutMs: 1000 })

    expect(stdout.writes).toEqual([QUERY])
    session.handleControl({ type: 'kitty-flags', flags: 1 })
    expect(stdout.writes).toEqual([QUERY])
    session()
    session.dispose()
    expect(stdout.writes).toEqual([QUERY, DISABLE_KITTY])
  })

  test('falls back to modifyOtherKeys after device attributes', () => {
    const stdout = new CapturingStdout()
    const session = enableEnhancedKeyboard(stdout as unknown as NodeJS.WriteStream, { negotiationTimeoutMs: 1000 })

    session.handleControl({ type: 'device-attributes' })
    expect(stdout.writes).toEqual([QUERY, DISABLE_KITTY, ENABLE_MODIFY_OTHER_KEYS])
    session.dispose()
    expect(stdout.writes).toEqual([
      QUERY,
      DISABLE_KITTY,
      ENABLE_MODIFY_OTHER_KEYS,
      DISABLE_MODIFY_OTHER_KEYS,
    ])
  })

  test('falls back when Kitty reports zero flags', () => {
    const stdout = new CapturingStdout()
    const session = enableEnhancedKeyboard(stdout as unknown as NodeJS.WriteStream, { negotiationTimeoutMs: 1000 })

    session.handleControl({ type: 'kitty-flags', flags: 0 })
    expect(stdout.writes).toEqual([QUERY, DISABLE_KITTY, ENABLE_MODIFY_OTHER_KEYS])
    session.dispose()
  })

  test('falls back after negotiation timeout', async () => {
    const stdout = new CapturingStdout()
    const session = enableEnhancedKeyboard(stdout as unknown as NodeJS.WriteStream, { negotiationTimeoutMs: 0 })

    await Bun.sleep(5)
    expect(stdout.writes).toEqual([QUERY, DISABLE_KITTY, ENABLE_MODIFY_OTHER_KEYS])
    session.dispose()
    expect(stdout.writes.at(-1)).toBe(DISABLE_MODIFY_OTHER_KEYS)
  })

  test('disposing during negotiation cancels fallback', async () => {
    const stdout = new CapturingStdout()
    const session = enableEnhancedKeyboard(stdout as unknown as NodeJS.WriteStream, { negotiationTimeoutMs: 1 })

    session.dispose()
    await Bun.sleep(5)
    expect(stdout.writes).toEqual([QUERY, DISABLE_KITTY])
  })

  test('parses OSC 11 and color-scheme control sequences', () => {
    expect(parseTerminalControlSequence('\x1b]11;rgb:0000/0000/0000\x07')).toEqual({
      type: 'osc11-background',
      rgb: { r: 0, g: 0, b: 0 },
    })
    expect(parseTerminalControlSequence('\x1b[?997;2n')).toEqual({
      type: 'color-scheme',
      scheme: 'light',
    })
  })

  test('theme control events do not abandon Kitty negotiation', () => {
    const stdout = new CapturingStdout()
    const session = enableEnhancedKeyboard(stdout as unknown as NodeJS.WriteStream, { negotiationTimeoutMs: 1000 })
    session.handleControl({ type: 'osc11-background', rgb: { r: 0, g: 0, b: 0 } })
    session.handleControl({ type: 'color-scheme', scheme: 'dark' })
    expect(stdout.writes).toEqual([QUERY])
    session.handleControl({ type: 'kitty-flags', flags: 1 })
    session.dispose()
    expect(stdout.writes).toEqual([QUERY, DISABLE_KITTY])
  })
})
