import type { NativeSuggestion } from '../../../native/contracts/ports.js'
import type { SkillEntry } from '../../../commands/skill/scan.js'
import type { SuggestionTrigger } from '../composer/composer-guidance.js'
import type { SuggestionFeedback, SuggestionHints, SuggestionMessage, SuggestionPosition } from './types.js'
import { SuggestionCandidates } from './candidates.js'
import type { SuggestionSnapshot } from './context.js'
import { suggestionCommand } from '../composer/command-usage.js'
import { readSuggestion } from './request.js'
import { SuggestionCache } from './cache.js'

type Slot = 'placeholder' | 'completion'
interface Intent {
  slot: Slot
  key: string
  context: SuggestionSnapshot
  draft: string
  cursor: number
  trigger?: SuggestionTrigger
  explicit: boolean
  request?: NativeSuggestion
  batch?: SuggestionCandidates
  notice?: Exclude<SuggestionFeedback, 'pending'>
  waitingForNext?: boolean
}

/** The empty composer and a typed draft have different lifetimes. A draft or
 * overlay may hide the conversation's suggestion, even while it's streaming.
 * Assistance for a draft is bound to its exact text and cursor. */
export class PromptSuggestion {
  private placeholder: Intent | undefined
  private completion: Intent | undefined
  private lastAutomaticAttempt = ''
  private deferred: { key: string; trigger: SuggestionTrigger } | null = null
  private readonly cache = new SuggestionCache()
  /** The route rejected its key. Automatic sampling pauses (the same key
   * cannot succeed on the next pause) until an explicit retry succeeds or the
   * host reports a credential change. */
  private credentialsRejected = false

  constructor(private readonly host: {
    key(): string
    eligible(): boolean
    /** Automatic sampling follows task state; explicit Tab does not. */
    automaticEligible?(): boolean
    context(): SuggestionSnapshot
    allowsCommand?(text: string): boolean
    validate?(text: string): boolean
    identity?(text: string): string | undefined
    start(messages: SuggestionMessage[], hints?: SuggestionHints): NativeSuggestion
    changed(): void
    /** Fired once per rejection episode so the user learns why completions stopped. */
    unauthorized?(): void
    draft?(): string
    cursor?(): number
    skills?(): readonly SkillEntry[]
  }) {}

  cancel(): void {
    this.deferred = null
    const { placeholder, completion } = this
    this.placeholder = this.completion = undefined
    placeholder?.request?.abort()
    completion?.request?.abort()
    if (placeholder || completion) this.host.changed()
  }

  private drop(slot: Slot): void {
    const intent = this[slot]
    if (!intent) return
    this[slot] = undefined
    intent.request?.abort()
    this.host.changed()
  }

  /** Dismiss only a visible suggestion/notice or an explicit pending request.
   * An invisible automatic request must not swallow the task's Esc key. */
  dismiss(): boolean {
    const intent = this.visible()
    if (!intent || (!intent.batch?.text() && !this.isPending(intent) && (!intent.notice || intent.notice === 'quiet'))) return false
    this.drop(intent.slot)
    if (intent.slot === 'placeholder') this.deferred = null
    return true
  }

  /** Local Tab/Right routing invalidates only draft-bound completions. */
  yieldToLocalInput(): void { this.drop('completion') }

  /** Background task transitions only invalidate speculative suggestions.
   * With a trigger, only automatic work started by that trigger is withdrawn. */
  cancelAutomatic(trigger?: SuggestionTrigger): void {
    if (!trigger || this.deferred?.trigger === trigger) this.deferred = null
    if (!this.placeholder?.explicit && (!trigger || this.placeholder?.trigger === trigger)) this.drop('placeholder')
  }

  /** Catalog changes only invalidate draft-bound command arguments. */
  cancelCommand(): void {
    if (this.completion?.draft.trimStart().startsWith('/')) this.drop('completion')
  }

  /** Keys changed (login, model reload): automatic sampling may resume. */
  credentialsChanged(): void {
    this.credentialsRejected = false
  }

  /** Returns whether this state is handled: sampled now, already sampled, or
   * owned by explicit input. False means ineligible now; callers may retry. */
  start(trigger: SuggestionTrigger = 'answer'): boolean {
    if (this.placeholder?.explicit && this.visible() === this.placeholder) return true
    if (this.credentialsRejected || this.host.automaticEligible?.() === false) return false
    if (!this.host.eligible() || this.host.draft?.()) {
      // Single-shot triggers can arrive while a draft or menu is open.
      this.deferred = { key: this.host.key(), trigger }
      return false
    }
    this.deferred = null
    const context = this.host.context()
    // A completed model turn can come from a skill invocation; the displayed
    // slash prefix doesn't distinguish it from a local command.
    if (!context.automatic || (trigger === 'answer' && !context.answered)) return false
    const key = this.host.key()
    const attempt = JSON.stringify([key, trigger, context])
    if (attempt === this.lastAutomaticAttempt) return true
    this.lastAutomaticAttempt = attempt
    this.begin({ slot: 'placeholder', key, context, draft: '', cursor: 0, trigger, explicit: false })
    return true
  }

  /** Explicit requests need neither a draft nor a final assistant answer.
   * A draft completion does not replace the empty composer's suggestion. */
  complete(draft: string, cursor = draft.length): void {
    if (!this.host.eligible() || cursor < 0 || cursor > draft.length) return
    if (draft.trimStart().startsWith('/') && !suggestionCommand(draft, cursor, this.host.skills?.())) return
    if (this.visible()?.request) return
    const slot = draft ? 'completion' : 'placeholder'
    this.begin({ slot, key: this.host.key(), context: this.host.context(), draft, cursor, explicit: true })
  }

  private begin(intent: Intent): void {
    this.drop(intent.slot)
    this[intent.slot] = intent
    this.launch(intent)
  }

  private visible(): Intent | undefined {
    const draft = this.host.draft?.() ?? ''
    const intent = draft ? this.completion : this.placeholder
    if (intent && this.host.eligible() && intent.key === this.host.key()
      && (intent.explicit || this.host.automaticEligible?.() !== false)
      && intent.draft === draft && intent.cursor === (this.host.cursor?.() ?? draft.length)) return intent
  }

  private acceptsResult(intent: Intent): boolean {
    return this[intent.slot] === intent && (intent.slot === 'placeholder' ? intent.key === this.host.key() : this.visible() === intent)
  }

  private launch(intent: Intent): void {
    if (intent.request || this.visible() !== intent) return
    const { context, draft, cursor, explicit } = intent
    const prefix = draft.slice(0, cursor)
    const suffix = draft.slice(cursor)
    const command = suggestionCommand(draft, cursor, this.host.skills?.())
    // All explicit input assistance uses the same literal suffix contract:
    // appending at the end is simply replacing an empty suffix.
    intent.notice = undefined
    try {
      const hints: SuggestionHints = {
        ...(explicit ? { explicit: true } : {}),
        // Keep the legacy field for older addons; current readers use workflow.
        activity: context.workflow.runtime.execution === 'retrying' ? 'running' : context.workflow.runtime.execution,
        workflow: context.workflow,
        ...(prefix ? { draft: prefix } : {}),
        ...(explicit ? { suffix } : {}),
        ...(command ? { command } : {}),
      }
      const makeBatch = (candidates: unknown) => new SuggestionCandidates(candidates, prefix,
        text => this.host.allowsCommand?.(text) ?? false,
        explicit ? { suffix, ...(command ? { command: command.name } : {}) } : undefined,
        text => this.host.validate?.(text) ?? true, text => this.host.identity?.(text))
      const cacheKey = JSON.stringify([intent.key, context.messages, draft, cursor, hints])
      const cached = explicit ? this.cache.get(cacheKey) : undefined
      if (cached) {
        const batch = makeBatch(cached)
        if (batch.count()) { intent.batch = batch; this.host.changed(); return }
      }
      const request = this.host.start(context.messages, hints)
      intent.request = request
      this.host.changed()
      const result = readSuggestion(request, candidates => {
        if (intent.request !== request || !this.acceptsResult(intent)) return
        if (!candidates.length) {
          if (intent.batch) { intent.batch = undefined; intent.waitingForNext = false; this.host.changed() }
          return
        }
        if (intent.batch) {
          if (intent.batch.append(candidates)) {
            this.advanceWaiting(intent)
            this.host.changed()
          }
        } else {
          const batch = makeBatch(candidates)
          if (batch.count()) { intent.batch = batch; this.host.changed() }
        }
      })
      void result.then(outcome => {
        if (this[intent.slot] !== intent || intent.request !== request) return
        intent.request = undefined
        if (!this.acceptsResult(intent)) { this.drop(intent.slot); return }
        if (intent.batch) intent.batch.finish(outcome.candidates)
        else intent.batch = makeBatch(outcome.candidates)
        if (outcome.status === 'unauthorized') {
          if (!this.credentialsRejected) this.host.unauthorized?.()
          this.credentialsRejected = true
        } else if (outcome.status === 'ready' || outcome.status === 'empty') {
          this.credentialsRejected = false
        }
        if (intent.batch.count()) {
          this.advanceWaiting(intent)
          if (outcome.status === 'ready') this.cache.put(cacheKey, intent.batch.values())
        } else {
          intent.batch = undefined
          // Automatic failures stay silent; an empty result gets a quiet marker.
          if (outcome.status === 'ready' || outcome.status === 'empty') intent.notice = intent.explicit ? 'none' : 'quiet'
          else intent.notice = intent.explicit ? outcome.status : undefined
        }
        intent.waitingForNext = false
        this.host.changed()
      }).catch(() => this.failed(intent))
    } catch {
      this.failed(intent)
    }
  }

  private advanceWaiting(intent: Intent): void {
    if (intent.waitingForNext && intent.batch && intent.batch.count() > 1) {
      intent.batch.next()
      intent.waitingForNext = false
    }
  }

  private failed(intent: Intent): void {
    if (this[intent.slot] !== intent) return
    if (!this.acceptsResult(intent)) { this.drop(intent.slot); return }
    intent.request?.abort()
    intent.request = undefined
    intent.batch = undefined
    intent.waitingForNext = false
    if (intent.explicit) intent.notice = 'failed'
    this.host.changed()
  }

  reconcile(): void {
    if (this.placeholder && !this.acceptsResult(this.placeholder)) this.drop('placeholder')
    if (this.completion && !this.acceptsResult(this.completion)) this.drop('completion')
    if (this.deferred) {
      const { key, trigger } = this.deferred
      if (key !== this.host.key()) this.deferred = null
      else if (this.host.automaticEligible?.() !== false && this.host.eligible() && !this.host.draft?.()) {
        this.deferred = null
        this.start(trigger)
      }
    }
  }

  feedback(): SuggestionFeedback | undefined {
    const intent = this.visible()
    return intent && (this.isPending(intent) ? 'pending' : intent.notice)
  }

  private isPending(intent: Intent): boolean {
    return intent.explicit && !!intent.request && (!intent.batch?.count() || intent.waitingForNext === true)
  }

  isExplicit(): boolean { return this.visible()?.explicit ?? false }
  pending(): boolean { const intent = this.visible(); return !!intent && this.isPending(intent) }
  exhausted(): boolean { return this.feedback() === 'none' }
  completing(): boolean { const intent = this.visible(); return intent?.slot === 'completion' && Boolean(intent.batch?.count()) }
  replacing(): boolean { const intent = this.visible(); return !!intent && intent.cursor < intent.draft.length }
  text(): string { return this.visible()?.batch?.text() ?? '' }
  candidates(): readonly string[] { return this.visible()?.batch?.values() ?? [] }
  position(): SuggestionPosition { return this.visible()?.batch?.position() ?? { current: 1, total: 1 } }

  /** Cycle a cached batch; retries are only possible with no usable batch. */
  next(): boolean {
    const intent = this.visible()
    if (!intent) return false
    const { batch, request } = intent
    intent.explicit = true
    if (request && batch?.count() === 1) intent.waitingForNext = true
    else {
      const cycled = batch?.next()
      if (!cycled && !request) {
        intent.context = this.host.context()
        this.launch(intent)
        return true
      }
    }
    this.host.changed()
    return true
  }

  take(): string {
    const intent = this.visible()
    if (!intent) return ''
    const text = intent.batch?.text() ?? ''
    this.drop(intent.slot)
    return text
  }
}
