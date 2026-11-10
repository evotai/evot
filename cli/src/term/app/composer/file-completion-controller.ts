import type { FileCompletionResult } from '../../../commands/file-completion.js'
import type { EditorState } from '../../input/editor.js'
import { acceptCompletion, closeCompletion, showCompletions } from '../../input/editor.js'

export type CompletionSearch = (beforeCursor: string, cwd: string, signal: AbortSignal) => Promise<FileCompletionResult | null>

/** Owns asynchronous file-search cancellation and stale-result rejection.
 * Applying the result is a projection; terminal rendering stays with the host. */
export class FileCompletion {
  private pending: AbortController | null = null
  private disposed = false

  constructor(private readonly search: CompletionSearch) {}

  dispose(): void {
    this.disposed = true
    this.pending?.abort()
    this.pending = null
  }

  async refresh(snapshot: EditorState, cwd: string, acceptSingle: boolean, current: () => EditorState, apply: (editor: EditorState) => void): Promise<void> {
    if (this.disposed) return
    this.pending?.abort()
    const controller = new AbortController()
    this.pending = controller
    const { cursorLine, cursorCol } = snapshot
    const before = snapshot.lines[cursorLine]?.slice(0, cursorCol) ?? ''
    try {
      const result = await this.search(before, cwd, controller.signal)
      if (this.disposed || controller.signal.aborted || this.pending !== controller) return
      const editor = current()
      if (editor.cursorLine !== cursorLine || editor.cursorCol !== cursorCol || editor.lines[cursorLine]?.slice(0, cursorCol) !== before) return
      if (!result) { apply(closeCompletion(editor)); return }
      const items = result.items.map(item => ({ label: item.label, value: item.value + (item.isDirectory ? '' : ' ') }))
      const next = showCompletions(editor, items, result.prefixStart, cursorCol, result.note)
      apply(acceptSingle && items.length === 1 ? acceptCompletion(next) : next)
    } catch {
      // File search is optional. Preserve the editor and any existing menu.
    } finally {
      if (this.pending === controller) this.pending = null
    }
  }
}
