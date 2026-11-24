import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function remoteHome() {
  return process.env.EVOT_HOME || join(homedir(), '.evotai')
}
export const sharingScope = (home: string, config: string, account: string) =>
  createHash('sha256')
    .update(JSON.stringify([resolve(home), resolve(config), account]))
    .digest('hex')
    .slice(0, 24)
// Stable origin for the browser's non-exportable key. Fail closed on collisions.
export const gatewayPort = (scope: string) => 15000 + (parseInt(scope.slice(0, 8), 16) % 32000)
