import { expect, test } from 'bun:test'
import type { OnlineTerminal } from '../../../src/features/remote/discovery.js'
import { makePhoneTerminalRoom, phoneTerminalSlots } from '../../../src/features/remote/phone-terminal-slots.js'

const window = (terminal: string, updatedAt: number, patch: Partial<OnlineTerminal> = {}): OnlineTerminal =>
  ({ terminal, session: terminal, phase: 'idle', title: terminal, workspace: 'w', phoneCreated: true, updatedAt, ...patch })

test('only an idle phone child in this tmux group can make room; its live check can refuse a stale idle badge', async () => {
  const peers = [window('newer', 4), window('waiting', 0, { phase: 'input' }), window('stray', 0),
    window('desktop', 0, { phoneCreated: false }), window('protected', 1), window('idle', 2)]
  const names = new Set(['chat-waiting', 'chat-protected', 'chat-idle', 'chat-newer'])
  const asked: string[] = []
  const park = async (id: string) => { asked.push(id); return id === 'idle' && names.delete('chat-' + id) }
  await makePhoneTerminalRoom(peers, () => names, park, () => true)
  expect(asked).toEqual(['protected', 'idle'])
  await makePhoneTerminalRoom(peers, () => names, park, () => true)
  expect(asked).toHaveLength(2) // free slot: do not ask another window to exit
})

test('two simultaneous launches with only one reclaimable slot never exceed four, and a refusal does not wedge admission', async () => {
  const slots = phoneTerminalSlots(), peers = [window('idle', 0)]
  const names = new Set(['chat-idle', '1', '2', '3'])
  const launch = (name: string) => slots.admit(async () => {
    await makePhoneTerminalRoom(peers, () => new Set(names), async id => {
      await Bun.sleep(1); return names.delete('chat-' + id)
    }, () => true)
    names.add(name)
    expect(names.size).toBeLessThanOrEqual(4)
  })
  const results = await Promise.allSettled([launch('A'), launch('B')])
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
  names.delete('1'); await launch('C')
  expect(names).toEqual(new Set(['2', '3', 'A', 'C']))
})
