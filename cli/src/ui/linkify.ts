/**
 * Auto-linking for GitHub issue refs and file paths.
 * When the terminal supports OSC 8, refs become clickable hyperlinks.
 */

import { createHyperlink, supportsHyperlinks } from './hyperlink.js'

/**
 * Linkify GitHub issue references (owner/repo#123) and absolute file paths.
 */
export function linkifyIssueRefs(input: string): string {
  const hyperlinks = supportsHyperlinks()
  // First pass: linkify file paths
  let text = hyperlinks ? linkifyFilePaths(input) : input
  // Second pass: linkify GitHub issue refs
  text = linkifyGitHubRefs(text, hyperlinks)
  return text
}

// ---------------------------------------------------------------------------
// File path linkification
// ---------------------------------------------------------------------------

// Match absolute paths: /foo/bar.ext or ~/foo/bar
// Must start at word boundary (after space, start of string, or common punctuation).
// Includes CJK punctuation (：，。、) so paths in Chinese text are matched.
const FILE_PATH_RE = /(?<=^|[\s(（：，。、；])([~/][\w./_-]+(?:\.[\w]+)?)/g

function linkifyFilePaths(input: string): string {
  return input.replace(FILE_PATH_RE, (_match, path: string) => {
    const resolved = path.startsWith('~')
      ? path.replace('~', process.env.HOME ?? '~')
      : path
    return createHyperlink(`file://${resolved}`, path)
  })
}

// ---------------------------------------------------------------------------
// GitHub issue ref linkification
// ---------------------------------------------------------------------------

function linkifyGitHubRefs(input: string, hyperlinks: boolean): string {
  let out = ''
  let cursor = 0
  const hashRe = /#(\d+)/g
  let m

  while ((m = hashRe.exec(input)) !== null) {
    const hashPos = m.index
    const num = m[1]!
    const before = input.slice(cursor, hashPos)
    const slashIdx = before.lastIndexOf('/')
    if (slashIdx === -1) continue
    const absSlash = cursor + slashIdx

    const name = input.slice(absSlash + 1, hashPos)
    if (!name || !/^[a-zA-Z0-9_\-.]+$/.test(name)) continue

    let ownerStart = absSlash - 1
    while (ownerStart >= cursor && /[a-zA-Z0-9_-]/.test(input[ownerStart]!)) ownerStart--
    ownerStart++
    const owner = input.slice(ownerStart, absSlash)
    if (!owner || !/^[a-zA-Z0-9_-]+$/.test(owner)) continue

    // Boundary check: char before owner must not be alphanumeric/repo-like
    if (ownerStart > 0 && /[a-zA-Z0-9_.\/-]/.test(input[ownerStart - 1]!)) continue

    const refText = `${owner}/${name}#${num}`
    out += input.slice(cursor, ownerStart)
    if (hyperlinks) {
      out += createHyperlink(`https://github.com/${owner}/${name}/issues/${num}`, refText)
    } else {
      // Claudecode-style fallback: leave the ref text untouched when OSC 8 is
      // not available. Coloring bare refs adds visual noise without benefit
      // (no click target, already recognizable to the eye).
      out += refText
    }
    cursor = hashPos + m[0].length
  }

  out += input.slice(cursor)
  return out
}
