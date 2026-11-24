export async function testDevice() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const key = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  return {
    key,
    sign: async (nonce: string) =>
      Buffer.from(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          Buffer.from('evot-device-v1:' + nonce),
        ),
      ).toString('base64url'),
  }
}
export async function pendingDevice(address: string) {
  const device = await testDevice()
  const post = async (path: string, body: unknown) => {
    const r = await fetch(address + path, {
      method: 'POST',
      headers: { origin: address, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw Error(`${path}: ${r.status}`)
    return await r.json()
  }
  const { nonce } = (await post('/device/challenge', { key: device.key })) as { nonce: string }
  const { receipt, code } = (await post('/device/prove', { nonce, signature: await device.sign(nonce) })) as {
    receipt: string
    code: string
  }
  return { code, key: device.key, poll: () => post('/device/poll', { receipt }) as Promise<{ token: string }> }
}
