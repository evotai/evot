import type { ConfigInfo } from '../../../native/contracts/config-info.js'
import type { AppState } from '../run/state.js'
import type { OutputLine } from '../../../render/output.js'
import type { OverlayState } from '../selector/overlay-state.js'
import { resolveCommand } from '../../../commands/index.js'
import { modelShareEvents } from '../../../session/share-events.js'
import { modelChangeNotice, nextModelOption } from '../../../features/models/options.js'

export interface CommandModelClient {
  model: string
  setProvider(spec: string): void
  configInfo(): Pick<ConfigInfo, 'provider'> & Partial<Pick<ConfigInfo, 'thinkingLevel'>>
}

export interface CommandContext {
  agent: CommandModelClient
  appState: AppState
  configInfo?: ConfigInfo
}

export interface CommandResult {
  appState: AppState
  overlay?: OverlayState
  clearContext?: boolean
  newSession?: boolean
  exit?: boolean
  restart?: 'safe' | 'now' | 'cancel'
  systemLines: OutputLine[]
}

export function handleSlashCommand(text: string, ctx: CommandContext): CommandResult {
  const resolved = resolveCommand(text)

  if (resolved.kind === 'unknown') {
    return {
      ...baseResult(ctx),
      systemLines: [{ id: 'sys-unk', kind: 'system', text: `  Unknown command: ${text.trim()}` }],
    }
  }

  if (resolved.kind === 'ambiguous') {
    return {
      ...baseResult(ctx),
      systemLines: [
        { id: 'sys-amb', kind: 'system', text: `  Ambiguous command: ${resolved.candidates.join(', ')}` },
        { id: 'sys-amb2', kind: 'system', text: '  Type more characters or /help for commands' },
      ],
    }
  }

  const { name, args } = resolved

  switch (name) {
    case '/help':
      return { ...baseResult(ctx), overlay: { kind: 'help' } }

    case '/new':
      return { ...baseResult(ctx), newSession: true }

    case '/clear':
      return { ...baseResult(ctx), clearContext: true }

    case '/exit':
      return { ...baseResult(ctx), exit: true }

    case '/restart':
      if (args === '' || args === 'now' || args === 'cancel') return { ...baseResult(ctx), restart: args || 'safe' }
      return { ...baseResult(ctx), systemLines: [{ id: 'sys-restart-usage', kind: 'system', text: '  Usage: /restart [now | cancel]' }] }

    case '/model': {
      if (args === 'n') {
        const next = nextModelOption(ctx.configInfo, ctx.agent.model)
        if (!next) {
          return { ...baseResult(ctx), systemLines: [{ id: 'sys-m', kind: 'system', text: '  Only one model available.' }] }
        }
        ctx.agent.setProvider(next.spec)
        const config = ctx.agent.configInfo()
        const appState = { ...ctx.appState, model: next.model }
        const shareEvents = modelShareEvents(next.provider, next.model, config.thinkingLevel)
        return {
          ...baseResult(ctx),
          appState,
          systemLines: [{ id: 'sys-model', kind: 'system', ...modelChangeNotice(next.model, next.provider, config.thinkingLevel, next), shareEvents }],
        }
      }
      if (args) {
        const configured = ctx.configInfo?.availableModels.find(option => option.spec === args)
        if (configured) {
          ctx.agent.setProvider(configured.spec)
        } else {
          ctx.agent.model = args
        }
        const model = ctx.agent.model
        const config = ctx.agent.configInfo()
        const provider = config.provider
        const appState = { ...ctx.appState, model }
        const selected = configured ?? ctx.configInfo?.availableModels.find(
          option => option.model === model && option.provider === provider)
        const shareEvents = modelShareEvents(provider, model, config.thinkingLevel)
        return {
          ...baseResult(ctx),
          appState,
          systemLines: [{ id: 'sys-model', kind: 'system', ...modelChangeNotice(model, provider, config.thinkingLevel, selected), shareEvents }],
        }
      }
      // No arg — return empty result; handleSlashInput will show selector overlay
      return baseResult(ctx)
    }

    case '/resume': {
      // Handled asynchronously in handleSlashInput (needs full session list)
      return baseResult(ctx)
    }

    default:
      // Commands handled asynchronously by handleSlashInput in repl.ts
      return baseResult(ctx)
  }
}

function baseResult(ctx: CommandContext): CommandResult {
  return {
    appState: ctx.appState,
    systemLines: [],
  }
}
