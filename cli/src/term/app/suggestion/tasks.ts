import type { SuggestionTasks } from '../../../native/contracts/suggestion.js'

/** Explicit task-list syntax only. Numbered prose, quoted examples and code
 * fences are not declarations of unfinished work. No task-completion NLP. */
export function checklistTasks(text: string): SuggestionTasks | undefined {
  const tasks: SuggestionTasks = { source: 'checklist', pending: 0, in_progress: 0, completed: 0, next: [] }
  let fence: { marker: string; length: number } | undefined
  for (const line of text.slice(0, 65_536).split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = { marker: marker[0]!, length: marker.length }
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence) continue
    const match = /^\s{0,3}(?:[-*+]|\d+[.)])\s+\[([ xX-])\]\s+(.+)$/.exec(line)
    if (!match) continue
    if (match[1]?.toLowerCase() === 'x') tasks.completed++
    else {
      if (match[1] === '-') tasks.in_progress++
      else tasks.pending++
      if (tasks.next.length < 6) tasks.next.push({ text: taskLabel(match[2]!), status: match[1] === '-' ? 'in_progress' : 'pending' })
    }
  }
  return tasks.pending + tasks.in_progress + tasks.completed ? tasks : undefined
}

export function taskLabel(text: string): string {
  return Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()).slice(0, 120).join('')
}
