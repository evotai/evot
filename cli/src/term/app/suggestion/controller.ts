import type { NativeSuggestion } from '../../../native/contracts/ports.js'
import type { SuggestionTrigger } from '../composer-guidance.js'
import type { SuggestionFeedback, SuggestionHints, SuggestionMessage, SuggestionPosition } from './types.js'
import { SuggestionCandidates } from './candidates.js'
import type { SuggestionSnapshot } from './context.js'
import { suggestionCommand } from './command.js'
import { readSuggestion } from './request.js'
import { SuggestionCache } from './cache.js'

interface Intent { key: string; context: SuggestionSnapshot; draft: string; cursor: number; trigger?: SuggestionTrigger }

/** Owns one cancellable side request and its result. It does not decide when
 * a state begins; triggers call `start` and may withdraw only their own work.
 * Explicit Tab can follow interruption or start a new session. Empty-composer
 * batches survive temporary typing; draft completions
 * remain bound to their exact text and cursor. */
export class PromptSuggestion {
  private generation = 0
  private request: NativeSuggestion | null = null
  private intent: Intent | null = null
  private batch: SuggestionCandidates | null = null
  private lastAutomaticAttempt = ''
  private explicit = false
  private waitingForNext = false
  private readonly cache = new SuggestionCache()
  private notice: Exclude<SuggestionFeedback, 'pending'> | undefined
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
  }) {}

  cancel(): void {
    const changed = Boolean(this.request || this.intent || this.batch || this.notice)
    this.generation++
    this.request?.abort()
    this.request = null
    this.intent = null
    this.batch = null
    this.notice = undefined
    this.explicit = false
    this.waitingForNext = false
    if (changed) this.host.changed()
  }

  /** Dismiss only a visible suggestion/notice or an explicit pending request.
   * An invisible automatic request must not swallow the task's Esc key. */
  dismiss(): boolean {
    // The quiet marker is not interactive; Esc must keep its normal meaning.
    if (!this.valid() || (!this.text() && (this.feedback() === undefined || this.feedback() === 'quiet'))) return false
    this.cancel()
    return true
  }

  /** Local Tab/Right routing invalidates draft-bound completions, not the
   * placeholder waiting underneath the user's temporary input. */
  yieldToLocalInput(): void {
    if (this.intent?.draft === '' && this.batch?.count()) this.reconcile()
    else this.cancel()
  }

  /** Background task transitions only invalidate speculative suggestions.
   * With a trigger, only automatic work started by that trigger is withdrawn. */
  cancelAutomatic(trigger?: SuggestionTrigger): void {
    if (this.explicit) return
    if (trigger && this.intent?.trigger !== trigger) return
    this.cancel()
  }

  /** Keys changed (login, model reload): automatic sampling may resume. */
  credentialsChanged(): void {
    this.credentialsRejected = false
  }

  /** Returns whether this state is handled: sampled now, already sampled, or
   * owned by explicit input. False means ineligible now; callers may retry. */
  start(trigger: SuggestionTrigger = 'answer'): boolean {
    if (this.explicit && this.valid()) return true
    if (this.credentialsRejected) return false
    if (!this.host.eligible() || this.host.automaticEligible?.() === false || (this.host.draft?.() ?? '')) return false
    const context = this.host.context()
    if (!context.automatic || (trigger === 'answer' && !context.answered)) return false
    const lastUser = context.messages.findLast(message => message.role === 'user')
    if (trigger === 'answer' && lastUser?.text.trimStart().startsWith('/')) return false
    const key = this.host.key()
    const attempt = JSON.stringify([key, trigger, context])
    if (attempt === this.lastAutomaticAttempt) return true
    this.cancel()
    this.lastAutomaticAttempt = attempt
    this.intent = { key, context, draft: '', cursor: 0, trigger }
    this.launch(false)
    return true
  }

  /** Explicit requests need neither a draft nor a final assistant answer.
   * No context/result still settles to visible feedback, never a silent no-op. */
  complete(draft: string, cursor = draft.length): void {
    if (!this.host.eligible() || cursor < 0 || cursor > draft.length) return
    if (draft.trimStart().startsWith('/') && !suggestionCommand(draft, cursor)) return
    if (this.valid() && this.request) return
    this.cancel()
    this.intent = { key: this.host.key(), context: this.host.context(), draft, cursor }
    this.explicit = true
    this.launch(true)
  }

  private current(): boolean {
    return (this.explicit || this.host.automaticEligible?.() !== false)
      && this.intent !== null && this.intent.key === this.host.key()
  }

  private valid(): boolean {
    return this.host.eligible() && this.current() && this.intent !== null
      && this.intent.draft === (this.host.draft?.() ?? '')
      && this.intent.cursor === (this.host.cursor?.() ?? this.intent.draft.length)
  }

  private launch(explicit: boolean): void {
    if (!this.valid() || this.request || !this.intent) return
    const { context, draft, cursor } = this.intent
    const prefix = draft.slice(0, cursor)
    const suffix = draft.slice(cursor)
    const command = suggestionCommand(draft, cursor)
    // All explicit input assistance uses the same literal suffix contract:
    // appending at the end is simply replacing an empty suffix.
    const generation = ++this.generation
    this.explicit = explicit
    this.notice = undefined
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
      const cacheKey = JSON.stringify([this.intent.key, context.messages, draft, cursor, hints])
      const cached = explicit ? this.cache.get(cacheKey) : undefined
      if (cached) {
        const batch = makeBatch(cached)
        if (batch.count()) { this.batch = batch; this.host.changed(); return }
      }
      const request = this.host.start(context.messages, hints)
      this.request = request
      this.host.changed()
      const result = readSuggestion(request, candidates => {
        if (generation !== this.generation || !this.valid()) return
        if (!candidates.length) {
          if (this.batch) { this.batch = null; this.waitingForNext = false; this.host.changed() }
          return
        }
        if (this.batch) {
          if (this.batch.append(candidates)) {
            if (this.waitingForNext && this.batch.count() > 1) {
              this.batch.next()
              this.waitingForNext = false
            }
            this.host.changed()
          }
        } else {
          const batch = makeBatch(candidates)
          if (batch.count()) { this.batch = batch; this.host.changed() }
        }
      })
      void result.then(outcome => {
        if (generation !== this.generation) return
        this.request = null
        if (!this.valid()) { this.cancel(); return }
        if (this.batch) this.batch.finish(outcome.candidates)
        else this.batch = makeBatch(outcome.candidates)
        if (outcome.status === 'unauthorized') {
          if (!this.credentialsRejected) this.host.unauthorized?.()
          this.credentialsRejected = true
        } else if (outcome.status === 'ready' || outcome.status === 'empty') {
          this.credentialsRejected = false
        }
        if (this.batch.count()) {
          if (this.waitingForNext && this.batch.count() > 1) this.batch.next()
          this.notice = undefined
          if (outcome.status === 'ready') this.cache.put(cacheKey, this.batch.values())
        } else {
          this.batch = null
          // Automatic sampling stays silent on failures; an honest "nothing to
          // suggest" is worth a faint marker so idle is not mistaken for broken.
          if (outcome.status === 'ready' || outcome.status === 'empty') this.notice = this.explicit ? 'none' : 'quiet'
          else this.notice = this.explicit ? outcome.status : undefined
        }
        this.waitingForNext = false
        this.host.changed()
      }).catch(() => this.failed(generation))
    } catch {
      this.failed(generation)
    }
  }

  private failed(generation: number): void {
    if (generation !== this.generation) return
    this.request?.abort()
    this.request = null
    this.batch = null
    this.waitingForNext = false
    if (this.explicit) this.notice = 'failed'
    this.host.changed()
  }

  reconcile(): void {
    if (!this.intent || this.valid()) return
    if (this.current() && this.intent.draft === '' && this.batch?.count()) {
      // Local completion/command windows temporarily own the composer, just
      // like a nonempty draft. Neither should discard its empty-input batch.
      // Stop streaming so late results cannot replace the restored selection.
      if (!this.request && !this.notice && !this.waitingForNext) return
      this.generation++
      this.request?.abort()
      this.request = null
      this.notice = undefined
      this.waitingForNext = false
      this.host.changed()
      return
    }
    this.cancel()
  }

  feedback(): SuggestionFeedback | undefined {
    if (!this.valid()) return undefined
    return this.pending() ? 'pending' : this.notice
  }

  isExplicit(): boolean { return this.valid() && this.explicit }
  pending(): boolean { return this.isExplicit() && this.request !== null && (!this.batch?.count() || this.waitingForNext) }
  exhausted(): boolean { return this.feedback() === 'none' }
  completing(): boolean { return Boolean(this.intent?.draft) && this.valid() && Boolean(this.batch?.count()) }
  replacing(): boolean { return this.valid() && this.intent !== null && this.intent.cursor < this.intent.draft.length }
  text(): string { return this.valid() ? this.batch?.text() ?? '' : '' }
  position(): SuggestionPosition { return this.valid() && this.batch ? this.batch.position() : { current: 1, total: 1 } }

  /** Cycle a cached batch; retries are only possible with no usable batch. */
  next(): boolean {
    if (!this.valid()) return false
    if (this.request && this.batch?.count() === 1) {
      this.explicit = true
      this.waitingForNext = true
      this.host.changed()
      return true
    }
    if (this.batch?.next()) {
      this.explicit = true
      this.host.changed()
      return true
    }
    if (this.request) {
      this.explicit = true
      this.host.changed()
      return true
    }
    if (this.intent) this.intent.context = this.host.context()
    this.launch(true)
    return true
  }

  take(): string {
    const text = this.text()
    this.cancel()
    return text
  }
}
