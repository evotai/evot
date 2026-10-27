/**
 * Update module — public API.
 */

export type { CheckResult, RunResult, ReleaseInfo, InstallState } from './types.js'
export { checkForUpdate, fetchReleaseNotesFor, lastCheckError, selectRelease } from './check.js'
export { compareVersions, isNewer, isPrerelease, parseVersion } from './version.js'
export { executeInstall } from './install.js'
export {
  applyProxyToEnv,
  collectCandidates,
  envCandidates,
  envExemptsAll,
  parseProxyUrl,
  probeReachable,
  resetUpdateProxy,
  resolveUpdateProxy,
  selectProxy,
  systemCandidates,
  UPDATE_URLS,
} from './proxy.js'
export type { ProxyCandidate, ProxyEnv, ProxySelection } from './proxy.js'
export { UpdateManager, type UpdateStatus } from './manager.js'
export { parseReleaseNotes } from './notes.js'
export { formatInstallerProgress } from './progress.js'
export { checkInstallHealth, installedVersionForThisProcess, isManagedInstall, readInstallState } from './state.js'
export type { InstallHealth } from './state.js'
export { readStaged, clearStaged } from './stage.js'
export type { StagedUpdate } from './stage.js'

import type { RunResult } from './types.js'
import { reapExitedChildren } from '../native/index.js'
import { existsSync } from 'fs'
import { join } from 'path'
import { checkForUpdate, lastCheckError } from './check.js'
import { executeInstall } from './install.js'
import { parseReleaseNotes } from './notes.js'
import { installBinDir, runningInstallDir } from './paths.js'
import { installedVersionForThisProcess, isManagedInstall } from './state.js'
import { clearStaged, readStaged } from './stage.js'
import { resolveUpdateProxy } from './proxy.js'
import { argvForRestart } from '../restart-argv.js'
import { compareVersions } from './version.js'

const APPLIED_UPDATE_ENV = 'EVOT_APPLIED_UPDATE'

/**
 * How the update reached the network, for attaching to an outcome.
 *
 * The proxy is chosen automatically, so a failure that does not name the route
 * leaves the user unable to tell "my proxy was used and still failed" from "my
 * proxy was never consulted".
 */
async function proxyContext(): Promise<string | undefined> {
  try {
    return (await resolveUpdateProxy()).reason
  } catch {
    return undefined
  }
}

/**
 * Force-check for updates and install if available.
 * Used by `/update` and `evot update`.
 */
export async function runUpdate(currentVersion: string, progress?: { onProgress?: (line: string) => void; signal?: AbortSignal }): Promise<RunResult> {
  const result = await checkForUpdate(currentVersion, { force: true })

  if (result.kind === 'error') {
    return { kind: 'error', message: result.message, proxy: await proxyContext() }
  }
  if (result.kind === 'up_to_date') {
    // Distinguish "confirmed current" from "could not reach GitHub, and the last
    // known release was not newer". Silently claiming the former would be wrong.
    if (!result.stale) return { kind: 'up_to_date' }
    return {
      kind: 'up_to_date',
      staleReason: lastCheckError()?.message ?? 'GitHub unreachable',
      proxy: await proxyContext(),
    }
  }

  progress?.onProgress?.('Fetching release installer…')
  const installResult = await executeInstall(result.latest.tag, stagedEnvFor(result.latest.tag), progress ?? {})
  if (installResult.success) {
    const notes = parseReleaseNotes(result.latest.body)
    return { kind: 'updated', from: currentVersion, to: result.latest.version, notes }
  }
  return { kind: 'error', message: installResult.output, proxy: await proxyContext() }
}

/**
 * Hand install.sh the pre-downloaded archive when one matches this tag.
 *
 * A mismatch (the candidate moved on while a stale download sat in staging)
 * simply falls through to the normal network path.
 */
function stagedEnvFor(tag: string): Record<string, string> | undefined {
  const staged = readStaged()
  if (!staged || staged.tag !== tag) return undefined
  return { EVOT_INSTALL_ASSET: staged.assetPath }
}

/**
 * Apply a background-staged download at startup, before the REPL comes up.
 *
 * Returns the version now on disk when an apply happened, or null when there
 * was nothing to do. Deliberately quiet on failure: install.sh falls back to
 * downloading on its own, and a failed auto-apply must never block launch —
 * the next `/update` surfaces whatever went wrong with full context.
 *
 * `currentVersion` is what this process is actually running. The swap replaces
 * files on disk, so the running image keeps the old code until the caller
 * re-executes — see `execIntoInstalledUpdate`.
 */
export async function applyStagedOnStartup(currentVersion: string): Promise<string | null> {
  // A source checkout or test runner must never rewrite the user's installed
  // release: it did not come from that install, and the swap would replace a
  // working release with whatever a local build staged.
  if (!isManagedInstall()) return null

  const staged = readStaged()
  if (!staged) return null

  // Stale against what is already running (a concurrent process applied it,
  // or the user updated manually): the download served its purpose or lost.
  if (compareVersions(currentVersion, staged.version) >= 0) {
    clearStaged()
    return null
  }

  // Another evot already applied this exact version to disk. Re-running the
  // installer would redo a 37 MB swap for nothing; the caller still needs to
  // re-exec, because this process is the one holding the old image.
  const installed = installedVersionForThisProcess()
  if (installed && compareVersions(installed, staged.version) >= 0) {
    clearStaged()
    return installed
  }

  // Fast path: apply what is staged; background checks re-stage newer releases.
  const result = await executeInstall(staged.tag, { EVOT_INSTALL_ASSET: staged.assetPath })
  if (!result.success) return null
  clearStaged()
  return staged.version
}

/**
 * Upper bound on waiting for children to exit before `execve`. Long enough for
 * a hook adapter to react to stdin EOF, short enough that a restart still
 * feels instant when one ignores it.
 */
const CHILD_REAP_TIMEOUT_MS = 500

/**
 * Replace this process with the currently installed binary, keeping argv,
 * pid, and the terminal. `execve` never returns on success.
 *
 * Returns only when handing over was impossible; the caller then keeps
 * running the current image rather than failing.
 */
function execIntoInstalledBinary(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const execve = process.execve
  // Not available on Windows/IBM i, where the current image simply keeps running.
  if (typeof execve !== 'function') return
  // Only a running installed evot may hand over to an installed evot. A source
  // checkout (`bun run src/index.ts`) or a test process would otherwise be
  // replaced by the released binary, discarding the code under development.
  if (!runningInstallDir()) return
  const binary = join(installBinDir(), 'evot')
  if (!existsSync(binary)) return
  // execve keeps the pid, so any child still around — the session-hook adapter
  // finishing its shutdown, background tool processes just signalled by
  // cleanup — would be inherited by an image that never waits on it and sit as
  // a zombie until evot exits. Drain them first; a wedged adapter only costs
  // the bounded wait, not the restart.
  reapExitedChildren(CHILD_REAP_TIMEOUT_MS)
  try {
    execve(binary, [binary, ...argv], env)
  } catch {
    // execve only returns on failure (a missing exec bit, ENOMEM). Staying on
    // the current image is the safe fallback.
  }
}

/**
 * Hand the process over to the freshly installed executable.
 *
 * Replacing files on disk does not change the running image: the compiled
 * bundle and its native binding are already mapped, so continuing would run
 * the old version against new install bookkeeping — exactly the
 * "install recorded v…, running v…" mismatch users saw. execve keeps the pid,
 * tty and fds, so the user just sees the new version come up.
 *
 * Returns only when handing over was impossible; the caller then keeps running
 * the old image rather than failing the launch.
 */
export function execIntoInstalledUpdate(appliedVersion: string): void {
  // At most one handover per process chain. The marker is still set when this
  // runs in the re-exec'd process, so a swap that somehow does not change the
  // reported version cannot bounce the session between images forever.
  if (process.env[APPLIED_UPDATE_ENV]) return
  execIntoInstalledBinary(
    process.argv.slice(2),
    { ...process.env, [APPLIED_UPDATE_ENV]: appliedVersion },
  )
}

/**
 * Replace this process with the currently installed binary, keeping argv,
 * pid, and the terminal. Used by `/restart` so an already-applied update
 * (or a hung session) comes up again without leaving the TTY.
 *
 * Unlike {@link execIntoInstalledUpdate}, this always re-execs even when the
 * version on disk matches what is already running: that is the point of an
 * in-place restart.
 */
export function execIntoInstalledRestart(sessionId?: string | null): void {
  const env = { ...process.env }
  delete env[APPLIED_UPDATE_ENV]
  execIntoInstalledBinary(argvForRestart(process.argv.slice(2), sessionId ?? null), env)
}

/** Version handed over by a startup re-exec, consumed once. */
export function takeAppliedUpdate(): string | null {
  const applied = process.env[APPLIED_UPDATE_ENV]
  if (!applied) return null
  // Consume it so child processes and a later re-exec never re-announce.
  delete process.env[APPLIED_UPDATE_ENV]
  return applied
}

/**
 * Announce an applied background update.
 *
 * One-shot prompt runs are scripting surfaces: stdout IS the answer (text or
 * stream-json), so a banner there leaks into captured files and breaks
 * JSON-lines parsers. It rides stderr instead; interactive paths keep the
 * terminal print.
 */
export function reportAppliedUpdate(appliedVersion: string, command: string): void {
  const line = `  ✓ evot updated to v${appliedVersion} in the background; this session is running the new version.`
  // Machine-readable stdout (one-shot output, ACP frames) must stay clean.
  if (command === 'prompt' || command === 'acp') console.error(line)
  else console.log(line)
}
