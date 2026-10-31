import { array, boolean, json, nullable, object, oneOf, optional, text, uint, type Schema } from './schema.js'

/** `evot::privacy::PrivacySettings` as the addon publishes it. */
export type PrivacyAction = 'mask' | 'warn' | 'block'
export interface PrivacySettings {
  schema_version: number
  enabled: boolean
  secrets: boolean
  personal: boolean
  /** Absent before network kinds existed: off. */
  network?: boolean
  actions: Record<string, PrivacyAction>
  terms: string[]
  terms_any_case: boolean
  allow: string[]
}
export interface PrivacyKindStats { kind: string; values: number; verified?: number; masked: number; warned: number; blocked: number }
/** A kind the rule packs define; the CLI holds no list of its own. */
export interface PrivacyKind { kind: string; category: 'secret' | 'personal' | 'network' | 'custom' }
export interface PrivacyPack { id: string; rules: number; source?: string | null; license?: string | null }
/** One place in a request that held values. `label` is a command's description
 * or head, a path: taken after masking, never a piece of a value. */
export interface PrivacyOrigin { at: string; label?: string | null; n: number }
export interface PrivacyRuleCount { rule: string; values: number }
export interface PrivacyEvent {
  time: string; target: string; session?: string | null; blocked: boolean; kinds: string[]; reason: string
  /** Absent from records older than these fields. */
  provider?: string | null; model?: string | null; rules?: PrivacyRuleCount[]; origins?: PrivacyOrigin[]
}
export interface PrivacySummary {
  days: number
  requests: number
  blocked: number
  by_target: Record<string, { requests: number; blocked: number }>
  kinds: PrivacyKindStats[]
  recent: PrivacyEvent[]
}
/** One record as the running process made it; `tags` are placeholders, never values. */
export interface PrivacyLiveNotice extends PrivacyEvent { seq: number; tags: string[] }
export interface PrivacyLive { cursor: number; notices: PrivacyLiveNotice[] }
export interface PrivacyStatus { settings: PrivacySettings; summary: PrivacySummary; kinds: PrivacyKind[]; packs: PrivacyPack[] }

export const privacySettings = object({
  schema_version: uint, enabled: boolean, secrets: boolean, personal: boolean, network: optional(boolean),
  actions: json, terms: array(text), terms_any_case: boolean, allow: array(text),
}) as unknown as Schema<PrivacySettings>

const origin = object({ at: text, label: optional(nullable(text)), n: uint })
const ruleCount = object({ rule: text, values: uint })
const eventFields = {
  time: text, target: oneOf('llm', 'share', 'sync', 'task', 'task_report', 'delivery'), session: optional(nullable(text)),
  blocked: boolean, kinds: array(text), reason: text,
  provider: optional(nullable(text)), model: optional(nullable(text)), rules: optional(array(ruleCount)), origins: optional(array(origin)),
}
const event = object(eventFields)

const summary = object({
  days: uint, requests: uint, blocked: uint, by_target: json,
  kinds: array(object({ kind: text, values: uint, verified: optional(uint), masked: uint, warned: uint, blocked: uint })),
  recent: array(event),
}) as unknown as Schema<PrivacySummary>

export const privacyLive = object({
  cursor: uint,
  notices: array(object({ seq: uint, ...eventFields, tags: array(text) })),
}) as unknown as Schema<PrivacyLive>

const kinds = array(object({ kind: text, category: oneOf('secret', 'personal', 'network', 'custom') }))
const packs = array(object({ id: text, rules: uint, source: optional(nullable(text)), license: optional(nullable(text)) }))

export const privacyStatus = object({ settings: privacySettings, summary, kinds, packs }) as unknown as Schema<PrivacyStatus>

export const privacyTags: Schema<string[]> = array(text)
