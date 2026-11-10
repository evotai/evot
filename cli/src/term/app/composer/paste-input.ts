import {
  cleanPastedText,
  formatImageRef,
  formatPastedTextRef,
  parsePasteRefs,
  shouldCollapse,
} from '../../input/paste_refs.js'
import {
  MAX_IMAGE_SIZE_BYTES,
  probeClipboardImage,
  readClipboardImage,
} from '../../input/clipboard_image.js'
import { getTextFromClipboard } from '../../input/clipboard_text.js'
import { formatImageSourceText, storeImage } from '../../input/image_store.js'
import { getEditorText, insertText, type EditorState } from '../../input/editor.js'
import type { ContentBlock } from '../../../native/index.js'
import type { PendingImages } from './pending-images.js'

export interface PastedImage {
  id: number
  base64: string
  mediaType: string
  filePath?: string
}

export interface PasteStore {
  chunks: Map<number, string>
  images: Map<number, PastedImage>
  allocId(): number
}

export function createPasteStore(): PasteStore {
  let nextId = 1
  return {
    chunks: new Map<number, string>(),
    images: new Map<number, PastedImage>(),
    allocId: () => nextId++,
  }
}

export interface PasteInputDeps {
  store: PasteStore
  pendingImages: PendingImages
  getEditor: () => EditorState
  mutateEditor: (mutator: (state: EditorState) => EditorState) => void
  isDestroyed: () => boolean
  requestRender: () => void
  getDisplayText: () => string
  getExpandedText: (resolvedImageIds?: Set<number>) => string
}

export function createPasteHandlers(deps: PasteInputDeps) {
  function insertPaste(raw: string) {
    const cleaned = cleanPastedText(raw)
    if (shouldCollapse(cleaned)) {
      const id = deps.store.allocId()
      const numLines = (cleaned.match(/\n/g) || []).length
      deps.store.chunks.set(id, cleaned)
      const ref = formatPastedTextRef(id, numLines)
      deps.mutateEditor(state => insertText(state, ref))
    } else {
      deps.mutateEditor(state => insertText(state, cleaned))
    }
  }

  function beginImagePaste(): void {
    const id = deps.store.allocId()
    const ref = formatImageRef(id)
    deps.mutateEditor(state => insertText(state, ref))
    deps.requestRender()

    const load = (async () => {
      const img = await readClipboardImage()
      if (!getEditorText(deps.getEditor()).includes(ref)) return
      if (!img) {
        removeImageRef(id, ref)
        return
      }
      const filePath = await storeImage(img.base64, img.mediaType)
      if (!getEditorText(deps.getEditor()).includes(ref)) return
      deps.store.images.set(id, {
        id,
        base64: img.base64,
        mediaType: img.mediaType,
        filePath: filePath ?? undefined,
      })
    })()

    deps.pendingImages.track(id, load)
  }

  function removeImageRef(id: number, ref: string): void {
    deps.store.images.delete(id)
    deps.mutateEditor(state => {
      const lineIndex = state.lines.findIndex(line => line.includes(ref))
      if (lineIndex === -1) return state
      const line = state.lines[lineIndex]!
      const start = line.indexOf(ref)
      const lines = [...state.lines]
      lines[lineIndex] = line.slice(0, start) + line.slice(start + ref.length)
      const cursorCol = state.cursorLine === lineIndex && state.cursorCol > start
        ? Math.max(start, state.cursorCol - ref.length)
        : state.cursorCol
      return { ...state, lines, cursorCol, preferredVisualCol: undefined }
    })
    deps.requestRender()
  }

  async function tryPasteImage() {
    const probe = await probeClipboardImage()
    if (!probe) return
    if (probe.byteLength !== null && probe.byteLength > MAX_IMAGE_SIZE_BYTES) return
    beginImagePaste()
  }

  async function tryPasteClipboard() {
    const probe = await probeClipboardImage()
    if (probe) {
      if (probe.byteLength !== null && probe.byteLength > MAX_IMAGE_SIZE_BYTES) return
      beginImagePaste()
      return
    }
    const text = await getTextFromClipboard()
    if (text) {
      insertPaste(text)
      deps.requestRender()
    }
  }

  function withDraftImages(submit: () => void): void {
    deps.pendingImages.gate(
      getEditorText(deps.getEditor()),
      () => {
        if (deps.isDestroyed()) return
        submit()
      },
      () => deps.requestRender(),
    )
  }

  function buildImageContentBlocks(): { blocks: ContentBlock[]; resolvedIds: Set<number> } | null {
    const displayText = deps.getDisplayText()
    const imageRefs = parsePasteRefs(displayText).filter(r => r.type === 'image')
    const resolved: PastedImage[] = []
    for (const ref of imageRefs) {
      const img = deps.store.images.get(ref.id)
      if (img) {
        resolved.push(img)
      }
    }
    if (resolved.length === 0) return null
    const blocks: ContentBlock[] = []
    const text = deps.getExpandedText(new Set(resolved.map(r => r.id)))
    const sourceAnnotations = resolved
      .filter(r => r.filePath)
      .map(r => formatImageSourceText(r.id, r.filePath!))
      .join('\n')
    const fullText = sourceAnnotations ? `${text}\n${sourceAnnotations}` : text
    if (fullText) blocks.push({ type: 'text', text: fullText })
    for (const img of resolved) {
      blocks.push({
        type: 'image',
        mimeType: img.mediaType,
        source: img.filePath
          ? { type: 'path', path: img.filePath }
          : { type: 'base64', data: img.base64 },
      })
    }
    return { blocks, resolvedIds: new Set(resolved.map(r => r.id)) }
  }

  return {
    insertPaste,
    beginImagePaste,
    removeImageRef,
    tryPasteImage,
    tryPasteClipboard,
    withDraftImages,
    buildImageContentBlocks,
  }
}
