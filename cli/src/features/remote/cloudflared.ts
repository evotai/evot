import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cloudflare's tunnel connector, fetched on first /remote instead of asking the
 * user to install it. Pinned: the version and every digest below are reviewed
 * with the evot release that ships them, so a compromised or swapped download
 * is refused. Bump all of them together from the GitHub release (`digest` of
 * the asset, and the SHA256 list in the release notes for the binary inside).
 */
export const CLOUDFLARED_VERSION = '2026.11.2'
export type Pin = { asset: string; archive?: string; binary: string }
const PINNED: Record<string, Pin> = {
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz',
    archive: 'f6d58eeec91ad1ec5fd1f7e4a587303772929b2625be5d24068033851c36ff55',
    binary: '8654fbdc9057f3e13e95f7892f417f8643113bee1b91ee2388fd0acb05210d55' },
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz',
    archive: '6153d9ec629174882a3adbff2f7dc5a24b4f3bdd7ccc38eaa84fba26eb890311',
    binary: '870dc2094f98befdd993c455234562be4eee51f8fca6e2e356df4579fa7e6766' },
  'linux-x64': { asset: 'cloudflared-linux-amd64', binary: '56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf' },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', binary: '04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281' },
  'linux-arm': { asset: 'cloudflared-linux-arm', binary: 'd219494581180764c6d2454409691bb06879d01b43cdeae12476070a7e4e4762' },
}
const MAX_BYTES = 96 * 1024 * 1024
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function cloudflaredPath(home: string) {
  return join(home, 'bin', 'cloudflared')
}

function pinnedBinary(path: string, digest: string) {
  try {
    return statSync(path).isFile() && sha256(readFileSync(path)) === digest
  } catch { return false }
}

/** A cloudflared on PATH wins; else the pinned copy under ~/.evotai/bin, downloaded once. */
export type InstallProgress = (text: string, bytes?: { done: number; total: number }) => void

async function readBody(response: Response, total: number, progress: InstallProgress, text: string) {
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let done = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    done += chunk.byteLength
    if (done > MAX_BYTES) throw Error('download too large')
    chunks.push(chunk)
    progress(text, { done, total })
  }
  return Buffer.concat(chunks)
}

export async function ensureCloudflared(home: string, progress: InstallProgress, {
  download = url => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) }),
  platform = `${process.platform}-${process.arch}`,
  pins = PINNED,
}: { download?: (url: string) => Promise<Response>; platform?: string; pins?: Record<string, Pin> } = {}): Promise<string> {
  const onPath = Bun.which('cloudflared', { PATH: process.env.PATH ?? '' })
  if (onPath) return onPath
  const pin = pins[platform]
  if (!pin) throw Error(`Remote needs cloudflared, which has no build for ${platform}. Install it from https://developers.cloudflare.com/tunnel/downloads/ and run /remote again.`)
  const target = cloudflaredPath(home)
  if (pinnedBinary(target, pin.binary)) return target
  const text = `Installing cloudflared ${CLOUDFLARED_VERSION}, Cloudflare's tunnel connector`
  progress(`${text}…`)
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${pin.asset}`
  let bytes: Uint8Array
  try {
    const response = await download(url)
    if (!response.ok) throw Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    if (total > MAX_BYTES) throw Error('download too large')
    bytes = await readBody(response, total, progress, text)
  } catch (error) {
    throw Error(`Could not download cloudflared (${error instanceof Error ? error.message : String(error)}). Check the network or proxy and run /remote again.`)
  }
  if (bytes.byteLength > MAX_BYTES || sha256(bytes) !== (pin.archive ?? pin.binary))
    throw Error('The cloudflared download did not match its pinned checksum and was discarded.')
  progress(`Verifying and unpacking cloudflared ${CLOUDFLARED_VERSION}…`)
  mkdirSync(join(home, 'bin'), { recursive: true, mode: 0o755 })
  const work = mkdtempSync(join(home, 'bin', '.cloudflared-'))
  try {
    let binary = join(work, 'cloudflared')
    if (pin.archive) {
      const archive = join(work, 'cloudflared.tgz')
      writeFileSync(archive, bytes)
      const tar = Bun.spawnSync(['tar', '-xzf', archive, '-C', work, 'cloudflared'], { stdout: 'ignore', stderr: 'pipe', timeout: 60_000 })
      if (tar.exitCode !== 0) throw Error('Could not unpack cloudflared.')
    } else writeFileSync(binary, bytes)
    if (!pinnedBinary(binary, pin.binary)) throw Error('The unpacked cloudflared did not match its pinned checksum.')
    chmodSync(binary, 0o755)
    const staged = `${target}.${randomUUID()}`
    renameSync(binary, staged)
    renameSync(staged, target) // atomic; a concurrent TUI installing the same pin is harmless
    binary = target
    return binary
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
