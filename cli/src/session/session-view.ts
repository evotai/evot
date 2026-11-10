import type { SessionMeta } from '../native/index.js'
import type { OutputLine } from '../render/output.js'
import type { UIMessage } from '../render/message-types.js'

/** Default number of most-recent messages painted to scrollback on resume. */
export const RESUME_DISPLAY_LIMIT = 80

export function shouldPreloadStartupSessions(opts: { continueLatest?: boolean; resumeSessionId?: string; forkFrom?: unknown }): boolean {
  return Boolean(opts.continueLatest || opts.resumeSessionId || opts.forkFrom)
}

export function findPreviousSession(preloaded: SessionMeta[], cwd: string): SessionMeta | undefined {
  return [...preloaded]
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .find(s => s.cwd === cwd && s.source !== 'automation')
}

/**
 * Select which messages to paint on resume. Rendering the whole transcript
 * re-runs markdown per message (O(total), ~500ms on very long sessions), so we
 * keep only the most recent `limit`. Hidden messages stay in the model's
 * context — the backend restores it by session_id, independent of this display
 * transcript — so this trims what's painted, not what the model remembers.
 */
export function selectResumeMessages(
  messages: UIMessage[],
  limit: number = RESUME_DISPLAY_LIMIT,
): { shown: UIMessage[]; hidden: number } {
  const hidden = Math.max(0, messages.length - limit)
  return {
    shown: hidden > 0 ? messages.slice(-limit) : messages,
    hidden,
  }
}

/** System notice shown above the resumed transcript when older messages are hidden. */
export function resumeElidedLine(hidden: number, limit: number = RESUME_DISPLAY_LIMIT): OutputLine {
  const plural = hidden === 1 ? '' : 's'
  return {
    id: 'sys-resumed-elided',
    kind: 'system',
    text: `  … ${hidden} earlier message${plural} hidden (still in context) · showing the latest ${limit}`,
  }
}

/**
 * Notice when a session's saved provider/model cannot be restored (e.g. the
 * channel was removed from config). Resume still loads the transcript and keeps
 * the live model so the user can switch with /model.
 */
export function resumeModelUnavailableNote(opts: {
  provider?: string
  model?: string
  keptModel: string
}): string {
  if (opts.provider) {
    return `  provider '${opts.provider}' unavailable · kept ${opts.keptModel} · /model to switch`
  }
  return `  model '${opts.model ?? ''}' unavailable · kept ${opts.keptModel} · /model to switch`
}

/**
 * Reload a resumed session's model from current config, then reapply the
 * session's recorded thinking level over the config default (pi precedence:
 * session wins on resume). Unsupported levels keep the config-applied value.
 */
export function reloadResumeModel(
  agent: {
    model: string
    reloadProvider(spec: string): boolean
    restoreThinkingLevel(level: string): void
  },
  model?: string,
  provider?: string,
  thinkingLevel?: string | null,
): string | null {
  let note: string | null = null
  if (model) {
    const preferred = provider ? `${provider}:${model}` : model
    try {
      if (!agent.reloadProvider(preferred)) {
        note = resumeModelUnavailableNote({ provider, model, keptModel: agent.model })
      }
    } catch {
      // Keep the current live selection and show the same recovery hint.
      note = resumeModelUnavailableNote({ provider, model, keptModel: agent.model })
    }
  }
  if (thinkingLevel) {
    try {
      agent.restoreThinkingLevel(thinkingLevel)
    } catch {
      // Keep the config-applied level.
    }
  }
  return note
}
