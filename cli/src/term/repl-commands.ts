import chalk from 'chalk'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Agent } from '../native/index.js'
import type { ConfigInfo } from '../native/index.js'
import { findLastAssistantMarkdown, findLastAssistantTurn } from '../session/assistant-markdown.js'
import { runShareCommand } from '../commands/share.js'
import type { OutputLine } from '../render/output.js'
import { defaultDeps, type LoginDeps } from '../commands/login-flow.js'
import { createCommandOutput } from './command-output.js'
import { renderCommandNotice, renderErrorNotice } from '../render/command-notice.js'
import type { RunResult } from '../update/types.js'

export interface ReplCommandContext {
  agent: Agent
  flushShareNotices?: () => Promise<void>
  isBusy?: () => boolean
  openShareList: () => Promise<void>
  openShareLinks?: () => Promise<void>
  cloudAcknowledged?: (sessionId: string, result: import('../native/index.js').CloudPushResult) => void
  cloudForgotten?: (sessionId: string) => void
  resumeSession?: (session: import('../native/index.js').SessionMeta) => Promise<void>
  getSessionId: () => string | null
  getCompactLines: () => import('../render/output.js').OutputLine[]
  getConfigInfo: () => ConfigInfo | null
  commitSystem: (id: string, text: string, kind?: OutputLine['kind']) => void
  /** Commit a secret shown on screen only, erased after `delayMs`. */
  commitRevealed: (id: string, text: string, erasedText: string, delayMs: number) => void
  commitLines: (lines: OutputLine[]) => void
  /** Rewrite an already-committed line, found by id. False when it is gone. */
  replaceLine: (id: string, text: string) => boolean
  /** Current terminal width, for commands that lay out their own columns. */
  columns: () => number
  requestRender: () => void
}

export function formatLogPaths(
  logPath: string | null,
  rendererPath: string | null = null,
  renderSummary: string | null = null,
  judgeTracePath: string | null = null,
): string | null {
  if (!logPath) return null
  const lines = [`  Log: ${logPath}`]
  if (judgeTracePath) lines.push(`  Judge trace: ${judgeTracePath}`)
  if (rendererPath) lines.push(`  Renderer run: ${rendererPath}`)
  if (renderSummary) lines.push(renderSummary)
  return lines.join('\n')
}

/** `sessions/<id>/judge-trace.jsonl`, or null until the judge has been asked. */
export function judgeTracePath(sessionId: string | null, exists: (path: string) => boolean = existsSync): string | null {
  if (!sessionId) return null
  const path = join(homedir(), '.evotai', 'sessions', sessionId, 'judge-trace.jsonl')
  return exists(path) ? path : null
}

/**
 * System prompt of a `/log <query>` fork. The screen log is what the user
 * saw; the judge trace is the evidence behind every `[JEV]` line in it.
 */
export function logAnalysisPrompt(logPath: string, judgeTrace: string | null): string {
  const files = [`Screen log file to analyze:\n${logPath}`]
  if (judgeTrace) {
    files.push(
      `Judge trace (JSONL, one line per Jev request: the state text the judge read, the questions, and its answers):\n${judgeTrace}\n` +
      'The screen log\'s "[JEV]" lines summarise these requests; read the trace to see why a call was kept, truncated or removed.',
    )
  }
  return [
    'You are in a temporary log analysis session.',
    'This session is not persisted and does not affect the main session context.',
    '',
    files.join('\n\n'),
    '',
    'Rules:',
    '- Read relevant log sections before answering; do not guess',
    '- Prefer partial reads; avoid loading the entire file at once',
    '- Use search to locate key information when needed',
    '- Do not modify any files',
  ].join('\n')
}

function failureText(label: string, err: unknown): string {
  const message = (err as { message?: string })?.message ?? String(err)
  return renderErrorNotice(`${label}: ${message}`)
}

/** Distinguishes concurrent reveals; see the comment at its use site. */
let nextRevealId = 0

async function defaultLoginCommandDeps(): Promise<LoginCommandDeps> {
  const { deviceFingerprint, openLoginBrowser } = await import('../commands/login.js')
  const { authBegin, authPoll } = await import('../native/index.js')
  return {
    fingerprint: deviceFingerprint,
    begin: authBegin,
    poll: authPoll,
    openBrowser: openLoginBrowser,
  }
}

async function defaultLogoutCommandDeps(): Promise<LogoutCommandDeps> {
  const { authLogout, authWhoami } = await import('../native/index.js')
  return { whoami: authWhoami, logout: authLogout }
}

export async function handleCopyCommand(ctx: ReplCommandContext): Promise<void> {
  const last = findLastAssistantMarkdown(ctx.getCompactLines())
  if (!last) {
    ctx.commitSystem('sys-copy', '  No agent messages to copy yet.')
    return
  }
  try {
    const { copyToClipboard } = await import('../render/clipboard.js')
    await copyToClipboard(last.rawMarkdown)
    ctx.commitSystem('sys-copy', '  Copied last agent message (Markdown source) to clipboard')
  } catch (err) {
    ctx.commitSystem('sys-copy-err', failureText('Copy failed', err))
  }
}

export async function handleClipCommand(ctx: ReplCommandContext): Promise<void> {
  const last = findLastAssistantTurn(ctx.getCompactLines())
  if (!last) {
    ctx.commitSystem('sys-clip', '  No agent messages to clip yet.')
    return
  }
  try {
    const { clipMarkdown } = await import('../commands/clip.js')
    const result = clipMarkdown(last.rawMarkdown, {
      sessionId: ctx.getSessionId() ?? undefined,
      cwd: ctx.agent.cwd,
    })
    ctx.commitSystem('sys-clip', `  Clipped: ${result.path}`)
  } catch (err) {
    ctx.commitSystem('sys-clip-err', failureText('Clip failed', err))
  }
}

export async function handleShareCommand(ctx: ReplCommandContext, args: string): Promise<void> {
  const output = createCommandOutput(ctx, 'share')
  await runShareCommand({ ...ctx, progressBar: options => output.bar(options) }, args)
}

/**
 * `/skill`.
 *
 * All four subcommands render through `commands/skill/render.ts` and commit as
 * pre-styled system lines, so the block keeps its own hierarchy instead of being
 * flattened to one gray. The fetch/extract/install phases share a single line
 * that is rewritten in place: they are progress, not history, and stacking them
 * buried the result that follows.
 */
export async function handleSkillCommand(ctx: ReplCommandContext, args: string): Promise<void> {
  const sub = args.trim()
  const skill = await import('../commands/skill.js')

  const { commit: commitStyled, progress: progressLine } = createCommandOutput(ctx, 'skill')

  const notice = (text: string): void => {
    commitStyled(`sys-skill-${Date.now()}`, skill.renderNotice(text))
  }

  if (!sub || sub === 'list') {
    try {
      commitStyled('sys-skill', skill.skillList(ctx.agent.skillsDirs(), { columns: ctx.columns() }))
    } catch {
      notice('skill list unavailable')
    }
    return
  }

  if (sub === 'install' || sub.startsWith('install ')) {
    const source = sub.slice(7).trim()
    const status = progressLine()
    status.update(skill.renderProgress(`installing ${source || 'official skills'}...`))
    try {
      const outcome = await skill.skillInstall(source || undefined, {
        progress: (msg) => status.update(skill.renderProgress(msg)),
      })
      status.finish(
        'view' in outcome ? skill.renderOperation(outcome.view) : skill.renderNotice(outcome.notice),
      )
    } catch (err) {
      status.finish(renderCommandNotice({ state: 'error', message: `install failed: ${(err as { message?: string })?.message ?? err}` }))
    }
    return
  }

  if (sub === 'update' || sub.startsWith('update ')) {
    const name = sub.slice(6).trim()
    const status = progressLine()
    status.update(skill.renderProgress(`updating ${name || 'installed skills'}...`))
    try {
      const outcome = await skill.skillUpdate(name || undefined, {
        progress: (msg) => status.update(skill.renderProgress(msg)),
      })
      status.finish(
        'view' in outcome ? skill.renderOperation(outcome.view) : skill.renderNotice(outcome.notice),
      )
    } catch (err) {
      status.finish(renderCommandNotice({ state: 'error', message: `update failed: ${(err as { message?: string })?.message ?? err}` }))
    }
    return
  }

  if (sub.startsWith('remove ')) {
    const name = sub.slice(7).trim()
    if (!name) {
      notice('Usage: /skill remove <name>')
      return
    }
    try {
      const result = skill.skillRemove(name)
      commitStyled(
        'sys-skill-rm',
        result.removed ? skill.renderRemoved(result.notice) : skill.renderNotice(result.notice),
      )
    } catch {
      notice('skill remove unavailable')
    }
    return
  }

  notice('Usage: /skill [list | install [name | source] | update [name] | remove <name>]')
}

export interface LoginCommandDeps {
  fingerprint: () => Promise<string>
  begin: LoginDeps['begin']
  poll: LoginDeps['poll']
  openBrowser: (url: string) => void
  sleep?: LoginDeps['sleep']
  now?: LoginDeps['now']
}

/** In-REPL login: device-code flow, then the caller reloads model config. */
export async function handleLoginCommand(
  ctx: ReplCommandContext,
  injected?: LoginCommandDeps,
): Promise<boolean> {
  ctx.commitSystem('sys-login', '  starting login...')
  ctx.requestRender()

  try {
    const { DEFAULT_SERVER, runDeviceLogin } = await import('../commands/login-flow.js')
    const deps: LoginCommandDeps = injected ?? await defaultLoginCommandDeps()
    const { outcome } = await runDeviceLogin(
      {
        ...defaultDeps,
        begin: deps.begin,
        poll: deps.poll,
        sleep: deps.sleep ?? defaultDeps.sleep,
        now: deps.now ?? defaultDeps.now,
      },
      DEFAULT_SERVER,
      await deps.fingerprint(),
      (url) => {
        deps.openBrowser(url)
        ctx.commitSystem('sys-login-url', `  Open this URL to log in:\n\n  ${url}`)
        ctx.requestRender()
      },
    )

    switch (outcome.status) {
      case 'success': {
        const lines = [`  ✓ logged in as ${outcome.user.name} <${outcome.user.email}>`]
        if (outcome.syncError) lines.push(`  ⚠ model sync failed: ${outcome.syncError}`)
        else lines.push('  ✓ free models synced')
        ctx.commitSystem('sys-login-ok', lines.join('\n'))
        return true
      }
      case 'denied':
        ctx.commitSystem('sys-login-err', renderErrorNotice('login denied'))
        return false
      case 'timeout':
        ctx.commitSystem('sys-login-err', renderErrorNotice('login timed out, try again'))
        return false
    }
  } catch (err) {
    ctx.commitSystem('sys-login-err', failureText('login failed', err))
    return false
  }
}

export interface LogoutCommandDeps {
  whoami: () => Promise<{ id: string; name: string; email: string } | null>
  logout: () => Promise<void>
}

/** In-REPL logout: drop cloud auth, then the caller reloads model config. */
export async function handleLogoutCommand(
  ctx: ReplCommandContext,
  injected?: LogoutCommandDeps,
): Promise<boolean> {
  try {
    const deps = injected ?? await defaultLogoutCommandDeps()
    const existing = await deps.whoami()
    if (!existing) {
      ctx.commitSystem('sys-logout', '  not logged in')
      return false
    }
    await deps.logout()
    ctx.commitSystem('sys-logout-ok', `  ✓ logged out ${existing.name} <${existing.email}>`)
    return true
  } catch (err) {
    ctx.commitSystem('sys-logout-err', failureText('logout failed', err))
    return false
  }
}

export async function handleVersionCommand(ctx: ReplCommandContext): Promise<void> {
  const { version } = await import('../native/index.js')
  ctx.commitSystem('sys-version', `  evot v${version()}`)
}

export async function handleUpdateCommand(
  ctx: ReplCommandContext,
  run?: () => Promise<RunResult>,
): Promise<void> {
  const status = createCommandOutput(ctx, 'update').progress()
  status.update(renderCommandNotice({ state: 'progress', label: 'update', message: 'checking for updates...' }))
  try {
    const result = await (run ?? (async () => {
      const { runUpdate } = await import('../update/index.js')
      const { version } = await import('../native/index.js')
      return runUpdate(version(), { onProgress: message => status.update(renderCommandNotice({ state: 'progress', label: 'update', message })) })
    }))()
    switch (result.kind) {
      case 'up_to_date':
        status.finish(renderCommandNotice({
          state: 'success',
          message: result.staleReason
            ? `evot is up to date, per the last successful check (${result.staleReason}).`
            : 'evot is up to date.',
          details: result.proxy ? [result.proxy] : [],
        }))
        break
      case 'updated':
        status.finish(renderCommandNotice({
          state: 'success',
          message: `updated ${result.from} → ${result.to}. /restart to apply.`,
          details: result.notes?.length
            ? ['', `What's new in ${result.to}:`, ...result.notes.map(note => `• ${note}`)]
            : [],
        }))
        break
      case 'error':
        status.finish(renderCommandNotice({
          state: 'error', message: result.message,
          details: result.proxy ? [result.proxy] : [],
        }))
        break
    }
  } catch (err) {
    status.finish(renderCommandNotice({
      state: 'error', message: `update failed: ${(err as { message?: string })?.message ?? err}`,
    }))
  }
}

export async function handleEnvCommand(ctx: ReplCommandContext, args: string): Promise<void> {
  const { runEnvCommand, parseRevealTarget, renderRevealed, REVEAL_ERASE_MS } = await import('../commands/env.js')
  const port = {
    list: () => ctx.agent.listVariables(),
    set: (key: string, value: string) => ctx.agent.setVariable(key, value),
    del: (key: string) => ctx.agent.deleteVariable(key),
    readFile: async (path: string) => {
      const { readFile } = await import('fs/promises')
      const { homedir } = await import('os')
      const expanded = path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
      return readFile(expanded, 'utf8')
    },
  }
  try {
    // A reveal is committed differently from every other `/env` output: shown on
    // screen, withheld from the screen log, and erased on a timer. Everything
    // else is ordinary history.
    const revealKey = parseRevealTarget(args)
    const revealRow = revealKey ? port.list().find((row) => row.key === revealKey) : undefined
    if (revealRow) {
      const { text, erasedText } = renderRevealed(revealRow)
      // A fresh id per reveal. The erase finds its line by id, so a shared one
      // made the second reveal mask the first line twice and leave its own
      // value on screen for good.
      ctx.commitRevealed(`sys-env-reveal-${nextRevealId++}`, text, erasedText, REVEAL_ERASE_MS)
      ctx.requestRender()
      return
    }
    ctx.commitSystem('sys-env', await runEnvCommand(port, args))
  } catch (err) {
    ctx.commitSystem('sys-env-err', failureText('env failed', err))
  }
  ctx.requestRender()
}
