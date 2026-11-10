import { readFileSync } from 'fs'
import { dirname, isAbsolute, join, relative } from 'path'
import stripAnsi from 'strip-ansi'
import type { SkillEntry } from '../../../commands/skill/index.js'
import { readSkillDisplay } from '../../../commands/skill/display.js'
import { parseSkillDescription } from '../../../commands/skill/frontmatter.js'
import { readSourceRecord } from '../../../commands/skill/install.js'
import { builtinSkillsRoot } from '../../../commands/skill/paths.js'
import { isOfficialRepo } from '../../../commands/skill/source.js'
import { selectorExpandItems, selectorFocusOn, type SelectorItem, type SelectorState } from '../../../ui/selector.js'
import { createAppSelectorState } from '../../../ui/selector-identity.js'

export const SKILL_SELECTOR_TITLE = 'Skills'

/** Toggle a package in place without executing a skill or changing the query. */
export function toggleSkillGroup(state: SelectorState): SelectorState | undefined {
  if (state.query.trim()) return undefined
  const item = state.items[state.focusIndex]
  if (item?.expanded === undefined) return undefined
  const expanded = !item.expanded
  const allItems = state.allItems.map(candidate => {
    if (candidate.id === item.id) return { ...candidate, expanded }
    if (candidate.group === item.group) return { ...candidate, searchOnly: !expanded }
    return candidate
  })
  return selectorFocusOn(selectorExpandItems(state, allItems), candidate => candidate.id === item.id)
}

function description(entry: SkillEntry): string {
  try {
    const text = parseSkillDescription(readFileSync(join(entry.dir, 'SKILL.md'), 'utf8')) ?? ''
    return stripAnsi(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/** Snapshot metadata when opening the window, never during frame rendering. */
export function createSkillSelectorState(entries: SkillEntry[]): SelectorState {
  const sorted = entries.filter(entry => {
    const path = relative(builtinSkillsRoot(), entry.dir)
    return path === '..' || path.startsWith('../') || isAbsolute(path)
  }).sort((a, b) => Number(Boolean(a.group)) - Number(Boolean(b.group)) || a.name.localeCompare(b.name))
  const items: SelectorItem[] = []
  const add = (entry: SkillEntry): void => {
    const source = readSourceRecord(entry.group ? dirname(entry.dir) : entry.dir)
    const official = Boolean(source && isOfficialRepo(source.repo))
    // A package example describes the package, not each of its members.
    const display = !entry.group && official
      ? readSkillDisplay(entry.dir, entry.name).display : undefined
    const summary = display?.summary ?? description(entry)
    items.push({
      id: entry.name,
      label: entry.group && entry.name.startsWith(`${entry.group}-`) ? entry.name.slice(entry.group.length + 1) : entry.name,
      ...(entry.group ? { group: entry.group, searchOnly: true } : {}),
      ...(official ? { badge: 'official' } : {}),
      searchText: `${entry.name} ${entry.group ?? ''} ${summary} ${display?.example ?? ''}`,
      preview: [entry.name, '', summary || 'No description available.',
        ...(display ? ['', 'Example', display.example] : [])],
    })
  }
  for (const entry of sorted.filter(entry => !entry.group)) add(entry)
  const groups = [...new Set(sorted.flatMap(entry => entry.group ? [entry.group] : []))].sort()
  for (const group of groups) {
    const members = sorted.filter(entry => entry.group === group)
    const first = members[0]
    if (!first) continue
    const dir = dirname(first.dir)
    const source = readSourceRecord(dir)
    const official = Boolean(source && isOfficialRepo(source.repo))
    const display = official ? readSkillDisplay(dir, group).display : undefined
    items.push({
      id: `group:${group}`, label: `${group}/`, group, expanded: false,
      ...(official ? { badge: 'official' } : {}),
      searchText: `${group} ${display?.summary ?? ''} ${display?.example ?? ''}`,
      preview: [group, '', display?.summary ?? 'Expand to browse skills in this group.',
        ...(display ? ['', 'Example', display.example] : [])],
    })
    for (const member of members) add(member)
  }
  // Stable partition keeps each package beside its members within its source.
  const categorized = [...items.filter(item => item.badge === 'official'), ...items.filter(item => item.badge !== 'official')]
  return {
    ...createAppSelectorState('skill', SKILL_SELECTOR_TITLE, categorized, categorized),
    presentation: 'skill',
    ...(items.length === 0 ? { emptyMessage: 'No skills installed' } : {}),
    hints: [
      { keys: ['up', 'down'], action: 'select' },
      { keys: 'type', action: 'search' },
      { keys: 'escape', action: 'close' },
    ],
  }
}
