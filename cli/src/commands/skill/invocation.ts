import { join } from 'node:path'
import { buildCommandPrompt } from '../../session/command-envelope.js'
import { isSlashCommand, resolveCommand } from '../index.js'
import type { SkillEntry } from './scan.js'

/** Skills are model input, not local control commands. This same expansion is
 * used for immediate input, steering and deferred input; queueing never turns a
 * local command into prose for the model. No skill body is loaded speculatively. */
export function promptInput(text: string, skills: readonly SkillEntry[] = []): string | null {
  const resolved = resolveCommand(text, skills)
  if (resolved.kind === 'skill') {
    return buildCommandPrompt({
      name: 'skill', input: text,
      instructions: `Use the ${resolved.name.slice(1)} skill. Read ${JSON.stringify(join(resolved.dir, 'SKILL.md'))} and follow its instructions before proceeding.`,
      text: text.trim().replace(/^\S+\s*/, ''),
    })
  }
  return isSlashCommand(text) ? null : text
}
