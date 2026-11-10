import { expect, test } from 'bun:test'
import { runInstallerScript } from '../../src/update/installer-process.js'

test('installer streams inert progress before it exits', async () => {
  const lines: string[] = []
  const result = await runInstallerScript("printf '\\033[31mdownloading\\033[0m\\rverified\\n' >&2; printf 'done\\n'", process.env as Record<string, string>, { onProgress: line => lines.push(line) })
  expect(result.success).toBe(true)
  expect(lines).toContain('downloading')
  expect(lines).toContain('verified')
  expect(lines.join('')).not.toContain('\x1b')
})

test('cancelling staging terminates the shell process group', async () => {
  const controller = new AbortController()
  const result = await runInstallerScript("printf 'started\\n'; sleep 60", process.env as Record<string, string>, { signal: controller.signal, onProgress: () => controller.abort() })
  expect(result).toEqual({ success: false, output: 'Installation cancelled' })
})
