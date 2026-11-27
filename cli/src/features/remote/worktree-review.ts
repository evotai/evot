import { emptyTree, reviewGit } from './worktree-status.js'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import { html, parse } from 'diff2html'

const fileLimit = 96, patchLimit = 128 * 1024, lineLimit = 2000
export interface ReviewFile { name: string; status: string; note?: string; unified?: string; split?: string }
export interface WorktreeReview { folder: string; branch: string; files: ReviewFile[]; message?: string }

/** No request paths or shell commands: the shared terminal supplies its own cwd. */
export async function worktreeReview(cwd: string): Promise<WorktreeReview> {
  const root = await realpath(cwd), deadline = Date.now() + 9000
  const git = reviewGit(root, deadline)
  const result: WorktreeReview = {folder:basename(root) || '/', branch:'', files:[]}
  if (await git(['rev-parse','--is-inside-work-tree']).catch(() => '') !== 'true\n')
    return {...result, message:'No Git working tree in this folder.'}
  result.branch = (await git(['symbolic-ref','--short','-q','HEAD']).catch(() => '')).trim()
  // hash-object without -w computes the empty tree ID (including for SHA-256 repos).
  const head = (await git(['rev-parse','--verify','HEAD']).catch(() => git(emptyTree))).trim()
  const diff = ['diff','--relative','--no-ext-diff','--no-textconv','--no-color','--ignore-submodules=dirty','--find-renames']
  const [tracked, untracked] = await Promise.all([git([...diff,'--name-status','-z',head,'--','.'], 1024*1024),
    git(['ls-files','--others','--exclude-standard','-z','--','.'], 1024*1024)])
  const names = tracked.split('\0'), entries: {status:string; names:string[]}[] = []
  for (let i = 0; names[i];) {
    const status = names[i++]![0]!, first = names[i++]!
    entries.push({status, names:status === 'R' || status === 'C' ? [first,names[i++]!] : [first]})
  }
  for (const name of untracked.split('\0')) if (name) entries.push({status:'?',names:[name]})
  entries.sort((a,b) => a.names.at(-1)!.localeCompare(b.names.at(-1)!))
  let linesLeft = lineLimit, bytesLeft = 2 * patchLimit
  for (const entry of entries.slice(0,fileLimit)) {
    const file: ReviewFile = {name:entry.names.join(' → '),status:entry.status}
    result.files.push(file)
    // List common credential files without copying their contents to the phone.
    if (entry.names.some(n => /^(?:\.env(?:\..*)?|evot\.env|id_(?:rsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(basename(n)))) {
      file.note = 'Sensitive file. Preview hidden.'; continue
    }
    if (Date.now() >= deadline || bytesLeft <= 0 || linesLeft <= 0) { file.note = 'Preview limit reached.'; continue }
    try {
      let patch: string
      if (entry.status === '?') {
        const path = resolve(root,entry.names[0]!)
        // Don't follow symlinks, traverse a nested repository, or block on a pipe.
        if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || await realpath(path) !== path) { file.note = 'Not a regular file.'; continue }
        const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = await fd.stat()
          if (!stat.isFile()) { file.note = 'Not a regular file.'; continue }
          if (stat.size > patchLimit) { file.note = 'Too large to preview.'; continue }
          const buf = Buffer.alloc(stat.size), {bytesRead} = await fd.read(buf)
          if (bytesRead !== stat.size) { file.note = 'File changed. Refresh to review.'; continue }
          if (buf.includes(0)) { file.note = 'Binary file.'; continue }
          let text: string
          try { text = new TextDecoder('utf-8',{fatal:true}).decode(buf) } catch { file.note = 'Binary file.'; continue }
          if (!text) { file.note = 'Empty file.'; continue }
          const lines = text.replace(/\n$/,'').split('\n')
          if (lines.length > Math.min(700,linesLeft)) { file.note = 'Too large to preview.'; continue }
          patch = `diff --git a/file b/file\n--- /dev/null\n+++ b/file\n@@ -0,0 +1,${lines.length} @@\n${lines.map(s=>'+'+s).join('\n')}\n`
        } finally { await fd.close() }
      } else patch = await git([...diff,'--patch',head,'--',...entry.names])
      if (/^(Binary files |GIT binary patch$)/m.test(patch)) { file.note = 'Binary file.'; continue }
      const lines = patch.split('\n').length
      if (patch.length > bytesLeft || lines > Math.min(700,linesLeft) || patch.split('\n').some(s=>s.length>8000)) { file.note = 'Too large to preview.'; continue }
      bytesLeft -= patch.length; linesLeft -= lines
      const parsed = parse(patch)
      if (!parsed.some(f=>f.blocks.length)) { file.note = 'No text changes.'; continue }
      const opts = {drawFileList:false, maxLineLengthHighlight:512, matchingMaxComparisons:1000}
      file.unified = html(parsed,{...opts,outputFormat:'line-by-line'})
      file.split = html(parsed,{...opts,outputFormat:'side-by-side'})
    } catch { file.note = 'Preview unavailable or too large.' }
  }
  if (entries.length > fileLimit) result.message = `Showing ${fileLimit} of ${entries.length} files.`
  return result
}
