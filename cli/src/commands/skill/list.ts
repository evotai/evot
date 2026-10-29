import { dirname } from 'path'

import { readSourceRecord } from './install.js'
import { readSkillDisplay } from './display.js'
import { builtinSkillsRoot, resolveSkillsDirs } from './paths.js'
import { renderSkillList, tildify, type SkillListView, type SkillUnitView } from './render.js'
import { getSkillEntries, type SkillEntry } from './scan.js'
import { isOfficialRepo, type SourceRecord } from './source.js'

function unitDirOf(entry: SkillEntry): string {
  return entry.group ? dirname(entry.dir) : entry.dir
}

/**
 * The shortest label that still identifies where a unit came from.
 *
 * Official installs drop the repo — every row would otherwise repeat
 * `evotai/evot-skills@` and push the useful part off screen. Directories are
 * tildified for the same reason.
 */
function originLabel(record: SourceRecord | null, unitDir: string, env: NodeJS.ProcessEnv): string {
  if (unitDir.startsWith(builtinSkillsRoot())) return 'builtin'
  if (record) {
    return isOfficialRepo(record.repo, env)
      ? `@${record.commit}`
      : `${record.repo}@${record.commit}`
  }
  return tildify(dirname(unitDir))
}

/**
 * Group entries into units, preserving the group directory as the unit.
 *
 * `dirs` is optional for the same reason `getSkillEntries` makes it optional:
 * callers without a live agent fall back to the resolved default set.
 */
export function skillListView(
  dirs?: string[],
  env: NodeJS.ProcessEnv = process.env,
): SkillListView {
  const byKey = new Map<string, SkillUnitView>()
  let total = 0

  for (const entry of getSkillEntries(dirs)) {
    const unitDir = unitDirOf(entry)
    // Builtins are internal commands, not catalog units users can manage.
    if (unitDir.startsWith(builtinSkillsRoot())) continue

    total += 1
    const record = readSourceRecord(unitDir)
    const official = record ? isOfficialRepo(record.repo, env) : false
    const origin = originLabel(record, unitDir, env)
    const name = entry.group ?? entry.name
    const key = `${unitDir}\u0000${origin}`
    const label = entry.group ? `${entry.group}/` : entry.name
    const unit = byKey.get(key) ?? {
      name, label, origin, official, members: [],
      ...(official ? readSkillDisplay(unitDir, name) : {}),
    }
    if (entry.group) unit.members.push(entry.name)
    byKey.set(key, unit)
  }

  const units = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { units, total }
}

export interface SkillListOptions {
  columns?: number
  env?: NodeJS.ProcessEnv
}

export function skillListFromDirs(dirs: string[], options: SkillListOptions = {}): string {
  const view = skillListView(dirs, options.env ?? process.env)
  return renderSkillList(view, options.columns ?? process.stdout.columns ?? 80)
}

export function skillList(dirs?: string[], options: SkillListOptions = {}): string {
  return skillListFromDirs(dirs ?? resolveSkillsDirs(), options)
}
