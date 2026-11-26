import type { OutputLine } from '../../render/output.js'
import { renderNoticeSpans } from '../../ui/command-notice.js'
import type { NoticeSpan } from '../../ui/notice-layout.js'
import { createProgressBar, type ProgressBar, type ProgressBarOptions } from '../../ui/progress-bar.js'
import { createProgressLine, type ProgressLine } from '../../ui/progress-line.js'

export interface CommandOutputPort {
  /** `remoteLines` replaces the local rendering when it contains private details. */
  commitLines: (lines: OutputLine[], remoteLines?: OutputLine[]) => void
  replaceLine: (id: string, text: string, spans?: readonly NoticeSpan[]) => boolean
  requestRender: () => void
}

type CommandPresentation = string | readonly NoticeSpan[]

export function commandOutputLine(id: string, result: CommandPresentation): OutputLine {
  const content = typeof result === 'string' ? { text: result } : { text: renderNoticeSpans(result), noticeSpans: result }
  return { id, kind: 'system', preStyled: true, ...content }
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
  const commit = (id: string, result: CommandPresentation): void => {
    port.commitLines([commandOutputLine(id, result)])
    port.requestRender()
  }
  const progress = (): ProgressLine<CommandPresentation> => createProgressLine(`sys-${command}-progress-${nextProgressId++}`, {
    commit,
    replace: (id, result) => {
      const { text, noticeSpans } = commandOutputLine(id, result)
      const replaced = port.replaceLine(id, text, noticeSpans)
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
