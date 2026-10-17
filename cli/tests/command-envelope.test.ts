import { describe, expect, test } from 'bun:test'
import { buildCommandPrompt, commandDisplay, parseCommandPrompt } from '../src/session/command-envelope.js'
import { replayUserText } from '../src/session/task-notification.js'
import { buildLoopStartPrompt, buildLoopWakeupPrompt } from '../src/loop/prompt.js'
import { transcriptToMessages } from '../src/session/transcript.js'
import { messagesToOutputLines } from '../src/render/output.js'

describe('command envelope', () => {
  test('round-trips name, input and instructions', () => {
    const text = buildCommandPrompt({ name: 'loop', input: '/loop 5m watch "CI" <main> & more', instructions: 'Rules:\n- a\n- b' })
    expect(text.startsWith('<command name="loop" input="/loop 5m watch &quot;CI&quot; &lt;main&gt; &amp; more">\n')).toBe(true)
    expect(text.endsWith('\n</command>')).toBe(true)
    expect(parseCommandPrompt(text)).toEqual({
      name: 'loop',
      input: '/loop 5m watch "CI" <main> & more',
      instructions: 'Rules:\n- a\n- b',
    })
  })

  test('keeps trailing user text outside the envelope', () => {
    const text = buildCommandPrompt({ name: 'task', input: '/task', instructions: 'x', text: 'make it daily' })
    expect(parseCommandPrompt(text)?.text).toBe('make it daily')
  })

  test('multi-line input survives the attribute', () => {
    const text = buildCommandPrompt({ name: 'harden', input: 'line one\nline two', instructions: 'x' })
    expect(text.split('\n')[0]).toBe('<command name="harden" input="line one&#10;line two">')
    expect(parseCommandPrompt(text)?.input).toBe('line one\nline two')
  })

  test('rejects things that merely mention the tag', () => {
    expect(parseCommandPrompt('explain <command name="x" input="y">')).toBeNull()
    expect(parseCommandPrompt('<command name="Loop" input="y">\nz\n</command>')).toBeNull()
    expect(parseCommandPrompt('hello\n<command name="loop" input="y">\nz\n</command>')).toBeNull()
  })

  test('a wakeup displays as a host notice, a command as the user line', () => {
    expect(commandDisplay({ name: 'loop-wakeup', input: 'loop wakeup #3 (09:15)', instructions: '' }))
      .toEqual({ kind: 'notice', text: '◌ loop wakeup #3 (09:15)' })
    expect(commandDisplay({ name: 'loop', input: '/loop watch ci', instructions: '' }))
      .toEqual({ kind: 'user', text: '/loop watch ci' })
  })
})

describe('loop prompts hide instructions from replay', () => {
  test('the model still receives the task and rules', () => {
    const text = buildLoopStartPrompt({ kind: 'dynamic' }, 'watch ci', '/loop watch ci')
    expect(text).toContain('schedule_wakeup')
    expect(text).toContain('Task:\nwatch ci')
  })

  test('resume shows what the user typed, never the rules', () => {
    const start = buildLoopStartPrompt({ kind: 'fixed', intervalMs: 300_000 }, 'watch ci', '/loop 5m watch ci')
    const wakeup = buildLoopWakeupPrompt({
      active: true, mode: { kind: 'fixed', intervalMs: 300_000 }, task: { prompt: 'watch ci', label: 'watch ci' },
      startedAt: 0, nextFireAt: null, reason: null, tick: 2, noopStreak: 0, streakStartedAt: null,
    }, Date.UTC(2026, 0, 1, 1, 15))
    expect(replayUserText(start)).toEqual([{ kind: 'user', text: '/loop 5m watch ci' }])
    const [notice] = replayUserText(wakeup)
    expect(notice?.kind).toBe('command-notice')
    expect(notice?.text).toMatch(/^◌ loop wakeup #2 \(\d\d:\d\d\)$/)

    const messages = transcriptToMessages([
      { type: 'user', text: start },
      { type: 'user', text: wakeup },
    ] as never)
    expect(messages.map(message => message.role)).toEqual(['user', 'system'])
    const rendered = messagesToOutputLines(messages).map(line => line.text).join('\n')
    expect(rendered).toContain('/loop 5m watch ci')
    expect(rendered).not.toContain('Rules:')
    expect(rendered).not.toContain('recurring loop')
    expect(rendered).not.toContain('<command')
  })

  test('historical plain-text loop prompts still replay verbatim', () => {
    const legacy = 'You are running a recurring loop. The host will wake you every 5m.\n\nTask:\nwatch ci\n\nRules:\n- a'
    expect(replayUserText(legacy)).toEqual([{ kind: 'user', text: legacy }])
  })
})
