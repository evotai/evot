/** Split explicit newlines into physical rows with hanging indentation. */
export function prefixedAskLines(text: string, firstPrefix: string): string[] {
  const rows = text.split('\n')
  const continuationPrefix = ' '.repeat([...firstPrefix].length)
  return rows.map((row, index) => `${index === 0 ? firstPrefix : continuationPrefix}${row}`)
}
