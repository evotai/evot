/**
 * Host-expanded slash commands (`/loop`, `/task`, installed skills, …) reach the
 * model as one user message: the instructions the command adds, then the
 * user's own words. Stored verbatim, that message would show a wall of
 * runtime rules wherever the transcript is replayed (resume, the recognition
 * pane, a shared page). This envelope marks which part the host wrote, so
 * readers can show what the user typed and fold the rest — the same way a
 * `<skill>` block is folded. The model reads the whole thing unchanged.
 *
 * The Rust side (`evot::command::command_prompt`) writes the identical shape
 * for commands expanded in the app layer; keep the two in sync.
 */
export interface CommandPrompt {
  /** Lower-case command identity, e.g. `loop`, `loop-wakeup`, `task`. */
  name: string
  /** What the user typed (or the host's one-line stand-in for a wakeup). */
  input: string
  /** Instructions the host adds; never shown unless the reader expands them. */
  instructions: string
  /** The user's own words, kept outside the envelope. */
  text?: string
}

const NAME = /^[a-z][a-z0-9-]*$/
const ENVELOPE = /^<command name="([a-z][a-z0-9-]*)" input="([^"\n]*)">\n([\s\S]*?)\n<\/command>(?:\n\n([\s\S]*))?$/

/** Wakeups and other turns the host starts on its own: a replay shows them
 *  as a notice, not as something the user said. */
const HOST_INITIATED: ReadonlySet<string> = new Set(['loop-wakeup'])

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

export function buildCommandPrompt(prompt: CommandPrompt): string {
  const name = NAME.test(prompt.name) ? prompt.name : 'command'
  const head = `<command name="${name}" input="${escapeAttr(prompt.input.trim())}">`
  const body = prompt.instructions.trim()
  const text = prompt.text?.trim()
  return `${head}\n${body}\n</command>${text ? `\n\n${text}` : ''}`
}

export function parseCommandPrompt(text: string): CommandPrompt | null {
  const match = ENVELOPE.exec(text)
  if (!match) return null
  const [, name = '', input = '', instructions = '', tail] = match
  const userText = tail?.trim()
  return { name, input: unescapeAttr(input), instructions, ...(userText ? { text: userText } : {}) }
}

/** How a stored command turn reads back to a person. */
export function commandDisplay(prompt: CommandPrompt): { kind: 'user' | 'notice'; text: string } {
  const text = prompt.input || prompt.text || `/${prompt.name}`
  return HOST_INITIATED.has(prompt.name) ? { kind: 'notice', text: `◌ ${text.replace(/^\//, '')}` } : { kind: 'user', text }
}
