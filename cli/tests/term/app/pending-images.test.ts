import { describe, expect, test } from 'bun:test'
import { PendingImages, draftImageIds } from '../../../src/term/app/composer/pending-images.js'

/** A promise whose settling this test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(res => { resolve = () => res() })
  return { promise, resolve }
}

describe('draft image ids', () => {
  test('collects image refs and ignores pasted text refs', () => {
    expect(draftImageIds('a [Image #2] b [Pasted text #3 +9 lines] c [Image #7]'))
      .toEqual([2, 7])
    expect(draftImageIds('no refs here')).toEqual([])
  })
})

describe('pending images', () => {
  test('a load stops blocking once it settles', async () => {
    const pending = new PendingImages()
    const load = deferred()
    const tracked = pending.track(1, load.promise)

    expect(pending.has(1)).toBe(true)
    expect(pending.blocking('[Image #1]')).toHaveLength(1)

    load.resolve()
    await tracked

    expect(pending.has(1)).toBe(false)
    expect(pending.size).toBe(0)
    expect(pending.blocking('[Image #1]')).toHaveLength(0)
  })

  test('submitting waits for the draft image, then sends it with its bytes', async () => {
    const pending = new PendingImages()
    const load = deferred()
    const bytes = new Map<number, string>()
    const tracked = pending.track(1, load.promise.then(() => { bytes.set(1, 'png') }))

    const sent: string[] = []
    const outcome = pending.gate('look [Image #1]', () => {
      // The whole point: bytes are present by the time the submit runs.
      sent.push(bytes.get(1) ?? 'MISSING')
    })

    expect(outcome).toBe('parked')
    expect(pending.awaiting).toBe(true)
    expect(sent).toEqual([])

    load.resolve()
    await tracked
    await Promise.resolve()

    expect(sent).toEqual(['png'])
    expect(pending.awaiting).toBe(false)
  })

  test('a draft with no pending image submits synchronously', () => {
    const pending = new PendingImages()
    let ran = 0
    expect(pending.gate('plain text', () => { ran++ })).toBe('ran')
    expect(ran).toBe(1)
    expect(pending.awaiting).toBe(false)
  })

  test('a load the draft no longer references does not park the submit', () => {
    const pending = new PendingImages()
    const load = deferred()
    pending.track(1, load.promise)

    // The user deleted [Image #1] while it was still loading.
    let ran = 0
    expect(pending.gate('text only', () => { ran++ })).toBe('ran')
    expect(ran).toBe(1)
    load.resolve()
  })

  test('a repeat Enter while parked does not queue a duplicate submit', async () => {
    const pending = new PendingImages()
    const load = deferred()
    const tracked = pending.track(1, load.promise)

    let ran = 0
    const submit = () => { ran++ }
    expect(pending.gate('[Image #1]', submit)).toBe('parked')
    expect(pending.gate('[Image #1]', submit)).toBe('ignored')
    expect(pending.gate('[Image #1]', submit)).toBe('ignored')

    load.resolve()
    await tracked
    await Promise.resolve()

    expect(ran).toBe(1)
  })

  test('a failed load still releases a parked submit', async () => {
    const pending = new PendingImages()
    const load = deferred()
    // Extraction failures are handled by the caller, which removes the ref; the
    // tracked promise resolves either way so a submit can never hang.
    const tracked = pending.track(1, load.promise)

    let ran = 0
    expect(pending.gate('[Image #1]', () => { ran++ })).toBe('parked')
    load.resolve()
    await tracked
    await Promise.resolve()

    expect(ran).toBe(1)
    expect(pending.size).toBe(0)
  })

  test('waits for every image in a multi-image draft', async () => {
    const pending = new PendingImages()
    const first = deferred()
    const second = deferred()
    const a = pending.track(1, first.promise)
    const b = pending.track(2, second.promise)

    let ran = 0
    expect(pending.gate('[Image #1] and [Image #2]', () => { ran++ })).toBe('parked')

    first.resolve()
    await a
    await Promise.resolve()
    expect(ran).toBe(0)

    second.resolve()
    await b
    await Promise.resolve()
    expect(ran).toBe(1)
  })

  test('parking notifies once so the caller can repaint', () => {
    const pending = new PendingImages()
    const load = deferred()
    pending.track(1, load.promise)

    let parks = 0
    pending.gate('[Image #1]', () => {}, () => { parks++ })
    expect(parks).toBe(1)
    load.resolve()
  })
})
