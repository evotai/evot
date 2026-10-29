/**
 * Background download of a release into a staging directory.
 *
 * The goal is that `/update` and the next startup never wait on a 37 MB
 * transfer: by the time the user acts, the archive is already on disk,
 * checksum-verified, and its binary proven runnable. Staging is deliberately
 * side-effect-free with respect to the running install — download, validation
 * and backup/rollback all belong to install.sh. This module only publishes the
 * compatible staging manifest after the installer succeeds.
 *
 * Layout under stateDir()/staging/<version>/:
 *   evot-v<version>-<target>.tar.gz       verified archive
 *   evot-v<version>-<target>.tar.gz.sha256  sidecar used by install.sh
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, closeSync, fsyncSync } from 'fs'
import { join } from 'path'
import type { ReleaseInfo } from './types.js'
import { currentTarget, stateDir } from './paths.js'
import { executeInstall } from './install.js'

export interface StagedUpdate {
  tag: string
  version: string
  target: string
  /** Archive path handed to install.sh via EVOT_INSTALL_ASSET. */
  assetPath: string
  stagedAt: number
}

interface Manifest {
  tag: string
  version: string
  target: string
  staged_at: number
}

export class StageAborted extends Error {}

function stagingRoot(): string {
  return join(stateDir(), 'staging')
}

/** Prune staging entries superseded by the currently staged version, plus
 * download scratch left behind by a process that died mid-stage. */
function pruneSupersededVersions(current: string): void {
  try {
    for (const entry of readdirSync(stagingRoot())) {
      if (entry === current || entry.endsWith('.json')) continue
      const path = join(stagingRoot(), entry)
      if (entry.startsWith('.download-') && Date.now() - statSync(path).mtimeMs < STALE_SCRATCH_MS) continue
      if (entry.startsWith('.') && !entry.startsWith('.download-')) continue
      rmSync(path, { recursive: true, force: true })
    }
  } catch { /* best effort */ }
}

/** A live stage-only install finishes well inside this; older scratch is dead. */
const STALE_SCRATCH_MS = 6 * 60 * 60_000

/** Drop whatever readStaged would not consider current, siblings included. */
export function pruneStaleStaging(): void {
  const staged = readStaged()
  if (staged) pruneSupersededVersions(staged.version)
}

function versionDir(version: string): string {
  return join(stagingRoot(), version)
}

function assetName(version: string, target: string): string {
  return `evot-v${version}-${target}.tar.gz`
}

/**
 * The staged update for this machine, if one is complete and still valid.
 *
 * Validation is cheap on purpose — manifest shape plus file presence — so the
 * startup path can call it unconditionally. Deeper checks (checksum ran during
 * staging; binary provenance was proven then too) are not repeated.
 */
export function readStaged(): StagedUpdate | null {
  const target = currentTarget()
  if (!target) return null
  try {
    const parsed = JSON.parse(readFileSync(join(stagingRoot(), 'staged.json'), 'utf-8')) as Partial<Manifest>
    if (
      typeof parsed?.version !== 'string' || !parsed.version ||
      typeof parsed?.tag !== 'string' ||
      parsed.target !== target
    ) return null
    const assetPath = join(versionDir(parsed.version), assetName(parsed.version, target))
    const sidecar = `${assetPath}.sha256`
    if (!existsSync(assetPath) || !existsSync(sidecar)) return null
    // A manifest without a timestamp predates resume support; treat as absent
    // rather than guessing what is on disk.
    if (typeof parsed.staged_at !== 'number') return null
    return {
      tag: parsed.tag,
      version: parsed.version,
      target,
      assetPath,
      stagedAt: parsed.staged_at,
    }
  } catch {
    return null
  }
}

/** Remove any staged download. Called after a successful apply or a corrupt find. */
export function clearStaged(): void {
  try {
    rmSync(stagingRoot(), { recursive: true, force: true })
  } catch { /* best effort */ }
}

/** Installer port: tests can supply an offline shell runner. Asset handling
 * remains exclusively in install.sh, never in the TypeScript host. */
export type StageInstaller = typeof executeInstall

export async function stageUpdate(
  release: ReleaseInfo,
  signal: AbortSignal,
  install: StageInstaller = executeInstall,
): Promise<StagedUpdate> {
  const target = currentTarget()
  if (!target) throw new Error('unsupported platform for auto-update')
  if (!/^[0-9][0-9A-Za-z.-]*$/.test(release.version) || release.tag !== `v${release.version}`) throw new Error('invalid release identity')
  if (signal.aborted) throw new StageAborted('download aborted')
  mkdirSync(stagingRoot(), { recursive: true })
  const temporary = mkdtempSync(join(stagingRoot(), '.download-'))
  const dir = versionDir(release.version)
  try {
    const result = await install(release.tag, { EVOT_STAGE_DIR: temporary, TMPDIR: temporary }, { signal })
    if (signal.aborted) throw new StageAborted('download aborted')
    if (!result.success) throw new Error(result.output)
    const asset = assetName(release.version, target)
    if (!existsSync(join(temporary, asset)) || !existsSync(join(temporary, `${asset}.sha256`))) throw new Error('installer did not publish a staged archive')
    rmSync(dir, { recursive: true, force: true })
    renameSync(temporary, dir)
    const manifest: Manifest = { tag: release.tag, version: release.version, target, staged_at: Date.now() }
    const manifestPath = join(stagingRoot(), `.staged-${process.pid}-${Date.now()}.json`)
    const fd = openSync(manifestPath, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(manifest)); fsyncSync(fd) } finally { closeSync(fd) }
    try { renameSync(manifestPath, join(stagingRoot(), 'staged.json')) } finally { rmSync(manifestPath, { force: true }) }
    pruneSupersededVersions(release.version)
    return { tag: release.tag, version: release.version, target, assetPath: join(dir, asset), stagedAt: manifest.staged_at }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

