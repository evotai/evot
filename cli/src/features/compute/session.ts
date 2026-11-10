/** `/compute` orchestration: list window lifecycle, key handling, and the
 *  agent turns that add or edit a machine.
 *
 *  The REPL owns the terminal; this owns Compute behaviour. Everything the
 *  REPL must provide is named in `ComputeSessionHost`, as for /task.
 */

import { cpus, totalmem } from 'os'
import { basename } from 'path'
import { selectorFocusOn, selectorType, type SelectorState } from '../../ui/selector.js'
import type { KeyEvent } from '../../ui/keys.js'
import type { AskUserAnswer, AskUserQuestion, HostToolExtension } from '../host-tools.js'
import { buildCommandPrompt } from '../../session/command-envelope.js'
/** Type-only, so importing this module loads no native addon. */
import type { checkMachine, createMachine, deleteMachine, discoverMachines, listMachines, probeMachine, updateMachine } from './client.js'
import { handleComputeKey } from './control.js'
import { createComputeExtension } from './host-tool.js'
import { createComputeFlowState, createComputePrompt, updateComputePrompt, type ComputeFlowState, type ComputePromptContext } from './prompt.js'
import type { ComputeMachine } from './types.js'
import { createComputeWindow } from './window.js'

export interface ComputeSessionApi {
  list: typeof listMachines
  discover: typeof discoverMachines
  probe: typeof probeMachine
  create: typeof createMachine
  update: typeof updateMachine
  delete: typeof deleteMachine
  check: typeof checkMachine
}

const computeApi: ComputeSessionApi = {
  list: async () => (await import('./client.js')).listMachines(),
  discover: async () => (await import('./client.js')).discoverMachines(),
  probe: async target => (await import('./client.js')).probeMachine(target),
  create: async input => (await import('./client.js')).createMachine(input),
  update: async (id, patch) => (await import('./client.js')).updateMachine(id, patch),
  delete: async id => (await import('./client.js')).deleteMachine(id),
  check: async id => (await import('./client.js')).checkMachine(id),
}

export interface ComputeSessionHost {
  dimensions?: () => { columns: number; rows: number }
  /** True while the Compute list itself is the visible overlay. */
  isComputeOverlay: () => boolean
  computeOverlayState: () => SelectorState | null
  showSelector: (state: SelectorState) => void
  currentSessionId: () => string | null
  closeOverlay: () => void
  requestRender: () => void
  notifyError: (text: string) => void
  notify: (text: string) => void
  collectAnswers: (questions: AskUserQuestion[]) => Promise<AskUserAnswer[] | null>
  /** Show `userLine` as the user's turn, then run `prompt` with Compute tools. */
  runComputeTurn: (userLine: string, prompt: string, extension: HostToolExtension) => void
  cwd: () => string
  destroyed: () => boolean
}

/** `Apple M5 Pro · 15 CPUs · 24 GB` for the prompt's comparison baseline. */
export function localMachineLabel(): string {
  const list = cpus()
  const model = list[0]?.model.trim() ?? ''
  const memory = Math.round(totalmem() / 1024 ** 3)
  return [model, list.length ? `${list.length} CPUs` : '', memory ? `${memory} GB` : ''].filter(Boolean).join(' · ')
}

export class ComputeSession {
  #host: ComputeSessionHost
  #api: ComputeSessionApi
  #machines: ComputeMachine[] | null = null
  #listRequest: Promise<void> | null = null
  #loadError = false
  #revision = 0
  #pending = new Map<string, string>()
  #activeFlow: { flow: ComputeFlowState; extension: HostToolExtension; sessionId: string | null } | undefined
  #disposed = false
  #previewListener: (() => void) | null = null

  constructor(host: ComputeSessionHost, api: ComputeSessionApi = computeApi) {
    this.#host = host
    this.#api = api
  }

  dispose(): void {
    this.#disposed = true
  }

  /** The list as the `/compute` composer preview. */
  preview(onChange: () => void): { state: SelectorState; unmount: () => void } {
    this.#previewListener = onChange
    void this.#refresh()
    return {
      state: this.previewState(),
      unmount: () => {
        if (this.#previewListener === onChange) this.#previewListener = null
      },
    }
  }

  previewState(): SelectorState {
    return { ...this.#windowState(), listFocused: false }
  }

  /** `/compute`: the list, or straight into adding the first machine. */
  async command(userLine: string): Promise<void> {
    if (this.#disposed || this.#host.destroyed()) return
    if (this.#machines === null) await this.#refresh()
    if (this.#disposed || this.#host.destroyed()) return
    if (this.#machines !== null && this.#machines.length === 0 && !this.#loadError) {
      this.create(userLine, '')
      return
    }
    this.open()
  }

  open(focusId?: string): void {
    if (this.#disposed || this.#host.destroyed()) return
    this.#activeFlow = undefined
    this.#previewListener = null
    this.#loadError = false
    this.#paint(focusId, true)
    void this.#refresh()
  }

  /** `/compute <request>` or `n`: add a machine via an agent turn. */
  create(userLine: string, request: string): void {
    const flow = createComputeFlowState('create', request)
    this.#startFlow(flow, userLine, createComputePrompt(request, this.#promptContext()))
  }

  #startFlow(flow: ComputeFlowState, userLine: string, prompt: string): void {
    const extension = createComputeExtension({
      flow,
      collectAnswers: params => this.#host.collectAnswers(params.questions),
      // A saved change makes the cached list stale.
      persist: {
        create: async input => { const machine = await this.#api.create(input); this.#revision++; void this.#refresh(true); return machine },
        update: async (id, patch) => { const machine = await this.#api.update(id, patch); this.#revision++; void this.#refresh(true); return machine },
      },
      existingNames: () => (this.#machines ?? []).map(machine => machine.name),
      discover: this.#api.discover,
      probe: this.#api.probe,
    })
    if (this.#machines === null) void this.#refresh()
    this.#activeFlow = { flow, extension, sessionId: this.#host.currentSessionId() }
    this.#host.runComputeTurn(userLine, buildCommandPrompt({ name: 'compute', input: userLine, instructions: prompt }), extension)
  }

  bindFlowSession(sessionId: string, extension?: HostToolExtension): void {
    const active = this.#activeFlow
    if (active && active.extension === extension) active.sessionId = sessionId
  }

  followUpExtension(sessionId: string | null): HostToolExtension | undefined {
    const active = this.#activeFlow
    if (!active) return undefined
    if (active.flow.mutationAttempted || active.sessionId !== sessionId) {
      this.#activeFlow = undefined
      return undefined
    }
    return active.extension
  }

  cancelFlow(): boolean {
    const active = this.#activeFlow
    this.#activeFlow = undefined
    return Boolean(active && !active.flow.mutationAttempted)
  }

  unfinishedFlow(extension?: HostToolExtension): boolean {
    const active = this.#activeFlow
    return Boolean(active && active.extension === extension && !active.flow.mutationAttempted)
  }

  async handleKey(event: KeyEvent): Promise<void> {
    const state = this.#host.computeOverlayState()
    if (!state) return
    const size = this.#host.dimensions?.()
    const action = handleComputeKey(state, event, size?.columns, size?.rows)
    const focused = state.items[state.focusIndex]?.id
    if (state.listFocused === true && focused && this.#pending.has(focused) && event.type === 'char' && event.char === 'd') return
    switch (action.kind) {
      case 'none':
        return
      case 'update':
        this.#host.showSelector(action.state)
        this.#host.requestRender()
        return
      case 'close':
        this.#close()
        this.#host.requestRender()
        return
      case 'create':
        this.#close()
        this.create('/compute', '')
        return
      case 'edit': {
        const machine = this.#machines?.find(row => row.id === action.id)
        if (!machine || this.#pending.has(action.id)) return
        this.#close()
        const flow = createComputeFlowState('update', '', machine)
        this.#startFlow(flow, `/compute edit ${machine.name}`, updateComputePrompt(machine, this.#promptContext()))
        return
      }
      default:
        await this.#mutate(action.kind, action.id)
    }
  }

  async #mutate(kind: 'toggle' | 'check' | 'delete', id: string): Promise<void> {
    const machine = this.#machines?.find(row => row.id === id)
    if (!machine || this.#pending.has(id)) return
    this.#pending.set(id, kind === 'delete' ? 'Deleting…' : kind === 'toggle' ? 'Updating…' : 'Checking…')
    this.#revision++
    this.#paint()
    let nextFocus: string | undefined
    try {
      if (kind === 'toggle') {
        const updated = await this.#api.update(id, { enabled: !machine.enabled })
        this.#replace(updated)
      } else if (kind === 'check') {
        const checked = await this.#api.check(id)
        this.#replace(checked)
        const check = checked.last_check
        if (check && check.status !== 'ok' && !this.#disposed && !this.#host.destroyed()) {
          this.#host.notifyError(`${checked.name}: ${check.message || 'check failed'}`)
        }
      } else {
        await this.#api.delete(id)
        const rows = this.#machines ?? []
        const at = rows.findIndex(row => row.id === id)
        const state = this.#host.computeOverlayState()
        if (state?.items[state.focusIndex]?.id === id) nextFocus = rows[at + 1]?.id ?? rows[at - 1]?.id
        this.#machines = rows.filter(row => row.id !== id)
      }
    } catch (error) {
      if (!this.#disposed && !this.#host.destroyed()) {
        this.#host.notifyError(`Compute operation failed: ${message(error)}`)
      }
    } finally {
      this.#revision++
      this.#pending.delete(id)
      this.#paint(nextFocus)
    }
  }

  #replace(machine: ComputeMachine): void {
    if (!this.#machines) return
    this.#machines = this.#machines.map(row => row.id === machine.id ? machine : row)
  }

  /** One list request at a time; a mutation fences older snapshots. */
  #refresh(force = false): Promise<void> {
    if (this.#listRequest && !force) return this.#listRequest
    if (this.#pending.size || this.#disposed) return Promise.resolve()
    const revision = this.#revision
    const request = Promise.resolve().then(async () => {
      try {
        const machines = await this.#api.list()
        if (this.#disposed || this.#host.destroyed() || revision !== this.#revision) return
        this.#machines = machines
        this.#loadError = false
      } catch {
        if (this.#disposed || this.#host.destroyed() || revision !== this.#revision) return
        this.#loadError = true
      } finally {
        if (this.#listRequest === request) {
          this.#listRequest = null
          this.#paint()
        }
      }
    })
    this.#listRequest = request
    return request
  }

  #paint(focusId?: string, open = false): void {
    if (this.#disposed || this.#host.destroyed()) return
    if (!open && !this.#host.isComputeOverlay()) {
      this.#previewListener?.()
      return
    }
    const state = this.#windowState(focusId)
    const focusedId = state.items[state.focusIndex]?.id
    this.#host.showSelector(focusedId ? selectorFocusOn(state, row => row.id === focusedId) : state)
    this.#host.requestRender()
  }

  #windowState(focusId?: string): SelectorState {
    const current = this.#host.computeOverlayState()
    const focus = focusId ?? (current ? current.items[current.focusIndex]?.id : undefined)
    let state = createComputeWindow(this.#machines ?? [], focus)
    if (current?.presentation === 'browser') {
      state = { ...state, listFocused: current.listFocused }
      if (current.query) state = selectorType(state, current.query)
      if (focus) state = selectorFocusOn(state, row => row.id === focus)
    }
    if (this.#machines === null) {
      state.subtitle = ''
      state.emptyMessage = this.#loadError ? 'Could not load compute machines · reopen /compute to retry' : 'Loading compute machines…'
    } else if (this.#pending.size) state.subtitle = [...this.#pending.values()].join(' · ')
    else if (this.#loadError) state.subtitle = 'Could not refresh · reopen /compute to retry'
    if (current) {
      state.scrollOffset = current.scrollOffset
      if (current.items[current.focusIndex]?.id === focus && current.previewPane) {
        state.previewPane = { ...current.previewPane }
      }
      const armed = current.pendingDeleteId
      if (armed && !this.#pending.has(armed) && state.items.some(row => row.id === armed)) {
        state.pendingDeleteId = armed
        state.subtitle = current.subtitle
      }
    }
    for (const row of state.allItems) {
      if (row.id && this.#pending.has(row.id)) {
        row.detail = this.#pending.get(row.id)
        row.pendingAction = true
      }
    }
    return state
  }

  #close(): void {
    this.#host.closeOverlay()
  }

  #promptContext(): ComputePromptContext {
    return {
      localMachine: localMachineLabel(),
      project: basename(this.#host.cwd()) || this.#host.cwd(),
      existingNames: (this.#machines ?? []).map(machine => machine.name),
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
