import type { SuggestionMessage } from './types.js'

const TOKENS = 4096
const cost = (message: SuggestionMessage) => Math.ceil(JSON.stringify(message).length / 4)

function fit(message: SuggestionMessage, budget: number): SuggestionMessage {
  const chars = Array.from(message.text)
  let low = 0
  let high = Math.min(chars.length, budget * 4)
  let text = ''
  while (low <= high) {
    const keep = Math.floor((low + high) / 2)
    const head = Math.floor(keep / 5)
    const candidate = `${chars.slice(0, head).join('')}\n[... middle omitted ...]\n${chars.slice(chars.length - (keep - head)).join('')}`
    if (cost({ ...message, text: candidate }) <= budget) { text = candidate; low = keep + 1 }
    else high = keep - 1
  }
  return { ...message, text }
}

/** A contiguous authored suffix, reserving space for the latest user and
 * preserving both ends of a long final answer. No UI messages or tool rows. */
export function recentHistory(messages: readonly SuggestionMessage[]): SuggestionMessage[] {
  const latestUser = messages.findLastIndex(message => message.role === 'user')
  const recent: SuggestionMessage[] = []
  let remaining = TOKENS
  for (let i = messages.length - 1; i >= 0; i--) {
    let message = messages[i]!
    const reserve = i === messages.length - 1 && message.role === 'assistant' && latestUser >= 0
      ? Math.min(1024, cost(messages[latestUser]!)) : 0
    const budget = remaining - reserve
    if (cost(message) > budget) {
      if (i !== messages.length - 1 && i !== latestUser) break
      message = fit(message, budget)
    }
    if (!message.text) break
    remaining -= cost(message)
    recent.push({ ...message })
  }
  return recent.reverse()
}
