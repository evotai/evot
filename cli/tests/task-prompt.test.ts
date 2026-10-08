import { describe, expect, test } from 'bun:test'
import {
  createTaskFlowState,
  createTaskPrompt,
  updateTaskPrompt,
} from '../src/task/prompt.js'
import type { ScheduledTask } from '../src/task/types.js'

const task: ScheduledTask = {
  id: 'task1',
  revision: 4,
  name: 'Daily report',
  cron: '0 9 * * 1-5',
  timezone: 'Asia/Shanghai',
  instruction: 'Prepare report',
  executor_id: 'exec1',
  model_policy: 'fixed',
  model_spec: 'evot-pro-anthropic:claude-opus-5',
  thinking_level: 'high',
  workspace_ref: '/work',
  delivery_channel: 'feishu',
  delivery_target: 'oc_chat1',
  timeout_seconds: 900,
  max_lateness_seconds: 14_400,
  enabled: true,
  next_run_at: 1_800_000_000_000,
  last_run: null,
}

const context = {
  localTimezone: 'Asia/Shanghai',
  currentModel: 'Claude Opus',
  thinkingLevel: 'high',
  availableModels: ['DeepSeek Flash', 'Claude Opus'],
  savedModel: 'Claude Opus',
}

describe('task prompts', () => {
  test('create prompt uses the schema and asks only when information is ambiguous', () => {
    const prompt = createTaskPrompt('每天九点用 DeepSeek Flash 发日报', context)
    expect(prompt).toContain('Use the automation_task_create schema')
    expect(prompt).toContain('Do not ask questions whose answers are already clear')
    expect(prompt).toContain('Model selection is mandatory')
    expect(prompt).toContain('always opens the current model catalog')
    expect(prompt).toContain('never use ask_user for model selection')
    expect(prompt).toContain('DeepSeek Flash')
    expect(prompt).not.toContain('provider:model')
    expect(prompt).not.toContain('four questions')
  })

  test('pressing e makes the first turn a field selector with readable current values', () => {
    const prompt = updateTaskPrompt(task, context)
    expect(prompt).toContain('one brief, user-visible sentence')
    expect(prompt).toContain('ordinary assistant text before calling automation_task_update')
    // Instruction edits go through the confirm/revise loop with a drafted
    // rewrite, never a placeholder "type it yourself" option.
    expect(prompt).toContain('Never offer placeholder options such as "Type new value (use Other)"')
    expect(prompt).toContain('call ask_user in the same turn with one free-text question ("options": [])')
    expect(prompt).toContain('rewrite the full instruction yourself')
    expect(prompt).toContain('do not ask them to retype the whole instruction')
    expect(prompt).toContain('A plain-text reply in the composer stays in this edit')
    expect(prompt).not.toContain('Never end an unfinished edit with a plain-text question')
    expect(prompt).not.toContain('Do not output explanatory text')
    expect(prompt).toContain('Do not call automation_task_update before the user chooses a field')
    expect(prompt).toContain('What do you want to change')
    expect(prompt).toContain('"label":"Schedule"')
    expect(prompt).toContain('"label":"Instruction"')
    expect(prompt).toContain('"label":"Model"')
    expect(prompt).toContain('"label":"Delivery"')
    expect(prompt).toContain('"description":"Claude Opus · high"')
    expect(prompt).toContain('only fields changed in this request as old → new')
    expect(prompt).not.toContain(task.model_spec)
    expect(prompt).not.toContain('fixed wizard')
  })

  test('flow state scopes a single mutation to one mode', () => {
    expect(createTaskFlowState('create')).toEqual({
      mode: 'create',
      currentTask: undefined,
      mutationAttempted: false,
    })
    expect(createTaskFlowState('update', task)).toEqual({
      mode: 'update',
      currentTask: task,
      mutationAttempted: false,
    })
  })
})
