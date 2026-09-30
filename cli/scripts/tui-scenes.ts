import type { ConfigInfo } from '../src/native/contracts/config-info.js'
import { createAskState } from '../src/term/ask.js'
import { createModelWindow, createResumeWindow } from '../src/term/app/selector-windows.js'
import { createInitialState } from '../src/term/app/state.js'
import { createEditorState, insertText } from '../src/term/input/editor.js'
import { promptFromSnapshot } from '../src/term/viewmodel/prompt-snapshot.js'
import type { ShellSnapshot } from '../src/term/viewmodel/shell.js'
import { createTaskWindow } from '../src/task/window.js'
import { shareSelectorState } from '../src/term/app/share-selector.js'
import { createBackgroundPanelState } from '../src/term/app/background-panel.js'

export const SCENES = ['idle', 'streaming', 'model-preview', 'model-focused', 'resume', 'tasks', 'shares', 'background', 'ask', 'help', 'planning'] as const
export type Scene = typeof SCENES[number]

/** Offline product fixtures. Deliberately no Agent, user config, network or
 * process-global theme changes. Shared by preview tooling and layout tests. */
export function previewScene(scene: Scene, columns: number, rows: number): ShellSnapshot {
  const config: ConfigInfo = {
    provider: 'fixture', protocol: 'openai', envPath: '', hasApiKey: false, baseUrl: null, thinkingLevel: 'high',
    availableModels: [
      { provider: 'fixture', protocol: 'openai', model: 'fast', spec: 'fixture:fast' },
      { provider: 'fixture', protocol: 'openai', model: 'reasoning', spec: 'fixture:reasoning' },
    ],
  }
  const input: ShellSnapshot = {
    contentLines: ['evot · offline component preview', '', 'You: Review the implementation.', 'Assistant: Ready to help.'],
    preEditorBlocks: [],
    prompt: promptFromSnapshot({
      editor: createEditorState(), session: createInitialState('fast', '/workspace/project'), config,
      active: true, caretVisible: true, planning: false, logMode: false, dashboardUrl: null,
      exitHint: false, columns, rows, gitBranch: 'main', backgroundProcessCount: 0,
    }),
    overlay: { kind: 'none' }, preview: null, commandFocused: false,
  }
  switch (scene) {
    case 'idle': break
    case 'streaming':
      input.preEditorBlocks = [{ lines: [{ spans: [{ text: 'Thinking…  3s · Esc to interrupt', dim: true }] }], marginTop: 1 }]
      break
    case 'model-preview':
    case 'model-focused': {
      const editor = insertText(createEditorState(), '/model')
      input.prompt = { ...input.prompt, lines: editor.lines, cursorCol: editor.cursorCol, placeholder: false }
      const state = createModelWindow(config, 'fast', scene === 'model-focused')
      if (scene === 'model-preview') input.preview = { kind: 'selector', state }
      else {
        input.overlay = { kind: 'selector', state }
        input.commandFocused = true
        input.prompt.active = false
      }
      break
    }
    case 'resume':
      input.overlay = { kind: 'selector', state: createResumeWindow([
        { id: 'session-a', label: 'Fix streaming layout', preview: ['Fix streaming layout', 'fast · 3 turns', '', '› Support 中文 and emoji 🙂'] },
        { id: 'session-b', label: 'Review configuration transactions' },
      ]) }
      input.prompt.active = false
      break
    case 'tasks':
      input.overlay = { kind: 'selector', state: createTaskWindow({
        cache: { ready: true, stale: false, synced_at: 0 },
        tasks: [true, false].map((enabled, index) => ({
          id: `task-${index}`, revision: 1, name: index ? 'Weekly project review' : '每日技术摘要',
          cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai', instruction: 'Summarize changes and send the important findings.',
          enabled, next_run_at: 0, executor_id: '', model_policy: 'default', model_spec: '',
          thinking_level: '', workspace_ref: '', delivery_channel: '', delivery_target: '',
          timeout_seconds: 900, max_lateness_seconds: 3600,
        })),
      }) }
      input.prompt.active = false
      break
    case 'shares':
      input.overlay = { kind: 'selector', state: shareSelectorState([
        { id: 'task-link', kind: 'task', title: '每日技术摘要', url: 'https://evot.ai/share/t/example' },
        { id: 'session-link', title: 'Review streaming layout', url: 'https://evot.ai/share/example' },
      ]) }
      input.prompt.active = false
      break
    case 'background':
      input.overlay = { kind: 'selector', state: createBackgroundPanelState([{
        task_id: 'offline-shell', command: 'bun test tests/browse-selector.test.ts', status: 'running',
        cwd: '/workspace/project', output_path: '/tmp/offline-preview.txt', output_file_truncated: false,
        elapsed_ms: 24_000, exit_code: null, stopped_by_user: false,
      }]) }
      input.prompt.active = false
      break
    case 'ask':
      input.overlay = { kind: 'ask-user', state: createAskState([
        { header: 'Scope', question: 'Which scope should be reviewed?', options: [
          { label: 'Current change', description: 'Review only the working diff.' },
          { label: 'Whole module', description: 'Include module boundaries.' },
        ] },
      ]) }
      input.prompt.active = false
      break
    case 'help':
      input.overlay = { kind: 'help' }
      input.prompt.active = false
      break
    case 'planning': input.prompt.planning = true; break
  }
  return input
}
