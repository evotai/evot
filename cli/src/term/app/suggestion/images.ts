import { readFile, stat } from 'node:fs/promises'
import type { SuggestionImage } from '../../../native/contracts/suggestion.js'
import { MAX_IMAGE_SIZE_BYTES } from '../../input/clipboard_image.js'
import { parsePasteRefs } from '../../input/paste_refs.js'
import type { PastedImage } from '../paste-input.js'
import type { PendingImages } from '../pending-images.js'

/** Share the paste load rather than probing or uploading the clipboard twice.
 * Only referenced images enter the side request; the editor and store stay intact. */
export async function suggestionImages(text: string, images: ReadonlyMap<number, PastedImage>, pending: PendingImages, signal: AbortSignal): Promise<SuggestionImage[]> {
  await Promise.all(pending.blocking(text))
  signal.throwIfAborted()
  const result: SuggestionImage[] = []
  const seen = new Set<number>()
  for (const ref of parsePasteRefs(text)) {
    if (ref.type !== 'image' || seen.has(ref.id)) continue
    seen.add(ref.id)
    const image = images.get(ref.id)
    if (!image) throw new Error('Attached image is unavailable')
    let data = image.base64
    if (!data && image.filePath) {
      if ((await stat(image.filePath)).size > MAX_IMAGE_SIZE_BYTES) throw new Error('Image is too large')
      const bytes = await readFile(image.filePath, { signal })
      if (bytes.length > MAX_IMAGE_SIZE_BYTES) throw new Error('Image is too large')
      data = bytes.toString('base64')
    }
    signal.throwIfAborted()
    if (!data || data.length > Math.ceil(MAX_IMAGE_SIZE_BYTES / 3) * 4) throw new Error('Image data is unavailable')
    result.push({ id: ref.id, media_type: image.mediaType, data })
  }
  return result
}
