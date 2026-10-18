import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from '../../src/app/tests/fixtures/schema/suggestion-request-images.json'
import { suggestionImages } from '../src/term/app/suggestion/images.js'
import { prepareSuggestion, readSuggestion } from '../src/term/app/suggestion/request.js'
import { PromptSuggestion } from '../src/term/app/suggestion/controller.js'
import { PendingImages } from '../src/term/app/pending-images.js'
import type { PastedImage } from '../src/term/app/paste-input.js'
import { context } from './helpers/suggestion-context.js'

const image: PastedImage = { id: 1, base64: fixture.images[0]!.data, mediaType: 'image/png' }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('uploads only referenced images once, including file-backed history, without mutating the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suggestion-image-'))
  try {
    const path = join(dir, 'image.png')
    writeFileSync(path, Buffer.from(image.base64, 'base64'))
    const images = new Map<number, PastedImage>([[1, image], [2, { ...image, id: 2, base64: '', filePath: path }], [3, { ...image, id: 3 }]])
    const result = await suggestionImages('[Image #2] [Image #1] [Image #2]', images, new PendingImages(), new AbortController().signal)
    expect(result.map(item => item.id)).toEqual([2, 1])
    expect(result.map(item => item.data)).toEqual([image.base64, image.base64])
    expect(images.get(2)?.base64).toBe('')
    expect(images.size).toBe(3)
    await expect(suggestionImages('[Image #99]', images, new PendingImages(), new AbortController().signal)).rejects.toThrow('unavailable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pending paste waits before exactly one request; cached cycling never uploads again', async () => {
  const images = new Map<number, PastedImage>()
  const pending = new PendingImages()
  let finish!: () => void
  pending.track(1, new Promise<void>(resolve => { finish = resolve }).then(() => { images.set(1, image) }))
  let uploads = 0
  const controller = new PromptSuggestion({
    key: () => 's', eligible: () => true, context, changed: () => {}, draft: () => '[Image #1]',
    start: (_messages, hints) => prepareSuggestion(async signal => {
      const attached = await suggestionImages((hints?.draft ?? '') + (hints?.suffix ?? ''), images, pending, signal)
      signal.throwIfAborted()
      uploads++
      expect(attached).toEqual([{ id: 1, media_type: 'image/png', data: image.base64 }])
      return { result: async () => null, outcome: async () => ({ status: 'ready', candidates: [' explain the image', ' compare the layout'] }), abort: () => {} }
    }),
  })
  controller.complete('[Image #1]')
  await tick()
  expect(controller.pending()).toBe(true)
  expect(uploads).toBe(0)
  finish()
  await tick()
  expect(controller.text()).toBe(' explain the image')
  controller.next()
  expect(controller.text()).toBe(' compare the layout')
  controller.cancel()
  controller.complete('[Image #1]')
  expect(uploads).toBe(1)
  expect(controller.text()).toBe(' explain the image')
})

test('the deadline includes preparation instead of waiting indefinitely for image bytes', async () => {
  const request = prepareSuggestion(() => new Promise(() => {}), 5)
  expect((await readSuggestion(request, () => {})).status).toBe('timed_out')
})

test('cancelling image preparation never uploads later or cancels the pasted attachment', async () => {
  const images = new Map<number, PastedImage>()
  const pending = new PendingImages()
  let finish!: () => void
  pending.track(1, new Promise<void>(resolve => { finish = resolve }).then(() => { images.set(1, image) }))
  let uploads = 0
  const request = prepareSuggestion(async signal => {
    await suggestionImages('[Image #1]', images, pending, signal)
    signal.throwIfAborted()
    uploads++
    return { result: async () => 'late', abort: () => {} }
  })
  const outcome = readSuggestion(request, () => {})
  request.abort()
  expect((await outcome).candidates).toEqual([])
  finish()
  await tick()
  expect(images.get(1)).toEqual(image)
  expect(uploads).toBe(0)
})
