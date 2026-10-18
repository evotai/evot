import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Child-process-only clipboard. Never reads or changes the developer clipboard. */
export function fixtureClipboard(home: string, imageBase64: string): string {
  const bin = join(home, 'clipboard-bin')
  mkdirSync(bin)
  const script = `#!/usr/bin/env python3
import base64, pathlib, re, sys, time
args = ' '.join(sys.argv[1:])
if 'clipboard info' in args:
    print('PNGf, 75')
elif 'TARGETS' in args or '--list-types' in args:
    print('image/png')
else:
    time.sleep(0.3)
    data = base64.b64decode('${imageBase64}')
    target = re.search(r'POSIX file "([^"]+)"', args)
    if target:
        pathlib.Path(target.group(1)).write_bytes(data)
    else:
        sys.stdout.buffer.write(data)
`
  for (const name of ['osascript', 'xclip', 'wl-paste']) {
    const file = join(bin, name)
    writeFileSync(file, script)
    chmodSync(file, 0o755)
  }
  return bin
}
