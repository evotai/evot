import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const verifier = join(root, '.github/scripts/verify-release-assets.py')
const fixture = fileURLToPath(new URL('../fixtures/release-assets-fixture.py', import.meta.url))
const targets = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
]
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  'continue-on-error'?: boolean
  with?: Record<string, string>
}
interface Job {
  if?: string
  needs?: string[]
  steps: Step[]
  strategy?: { matrix: { include: Array<{ target: string }> } }
}
const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')) as { jobs: Record<string, Job> }
const setup = Bun.YAML.parse(readFileSync(join(root, '.github/actions/setup-rust/action.yml'), 'utf8')) as {
  inputs: Record<string, { default: string }>
  runs: { steps: Step[] }
}

describe('release publication contract', () => {
  test('failed, cancelled, or skipped prerequisites can never publish', () => {
    const finalize = workflow.jobs.finalize_release!
    expect(finalize.needs).toEqual(['create_release', 'build'])
    const permits = new Function('success', 'github', 'needs', `return (${finalize.if})`) as (
      success: () => boolean,
      github: { ref_name: string },
      needs: Record<string, { result: string }>,
    ) => boolean
    for (const create of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const build of ['success', 'failure', 'cancelled', 'skipped']) {
        const needs = { create_release: { result: create }, build: { result: build } }
        expect(permits(() => true, { ref_name: 'main' }, needs)).toBe(create === 'success' && build === 'success')
        expect(permits(() => true, { ref_name: 'feature' }, needs)).toBe(false)
        expect(permits(() => false, { ref_name: 'main' }, needs)).toBe(false)
      }
    }
  })

  test('remote package verification runs before undraft, using the workflow revision', () => {
    const steps = workflow.jobs.finalize_release!.steps
    const checkout = steps.find(step => step.uses === 'actions/checkout@v5')
    expect(checkout?.with?.ref).toBe('${{ github.sha }}')
    const verify = steps.findIndex(step => step.run?.includes('verify-release-assets.py'))
    const publish = steps.findIndex(step => step.run?.includes('gh release edit'))
    expect(verify).toBeGreaterThan(0)
    expect(publish).toBeGreaterThan(verify)
    expect(steps[verify]?.if).toBeUndefined()
    expect(steps[verify]?.['continue-on-error']).toBeUndefined()
    expect(steps[publish]?.if).toBeUndefined()
    expect(steps[publish]?.run).toContain('--draft=false')
    expect(workflow.jobs.build!.strategy?.matrix.include.map(entry => entry.target)).toEqual(targets)
  })

  test('release builds do not depend on downloading unused sccache', () => {
    const step = workflow.jobs.build!.steps.find(step => step.uses === './.github/actions/setup-rust')
    expect(step?.with?.sccache).toBe('false')
    expect(setup.inputs.sccache?.default).toBe('true')
    expect(setup.runs.steps.find(step => step.name === 'Setup sccache')?.if).toBe("inputs.sccache == 'true'")
  })
})

function verify(scenario: string, tag = 'v2026.11.9', downloadFails: boolean | 'once' = false) {
  const dir = mkdtempSync(join(tmpdir(), 'evot-release-test-'))
  directories.push(dir)
  const created = Bun.spawnSync(['python3', fixture, 'create', dir, tag, scenario])
  expect(created.exitCode).toBe(0)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexec python3 "$EVOT_RELEASE_FIXTURE_SCRIPT" "$@"\n', { mode: 0o755 })
  const result = Bun.spawnSync(['python3', verifier, tag, '--repo', 'evotai/evot'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      EVOT_RELEASE_FIXTURE: dir,
      EVOT_RELEASE_FIXTURE_SCRIPT: fixture,
      EVOT_RELEASE_DOWNLOAD_FAIL: downloadFails === 'once' ? 'once' : downloadFails ? '1' : '0',
    },
  })
  return { result, dir, stderr: result.stderr.toString(), stdout: result.stdout.toString() }
}

describe('remote release package verification', () => {
  test.each(['v2026.11.9', 'v2026.11.9.2', 'v2026.11.9-beta.1'])('accepts complete, verified packages for %s', tag => {
    const { result, stdout, dir } = verify('valid', tag)
    expect(result.exitCode).toBe(0)
    expect(stdout).toContain('All 4 platform packages and checksums verified')
    for (const target of targets) expect(stdout).toContain(`evot-${tag}-${target}.tar.gz`)
    const calls = readFileSync(join(dir, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls).toHaveLength(9)
    expect(calls.slice(1).every(args => args.includes('--clobber'))).toBe(true)
    const patterns = calls.slice(1).map(args => args[args.indexOf('--pattern') + 1])
    expect(new Set(patterns).size).toBe(8)
  })

  test.each([
    ['missing-package', 'expected exactly one release asset'],
    ['missing-checksum', 'expected exactly one release asset'],
    ['duplicate', 'expected exactly one release asset'],
    ['empty-upload', 'empty or not uploaded'],
    ['incomplete-upload', 'empty or not uploaded'],
  ])('rejects %s before downloading', (scenario, error) => {
    const { result, stderr, dir } = verify(scenario)
    expect(result.exitCode).not.toBe(0)
    expect(stderr).toContain(error)
    expect(readFileSync(join(dir, 'commands.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test.each([
    ['bad-checksum', 'SHA-256 mismatch'],
    ['invalid-checksum', 'invalid SHA-256 file'],
    ['corrupt-archive', 'Release verification failed'],
    ['missing-binary', 'missing or invalid bin/evot'],
    ['not-executable', 'bin/evot is not executable'],
    ['wrong-binding', 'missing or invalid lib/evot-napi.linux-x64-gnu.node'],
    ['symlink', 'missing or invalid bin/evot'],
  ])('rejects %s rather than treating an uploaded filename as sufficient', (scenario, error) => {
    const { result, stderr } = verify(scenario)
    expect(result.exitCode).not.toBe(0)
    expect(stderr).toContain(error)
  })

  test('transient CDN failure retries and overwrites a partial download', () => {
    const { result, stdout, dir } = verify('valid', 'v2026.11.9', 'once')
    expect(result.exitCode).toBe(0)
    expect(stdout).toContain('All 4 platform packages and checksums verified')
    const calls = readFileSync(join(dir, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls).toHaveLength(10)
    expect(calls[1]).toEqual(calls[2])
  })

  test('persistent download errors fail closed after bounded retries', () => {
    const { result, stderr, dir } = verify('valid', 'v2026.11.9', true)
    expect(result.exitCode).not.toBe(0)
    expect(stderr).toContain('Release verification failed')
    expect(readFileSync(join(dir, 'commands.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4)
  })
})
