import { expect, test } from 'bun:test'
import { imageTray } from '../../../src/features/remote/phone-images.js'

const cell = () => ({ append() {}, setAttribute() {} })
const tray = () => ({ ownerDocument:{ createElement:cell }, replaceChildren() {} })
const photo = new File([new Uint8Array(100)], 'camera.jpg', { type:'image/jpeg' })

test('taking a batch is immediate even during decode; byte progress belongs to that batch, not the next draft', async () => {
  const decode = Promise.withResolvers<File>(), progress = Promise.withResolvers<(bytes:number) => void>(), receipt = Promise.withResolvers<string>()
  const photos = imageTray({ tray:tray(), input:{}, button:{}, thumbnail:cell, changed() {}, notice() {},
    prepare:() => decode.promise, upload:(_blob:Blob, report:(bytes:number) => void) => { progress.resolve(report); return receipt.promise } })
  photos.add([photo]); const batch = photos.take()
  expect([photos.count, batch.count, batch.previews().length]).toEqual([0,1,0])
  const seen:string[] = []
  const ready = batch.ready((_previews:unknown[], label:string) => seen.push(label))
  expect(seen.at(-1)).toBe('Preparing photos · 0/1')
  photos.clear() // the submitted batch is no longer owned by the composer
  decode.resolve(photo); const report = await progress.promise
  report(25); expect(seen.at(-1)).toBe('Uploading · 25%')
  report(100); expect(seen.at(-1)).toBe('Waiting for upload receipt…')
  receipt.resolve('receipt'); await ready
  expect(await batch.images(false)).toEqual([{ ref:'receipt' }]); batch.release()
})

test('a decode failure does not silently submit a partial message; its attachments can be restored', async () => {
  const photos = imageTray({ tray:tray(), input:{}, button:{}, thumbnail:cell, changed() {}, notice() {},
    prepare:async () => { throw Error('decode') }, upload:async () => 'unused' })
  photos.add([photo]); const batch = photos.take()
  await expect(batch.ready(() => {})).rejects.toThrow('Could not read camera.jpg')
  batch.restore(); expect(photos.count).toBe(1); photos.clear()
})
