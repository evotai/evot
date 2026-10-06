import { join, dirname, resolve } from 'path'

/** Keep lookup separate from module initialization so failures can be tested. */
export function loadNativeBinding({ platform, arch, moduleDir, execPath, evotHome, exists, load }) {
  const triples = {
    'darwin-arm64': 'evot-napi.darwin-arm64.node',
    'darwin-x64': 'evot-napi.darwin-x64.node',
    'linux-x64': 'evot-napi.linux-x64-gnu.node',
    'linux-arm64': 'evot-napi.linux-arm64-gnu.node',
  }
  const key = `${platform}-${arch}`
  const filename = triples[key]
  if (!filename) throw new Error(`Unsupported platform: ${key}`)

  // Local source builds win in dev mode; compiled installs load their paired lib.
  const executableDir = dirname(execPath)
  const candidates = [...new Set([
    join(moduleDir, '..', '..', filename),
    join(executableDir, 'lib', filename),
    join(executableDir, '..', 'lib', filename),
    join(evotHome, 'lib', filename),
  ])]
  for (const candidate of candidates) {
    if (!exists(candidate)) continue
    try {
      const binding = load(resolve(candidate))
      if (typeof binding?.NapiAgent?.create !== 'function' || typeof binding?.version !== 'function') {
        throw new Error('Missing required exports: NapiAgent.create and version')
      }
      return binding
    } catch (cause) {
      // Do not silently fall back to a different build: CLI/addon must be paired.
      throw new Error(`Cannot load native addon ${candidate}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
  }
  throw new Error(`Cannot find ${filename} in any of:\n${candidates.map(c => `  - ${c}`).join('\n')}`)
}
