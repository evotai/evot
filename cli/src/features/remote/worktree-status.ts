import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export function reviewGit(cwd: string, deadline: number) {
  return (args: string[], maxBuffer = 128 * 1024) => exec('git', ['--no-pager','--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false', ...args], {
    cwd, timeout: Math.max(1, Math.min(3000, deadline - Date.now())), maxBuffer, encoding:'utf8',
  }).then(r => r.stdout)
}
export const emptyTree = ['hash-object','-t','tree','/dev/null'] // without -w, including SHA-256 repositories
const quiet = ['diff','--quiet','--no-ext-diff','--no-textconv','--ignore-submodules=dirty']

/** Same net working-tree comparison as the review, not index vs worktree. No patches or rename detection. */
export async function hasWorktreeChanges(cwd: string): Promise<boolean | undefined> {
  const git = reviewGit(cwd, Date.now() + 5000)
  const tracked = async (base: string) => {
    try { await git([...quiet,base,'--','.']); return false }
    catch (e) { if ((e as {code?:unknown}).code === 1) return true; throw e }
  }
  try {
    // Outside a worktree `git diff` can fall back to --no-index (also exit 1).
    // Resolve the base first; only an actual unborn worktree uses the empty tree.
    const base = await git(['rev-parse','--verify','HEAD']).catch(async e => {
      if ((await git(['rev-parse','--is-inside-work-tree'])).trim() !== 'true') throw e
      return git(emptyTree)
    })
    if (await tracked(base.trim())) return true
    try { return !!await git(['ls-files','--others','--exclude-standard','--directory','--no-empty-directory','-z','--','.'], 4096) }
    catch (e) {
      // A full stdout buffer is already proof of at least one name.
      if ((e as {code?:unknown;stdout?:string}).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && (e as {stdout?:string}).stdout) return true
      throw e
    }
  } catch { return undefined }
}

/** Demand-driven: polling and streams share a probe, and unwatched windows never poll Git. */
export function worktreeStatusCache(probe = hasWorktreeChanges, now = Date.now) {
  let entry: {cwd:string; value?:boolean; next:number} | undefined
  return (cwd:string) => {
    if (entry?.cwd !== cwd) entry = {cwd,next:0}
    const slot = entry
    if (now() >= slot.next) {
      slot.next = Infinity
      void probe(cwd).then(v => { slot.value = v }, () => { slot.value = undefined })
        .finally(() => { slot.next = now() + 5000 })
    }
    return slot.value
  }
}
