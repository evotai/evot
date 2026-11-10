import { describe, expect, test } from 'bun:test'
import { createComputeWindow } from '../../src/features/compute/window.js'
import { handleComputeKey } from '../../src/features/compute/control.js'
import { candidateEvidence } from '../../src/features/compute/format.js'
import { SELECTOR_OWNER, isCommandSelector } from '../../src/ui/selector-identity.js'
import { resolveCommand } from '../../src/commands/index.js'
import { resolveCommandWindowTrigger } from '../../src/term/app/selector/command-window-trigger.js'
import { machine } from '../helpers/compute-fixtures.js'

describe('compute window', () => {
  test('uses the shared browse window and Task row conventions', () => {
    const state = createComputeWindow([machine()])
    expect(state.owner).toBe(SELECTOR_OWNER.compute)
    expect(state.presentation).toBe('browser')
    expect(isCommandSelector(state)).toBe(true)
    const row = state.items[0]!
    expect(row.label).toBe('big-1')
    expect(row.status).toEqual({ text: 'On', tone: 'muted' })
    expect(row.detail).toBe('ubuntu@3.15.73.38 · 64 CPUs · 128 GB')
    expect(row.preview?.slice(0, 3)).toEqual(['big-1', 'SSH  ubuntu@3.15.73.38', 'Machine  Ubuntu 24.04 LTS · 64 CPUs · 128 GB'])
    expect(row.preview).toContain('# Configuration')
    expect(row.preview).toContain('Tools  git · cargo · docker')
    expect(row.preview?.slice(-2)).toEqual(['# Use for', 'Rust builds and tests'])
    expect(row.hints?.map(hint => hint.action)).toEqual(['select', 'details', 'search', 'new', 'edit', 'check now', 'pause/resume', 'delete', 'close'])
  })

  test('paused and failed machines use Task state words', () => {
    const paused = createComputeWindow([machine({ enabled: false })]).items[0]!
    expect(paused.status).toEqual({ text: 'Paused', tone: 'muted' })
    const failed = createComputeWindow([machine({
      last_check: { checked_at: '2026-10-30T06:00:00Z', status: 'host_key_changed', message: 'Host key changed since it was trusted' },
    })]).items[0]!
    expect(failed.status).toEqual({ text: 'Attention', tone: 'attention' })
    expect(failed.preview).toContain('# Latest issue')
    expect(failed.preview).toContain('Host key changed since it was trusted')
  })

  test('unchecked machine and empty list', () => {
    const row = createComputeWindow([machine({ profile: null, last_check: null })]).items[0]!
    expect(row.detail).toBe('ubuntu@3.15.73.38')
    expect(row.preview).toContain('Machine  Not checked yet')
    expect(row.preview).toContain('Last check  Never')
    const empty = createComputeWindow([])
    expect(empty.emptyMessage).toBe('No compute machines · n to create')
    expect(empty.hints?.map(hint => hint.action)).toEqual(['new', 'close'])
  })

  test('keys map to the same gestures as the Task list', () => {
    const state = { ...createComputeWindow([machine()]), listFocused: true }
    expect(handleComputeKey(state, { type: 'char', char: 'n' }).kind).toBe('create')
    expect(handleComputeKey(state, { type: 'char', char: 'e' })).toEqual({ kind: 'edit', id: 'm1' })
    expect(handleComputeKey(state, { type: 'char', char: 'r' })).toEqual({ kind: 'check', id: 'm1' })
    expect(handleComputeKey(state, { type: 'char', char: ' ' })).toEqual({ kind: 'toggle', id: 'm1' })
    const armed = handleComputeKey(state, { type: 'char', char: 'd' })
    expect(armed.kind).toBe('update')
    if (armed.kind !== 'update') return
    expect(armed.state.subtitle).toBe('Press d again to delete')
    expect(handleComputeKey(armed.state, { type: 'char', char: 'd' }).kind).toBe('delete')
    expect(handleComputeKey(state, { type: 'escape' }).kind).toBe('close')
  })

  test('candidate evidence reads as one line', () => {
    expect(candidateEvidence({
      target: 'db0-aws', host_name: '3.14.81.203', sources: ['ssh_config', 'shell_history'],
      connections: 8, last_used: null, warning: 'name suggests a database',
    })).toBe('~/.ssh/config · shell history · 8 connections · name suggests a database')
  })
})

describe('/compute command', () => {
  test('resolves without stealing the /comp prefix from /compact', () => {
    expect(resolveCommand('/compute')).toEqual({ kind: 'resolved', name: '/compute', args: '' })
    expect(resolveCommand('/compu add box')).toEqual({ kind: 'resolved', name: '/compute', args: 'add box' })
    expect(resolveCommand('/comp')).toEqual({ kind: 'resolved', name: '/compact', args: '' })
    expect(resolveCommandWindowTrigger('/compute')).toBe('compute')
    expect(resolveCommandWindowTrigger('/compute x')).toBeNull()
  })
})
