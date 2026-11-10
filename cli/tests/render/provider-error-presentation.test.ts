import { expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { providerFailurePresentation } from '../../src/render/provider-error.js'
import { buildLlmCard } from '../../src/render/output.js'
import { createSpinnerState, formatSpinnerLine, setLongWait, setRetryWait } from '../../src/term/widgets/spinner.js'

test('provider failure vocabulary is reusable without terminal-specific output', () => {
  for (const [error, label] of [
    ['Network error: tls handshake eof https://private.invalid/key', 'Connection interrupted'],
    ['request timed out', 'Request timed out'],
    ['DNS lookup failed', 'Unable to resolve service address'],
    ['HTTP 529 overloaded', 'Model provider overloaded'], ['HTTP 429', 'Rate limited'],
    ['invalid API key', 'Authentication failed'], ['Auth error: session_revoked', 'Authentication failed'], ['insufficient_quota', 'Quota unavailable'],
  ]) {
    const copy = providerFailurePresentation({ error })
    expect(copy.label).toBe(label)
    expect(copy.label).not.toContain('https:')
    expect(copy.label).not.toContain('\x1b')
  }
  expect(providerFailurePresentation({ kind: 'busy', error: 'tls' }).label).toBe('Model provider unavailable')
  expect(providerFailurePresentation({ kind: 'backend-version' }).label).toBe('The model provider requires a newer client version than the gateway uses.')
})

test('the gateway tells us who failed; the copy says so and nothing more', () => {
  const GATEWAY = 'Gateway error, not the model provider'
  const PROVIDER = 'Model provider unavailable'
  const NO_BACKEND = 'No backend available for this model'
  const cases: Array<[string, string, string]> = [
    // explicit codes (OpenAI dialect)
    ['HTTP 502: {"error":{"type":"server_error","code":"provider_error","message":"The model provider failed to process this request. Please retry."}}', 'busy', PROVIDER],
    ['HTTP 503: {"error":{"code":"provider_overloaded","message":"PRIVATE_BACKEND"}}', 'overloaded', 'Model provider overloaded'],
    ['HTTP 504: provider_timeout', 'timeout', 'Request timed out'],
    ['provider_stream_interrupted: The model provider interrupted the response stream.', 'busy', PROVIDER],
    ['HTTP 500: {"error":{"code":"gateway_error","message":"The gateway failed to process this request."}}', 'gateway', GATEWAY],
    ['HTTP 503: gateway_no_backend', 'gateway-no-backend', NO_BACKEND],
    ['HTTP 503: gateway_draining: The gateway is restarting.', 'gateway', GATEWAY],
    // Anthropic dialect has no code: the wording carries it
    ['HTTP 502: api_error: The model provider is temporarily unreachable. Please retry.', 'busy', PROVIDER],
    ['HTTP 500: api_error: The gateway failed to process this request. Please retry; if it persists, contact the gateway operator.', 'gateway', GATEWAY],
    ["HTTP 503: The gateway has no available model backend for 'x' right now.", 'gateway-no-backend', NO_BACKEND],
    // status alone: 500 is the gateway's own, 502/503/504 are the provider's
    ['API error: HTTP 500', 'gateway', GATEWAY],
    ['HTTP 502', 'busy', PROVIDER],
  ]
  for (const [error, kind, label] of cases) {
    const copy = providerFailurePresentation({ error })
    expect([error, copy.kind]).toEqual([error, kind])
    expect(copy.label).toBe(label)
    expect(copy.label).not.toContain('PRIVATE')
    expect(copy).not.toHaveProperty('guidance')
  }
  // "bad gateway" is HTTP's name for a provider failure, not our gateway.
  expect(providerFailurePresentation({ error: 'HTTP/1.1 502 Bad Gateway' }).kind).toBe('busy')
})

test('cyber policy refusals have specific copy across codes and code-less protocols', () => {
  const label = 'Request refused by cybersecurity content policy'
  for (const error of [
    'HTTP 400: {"error":{"type":"invalid_request_error","code":"cyber_policy","message":"PRIVATE_BACKEND https://private.invalid"}}',
    // Older gateways preserved the code but redacted the text to provider_error copy.
    'cyber_policy: The model provider failed to process this request.',
    'Invalid request: The model provider refused this request under its cybersecurity content policy.',
    'invalid_request_error: This content was flagged for possible cybersecurity risk.',
  ]) {
    const copy = providerFailurePresentation({ error })
    expect(copy.kind).toBe('cyber-policy')
    expect(copy.label).toBe(label)
    const text = buildLlmCard(`[LLM] ✗ · gpt-6-astra · turn 3 · 19.1s\n    error     ${error}`).map(l => l.text).join('\n')
    expect(text).toContain(label)
    expect(text).not.toContain('Model provider unavailable')
    expect(text).not.toContain('PRIVATE_BACKEND')
    expect(text).not.toContain('https:')
  }
  expect(providerFailurePresentation({ kind: 'cyber-policy' }).label).toBe(label)
  // Explicit authentication failures still take precedence over policy details.
  expect(providerFailurePresentation({ error: 'HTTP 403: cyber_policy' }).kind).toBe('authentication')
  expect(providerFailurePresentation({ error: 'cyber_policy_extra' }).kind).toBe('unknown')
})

test('permanent request prefixes win over historical redaction fallback text', () => {
  const error = 'Invalid request: The model provider failed to process this request.'
  expect(providerFailurePresentation({ error }).kind).toBe('invalid-request')
  expect(buildLlmCard(`[LLM] ✗ · model\n    error     ${error}`).map(l => l.text).join('\n')).toContain('Invalid request')
  expect(providerFailurePresentation({ error: 'The model provider failed to process this request.' }).kind).toBe('busy')
})

test('final failure and retry cards show only the error fact', () => {
  const failed = buildLlmCard('[LLM] ✗ · gpt-5.6-sol · turn 20 · 40.5s\n    error     HTTP 500: gateway_error: PRIVATE').map(l => l.text).join('\n')
  expect(failed).toContain('Gateway error, not the model provider')
  expect(failed).not.toContain('The gateway failed to process this request.')
  expect(failed).not.toContain('Contact the gateway operator.')
  expect(failed).not.toContain('PRIVATE')
  expect(buildLlmCard('[LLM] ✗ · model\n    error     PRIVATE').map(l => l.text).join('\n')).toContain('Request failed')
  expect(buildLlmCard('[LLM] ✗ · model\n    error     PRIVATE').map(l => l.text).join('\n')).not.toContain('PRIVATE')
  const retry = buildLlmCard('[LLM] ↻ · retrying in 2 seconds · attempt 1/10\n    error     HTTP 503: provider_overloaded').map(l => l.text).join('\n')
  expect(retry).toContain('Model provider overloaded')
  expect(retry).not.toContain('The model provider is having trouble processing this request.')
})

test('input validation numbers are not mistaken for HTTP status codes', () => {
  const error = 'HTTP 400: invalid_request_error: Image has 256 total pixels (16x16), which is below the minimum of 512 pixels.'
  const copy = providerFailurePresentation({ error })
  expect(copy.kind).toBe('invalid-request')
  expect(copy.label).toBe('Invalid request')
  expect(copy).not.toHaveProperty('guidance')
  for (const detail of ['minimum of 512 pixels', 'image width 503', 'max 429 tokens', 'size 401 bytes']) {
    expect(providerFailurePresentation({ error: detail }).kind).toBe('unknown')
  }
  for (const message of ['HTTP 503 unavailable', 'HTTP/1.1 502 Bad Gateway', 'status=504']) {
    expect(providerFailurePresentation({ error: message }).kind).toBe('busy')
  }
  expect(providerFailurePresentation({ error: 'status_code: 500' }).kind).toBe('gateway')
  expect(providerFailurePresentation({ error: 'HTTP 400: connection parameter invalid' }).kind).toBe('invalid-request')
  expect(providerFailurePresentation({ error: 'HTTP 502: invalid_request_error' }).kind).toBe('busy')
})

test('overflow semantics take precedence over generic invalid requests', () => {
  for (const error of [
    'Context overflow: HTTP 400: invalid_request_error: prompt is too long',
    'HTTP 413: context_length_exceeded',
    'HTTP 400: the request exceeds the model context window',
    'This model has a maximum context length of 128000 tokens',
  ]) {
    const copy = providerFailurePresentation({ error })
    expect(copy.kind).toBe('context-overflow')
    expect(copy.label).toBe('Context limit exceeded')
    expect(copy).not.toHaveProperty('guidance')
  }
  expect(providerFailurePresentation({ kind: 'context-overflow', error: 'HTTP 400' }).kind).toBe('context-overflow')
})

test('model errors use protocol semantics, not gateway-specific sentences', () => {
  for (const error of ['Model not found: HTTP 404', 'HTTP 404: model_not_found', 'not_found_error: Model not found.']) {
    expect(providerFailurePresentation({ error }).kind).toBe('model-not-found')
    expect(providerFailurePresentation({ error }).label).toBe('Model not found')
  }
  expect(providerFailurePresentation({ error: 'HTTP 404: route not found' }).label).toBe('Resource not found')
  expect(providerFailurePresentation({ error: 'HTTP 400: invalid_request_error: Unsupported operation' }).kind).toBe('invalid-request')
  expect(providerFailurePresentation({ error: 'HTTP 503: temporarily unavailable' }).kind).toBe('busy')
})

test('standard overload errors have fixed copy without provider details', () => {
  for (const error of [
    'Overloaded: HTTP 503: overloaded_error: PRIVATE_BACKEND is cooling down',
    'HTTP 503: {"error":{"type":"server_error","code":"overloaded_error","message":"PRIVATE_BACKEND"}}',
    'overloaded_error: PRIVATE_BACKEND',
    'HTTP 529',
  ]) {
    const copy = providerFailurePresentation({ error })
    expect(copy.kind).toBe('overloaded')
    expect(copy.label).toBe('Model provider overloaded')
    const card = buildLlmCard(`[LLM] ✗ · model · turn 3 · 1.4s\n    error     ${error}`)
    const text = card.map(line => line.text).join('\n')
    expect(text).toContain(copy.label)
    expect(text).not.toContain('PRIVATE_BACKEND')
    expect(text).not.toContain('Service busy')
  }
  for (const error of ['HTTP 502', 'HTTP 503: temporarily unavailable', 'HTTP 504']) {
    expect(providerFailurePresentation({ error }).label).toBe('Model provider unavailable')
  }
  for (const [error, kind] of [
    ['HTTP 429: overloaded_error: rate limit', 'rate-limit'],
    ['HTTP 401: overloaded_error', 'authentication'],
    ['HTTP 400: prompt is too long: overloaded_error', 'context-overflow'],
    ['HTTP 503: overloaded_error: quota exhausted', 'quota'],
  ]) {
    expect(providerFailurePresentation({ error }).kind).toBe(kind)
  }
})

test('provider failures describe status without telling the user to control retry or model choice', () => {
  for (const kind of [
    'connection', 'timeout', 'dns', 'busy', 'overloaded', 'gateway', 'gateway-no-backend',
    'rate-limit', 'quota', 'authentication', 'invalid-request', 'cyber-policy', 'context-overflow',
    'configuration', 'backend-version', 'model-not-found', 'not-found', 'unknown',
  ] as const) {
    const copy = providerFailurePresentation({ kind })
    expect(copy).not.toHaveProperty('guidance')
    expect(copy.label).not.toMatch(/retry|try again|switch model|pick another model|select another model|compact the conversation/i)
  }
})

test('TLS retries keep cumulative elapsed time across the long-wait transition', () => {
  let state = setRetryWait(createSpinnerState(), 2000, 1, 10, 1000, 'tls handshake eof')
  expect(stripAnsi(formatSpinnerLine(state, 1000))).toContain('Connection interrupted · retrying in 2s')
  state = setLongWait(state, 'outage_waiting', 60000, 121000, 'tls handshake eof')
  const text = stripAnsi(formatSpinnerLine(state, 121000, { inputTokens: 1234 }))
  expect(text).toContain('Unable to connect · retrying in 60s')
  expect(text).toContain('waiting 2m')
  expect(text).not.toContain('attempt')
  expect(text).not.toContain('tls')
  expect(text).not.toContain('↑')
  state = setLongWait(state, 'outage_waiting', 60000, 181000, 'tls handshake eof')
  expect(stripAnsi(formatSpinnerLine(state, 181000))).toContain('waiting 3m')
})
