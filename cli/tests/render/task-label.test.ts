import { describe, expect, test } from 'bun:test'
import { stripTaskSetup, taskCommandLabel, taskDirectory, taskTitle } from '../../src/render/task-label.js'

const HOME = process.env.HOME ?? ''

describe('stripTaskSetup', () => {
  test('drops a leading cd and keeps the rest of the pipeline', () => {
    const command = 'cd /home/dev/databend && cargo fmt --all && cargo clippy -p databend-storages-common-cache -- -D warnings 2>&1 | head'
    expect(stripTaskSetup(command)).toEqual({
      command: 'cargo fmt --all && cargo clippy -p databend-storages-common-cache -- -D warnings 2>&1 | head',
      dir: '/home/dev/databend',
    })
  })

  test('skips variable assignments to the first command that runs', () => {
    const command = `S="-o BatchMode=yes -o IdentityAgent=none -i $HOME/.ssh/id_ed25519 -o ServerAliveInterval=60"; ssh $S db0 'cd bench && ./run.sh sf100'`
    expect(stripTaskSetup(command).command).toBe(`ssh $S db0 'cd bench && ./run.sh sf100'`)
  })

  test('skips export and set options too', () => {
    expect(stripTaskSetup('set -euo pipefail; export RUST_LOG=debug A=1; cargo test').command).toBe('cargo test')
  })

  test('separators inside quotes do not split a step', () => {
    expect(stripTaskSetup(`MSG="a; b && c"; echo "$MSG"`).command).toBe('echo "$MSG"')
  })

  test('an env prefix on the command itself is part of the command', () => {
    expect(stripTaskSetup('RUST_LOG=debug cargo run').command).toBe('RUST_LOG=debug cargo run')
  })

  test('a cd guarded by || is not plain setup', () => {
    expect(stripTaskSetup('cd build || exit 1').command).toBe('cd build || exit 1')
  })

  test('a command that is only setup is shown as written', () => {
    expect(stripTaskSetup('cd /tmp').command).toBe('cd /tmp')
  })

  test('newline-separated setup is stripped like `;`', () => {
    expect(stripTaskSetup('cd "/srv/my app"\nmake check')).toEqual({ command: 'make check', dir: '/srv/my app' })
  })
})

describe('taskCommandLabel', () => {
  test('a script that stays multi-line after setup names itself a script', () => {
    expect(taskCommandLabel('cd /w\ncargo build\ncargo test')).toBe('script (2 lines)')
  })

  test('setup on its own lines leaves a one-line command', () => {
    expect(taskCommandLabel('cd /w\nexport A=1\ncargo build')).toBe('cargo build')
  })
})

describe('taskTitle', () => {
  test('a launch description names the task', () => {
    expect(taskTitle({ command: 'cd /w && cargo clippy', description: '  clippy   storages ' })).toBe('clippy storages')
  })

  test('without one, the command label does', () => {
    expect(taskTitle({ command: 'cd /w && cargo clippy', description: null })).toBe('cargo clippy')
  })
})

describe('taskDirectory', () => {
  test('a cd into the task cwd is not worth a column', () => {
    expect(taskDirectory('cd /repo && make', '/repo')).toBeUndefined()
    expect(taskDirectory('cd . && make', '/repo')).toBeUndefined()
  })

  test('a cd elsewhere is shown, relative paths resolved against the cwd', () => {
    expect(taskDirectory('cd ../other && make', '/work/repo')).toBe('/work/other')
    expect(taskDirectory('cd /srv && make', '/repo')).toBe('/srv')
  })

  test('paths under home are shortened', () => {
    if (!HOME) return
    expect(taskDirectory(`cd ${HOME}/src/app && make`, '/tmp')).toBe('~/src/app')
  })

  test('a directory the CLI cannot resolve is shown as written', () => {
    expect(taskDirectory('cd $REPO && make', '/repo')).toBe('$REPO')
  })
})
