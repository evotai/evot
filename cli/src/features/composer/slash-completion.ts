/** Browser-safe grammar. Inventory comes from the followed window, not from
 * the gateway build; none of it is authority to execute a command. */
export interface SlashHint {
  name: string
  aliases?: readonly string[]
  description: string
  arguments?: readonly string[]
  handler: 'builtin' | 'skill'
  /** Includes the leading slash. */
  minPrefixLength?: number
  hidden?: boolean
  /** Advertise on bare `/` only when the session has a parent. */
  hintWhenForked?: boolean
}

export interface CommandSpelling<C extends SlashHint = SlashHint> { label: string; command: C }
export function commandSpellings<C extends SlashHint>(commands: readonly C[]): CommandSpelling<C>[] {
  return commands.flatMap(command => [command.name, ...command.aliases ?? []].map(label => ({ label, command })))
}

export function matchCatalogPrefix<C extends SlashHint>(catalog: readonly C[], prefix: string): CommandSpelling<C>[] {
  const matches = commandSpellings(catalog).filter(({ label, command }) =>
    prefix.length >= (command.minPrefixLength ?? 1) && label.toLowerCase().startsWith(prefix))
  const builtins = matches.filter(({ command }) => command.handler === 'builtin')
  return builtins.length ? builtins : matches
}

/** Exact spellings win; aliases of the same command are not ambiguous. */
export function resolveSpelling<C extends SlashHint>(matches: readonly CommandSpelling<C>[], token: string): C[] {
  const exact = matches.find(match => match.label.toLowerCase() === token)
  return exact ? [exact.command] : [...new Set(matches.map(match => match.command))]
}

export interface CompletionChoice { label: string; detail?: string; value: string }
interface SlashCompletion {
  hint: string
  choices: CompletionChoice[]
  wordStart: number
  replacement: string | null
  tabCandidates: string[]
}

function commonPrefix(labels: readonly string[]): string {
  let prefix = labels[0] ?? ''
  for (const label of labels.slice(1)) {
    while (prefix && !label.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix
}

function candidateHint(labels: string[], partial: string): string {
  const suffix = commonPrefix(labels).slice(partial.length)
  return labels.length === 1 ? suffix : `${suffix}  [${labels.join('  ')}]`
}

function commandHint(command: SlashHint): string {
  const entries = command.arguments ?? []
  const args = entries.length ? `  [${entries.join('  ')}]` : ''
  return command.handler === 'skill' || !args ? `${args}  ${command.description}` : args
}

/** A line up to the caret. The TUI uses `hint`/`replacement`; a touchscreen
 * can also pick any literal choice, even where Tab cannot extend the prefix. */
export function slashCompletion(input: string, catalog: readonly SlashHint[], forked = false): SlashCompletion | null {
  if (!input.startsWith('/')) return null
  const parts = input.split(/\s+/), token = parts[0]!.toLowerCase()
  const matches = matchCatalogPrefix(catalog, token)
  const [command, another] = resolveSpelling(matches, token)
  if (parts.length === 1) {
    const visible = token === '/' ? catalog.filter(c => !c.hidden && (forked || !c.hintWhenForked)) : null
    if (visible ? visible.length === 0 : matches.length === 0) return null
    const rows = visible ? visible.map(command => ({ label: command.name, command })) : matches
    const choices = rows.map(({label, command}) => ({label, detail:command.description, value:label + ' '}))
    const labels = matches.map(row => row.label)
    const hint = visible ? `  [${visible.map(c => c.name.slice(1)).join('  ')}]`
      : matches.length === 1 ? candidateHint(labels, token) + commandHint(matches[0]!.command)
      : candidateHint(labels, token)
    return { choices, hint, wordStart: 0, tabCandidates: labels,
      replacement: labels.length === 1 ? labels[0]! + ' ' : labels.length ? commonPrefix(labels) : null }
  }
  if (!command || another) return null
  const partial = parts.slice(1).join(' ').toLowerCase()
  const entries = (command.arguments ?? []).filter(arg => arg.toLowerCase().startsWith(partial))
  const hint = !partial && command.handler === 'skill' ? commandHint(command)
    : entries.length === 0 ? '' : !partial ? `  [${entries.join('  ')}]` : candidateHint(entries, partial)
  const literals = parts.length === 2 ? entries.filter(arg => !arg.startsWith('<')) : []
  const choices = literals.map(label => ({ label, value:label + ' ' }))
  const common = commonPrefix(literals)
  return { choices, hint, tabCandidates: literals, wordStart: input.length - parts.at(-1)!.length,
    replacement: literals.length === 1 ? literals[0]! + ' ' : common.length > partial.length ? common : null }
}
