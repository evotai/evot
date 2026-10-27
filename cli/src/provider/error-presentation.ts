/** Customer-facing provider failure vocabulary. No TUI, native, or DOM dependency.
 * Consumers retain the original error separately for diagnostics. Prefer a
 * structured category; string matching is only for historical error events.
 */
import { parsePrivacyStop } from '../privacy/notice.js'

export type ProviderFailureKind = 'connection' | 'timeout' | 'dns' | 'busy' | 'overloaded' | 'gateway' | 'gateway-no-backend' | 'rate-limit' | 'quota' | 'authentication' | 'invalid-request' | 'context-overflow' | 'configuration' | 'backend-version' | 'model-not-found' | 'not-found' | 'privacy-blocked' | 'privacy-unavailable' | 'unknown'

/** Who failed, when the gateway says so. Two parties only: the model
 * provider (the backend serving the model) or the gateway (the proxy in
 * between). It tells us in standard fields -- `error.code` (`provider_*` /
 * `gateway_*`), the message wording, and the HTTP status (500 is the
 * gateway's own; 502/503/504 are the provider's). */
function classifyByOrigin(text: string, status: number): ProviderFailureKind | undefined {
  if (/\bgateway_no_backend\b|the gateway has no available model backend/.test(text)) return 'gateway-no-backend'
  if (/\bgateway_(?:error|draining)\b|\bthe gateway (?:failed|is restarting)\b/.test(text)) return 'gateway'
  if (/\bprovider_overloaded\b|the model provider is temporarily overloaded/.test(text)) return 'overloaded'
  if (/\bprovider_timeout\b|the model provider did not respond in time/.test(text)) return 'timeout'
  if (/\bprovider_(?:error|unreachable|stream_interrupted)\b|\bthe model provider (?:failed|is temporarily unreachable|interrupted|ended)\b/.test(text)) return 'busy'
  if (status === 500) return 'gateway'
  return undefined
}

export function classifyProviderFailure(error: string): ProviderFailureKind {
  // Raised locally before anything was sent, whatever HTTP-ish words follow.
  const privacy = parsePrivacyStop(error)
  if (privacy) return privacy.kind === 'blocked' ? 'privacy-blocked' : 'privacy-unavailable'
  const text = error.toLowerCase()
  // Numeric values in error details (e.g. "minimum of 512 pixels")
  // are not HTTP statuses. Accept explicit markers or a leading bare code.
  const status = Number(text.match(/\bhttp(?:\/\d(?:\.\d)?)?\s+(\d{3})(?!\d)|\bstatus(?:_code|\s+code)?[\s:=]+(\d{3})(?!\d)|^\s*(\d{3})(?:\s|:|$)/)?.slice(1).find(Boolean))
  if (status === 401 || status === 403) return 'authentication'
  const origin = classifyByOrigin(text, status)
  if (origin) return origin
  if (/model_not_found|model not found/.test(text)) return 'model-not-found'
  if (status === 404 || /not_found_error/.test(text)) return 'not-found'
  if (/^invalid request:/.test(text)) return 'invalid-request'
  if (/configuration error:/.test(text)) return 'configuration'
  // Preserve the engine's overflow diagnosis before the generic HTTP 400 branch.
  if (/context overflow|context_length_exceeded|prompt is too long|request exceeds the model context window|maximum context length/.test(text)) return 'context-overflow'
  if (/quota|insufficient_quota|credit balance/.test(text)) return 'quota'
  if (status === 401 || status === 403 || /unauthorized|invalid.api.key|authentication|auth error|session_revoked/.test(text)) return 'authentication'
  if (status === 429 || /rate.limit|too many requests/.test(text)) return 'rate-limit'
  // Standard provider overload semantics, independent of gateway/vendor.
  // Do not label every transport failure or unknown 5xx as overload.
  if (status === 529 || /\boverloaded_error\b|\boverloaded\b/.test(text)) return 'overloaded'
  if (status >= 500 && status <= 599) return 'busy'
  if (status === 400 || status === 413 || status === 422 || /invalid_request_error/.test(text)) return 'invalid-request'
  if (/dns|enotfound|eai_again|failed to lookup|name resolution/.test(text)) return 'dns'
  if (/timed? ?out|timeout/.test(text)) return 'timeout'
  if (/tls|handshake|connection reset|econnreset|connection refused|econnrefused|network error|connect error/.test(text)) return 'connection'
  if (/server.error|service unavailable|bad gateway/.test(text)) return 'busy'
  return 'unknown'
}

const labels: Record<ProviderFailureKind, string> = {
  connection: 'Connection interrupted', timeout: 'Request timed out',
  dns: 'Unable to resolve service address',
  busy: 'Model provider unavailable',
  overloaded: 'Model provider overloaded',
  gateway: 'Gateway error, not the model provider',
  'gateway-no-backend': 'No backend available for this model',
  'rate-limit': 'Rate limited', quota: 'Quota unavailable',
  authentication: 'Authentication failed', 'invalid-request': 'Invalid request',
  'context-overflow': 'Context limit exceeded',
  configuration: 'Configuration error', 'backend-version': 'The model provider requires a newer client version than the gateway uses.',
  'model-not-found': 'Model not found', 'not-found': 'Resource not found',
  'privacy-blocked': 'Blocked by privacy masking · nothing was sent',
  'privacy-unavailable': 'Privacy masking unavailable · nothing was sent',
  unknown: 'Request failed',
}

export function providerFailurePresentation(input: {
  error?: string
  kind?: ProviderFailureKind
  sustained?: boolean
}): { kind: ProviderFailureKind; label: string } {
  const kind = input.kind ?? classifyProviderFailure(input.error ?? '')
  return {
    kind,
    label: input.sustained && kind === 'connection' ? 'Unable to connect' : labels[kind],
  }
}
