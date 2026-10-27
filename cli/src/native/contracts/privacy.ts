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
  /** Hosts, `*.suffix`, `tool:NAME` or `*` a tool call may send a secret to. Absent before the egress guard: none. */
  egress_allow?: string[]
}
export interface PrivacyKindStats { kind: string; values: number; verified?: number; masked: number; warned: number; blocked: number }
/** A kind the rule packs define; the CLI holds no list of its own. */
export interface PrivacyKind { kind: string; category: 'secret' | 'personal' | 'network' | 'custom' }
export interface PrivacyPack { id: string; rules: number; source?: string | null; license?: string | null }
export interface PrivacyEvent { time: string; target: string; session?: string | null; tool?: string | null; blocked: boolean; kinds: string[]; reason: string }
export interface PrivacySummary {
  days: number
  requests: number
  blocked: number
  by_target: Record<string, { requests: number; blocked: number }>
  kinds: PrivacyKindStats[]
  recent: PrivacyEvent[]
}
export interface PrivacyStatus { settings: PrivacySettings; summary: PrivacySummary; kinds: PrivacyKind[]; packs: PrivacyPack[] }

export const privacySettings = object({
  schema_version: uint, enabled: boolean, secrets: boolean, personal: boolean, network: optional(boolean),
  actions: json, terms: array(text), terms_any_case: boolean, allow: array(text),
  egress_allow: optional(array(text)),
}) as unknown as Schema<PrivacySettings>

const summary = object({
  days: uint, requests: uint, blocked: uint, by_target: json,
  kinds: array(object({ kind: text, values: uint, verified: optional(uint), masked: uint, warned: uint, blocked: uint })),
  recent: array(object({
    time: text, target: oneOf('llm', 'share', 'sync', 'task', 'task_report', 'delivery', 'egress'), session: optional(nullable(text)),
    tool: optional(nullable(text)), blocked: boolean, kinds: array(text), reason: text,
  })),
}) as unknown as Schema<PrivacySummary>

const kinds = array(object({ kind: text, category: oneOf('secret', 'personal', 'network', 'custom') }))
const packs = array(object({ id: text, rules: uint, source: optional(nullable(text)), license: optional(nullable(text)) }))

export const privacyStatus = object({ settings: privacySettings, summary, kinds, packs }) as unknown as Schema<PrivacyStatus>
