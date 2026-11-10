import { describe, expect, test } from 'bun:test'
import { TerminalInputBuffer } from '../../../src/term/input/buffer.js'

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

describe('TerminalInputBuffer', () => {
  test('reassembles a CSI key split across chunks', () => {
    const buffer = new TerminalInputBuffer()
    expect(buffer.write(bytes('\x1b['))).toEqual([])
    expect(buffer.write(bytes('1;2'))).toEqual([])
    expect(buffer.write(bytes('D'))).toEqual([{ type: 'left' }])
  })

  test('reassembles a Kitty CSI-u key split at every boundary', () => {
    const buffer = new TerminalInputBuffer()
    for (const part of ['\x1b', '[', '1', '3', ';', '2']) {
      expect(buffer.write(bytes(part))).toEqual([])
    }
    expect(buffer.write(bytes('u'))).toEqual([{ type: 'shift-enter' }])
  })

  test('intercepts split keyboard negotiation responses', () => {
    const controls: unknown[] = []
    const buffer = new TerminalInputBuffer({ onControl: event => controls.push(event) })

    expect(buffer.write(bytes('\x1b[?'))).toEqual([])
    expect(buffer.write(bytes('7u'))).toEqual([])
    expect(buffer.write(bytes('\x1b[?1;'))).toEqual([])
    expect(buffer.write(bytes('2ca'))).toEqual([{ type: 'char', char: 'a' }])
    expect(controls).toEqual([
      { type: 'kitty-flags', flags: 7 },
      { type: 'device-attributes' },
    ])
  })

  test('preserves a UTF-8 character split across byte chunks', () => {
    const buffer = new TerminalInputBuffer()
    const encoded = bytes('👩🏽‍💻')
    const events = []
    for (const byte of encoded) events.push(...buffer.write(Buffer.from([byte])))
    expect(events.map(event => event.type === 'char' ? event.char : '').join('')).toBe('👩🏽‍💻')
  })

  test('emits batched text and keys in original order', () => {
    const buffer = new TerminalInputBuffer()
    expect(buffer.write(bytes('hi\x1b[A\r'))).toEqual([
      { type: 'char', char: 'h' },
      { type: 'char', char: 'i' },
      { type: 'up' },
      { type: 'enter' },
    ])
  })

  test('reassembles bracketed paste markers and content across chunks', () => {
    const buffer = new TerminalInputBuffer()
    expect(buffer.write(bytes('\x1b[20'))).toEqual([])
    expect(buffer.write(bytes('0~line 1\n'))).toEqual([])
    expect(buffer.write(bytes('line 2\x1b[20'))).toEqual([])
    expect(buffer.write(bytes('1~x'))).toEqual([
      { type: 'paste', text: 'line 1\nline 2' },
      { type: 'char', char: 'x' },
    ])
  })

  test('holds a partial paste closing marker until the next chunk', () => {
    const buffer = new TerminalInputBuffer()
    expect(buffer.write(bytes('\x1b[200~content\x1b[2'))).toEqual([])
    expect(buffer.write(bytes('01~'))).toEqual([{ type: 'paste', text: 'content' }])
  })

  test('reports an empty paste without emitting a text event', () => {
    let emptyPastes = 0
    const buffer = new TerminalInputBuffer({ onEmptyPaste: () => { emptyPastes++ } })
    expect(buffer.write(bytes('\x1b[200~\x1b[201~'))).toEqual([])
    expect(emptyPastes).toBe(1)
  })

  test('holds a bare escape until explicitly flushed', () => {
    const buffer = new TerminalInputBuffer()
    expect(buffer.write(bytes('\x1b'))).toEqual([])
    expect(buffer.hasAmbiguousEscape).toBe(true)
    expect(buffer.flushPending()).toEqual([{ type: 'escape' }])
    expect(buffer.hasPending).toBe(false)
  })

  test('SS3 sequences are safe at every chunk boundary', () => {
    for (const [sequence, expected] of [
      ['\x1bOP', []], ['\x1bOQ', []], ['\x1bO1;2P', []],
      ['\x1bOA', [{ type: 'up' }]], ['\x1bO1;5D', [{ type: 'word-left' }]],
    ] as const) {
      for (let split = 1; split < sequence.length; split++) {
        const buffer = new TerminalInputBuffer()
        expect(buffer.write(sequence.slice(0, split))).toEqual([])
        expect(buffer.write(`${sequence.slice(split)}x`)).toEqual([...expected, { type: 'char', char: 'x' }])
        expect(buffer.hasPending).toBe(false)
      }
    }
  })

  test('forcing truncated terminal sequences never synthesizes Escape', () => {
    for (const sequence of ['\x1b[', '\x1b[1;', '\x1bO', '\x1bO1;', '\x1b]title', '\x1bPresponse', '\x1b_response', '\x1b^response']) {
      for (const flush of ['flushPending', 'end'] as const) {
        const buffer = new TerminalInputBuffer()
        expect(buffer.write(sequence)).toEqual([])
        expect(buffer.hasAmbiguousEscape).toBe(false)
        expect(buffer[flush]()).toEqual([])
        expect(buffer.hasPending).toBe(false)
        expect(buffer.write('x')).toEqual([{ type: 'char', char: 'x' }])
      }
    }
  })

  test('discards incomplete paste without callbacks or events', () => {
    let emptyPastes = 0
    const buffer = new TerminalInputBuffer({ onEmptyPaste: () => { emptyPastes++ } })
    expect(buffer.write(bytes('\x1b[200~unfinished'))).toEqual([])
    buffer.discard()
    expect(buffer.hasPending).toBe(false)
    expect(emptyPastes).toBe(0)
  })

  test('does not leak terminal OSC responses into editor input', () => {
    const buffer = new TerminalInputBuffer()
    expect(buffer.write(bytes('\x1b]11;rgb:0000/0000/0000'))).toEqual([])
    expect(buffer.write(bytes('\x07a'))).toEqual([{ type: 'char', char: 'a' }])
  })
})
