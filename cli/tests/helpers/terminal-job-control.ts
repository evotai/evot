// Real TTY subprocess used by terminal.test.ts; no addon or model connection.
import { createTerminalController, type TerminalDeps } from '../../src/term/host/terminal.js'
import type { ReplState } from '../../src/term/host/state.js'
import { TermRenderer } from '../../src/term/screen/renderer.js'
import { createEditorState, getEditorText, insertText } from '../../src/term/input/editor.js'
import { TerminalInputBuffer } from '../../src/term/input/buffer.js'
import type { KeyEvent } from '../../src/ui/keys.js'

const st = { destroyed: false, terminalSuspended: false, enhancedKeyboard: false,
  editor: insertText(createEditorState(), 'saved draft') } as ReplState
const renderer = new TermRenderer()
renderer.init()
renderer.setRenderCallback(() => [getEditorText(st.editor)])
const terminal = createTerminalController(st, {
  renderer, terminalInput: new TerminalInputBuffer(), frames: { resetHistoryCache: () => {} },
  keys: { handleKey: (event: KeyEvent) => {
    if (event.type === 'ctrl' && event.key === 'z') terminal.suspend()
    if (event.type === 'char' && event.char === '!') process.stdout.write(`CHECK:${getEditorText(st.editor)}:${process.stdin.isRaw}\n`)
    if (event.type === 'char' && event.char === 'q') { st.destroyed = true; terminal.stop(); renderer.destroy(); process.exit(0) }
  } },
} as unknown as TerminalDeps)
terminal.start()
process.stdout.write('JOB-CONTROL-READY\n')
