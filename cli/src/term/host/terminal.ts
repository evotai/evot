import type { FrameController } from './frame.js'
import type { KeysController } from './keys.js'
import type { ReplState } from './state.js'
import type { TerminalInputBuffer } from '../input/buffer.js'
import type { TermRenderer } from '../screen/renderer.js'
import { enableRawMode, enableEnhancedKeyboard, type KeyEvent, type TerminalControlEvent } from '../../ui/keys.js'
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
  start(): void
  stop(): void
  suspend(): void
  resume(): void
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
      if (st.destroyed || st.terminalSuspended) break
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

  function acquire(): void {
    st.disableRaw = enableRawMode(process.stdin)
    st.onInputData = inputHandler
    process.stdin.on('data', inputHandler)
    st.enhancedKeyboard = enableEnhancedKeyboard(process.stdout)
    process.stdout.write('\x1b]11;?\x07\x1b[?996n\x1b[?2031h\x1b[?2004h')
  }
  function release(): void {
    if (st.escapeFlushTimer) { clearTimeout(st.escapeFlushTimer); st.escapeFlushTimer = undefined }
    if (st.onInputData) {
      process.stdin.off('data', st.onInputData)
      deps.terminalInput.discard()
    }
    st.onInputData = null
    process.stdout.write('\x1b[?2004l\x1b[?2031l')
    st.enhancedKeyboard?.dispose()
    st.enhancedKeyboard = null
    st.disableRaw?.()
    st.disableRaw = null
  }
  function start(): void {
    st.terminalSuspended = false
    acquire()
    if (process.platform !== 'win32') {
      process.on('SIGCONT', resume)
      process.on('SIGTSTP', suspend)
    }
  }
  function stop(): void {
    process.off('SIGCONT', resume)
    process.off('SIGTSTP', suspend)
    release()
  }
  function suspend(): void {
    if (st.destroyed || st.terminalSuspended || process.platform === 'win32' || !process.stdin.isTTY) return
    st.terminalSuspended = true
    release()
    deps.renderer.suspend()
    // Stop only this process, not the detached work it owns. SIGSTOP also
    // works in orphaned PTY process groups where default SIGTSTP is ignored.
    try { process.kill(process.pid, 'SIGSTOP') }
    catch { /* Restore ownership below if this runtime cannot stop itself. */ }
    finally {
      // kill(self, SIGSTOP) returns after continuation. Do not depend only
      // on a later SIGCONT callback: releasing stdin can leave no ref'ed I/O.
      resume()
    }
  }
  function resume(): void {
    if (st.destroyed || !st.terminalSuspended) return
    st.terminalSuspended = false
    acquire()
    deps.renderer.resume()
  }
  return { start, stop, suspend, resume, handleTerminalControl, inputHandler }
}
