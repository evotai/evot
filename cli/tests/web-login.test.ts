import { expect, test } from 'bun:test'
import { loginDeniedMessage } from '../../src/app/assets/console/ui/login-errors.js'
import deniedLegacy from '../../src/app/tests/fixtures/schema/auth-poll-denied-v0.json'
import deniedCurrent from '../../src/app/tests/fixtures/schema/auth-poll-denied-v1.json'

test('dashboard shows the denial explanation and stable code, including unknown codes', () => {
  expect(loginDeniedMessage(deniedCurrent)).toBe(
    'Login denied: This account has been disabled by an administrator. [account_disabled]',
  )
  expect(loginDeniedMessage({ reason: 'Approval refused' })).toBe('Login denied: Approval refused')
  expect(loginDeniedMessage({ reason_code: 'future_server_reason' })).toBe('Login denied [future_server_reason]')
})

test('dashboard handles old, null, and blank denial diagnostics without guessing a cause', () => {
  for (const result of [deniedLegacy, { reason: null, reason_code: null }, { reason: ' ', reason_code: '\t' }]) {
    expect(loginDeniedMessage(result)).toBe('Login denied: server did not provide a reason; try again')
  }
})

test('dashboard displays server text as text, not HTML', async () => {
  const message = '<img src=x onerror=alert(1)>'
  expect(loginDeniedMessage({ reason: message })).toContain(message)
  const app = await Bun.file(new URL('../../src/app/assets/console/ui/app.js', import.meta.url)).text()
  expect(app).toContain('el.textContent = message')
  const chat = await Bun.file(new URL('../../src/app/assets/console/ui/chat.js', import.meta.url)).text()
  expect(chat).toContain('import { loginDeniedMessage } from "./login-errors.js"')
  expect(chat).toContain('result.status === "denied" ? loginDeniedMessage(result) : "Login code expired"')
})
