export function suggestionMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(block => typeof block.text === 'string' ? block.text : '').join('') : ''
}

/** The model input ends with the prediction instruction and composer hints;
 * history before it retains native user/assistant roles. */
export function suggestionInstructions(request: Record<string, unknown>): string {
  const messages = request.messages as { role: string; content: unknown }[]
  const last = messages.at(-1)
  // Anthropic merges adjacent user messages (e.g. an interrupted request
  // followed by the prediction instruction) into one content array.
  const content = suggestionMessageText(last?.content)
  const start = content.lastIndexOf('<next_prompt_suggestion>\n')
  const end = content.indexOf('\n</next_prompt_suggestion>', start)
  const text = start < 0 || end < 0 ? '' : content.slice(start, end + '\n</next_prompt_suggestion>'.length)
  if (last?.role !== 'user' || !text.startsWith('<next_prompt_suggestion>\n') || !text.endsWith('\n</next_prompt_suggestion>')) {
    throw new Error('Missing final suggestion instruction')
  }
  if (['suggestion_context', 'language_reference', 'original_task', 'product_context'].some(field => text.includes(field))) {
    throw new Error('Unexpected extra prompt metadata')
  }
  return text
}
