import { fileURLToPath } from 'node:url'

// Use a subprocess: a malformed addon can terminate the runtime during dlopen.
// Exit status alone is not sufficient; require a post-load success marker too.
const loader = fileURLToPath(new URL('../src/native/binding.js', import.meta.url))
const marker = 'evot-native-load-ok'
const child = Bun.spawnSync([process.execPath, '--eval', `
  const { NapiAgent, version } = await import(${JSON.stringify(loader)});
  if (typeof NapiAgent?.create !== 'function' || typeof version() !== 'string') {
    throw new Error('Invalid native addon exports');
  }
  console.log(${JSON.stringify(marker)});
`], { stdout: 'pipe', stderr: 'pipe' })
if (child.exitCode !== 0 || child.stdout.toString().trim() !== marker) {
  console.error('Native addon load check failed. Refusing to build/install a broken CLI.')
  console.error(child.stderr.toString().trim() || `Addon load terminated without success (exit ${child.exitCode}).`)
  process.exit(1)
}
console.log('Native addon load check passed.')
