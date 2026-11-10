import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { GitInfoProvider } from '../../src/term/git-info.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRepoHead(branch: string): { root: string; headPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'evot-git-info-'))
  roots.push(root)
  const gitDir = join(root, '.git')
  mkdirSync(gitDir)
  const headPath = join(gitDir, 'HEAD')
  writeFileSync(headPath, `ref: refs/heads/${branch}\n`)
  return { root, headPath }
}

describe('GitInfoProvider', () => {
  test('refresh updates a branch changed before the watcher fires', () => {
    const { root, headPath } = createRepoHead('docs/ai-document-pipeline')
    const provider = new GitInfoProvider(root)
    let changes = 0
    provider.onChange(() => { changes++ })

    try {
      expect(provider.getBranch()).toBe('docs/ai-document-pipeline')
      writeFileSync(headPath, 'ref: refs/heads/main\n')

      expect(provider.refresh()).toBe(true)
      expect(provider.getBranch()).toBe('main')
      expect(changes).toBe(1)
      expect(provider.refresh()).toBe(false)
      expect(changes).toBe(1)
    } finally {
      provider.dispose()
    }
  })
})
