import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A controlling PTY lets us inspect the kernel's stopped state and canonical
// mode, not just mock process.kill or assert escape sequences in source text.
const probe = String.raw`
import os, pty, select, signal, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2]])
os.set_blocking(fd, False)
output = b''
reaped = False
def read_some():
    global output
    if select.select([fd], [], [], .02)[0]:
        try: output += os.read(fd, 65536)
        except (BlockingIOError, OSError): pass
def until(check, message):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if check(): return
        read_some()
    raise AssertionError(message + ': ' + repr(output))
def stopped():
    child, status = os.waitpid(pid, os.WUNTRACED | os.WNOHANG)
    return child == pid and os.WIFSTOPPED(status)
try:
    until(lambda: b'JOB-CONTROL-READY' in output, 'startup')
    assert not termios.tcgetattr(fd)[3] & termios.ICANON
    for external in (False, True):
        output = b''
        if external: os.kill(pid, signal.SIGTSTP)
        else: os.write(fd, b'\x1a')
        until(stopped, 'process did not stop')
        read_some()
        flags = termios.tcgetattr(fd)[3]
        assert flags & termios.ICANON and flags & termios.ECHO, flags
        assert b'\x1b[?2004l' in output and b'\x1b[?25h' in output, repr(output)
        output = b''
        os.kill(pid, signal.SIGCONT)
        until(lambda: b'\x1b[?2004h' in output, 'terminal did not resume')
        os.write(fd, b'!')
        until(lambda: b'CHECK:saved draft:true' in output, 'draft or raw mode lost')
        assert not termios.tcgetattr(fd)[3] & termios.ICANON
    os.write(fd, b'q')
    exit_status = []
    def exited():
        child, status = os.waitpid(pid, os.WNOHANG)
        if child: exit_status.append(status)
        return bool(child)
    until(exited, 'process did not exit')
    reaped = True
    status = exit_status[0]
    assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
    assert termios.tcgetattr(fd)[3] & termios.ICANON
    print('job control restored twice')
finally:
    if not reaped:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(pid, 0)
    os.close(fd)
`

const canRun = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0

test.skipIf(!canRun)('Ctrl-Z and external SIGTSTP release terminal ownership; SIGCONT restores input and draft', () => {
  const fixture = fileURLToPath(new URL('../../helpers/terminal-job-control.ts', import.meta.url))
  const result = spawnSync('python3', ['-c', probe, process.execPath, fixture], { encoding: 'utf8', timeout: 15_000 })
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  expect(result.stdout).toContain('job control restored twice')
}, 20_000)
