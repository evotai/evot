import { existsSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { installBinDir, runningInstallDir } from './paths.js'

/** Identity of an executable file. Replacing the installed binary (`make
 * install`, install.sh) renames a new file over the path, which changes it;
 * the version string does not, since local builds all report the same one. */
function fileIdentity(path: string): string | null {
  try {
    const stat = statSync(realpathSync(path))
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
}

// Read when the process starts: index.ts imports this module before anything
// slow, so the binary on disk is still the one this process mapped.
const startedFrom = runningInstallDir() ? fileIdentity(process.execPath) : null

/** True when the installed binary is no longer the one this process runs;
 * null when this process did not start from an installed evot. */
export function runningOutdatedBuild(): boolean | null {
  if (startedFrom === null) return null
  const installed = fileIdentity(join(installBinDir(), 'evot'))
  return installed === null ? null : installed !== startedFrom
}

/**
 * Whether `/restart` can hand this process to the installed binary in place.
 * A source checkout or test process never can; it would only exit.
 */
export function canRestartInPlace(): boolean {
  return typeof process.execve === 'function' && !!runningInstallDir() && existsSync(join(installBinDir(), 'evot'))
}
