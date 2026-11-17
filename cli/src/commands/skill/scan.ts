import { join } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'

import { parseSkillCommand, type SkillCommandMetadata } from './frontmatter.js'
import { resolveSkillsDirs } from './paths.js'

export interface SkillEntry {
  name: string
  dir: string
  group?: string
  command?: SkillCommandMetadata
  commandError?: string
}

export function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(name) && name.length <= 64
}

export function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => {
        if (name.startsWith('.')) return false
        try {
          return statSync(join(dir, name)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

function skillEntry(name: string, dir: string, group?: string): SkillEntry {
  const entry: SkillEntry = { name, dir, ...(group ? { group } : {}) }
  try {
    const command = parseSkillCommand(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
    if (command?.usage && command.usage.split(/\s/u)[0]?.toLowerCase() !== `/${name.toLowerCase()}`) {
      throw new Error(`metadata.evot.command.usage must start with /${name}`)
    }
    if (command) entry.command = command
  } catch (error) {
    entry.commandError = (error instanceof Error ? error.message : String(error)).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 512)
  }
  return entry
}

export function scanSkillDir(root: string): SkillEntry[] {
  const found: SkillEntry[] = []
  for (const name of subdirs(root)) {
    const dir = join(root, name)
    if (existsSync(join(dir, 'SKILL.md'))) {
      found.push(skillEntry(name, dir))
      continue
    }
    for (const child of subdirs(dir)) {
      const childDir = join(dir, child)
      if (existsSync(join(childDir, 'SKILL.md'))) {
        found.push(skillEntry(child, childDir, name))
      }
    }
  }
  return found
}

export function getSkillEntries(dirs: string[] = resolveSkillsDirs()): SkillEntry[] {
  const byName = new Map<string, SkillEntry>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of scanSkillDir(dir)) byName.set(entry.name, entry)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
