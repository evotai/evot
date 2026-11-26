import { expect, test } from 'bun:test'
import { DevicePresence, remoteDeviceKind } from '../../../src/features/remote/presence.js'

test('browser headers are only device type hints; unrecognizable clients are unknown', () => {
  const kind = (agent: string, hints: Record<string, string> = {}) => remoteDeviceKind(new Headers({ 'user-agent': agent, ...hints }))
  expect(kind('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148')).toBe('phone')
  expect(kind('Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/127.0 Mobile Safari/537.36')).toBe('phone')
  expect(kind('Mozilla/5.0 (Linux; Android 14) Chrome/127.0 Safari/537.36')).toBe('tablet')
  expect(kind('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148')).toBe('tablet')
  expect(kind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { 'X-Evot-Touch-Mac': '1' })).toBe('tablet')
  expect(kind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('desktop')
  expect(kind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', { 'X-Evot-Touch-Mac': '1' })).toBe('desktop')
  expect(kind('Mozilla/5.0 (X11; Linux x86_64)')).toBe('desktop')
  expect(kind('ReducedAgent', { 'Sec-CH-UA-Mobile': '?1' })).toBe('phone')
  expect(kind('RemoteFixture/1.0')).toBe('unknown')
})

test('repeated activity extends one device lease; going silent repaints on expiry with no further traffic', async () => {
  let changes = 0, now = 1000
  const expired = Promise.withResolvers<void>()
  const presence = new DevicePresence(() => { if (++changes === 2) expired.resolve() }, () => now)
  try {
    presence.touch('phone-key', 'phone', now + 30)
    presence.touch('phone-key', 'phone', now + 50)
    presence.touch('phone-key', 'phone', now + 20) // an older bearer must not shorten the lease
    expect(changes).toBe(1)
    expect(presence.counts).toEqual({ phone: 1, tablet: 0, desktop: 0, unknown: 0 })
    now += 49
    await Bun.sleep(5)
    expect(presence.counts.phone).toBe(1)
    now++
    const deadline = AbortSignal.timeout(500)
    await Promise.race([expired.promise, new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(deadline.reason), { once: true }))])
    expect(presence.counts.phone).toBe(0)
    expect(changes).toBe(2)
  } finally { presence.clear() }
})
