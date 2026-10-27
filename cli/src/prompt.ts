import { isHostToolEvent, type RunEvent } from './native/contracts/query-event.js'
import { Agent } from './native/index.js'
import type { CliOptions } from './cli.js'
import { createAgent } from './cli.js'
import { loadFileBlocks } from './file-loader.js'
import { findPreviousSession } from './term/app/session-view.js'
import { SessionHook } from './session/hook.js'
import { errorText } from './render/format.js'

export async function runPrompt(opts: CliOptions) {
  if (!opts.prompt) {
    console.error('No prompt provided. Use -p <text>')
    process.exit(1)
  }

  const agent: Agent = await createAgent(opts)
  // Non-interactive runs have no picker to repair a stale `--model`, and a
  // silent swap would make scripted output lie about which model ran.
  if (agent.startupWarning) {
    console.error(agent.startupWarning)
    process.exit(1)
  }

  let contentJson: string | undefined
  try {
    const fileBlocks = loadFileBlocks(opts.files)
    if (fileBlocks.length > 0) {
      const blocks = [{ type: 'text', text: opts.prompt }, ...fileBlocks]
      contentJson = JSON.stringify(blocks)
    }
  } catch (err: any) {
    console.error(err.message)
    process.exit(1)
  }

  const resumeSessionId = await resolveResumeSessionId(agent, opts)

  const sessionHook = new SessionHook({ cwd: agent.cwd })
  sessionHook.startProcess(agent.cwd)
  let closeReason = 'completed'
  try {
    const stream = await agent.query(
      contentJson ? '' : opts.prompt,
      resumeSessionId,
      undefined,
      contentJson,
    )
    sessionHook.startSession(stream.sessionId, agent.cwd)

    for await (const event of stream) {
      if (isHostToolEvent(event)) throw new Error('Headless prompt requested a host tool')
      if (event.kind === 'run_started') {
        sessionHook.runStarted(event.run_id)
      } else if (event.kind === 'run_finished') {
        sessionHook.runFinished(event.run_id)
      } else if (event.kind === 'error') {
        closeReason = 'failed'
        sessionHook.runFailed(event.run_id, String(event.payload?.message ?? ''))
      }

      if (opts.outputFormat === 'stream-json') {
        console.log(JSON.stringify(event))
      } else {
        printEventText(event)
      }
    }
  } catch (err) {
    closeReason = 'failed'
    // No-op when an `error` event already settled the run.
    sessionHook.runFailed(undefined, errorText(err))
    throw err
  } finally {
    await sessionHook.close(closeReason)
  }
  process.exit(closeReason === 'failed' ? 1 : 0)
}

function printEventText(event: RunEvent) {
  switch (event.kind) {
    case 'assistant_delta':
      if (event.payload?.content_type === 'text' && event.payload?.delta) process.stdout.write(String(event.payload.delta))
      break
    case 'tool_finished':
      if (event.payload?.is_error) {
        process.stderr.write(`[error: ${event.payload.tool_name}] ${event.payload.content}\n`)
      }
      break
    case 'error':
      process.stderr.write(`error: ${event.payload?.message}\n`)
      break
    case 'run_finished':
      console.log()
      break
  }
}

export async function resolveResumeSessionId(agent: Agent, opts: Pick<CliOptions, 'resume' | 'continueLatest' | 'outputFormat'>): Promise<string | undefined> {
  if (!opts.continueLatest) return opts.resume

  const sessions = await agent.listSessions(0)
  const session = findPreviousSession(sessions, agent.cwd)
  if (!session) {
    emitLoadError('No conversation found to continue', opts.outputFormat)
    process.exit(1)
  }
  return session.session_id
}

function emitLoadError(message: string, outputFormat: CliOptions['outputFormat']): void {
  if (outputFormat === 'stream-json') {
    console.log(JSON.stringify({ kind: 'error', payload: { message } }))
  } else {
    console.error(message)
  }
}
