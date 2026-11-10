import type { FrameController } from './frame.js'
import type { KeysController } from './keys.js'
import type { ReplState } from './state.js'
import type { TerminalInputBuffer } from '../input/buffer.js'
import type { TermRenderer } from '../screen/renderer.js'
import type { KeyEvent, TerminalControlEvent } from '../../ui/keys.js'
import { schemeFromRgbColor } from '../../ui/terminal-colors.js'
import { setDetectedThemeScheme } from '../../ui/theme/index.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface TerminalDeps {
  readonly frames: FrameController
  readonly keys: KeysController
  readonly renderer: TermRenderer
  readonly terminalInput: TerminalInputBuffer
}

export interface TerminalController {
  handleTerminalControl(event: TerminalControlEvent): void
  readonly inputHandler: (data: string | Buffer<ArrayBufferLike>) => void
}

/** Raw terminal input: decoded key dispatch, control replies and theme detection. */
export function createTerminalController(st: ReplState, deps: TerminalDeps): TerminalController {
  function applyDetectedTheme(
    scheme: 'dark' | 'light',
    source: 'osc11-background' | 'color-scheme',
  ): void {
    // Committed history is pre-painted ANSI; a scheme change must rebuild it.
    if (!setDetectedThemeScheme(scheme, source)) return
    deps.frames.resetHistoryCache()
    st.partialBlocksMemo = null
    deps.renderer.requestRender(true)
  }

  function handleTerminalControl(event: TerminalControlEvent): void {
    if (event.type === 'osc11-background') {
      applyDetectedTheme(schemeFromRgbColor(event.rgb), event.type)
      return
    }
    if (event.type === 'color-scheme') {
      applyDetectedTheme(event.scheme, event.type)
      // Mode 2031 may signal a palette change. Refresh the actual background
      // rather than replacing it with a possibly OS-derived scheme report.
      process.stdout.write('\x1b]11;?\x07')
      return
    }
    st.enhancedKeyboard?.handleControl(event)
  }
  const dispatchInputEvents = (events: KeyEvent[]) => {
    for (const event of events) {
      if (st.destroyed) break
      deps.keys.handleKey(event)
    }
  }
  const inputHandler = (data: Buffer | string) => {
    if (st.escapeFlushTimer) {
      clearTimeout(st.escapeFlushTimer)
      st.escapeFlushTimer = undefined
    }
    dispatchInputEvents(deps.terminalInput.write(data))
    if (deps.terminalInput.hasAmbiguousEscape) {
      st.escapeFlushTimer = setTimeout(() => {
        st.escapeFlushTimer = undefined
        dispatchInputEvents(deps.terminalInput.flushPending())
      }, 10)
    }
  }

  return { handleTerminalControl, inputHandler }
}
