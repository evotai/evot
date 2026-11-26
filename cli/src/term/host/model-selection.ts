import { modelChangeNotice, selectModelOption } from '../../features/models/options.js'
import type { Agent } from '../../native/index.js'
import { modelShareEvents } from '../../session/share-events.js'
import { errorText } from '../../ui/format.js'
import { renderErrorNotice } from '../../ui/command-notice.js'
import type { TermRenderer } from '../screen/renderer.js'
import type { RunController } from './run.js'
import type { ScrollbackController } from './scrollback.js'
import type { ReplState } from './state.js'

export interface ModelSelectionDeps {
  readonly agent: Agent
  readonly runCtl: RunController
  readonly refreshConfigInfo: () => void
  readonly scrollback: ScrollbackController
  readonly renderer: TermRenderer
}

/** Both pickers commit against the live REPL; neither owns a second selection. */
export function createModelSelectionController(st: ReplState, deps: ModelSelectionDeps) {
  function select(spec: string, level?: string): boolean {
    if (st.isLoading) return deps.runCtl.requestModelHandoff(spec, level)
    try {
      deps.agent.setProvider(spec)
      deps.refreshConfigInfo()
      const selected = selectModelOption(st.configInfo, spec)
      const model = selected?.model ?? deps.agent.model
      const provider = selected?.provider ?? st.configInfo?.provider ?? ''
      st.appState = { ...st.appState, model }
      // Apply effort against the new model's own ladder, as one picker gesture.
      let effort = st.configInfo?.thinkingLevel ?? ''
      if (level !== undefined && level !== effort) {
        const applied = deps.agent.setThinkingLevel(level)
        if (applied !== null) { deps.refreshConfigInfo(); effort = applied }
      }
      deps.scrollback.commitStatusLine({ id: 'sys-model', kind: 'system',
        ...modelChangeNotice(model, provider, effort, selected),
        shareEvents: modelShareEvents(provider, model, effort) })
      return true
    } catch (err) {
      deps.scrollback.commitSystem('sys-model-err', renderErrorNotice(`Failed to switch model: ${errorText(err)}`))
      return false
    } finally { deps.renderer.requestRender() }
  }
  return { select }
}
export type ModelSelectionController = ReturnType<typeof createModelSelectionController>
