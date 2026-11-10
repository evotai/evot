import { previewRows } from '../../ui/preview-scroll.js'
import { line, plain, dim, bold, colored, type StyledLine } from './types.js'

/** Fixed-height viewport. Scrolling clamps at both ends and never wraps. */
export function scrollPreview(preview: string[], width: number, height: number, requestedOffset: number): StyledLine[] {
  const rows = previewRows(preview, width)
  const budget = Math.max(1, height - 1)
  const offset = Math.min(Math.max(0, requestedOffset), Math.max(0, rows.length - budget))
  const visible = rows.slice(offset, offset + budget).map(row => line(
    row.heading ? bold(row.text) : row.alert ? colored(row.text, 'red') : plain(row.text),
  ))
  while (visible.length < budget) visible.push(line(plain('')))
  visible.push(line(dim(`Details ${rows.length ? offset + 1 : 0}–${Math.min(offset + budget, rows.length)}/${rows.length}`)))
  return visible
}
