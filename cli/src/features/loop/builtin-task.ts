import type { LoopTask } from './parser.js'

export const BUILTIN_LOOP_PROMPT = [
  'Read the current conversation, especially actions already taken and their results. Which of those steps would be useful to repeat, and under what condition?',
  'Continue that workflow from its latest result, within the scope the user authorized. A completed one-off action is not a recurring task.',
  'If there is no useful next pass, say so and stop rather than inventing work.',
].join(' ')

export const BUILTIN_LOOP_TASK: LoopTask = { prompt: BUILTIN_LOOP_PROMPT, label: 'continue this work' }
