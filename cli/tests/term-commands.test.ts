import { describe, expect, test } from 'bun:test'
import { handleSlashCommand, type CommandContext } from '../src/term/app/commands.js'
import { createInitialState } from '../src/term/app/state.js'

describe('term commands', () => {
  const mkCtx = (): CommandContext => ({
    agent: {
      model: 'claude-3-5-sonnet',
      setProvider(spec: string) { this.model = spec },
      configInfo: () => ({ provider: 'p1' }),
    },
    appState: createInitialState('claude-3-5-sonnet', '/tmp'),
    configInfo: {
      provider: 'p1',
      protocol: 'openai', envPath: '', hasApiKey: true, baseUrl: null, thinkingLevel: '',
      availableModels: [
        { provider: 'p1', model: 'shared', spec: 'p1:shared' },
        { provider: 'p2', model: 'shared', spec: 'p2:shared' },
      ],
    },
  })

  test('/help opens overlay', () => {
    const result = handleSlashCommand('/help', mkCtx())
    expect(result.overlay?.kind).toBe('help')
  })

  test('/plan is rejected without changing conversation state', () => {
    const ctx = mkCtx()
    const result = handleSlashCommand('/plan', ctx)
    expect(result.appState).toBe(ctx.appState)
    expect(result.systemLines[0]?.text).toContain('Unknown command: /plan')
    expect(result.overlay).toBeUndefined()
  })

  test('/model updates model and reports its resolved provider', () => {
    const ctx = mkCtx()
    ctx.agent.configInfo = () => ({ provider: 'p2' })
    const result = handleSlashCommand('/model p2:shared', ctx)
    expect(ctx.agent.model).toBe('p2:shared')
    expect(result.appState.model).toBe('p2:shared')
    expect(result.systemLines[0]?.text).toContain('p2:shared@p2')
  })

  test('/model uses strict provider switching for a configured model', () => {
    const ctx = mkCtx()
    let selected = ''
    ctx.agent.setProvider = (spec: string) => { selected = spec; ctx.agent.model = 'shared' }
    ctx.agent.configInfo = () => ({ provider: 'p2' })

    handleSlashCommand('/model p2:shared', ctx)

    expect(selected).toBe('p2:shared')
  })

  test('/model n distinguishes the same model from different providers', () => {
    const ctx = mkCtx()
    ctx.agent.model = 'shared'
    ctx.appState = createInitialState('shared', '/tmp')
    const result = handleSlashCommand('/model n', ctx)
    expect(ctx.agent.model).toBe('p2:shared')
    expect(result.appState.model).toBe('shared')
    expect(result.systemLines[0]?.text).toContain('shared@p2')
  })

  test('/model without arg returns empty result for selector', () => {
    const result = handleSlashCommand('/model', mkCtx())
    expect(result.systemLines.length).toBe(0)
  })

  test('/new starts an unbound session that persists on first prompt', () => {
    const result = handleSlashCommand('/new', mkCtx())
    expect(result.newSession).toBe(true)
    expect(result.clearContext).toBeUndefined()
  })

  test('/clear only clears local context', () => {
    const result = handleSlashCommand('/clear', mkCtx())
    expect(result.clearContext).toBe(true)
    expect(result.newSession).toBeUndefined()
  })

  test('/exit exits the REPL', () => {
    const result = handleSlashCommand('/exit', mkCtx())
    expect(result.exit).toBe(true)
    expect(result.restart).toBeUndefined()
  })

  test('/restart restarts in place', () => {
    const result = handleSlashCommand('/restart', mkCtx())
    expect(result.restart).toBe(true)
    expect(result.exit).toBeUndefined()
  })

  test('/compact defers to the async app command path', () => {
    const result = handleSlashCommand('/compact preserve decisions', mkCtx())
    expect(result.systemLines.length).toBe(0)
  })

  test('/resume defers to async handler', () => {
    const result = handleSlashCommand('/resume abc', mkCtx())
    // /resume is now handled asynchronously in handleSlashInput
    expect(result.systemLines.length).toBe(0)
    expect(result.overlay).toBeUndefined()
  })

  test('/resume with no arg returns empty result for selector', () => {
    const ctx = mkCtx()
    const result = handleSlashCommand('/resume', ctx)
    expect(result.systemLines.length).toBe(0)
  })

  test('/login defers to the async app command path', () => {
    const result = handleSlashCommand('/login', mkCtx())
    expect(result.systemLines.length).toBe(0)
  })

  test('/logout defers to the async app command path', () => {
    const result = handleSlashCommand('/logout', mkCtx())
    expect(result.systemLines.length).toBe(0)
  })

  test('removed /history command returns unknown-command message', () => {
    const result = handleSlashCommand('/history', mkCtx())
    expect(result.systemLines[0]?.text).toContain('Unknown command: /history')
  })

  test('unknown command returns system message', () => {
    const result = handleSlashCommand('/wat', mkCtx())
    expect(result.systemLines[0]?.text).toContain('Unknown command')
  })
})
