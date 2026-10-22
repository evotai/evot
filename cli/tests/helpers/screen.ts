import xterm from '@xterm/headless'
import { Writable } from 'node:stream'

const { Terminal } = xterm

/**
 * A real terminal emulator behind a Writable, so renderer output can be
 * asserted as physical screen rows rather than as escape sequences.
 *
 * Cursor motion, scrolling, and clears are interpreted by xterm, which is the
 * only way to tell "row 30 of the viewport" from "row 30 of the logical frame".
 */
export class ScreenHarness {
  readonly terminal: InstanceType<typeof Terminal>
  readonly stdout: NodeJS.WriteStream

  constructor(columns = 80, rows = 24) {
    this.terminal = new Terminal({
      cols: columns,
      rows,
      allowProposedApi: true,
      scrollback: 5000,
    })
    const terminal = this.terminal
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        terminal.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'), () => callback())
      },
    }) as unknown as NodeJS.WriteStream
    stream.rows = rows
    stream.columns = columns
    this.stdout = stream
  }

  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }

  /** Match both the physical emulator geometry and renderer's stdout. */
  resize(columns: number, rows: number): void {
    this.stdout.columns = columns
    this.stdout.rows = rows
    this.terminal.resize(columns, rows)
    this.stdout.emit('resize')
  }

  /** Let queued writes drain into the emulator. */
  async settle(): Promise<void> {
    await new Promise<void>(resolve => this.terminal.write('', resolve))
  }

  /** Visible viewport rows, trailing blanks preserved, right-trimmed. */
  viewport(): string[] {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let row = 0; row < this.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row)
      lines.push((line?.translateToString(true) ?? '').trimEnd())
    }
    return lines
  }

  /** Viewport index of the first row containing `text`, or -1. */
  rowOf(text: string): number {
    return this.viewport().findIndex(line => line.includes(text))
  }

  /** Viewport index of the last non-blank row, or -1 when the screen is blank. */
  lastNonBlankRow(): number {
    const rows = this.viewport()
    for (let row = rows.length - 1; row >= 0; row--) {
      if (rows[row] !== '') return row
    }
    return -1
  }
}
