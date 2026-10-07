/** Outcomes of cloud session sync. Decisions for the user (diverged, local
 *  ahead) arrive as data so the REPL can offer a choice instead of failing. */
import { array, boolean, nullable, object, oneOf, optional, tagged, text, uint } from './schema.js'
import { cloudSync, sessionMeta, type CloudSync, type SessionMeta } from './results.js'

export type CloudPushResult =
  | { kind: 'synced'; cloud: CloudSync; pushed: number }
  | { kind: 'diverged'; local_seq: number; remote_seq: number }
  | { kind: 'not_shared' }
export const cloudPushResult = tagged('kind', {
  synced: object({ kind: oneOf('synced'), cloud: cloudSync, pushed: uint }),
  diverged: object({ kind: oneOf('diverged'), local_seq: uint, remote_seq: uint }),
  not_shared: object({ kind: oneOf('not_shared') }),
}) as import('./schema.js').Schema<CloudPushResult>

/** One tick of a long push: after each batch the server acknowledged. */
export interface CloudPushProgress {
  uploaded_entries: number
  total_entries: number
  batch: number
  batches: number
}
export const cloudPushProgress = object({
  uploaded_entries: uint, total_entries: uint, batch: uint, batches: uint,
}) as import('./schema.js').Schema<CloudPushProgress>

export type CloudPullResult =
  | { kind: 'pulled'; meta: SessionMeta; appended: number }
  | { kind: 'up_to_date' }
  | { kind: 'local_ahead'; local_seq: number; remote_seq: number }
  | { kind: 'diverged'; local_seq: number; remote_seq: number }
export const cloudPullResult = tagged('kind', {
  pulled: object({ kind: oneOf('pulled'), meta: sessionMeta, appended: uint }),
  up_to_date: object({ kind: oneOf('up_to_date') }),
  local_ahead: object({ kind: oneOf('local_ahead'), local_seq: uint, remote_seq: uint }),
  diverged: object({ kind: oneOf('diverged'), local_seq: uint, remote_seq: uint }),
}) as import('./schema.js').Schema<CloudPullResult>

/** One row of the owner's remote index: metadata only, never entries. */
export interface RemoteSession {
  session_id: string
  meta: SessionMeta
  seq: number
  visibility: 'private' | 'public'
  origin_host?: string
  updated_at?: string
  public_url?: string | null
  /** Team page; absent from older servers and addons. */
  team?: boolean
  team_url?: string | null
  team_name?: string | null
}
export const remoteSessions = array(object({
  session_id: text, meta: sessionMeta, seq: uint, visibility: oneOf('private', 'public'),
  origin_host: optional(text), updated_at: optional(text), public_url: optional(nullable(text)),
  team: optional(boolean), team_url: optional(nullable(text)), team_name: optional(nullable(text)),
})) as import('./schema.js').Schema<RemoteSession[]>
