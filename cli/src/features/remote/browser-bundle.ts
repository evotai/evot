import { join } from 'node:path'

/** Bun macro: ship the whole browser module graph with the HTML. Runs on the
 * build host, never in the compiled TUI. Bun.build cannot nest inside a macro. */
export function bundlePhone(): string {
  const build = Bun.spawnSync([process.execPath, 'build', join(import.meta.dir, 'phone-start.js'),
    '--target=browser', '--format=iife', '--minify'], {stdout:'pipe', stderr:'pipe'})
  if (build.exitCode !== 0) throw Error(`Cannot build remote browser client: ${build.stderr.toString()}`)
  return build.stdout.toString()
}
