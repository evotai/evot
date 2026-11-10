import { describe, expect, test } from 'bun:test'
import { createComputeExtension, type ComputeToolContext } from '../../src/features/compute/host-tool.js'
import { createComputeFlowState, createComputePrompt, updateComputePrompt } from '../../src/features/compute/prompt.js'
import type { AskUserParams } from '../../src/features/host-tools.js'
import type { ComputeCandidate, ComputeMachine, NewMachine, ProbeResult } from '../../src/features/compute/types.js'
import { machine } from '../helpers/compute-fixtures.js'

const candidates: ComputeCandidate[] = [
  { target: 'ubuntu@3.15.73.38', host_name: '', sources: ['shell_history'], connections: 77, last_used: null, warning: '' },
  { target: 'db0-aws', host_name: '3.14.81.203', sources: ['ssh_config', 'shell_history'], connections: 8, last_used: null, warning: 'name suggests a database' },
]

const okProbe = (target: string): ProbeResult => ({
  target,
  check: { checked_at: '2026-10-30T06:00:00Z', status: 'ok', message: '' },
  profile: { os: 'Ubuntu 24.04 LTS', arch: 'x86_64', cpus: 64, mem_gb: 128, tools: ['git', 'cargo'] },
})

let callId = 0
const call = (tool_name: string, args: Record<string, unknown> = {}) => ({ tool_name, tool_call_id: `c${++callId}`, arguments: args })

function harness(mode: 'create' | 'update', options: {
  answers?: string[]
  request?: string
  current?: ComputeMachine
  probe?: (target: string) => Promise<ProbeResult>
  create?: (input: NewMachine) => Promise<ComputeMachine>
} = {}) {
  const flow = createComputeFlowState(mode, options.request ?? '', options.current)
  const asked: AskUserParams[] = []
  const probed: string[] = []
  const created: NewMachine[] = []
  const updated: Array<[string, unknown]> = []
  const answers = [...(options.answers ?? [])]
  const context: ComputeToolContext = {
    flow,
    collectAnswers: async params => {
      asked.push(params)
      const answer = answers.shift()
      return answer === undefined ? null : params.questions.map(q => ({ header: q.header, question: q.question, answer }))
    },
    persist: {
      create: options.create ?? (async input => { created.push(input); return machine({ id: 'new', name: input.name }) }),
      update: async (id, patch) => { updated.push([id, patch]); return { ...(options.current ?? machine()), ...patch } as ComputeMachine },
    },
    existingNames: () => ['taken'],
    discover: async () => candidates,
    probe: options.probe ?? (async target => { probed.push(target); return okProbe(target) }),
  }
  const extension = createComputeExtension(context)
  return { flow, extension, asked, probed, created, updated }
}

const text = (response: { content: Array<{ text: string }> }) => response.content.map(part => part.text).join('\n')

describe('compute create flow', () => {
  test('advertises only create tools, including ask_user', () => {
    const { extension } = harness('create')
    const names = (JSON.parse(extension.specsJson) as Array<{ name: string }>).map(spec => spec.name)
    expect(names).toEqual(['ask_user', 'compute_discover', 'compute_probe', 'compute_create'])
    expect(extension.handles('ask_user')).toBe(true)
    expect(extension.handles('compute_update')).toBe(false)
  })

  test('discovery summarises candidates with evidence', async () => {
    const { extension } = harness('create')
    const response = await extension.dispatch(call('compute_discover'))
    expect(response.is_error).toBe(false)
    expect(text(response)).toContain('- ubuntu@3.15.73.38 — shell history · 77 connections')
    expect(text(response)).toContain('- db0-aws — ~/.ssh/config · shell history · 8 connections · name suggests a database')
  })

  test('never probes a machine the user did not choose', async () => {
    const h = harness('create', { answers: ['ubuntu@3.15.73.38 (Recommended)'] })
    const refused = await h.extension.dispatch(call('compute_probe', { target: 'ubuntu@3.15.73.38' }))
    expect(refused.is_error).toBe(true)
    expect(h.probed).toEqual([])
    await h.extension.dispatch(call('ask_user', { questions: [{ header: 'Compute', question: 'Which machine should evot use?', options: [] }] }))
    const other = await h.extension.dispatch(call('compute_probe', { target: 'db0-aws' }))
    expect(other.is_error).toBe(true)
    // A target that merely contains the chosen one is not the chosen one.
    const prefix = await h.extension.dispatch(call('compute_probe', { target: 'ubuntu@3.15.73.3' }))
    expect(prefix.is_error).toBe(true)
    const chosen = await h.extension.dispatch(call('compute_probe', { target: 'ubuntu@3.15.73.38' }))
    expect(chosen.is_error).toBe(false)
    expect(text(chosen)).toContain('Machine: Ubuntu 24.04 LTS · 64 CPUs · 128 GB · x86_64')
    expect(h.probed).toEqual(['ubuntu@3.15.73.38'])
  })

  test('a machine named in the request may be probed directly', async () => {
    const h = harness('create', { request: 'add 10.0.0.5.' })
    const response = await h.extension.dispatch(call('compute_probe', { target: '10.0.0.5' }))
    expect(response.is_error).toBe(false)
  })

  test('create requires a successful probe from this flow', async () => {
    const h = harness('create', { request: 'add box' })
    const unchecked = await h.extension.dispatch(call('compute_create', { name: 'box', ssh_target: 'box', description: 'builds' }))
    expect(unchecked.is_error).toBe(true)
    expect(text(unchecked)).toContain('compute_probe')

    const failing = harness('create', {
      request: 'add box',
      probe: async target => ({ target, check: { checked_at: '', status: 'auth', message: 'Authentication failed' }, profile: null }),
    })
    await failing.extension.dispatch(call('compute_probe', { target: 'box' }))
    const refused = await failing.extension.dispatch(call('compute_create', { name: 'box', ssh_target: 'box', description: 'builds' }))
    expect(refused.is_error).toBe(true)
    expect(failing.asked).toEqual([])
  })

  test('confirmation lists the merged configuration and saves the host profile', async () => {
    const h = harness('create', { request: 'add box', answers: ['Confirm'] })
    await h.extension.dispatch(call('compute_probe', { target: 'box' }))
    const response = await h.extension.dispatch(call('compute_create', {
      name: 'box', ssh_target: 'box', description: 'Rust builds and tests',
      // The model cannot smuggle in a profile.
      profile: { cpus: 9999 },
    }))
    expect(text(response)).toBe('Added box.')
    const question = h.asked[0]!.questions[0]!
    expect(question.header).toBe('Compute')
    expect(question.question.split('\n')).toEqual([
      'Add this machine?',
      'name: box',
      'ssh: box',
      'machine: Ubuntu 24.04 LTS · 64 CPUs · 128 GB',
      'tools: git · cargo',
      'use for: Rust builds and tests',
      '',
      'Not quite right? Type what to change and it will be revised before anything is saved.',
    ])
    expect(question.options.map(option => option.label)).toEqual(['Confirm', 'Cancel'])
    expect(h.created[0]?.profile?.cpus).toBe(64)
    expect(h.created[0]?.last_check?.status).toBe('ok')
    const again = await h.extension.dispatch(call('compute_create', { name: 'box2', ssh_target: 'box', description: 'x' }))
    expect(text(again)).toContain('already made its confirmed change')
  })

  test('an address is added under a new ssh alias named after the machine', async () => {
    const h = harness('create', { request: 'add ubuntu@3.15.73.38', answers: ['Confirm'] })
    await h.extension.dispatch(call('compute_probe', { target: 'ubuntu@3.15.73.38' }))
    await h.extension.dispatch(call('compute_create', {
      name: 'big-1', ssh_target: 'ubuntu@3.15.73.38', description: 'Rust builds and tests',
    }))
    expect(h.asked[0]!.questions[0]!.question.split('\n')[2])
      .toBe('ssh: big-1 (new alias in ~/.ssh/config for ubuntu@3.15.73.38)')
  })

  test('typed feedback revises; Cancel ends the flow', async () => {
    const h = harness('create', { request: 'add box', answers: ['call it rust-box', 'Cancel'] })
    await h.extension.dispatch(call('compute_probe', { target: 'box' }))
    const revise = await h.extension.dispatch(call('compute_create', { name: 'box', ssh_target: 'box', description: 'builds' }))
    expect(text(revise)).toContain('replied: "call it rust-box"')
    expect(h.flow.mutationAttempted).toBe(false)
    const cancel = await h.extension.dispatch(call('compute_create', { name: 'rust-box', ssh_target: 'box', description: 'builds' }))
    expect(text(cancel)).toContain('cancelled')
    expect(h.flow.mutationAttempted).toBe(true)
    expect(h.created).toEqual([])
  })

  test('duplicate names are rejected before asking', async () => {
    const h = harness('create', { request: 'add box' })
    await h.extension.dispatch(call('compute_probe', { target: 'box' }))
    const response = await h.extension.dispatch(call('compute_create', { name: 'Taken', ssh_target: 'box', description: 'builds' }))
    expect(response.is_error).toBe(true)
    expect(h.asked).toEqual([])
  })

  test('a failed save after confirming may be retried', async () => {
    let attempts = 0
    const h = harness('create', {
      request: 'add box',
      answers: ['Confirm', 'Confirm'],
      create: async input => {
        attempts++
        if (attempts === 1) throw new Error('disk full')
        return machine({ id: 'new', name: input.name })
      },
    })
    await h.extension.dispatch(call('compute_probe', { target: 'box' }))
    const failed = await h.extension.dispatch(call('compute_create', { name: 'box', ssh_target: 'box', description: 'builds' }))
    expect(failed.is_error).toBe(true)
    expect(text(failed)).toContain('Nothing was written')
    const saved = await h.extension.dispatch(call('compute_create', { name: 'box', ssh_target: 'box', description: 'builds' }))
    expect(text(saved)).toBe('Added box.')
  })
})

describe('compute edit flow', () => {
  test('confirms only the changed fields, with the description as a diff', async () => {
    const current = machine()
    const h = harness('update', { current, answers: ['Confirm'] })
    const names = (JSON.parse(h.extension.specsJson) as Array<{ name: string }>).map(spec => spec.name)
    expect(names).toEqual(['ask_user', 'compute_update'])
    const response = await h.extension.dispatch(call('compute_update', {
      machine_id: 'm1', description: 'Rust builds, tests and benchmarks', name: 'build-1',
    }))
    const lines = h.asked[0]!.questions[0]!.question.split('\n')
    expect(lines[0]).toBe('Apply these changes to “big-1”?')
    expect(lines).toContain('use for (+1 −1):')
    expect(lines).toContain('name: big-1 → build-1')
    expect(h.updated).toEqual([['m1', { name: 'build-1', description: 'Rust builds, tests and benchmarks' }]])
  })

  test('the ssh target cannot be edited, and probing is not offered', async () => {
    const h = harness('update', { current: machine() })
    const response = await h.extension.dispatch(call('compute_update', { machine_id: 'm1', ssh_target: 'elsewhere' }))
    expect(response.is_error).toBe(true)
    const probe = await h.extension.dispatch(call('compute_probe', { target: 'ubuntu@3.15.73.38' }))
    expect(probe.is_error).toBe(true)
  })
})

describe('compute prompts', () => {
  const context = { localMachine: 'Apple M5 Pro · 15 CPUs · 24 GB', project: 'evot', existingNames: [] }

  test('create prompt keeps discovery local and probing to the chosen machine', () => {
    const prompt = createComputePrompt('', context)
    expect(prompt).toContain('call compute_discover first')
    expect(prompt).toContain('connects to nothing')
    expect(prompt).toContain('Call compute_probe only for the machine the user chose')
    expect(prompt).toContain('"What should evot use this machine for?" and "options": []')
    expect(prompt).toContain('This computer: Apple M5 Pro · 15 CPUs · 24 GB')
  })

  test('edit prompt opens with the fixed Edit Compute question', () => {
    const prompt = updateComputePrompt(machine(), context)
    expect(prompt).toContain('"header":"Edit Compute"')
    expect(prompt).toContain('What do you want to change in “big-1”?')
    expect(prompt).toContain('"label":"Use for"')
    expect(prompt).toContain('"label":"Name"')
  })
})
