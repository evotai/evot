import type { OutputLine } from '../render/output.js'
import { createProgressBar, type ProgressBar, type ProgressBarOptions } from './progress-bar.js'
import { createProgressLine, type ProgressLine } from './progress-line.js'

export interface CommandOutputPort {
  commitLines: (lines: OutputLine[]) => void
  replaceLine: (id: string, text: string) => boolean
  requestRender: () => void
}

let nextProgressId = 0

/**
 * Shared pre-styled output and replaceable progress rows per invocation.
 *
 * `progress()` is a phase line ("downloading…" → "extracting…"); `bar()` is a
 * counted bar with elapsed time for work that knows its total. Both cost one
 * row of scrollback and end with the outcome in that same row.
 */
export function createCommandOutput(port: CommandOutputPort, command: string) {
  const commit = (id: string, text: string): void => {
    port.commitLines([{ id, kind: 'system', text, preStyled: true }])
    port.requestRender()
  }
  const progress = (): ProgressLine => createProgressLine(`sys-${command}-progress-${nextProgressId++}`, {
    commit,
    replace: (id, text) => {
      const replaced = port.replaceLine(id, text)
      if (replaced) port.requestRender()
      return replaced
    },
  })
  return {
    commit,
    progress,
    bar: (options: ProgressBarOptions): ProgressBar => createProgressBar(progress(), options),
  }
}
