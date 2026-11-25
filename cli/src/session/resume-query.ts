export function normalizeResumeQuery(value: string): string {
  const query = value.trim()
  const quotePairs = [["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”']] as const
  for (const [open, close] of quotePairs) {
    if (query.startsWith(open) && query.endsWith(close)) {
      return query.slice(open.length, -close.length).trim()
    }
  }
  return query
}

export function isSessionIdPrefix(value: string): boolean {
  return /^[0-9a-f]{1,36}$/i.test(value)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
