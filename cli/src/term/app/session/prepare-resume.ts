import type { SessionMeta, TranscriptItem } from '../../../native/contracts/results.js'

export interface ResumeSource {
  loadResumeTranscript(sessionId: string): Promise<TranscriptItem[]>
  findSession(sessionId: string): Promise<SessionMeta | null>
}

/** Read-only preparation. Nothing in the live UI/session is changed until both
 * transcript and missing metadata have loaded successfully. */
export async function prepareResume(source: ResumeSource, requested: SessionMeta) {
  const transcript = await source.loadResumeTranscript(requested.session_id)
  const needsMetadata = !requested.model || !requested.provider
    || requested.thinking_level === undefined || !requested.cwd
  const full = needsMetadata ? await source.findSession(requested.session_id) : null
  return {
    transcript,
    model: requested.model || full?.model,
    provider: requested.provider || full?.provider,
    thinkingLevel: requested.thinking_level === undefined ? full?.thinking_level : requested.thinking_level,
    cwd: requested.cwd || full?.cwd,
  }
}
