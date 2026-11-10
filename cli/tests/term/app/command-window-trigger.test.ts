import { describe, expect, test } from 'bun:test'
import {
  isCommandWindowBridge,
  isCommandWindowTypingEvent,
  resolveCommandWindowTrigger,
} from '../../../src/term/app/selector/command-window-trigger.js'

describe('command window trigger', () => {
  test('resolves unique prefixes without opening on text input alone', () => {
    expect(resolveCommandWindowTrigger('/r')).toBe('resume')
    expect(resolveCommandWindowTrigger('/res')).toBe('resume')
    expect(resolveCommandWindowTrigger('/m')).toBe('model')
    expect(resolveCommandWindowTrigger('/mo')).toBe('model')
    expect(resolveCommandWindowTrigger('/sk')).toBe('skill')
    expect(resolveCommandWindowTrigger('/he')).toBe('help')
    expect(resolveCommandWindowTrigger('/ta')).toBe('task')
  })

  test('share prefixes preview the list, but visibility arguments never do', () => {
    for (const text of ['/sh', '/sha', '/shar', '/share']) {
      expect(resolveCommandWindowTrigger(text)).toBe('share')
      expect(isCommandWindowBridge(text)).toBe(true)
    }
    for (const text of ['/sha ', '/share ', '/share public', '/share private', '/share off']) {
      expect(resolveCommandWindowTrigger(text)).toBeNull()
      expect(isCommandWindowBridge(text)).toBe(false)
    }
    expect(resolveCommandWindowTrigger('/s')).toBeNull()
  })

  test('resolves complete commands and alias prefixes', () => {
    expect(resolveCommandWindowTrigger('/resume')).toBe('resume')
    expect(resolveCommandWindowTrigger('/model')).toBe('model')
    expect(resolveCommandWindowTrigger('/skill')).toBe('skill')
    expect(resolveCommandWindowTrigger('/help')).toBe('help')
    expect(resolveCommandWindowTrigger('/task')).toBe('task')
    expect(resolveCommandWindowTrigger('/sessions')).toBe('resume')
    expect(resolveCommandWindowTrigger('/sess')).toBe('resume')
  })

  test('recognizes ambiguous bridge prefixes without treating them as triggers', () => {
    expect(isCommandWindowBridge('/')).toBe(true)
    expect(isCommandWindowBridge('/s')).toBe(true)
    expect(isCommandWindowBridge('/m')).toBe(true)
    expect(resolveCommandWindowTrigger('/')).toBeNull()
    expect(resolveCommandWindowTrigger('/s')).toBeNull()
  })

  test('does not bridge empty, unrelated, or argument input', () => {
    expect(isCommandWindowBridge('')).toBe(false)
    expect(isCommandWindowBridge('/n')).toBe(false)
    expect(isCommandWindowBridge('/wat')).toBe(false)
    expect(isCommandWindowBridge('/resume ')).toBe(false)
    expect(isCommandWindowBridge('explain /')).toBe(false)
  })

  test('does not resolve ambiguous, unknown, or non-window commands', () => {
    expect(resolveCommandWindowTrigger('/')).toBeNull()
    expect(resolveCommandWindowTrigger('/s')).toBeNull()
    expect(resolveCommandWindowTrigger('/new')).toBeNull()
    expect(resolveCommandWindowTrigger('/wat')).toBeNull()
  })

  test('does not resolve while entering command arguments', () => {
    expect(resolveCommandWindowTrigger('/resume ')).toBeNull()
    expect(resolveCommandWindowTrigger('/resume renderer')).toBeNull()
    expect(resolveCommandWindowTrigger('/model ')).toBeNull()
    expect(resolveCommandWindowTrigger('/model gpt')).toBeNull()
    // `/task <prompt>` creates a task; only the bare command previews the list.
    expect(resolveCommandWindowTrigger('/task ')).toBeNull()
    expect(resolveCommandWindowTrigger('/task summarize hn')).toBeNull()
    expect(resolveCommandWindowTrigger('explain /resume')).toBeNull()
  })

  test('only edit keystrokes may mount a command window', () => {
    expect(isCommandWindowTypingEvent({ type: 'char', char: 'l' })).toBe(true)
    expect(isCommandWindowTypingEvent({ type: 'shift-char', char: 'L' })).toBe(true)
    expect(isCommandWindowTypingEvent({ type: 'backspace' })).toBe(true)
    expect(isCommandWindowTypingEvent({ type: 'delete' })).toBe(true)
  })

  test('history recall, paste, and navigation never mount a command window', () => {
    expect(isCommandWindowTypingEvent({ type: 'up' })).toBe(false)
    expect(isCommandWindowTypingEvent({ type: 'down' })).toBe(false)
    expect(isCommandWindowTypingEvent({ type: 'paste', text: '/model' })).toBe(false)
    expect(isCommandWindowTypingEvent({ type: 'paste-clipboard' })).toBe(false)
    expect(isCommandWindowTypingEvent({ type: 'undo' })).toBe(false)
    expect(isCommandWindowTypingEvent({ type: 'tab' })).toBe(false)
    expect(isCommandWindowTypingEvent({ type: 'ctrl', key: 'u' })).toBe(false)
  })
})
