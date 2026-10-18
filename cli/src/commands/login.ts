import { exec } from 'node:child_process'

import { authBegin, authPoll } from '../native/index.js'
import { DEFAULT_SERVER, defaultDeps, loginDeniedMessage, runDeviceLogin, type LoginOutcome } from './login-flow.js'

export { DEFAULT_SERVER }

export async function runLogin(): Promise<boolean> {
  console.log('\nevot login\n')
  const fingerprint = await deviceFingerprint()

  try {
    const { outcome } = await runDeviceLogin(
      { ...defaultDeps, begin: authBegin, poll: authPoll },
      DEFAULT_SERVER,
      fingerprint,
      (url) => {
        openLoginBrowser(url)
        console.log(`Open this URL in your browser to log in:\n\n  ${url}\n`)
      },
    )
    report(outcome)
    return outcome.status === 'success'
  } catch (err) {
    console.error(`  ✗ cannot reach evot server (${DEFAULT_SERVER})`)
    console.error(`    ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}

function report(outcome: LoginOutcome): void {
  switch (outcome.status) {
    case 'success':
      console.log(`  ✓ logged in as ${outcome.user.name} <${outcome.user.email}>`)
      if (outcome.syncError) console.warn(`  ⚠ model sync failed: ${outcome.syncError}`)
      else console.log('  ✓ free models synced')
      break
    case 'denied':
      console.error(`  ✗ ${loginDeniedMessage(outcome)}`)
      break
    case 'timeout':
      console.error('  ✗ login timed out, try again')
      break
  }
}

export async function runLogout(): Promise<void> {
  const { authLogout } = await import('../native/index.js')
  await authLogout()
  console.log('  ✓ logged out')
}

export async function runWhoami(): Promise<number> {
  const { authWhoami } = await import('../native/index.js')
  const user = await authWhoami()
  if (!user) {
    console.log('  not logged in (run `evot login` or `/login`, or configure a provider with an API key)')
    return 1
  }
  console.log(`  ${user.name} <${user.email}> (${user.id})`)
  return 0
}

export async function deviceFingerprint(): Promise<string> {
  const { createHash } = await import('node:crypto')
  const os = await import('node:os')
  return createHash('sha256')
    .update(`${os.hostname()}:${os.platform()}:${os.arch()}:${os.userInfo().username}`)
    .digest('hex')
    .slice(0, 32)
}

export function openLoginBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'
  exec(`${cmd} "${url}"`, () => {})
}
