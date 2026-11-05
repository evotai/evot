import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'

import { discardCheckout, fetchHeadCommit, fetchRepo, type Checkout, type FetchFn, type HeadFn, type ProgressFn } from './fetch.js'
import { installUnit, readSourceRecord, removeDirs } from './install.js'
import { skillsRoot } from './paths.js'
import { missingRequirements } from './requires.js'
import type { SkillOutcome, UnitNote, UnitResult } from './render.js'
import { isValidSkillName, scanSkillDir, subdirs } from './scan.js'
import { isOfficialRepo, OFFICIAL_PREFIX, resolveSource, type Source, type SourceRecord } from './source.js'
import { enumerateUnits, supersededDirs, type Unit } from './units.js'

export interface ManageOptions {
  root?: string
  fetch?: FetchFn
  /** Remote head lookup for the cheap "anything new?" check. */
  head?: HeadFn
  progress?: ProgressFn
  env?: NodeJS.ProcessEnv
  variablesFile?: string
  now?: () => number
}

export interface OfficialSyncResult {
  installed: string[]
  updated: string[]
  unchanged: string[]
  skipped: string[]
  removed: string[]
}

/** What one periodic maintenance pass did. */
export type OfficialMaintenance =
  /** Checked within the interval; nothing was asked of the network. */
  | { kind: 'fresh' }
  /** The catalog head is what we already have; only the stamp was touched. */
  | { kind: 'current'; commit: string }
  /** The head moved (or nothing was ever installed): a full reconcile ran. */
  | { kind: 'synced'; commit: string; result: OfficialSyncResult }

/** How often a long-running REPL asks whether the official catalog moved.
 *  Each ask is one small request; a download happens only when it did. */
export const OFFICIAL_SYNC_INTERVAL_MS = 30 * 60 * 1000

/** Persisted beside the managed skills: when the catalog was last checked and
 *  which commit it was at. A missing or unreadable stamp means "never". */
export const SYNC_STAMP_FILE = '.official-sync.json'

export interface SyncStamp {
  version: 1
  checked_at: number
  commit: string
  /** Official units the catalog held at `commit`, so a cheap check can tell
   *  a unit removed by hand from a catalog that has not moved. */
  units: string[]
}

interface Context {
  root: string
  fetch: FetchFn
  head: HeadFn
  progress?: ProgressFn
  env: NodeJS.ProcessEnv
  variablesFile?: string
  now: () => number
}

function context(options: ManageOptions): Context {
  return {
    root: options.root ?? skillsRoot(),
    fetch: options.fetch ?? fetchRepo,
    head: options.head ?? fetchHeadCommit,
    progress: options.progress,
    env: options.env ?? process.env,
    variablesFile: options.variablesFile,
    now: options.now ?? Date.now,
  }
}

export function readSyncStamp(root: string): SyncStamp | null {
  try {
    const stamp = JSON.parse(readFileSync(join(root, SYNC_STAMP_FILE), 'utf8')) as Partial<SyncStamp>
    if (stamp.version !== 1 || typeof stamp.checked_at !== 'number' || typeof stamp.commit !== 'string') return null
    const units = Array.isArray(stamp.units) ? stamp.units.filter((name): name is string => typeof name === 'string') : []
    return { version: 1, checked_at: stamp.checked_at, commit: stamp.commit, units }
  } catch {
    return null
  }
}

/** Same-directory temp file and rename: a crash mid-write leaves the old stamp. */
async function writeSyncStamp(root: string, stamp: SyncStamp): Promise<void> {
  await mkdir(root, { recursive: true })
  const target = join(root, SYNC_STAMP_FILE)
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(stamp, null, 2)}\n`, { flush: true })
  await rename(temp, target)
}

function record(source: Source, unit: Unit, commit: string): SourceRecord {
  return {
    version: 1,
    repo: source.repo,
    ref: source.ref,
    path: unit.path,
    commit,
    installedAt: new Date().toISOString(),
  }
}

/** Skills present in the managed root, for the closing count. */
function installedSkillCount(root: string): number {
  return scanSkillDir(root).length
}

async function applyUnit(
  ctx: Context,
  source: Source,
  unit: Unit,
  commit: string,
  replaceSuperseded = true,
): Promise<UnitNote[]> {
  const superseded = source.official && replaceSuperseded ? supersededDirs(ctx.root, unit) : []
  await installUnit(unit, record(source, unit, commit), ctx.root)

  const notes: UnitNote[] = []
  if (superseded.length) {
    removeDirs(superseded.map((entry) => entry.dir))
    notes.push({
      kind: 'info',
      text: `replaced standalone ${superseded.map((entry) => entry.name).join(', ')}`,
    })
  }

  const installed = unit.skills.map((skill) => ({
    ...skill,
    dir: skill.group ? join(ctx.root, unit.name, skill.name) : join(ctx.root, unit.name),
  }))
  for (const text of missingRequirements(installed, ctx.env, ctx.variablesFile)) {
    notes.push({ kind: 'warn', text })
  }
  return notes
}

export async function skillInstall(arg?: string, options: ManageOptions = {}): Promise<SkillOutcome> {
  const ctx = context(options)
  const source = resolveSource(arg, ctx.env)
  const checkout = await ctx.fetch(source, ctx.progress)

  try {
    const units = enumerateUnits(checkout.dir, source)
    ctx.progress?.('installing...', 'info')
    const results: UnitResult[] = []
    for (const unit of units) {
      const notes = await applyUnit(ctx, source, unit, checkout.commit)
      results.push({
        name: unit.name,
        skills: unit.skills.length,
        outcome: 'new',
        detail: '',
        notes,
      })
    }
    return {
      view: {
        title: 'Installed',
        source: `${source.repo}@${checkout.commit}`,
        units: results,
        total: installedSkillCount(ctx.root),
      },
    }
  } finally {
    await discardCheckout(checkout)
  }
}

function withdrawnUnits(ctx: Context, present: Set<string>): Installed[] {
  return installedUnits(ctx.root).filter((unit) => {
    const tracked = unit.record
    if (!tracked || !isOfficialRepo(tracked.repo, ctx.env)) return false
    if (!tracked.path.startsWith(`${OFFICIAL_PREFIX}/`)) return false
    return !present.has(unit.name)
  })
}

/**
 * Reconcile the managed root with the complete official catalog.
 *
 * New official units are installed and previously managed official units are
 * updated. A local or third-party unit with the same directory name is left
 * untouched, so background maintenance never replaces user-owned content.
 */
export async function syncOfficialSkills(
  options: ManageOptions = {},
): Promise<OfficialSyncResult> {
  const ctx = context(options)
  const source = resolveSource(undefined, ctx.env)
  const checkout = await ctx.fetch(source, ctx.progress)
  const result: OfficialSyncResult = {
    installed: [],
    updated: [],
    unchanged: [],
    skipped: [],
    removed: [],
  }

  try {
    const units = enumerateUnits(checkout.dir, source)
    for (const unit of units) {
      const destination = join(ctx.root, unit.name)
      const installed = existsSync(destination)
      const previous = installed ? readSourceRecord(destination) : null

      if (installed && (!previous || !isOfficialRepo(previous.repo, ctx.env))) {
        result.skipped.push(unit.name)
        continue
      }
      if (previous?.commit === checkout.commit) {
        result.unchanged.push(unit.name)
        continue
      }

      await applyUnit(ctx, source, unit, checkout.commit, false)
      if (previous) result.updated.push(unit.name)
      else result.installed.push(unit.name)
    }

    const withdrawn = withdrawnUnits(ctx, new Set(units.map((unit) => unit.name)))
    if (withdrawn.length) {
      removeDirs(withdrawn.map((unit) => unit.dir))
      result.removed.push(...withdrawn.map((unit) => unit.name))
    }
    return result
  } finally {
    await discardCheckout(checkout)
  }
}

/** Current means: every unit the catalog held at `commit` is either installed
 *  from that commit or is a user-owned directory the sync would skip anyway.
 *  A unit deleted by hand, or a stamp from before units were recorded, needs
 *  the full pass even when the remote head has not moved. */
function officialUnitsAt(ctx: Context, stamp: SyncStamp): boolean {
  if (stamp.units.length === 0) return false
  return stamp.units.every(name => {
    const record = existsSync(join(ctx.root, name)) ? readSourceRecord(join(ctx.root, name)) : null
    if (record === null) return existsSync(join(ctx.root, name))
    if (!isOfficialRepo(record.repo, ctx.env)) return true
    return stamp.commit.startsWith(record.commit)
  })
}

/**
 * Keep the official catalog current without being asked.
 *
 * Within `intervalMs` of the last check nothing happens. Past it, one small
 * request resolves the catalog head; if it is the commit already installed the
 * stamp is refreshed and that is all. Only a moved head downloads the tarball
 * and reconciles, so a REPL left open for a week costs a handful of requests.
 */
export async function maintainOfficialSkills(
  options: ManageOptions = {},
  intervalMs = OFFICIAL_SYNC_INTERVAL_MS,
): Promise<OfficialMaintenance> {
  const ctx = context(options)
  const now = ctx.now()
  const stamp = readSyncStamp(ctx.root)
  if (stamp && now - stamp.checked_at < intervalMs && now >= stamp.checked_at) return { kind: 'fresh' }
  const source = resolveSource(undefined, ctx.env)
  const head = await ctx.head(source)
  if (stamp && head === stamp.commit && officialUnitsAt(ctx, stamp)) {
    await writeSyncStamp(ctx.root, { ...stamp, checked_at: now })
    return { kind: 'current', commit: head }
  }
  const result = await syncOfficialSkills(options)
  const units = [...result.installed, ...result.updated, ...result.unchanged, ...result.skipped].sort()
  await writeSyncStamp(ctx.root, { version: 1, checked_at: ctx.now(), commit: head, units })
  return { kind: 'synced', commit: head, result }
}

let maintenanceInFlight: Promise<OfficialMaintenance> | null = null

/** Share one maintenance pass when callers overlap (startup and the REPL's
 *  periodic job, or two REPL ticks around a slow network). */
export function startOfficialSkillMaintenance(
  options: ManageOptions = {},
  intervalMs = OFFICIAL_SYNC_INTERVAL_MS,
): Promise<OfficialMaintenance> {
  if (!maintenanceInFlight) {
    maintenanceInFlight = maintainOfficialSkills(options, intervalMs).finally(() => {
      maintenanceInFlight = null
    })
  }
  return maintenanceInFlight
}

interface Installed {
  name: string
  dir: string
  record: SourceRecord | null
}

function installedUnits(root: string): Installed[] {
  if (!existsSync(root)) return []
  return subdirs(root).map((name) => {
    const dir = join(root, name)
    return { name, dir, record: readSourceRecord(dir) }
  })
}

/** Group tracked units by the repo@ref they came from, so each is fetched once. */
function groupBySource(
  units: Installed[],
  env: NodeJS.ProcessEnv,
): Array<{ source: Source; members: Installed[] }> {
  const groups = new Map<string, { source: Source; members: Installed[] }>()
  for (const unit of units) {
    const tracked = unit.record
    if (!tracked) continue
    const source: Source = {
      repo: tracked.repo,
      ref: tracked.ref,
      official: isOfficialRepo(tracked.repo, env),
    }
    const key = `${source.repo}@${source.ref}`
    const group = groups.get(key) ?? { source, members: [] }
    group.members.push(unit)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function catalogIsIntact(checkout: Checkout, source: Source): boolean {
  if (!source.official) return false
  try {
    return enumerateUnits(checkout.dir, { ...source, path: undefined }).length > 0
  } catch {
    return false
  }
}

async function updateOne(
  ctx: Context,
  source: Source,
  checkout: Checkout,
  installed: Installed,
): Promise<UnitResult> {
  const previous = installed.record!
  const unitSource: Source = { ...source, path: previous.path }
  let unit: Unit
  try {
    unit = enumerateUnits(checkout.dir, unitSource)[0]!
  } catch (error) {
    if (catalogIsIntact(checkout, source)) {
      removeDirs([installed.dir])
      return {
        name: installed.name,
        skills: 1,
        outcome: 'removed',
        detail: 'withdrawn from catalog',
        notes: [],
      }
    }
    return {
      name: installed.name,
      skills: 1,
      outcome: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      notes: [],
    }
  }
  const notes = await applyUnit(ctx, unitSource, unit, checkout.commit)
  const same = previous.commit === checkout.commit
  return {
    name: unit.name,
    skills: unit.skills.length,
    outcome: same ? 'unchanged' : 'updated',
    detail: same ? previous.commit : `${previous.commit} → ${checkout.commit}`,
    notes,
  }
}

function sameSource(a: Source, b: Source): boolean {
  return a.repo === b.repo && a.ref === b.ref
}

/** Official units the catalog gained since they were installed, as background
 *  sync would add them. An existing directory of the same name is never touched. */
async function installNewOfficial(ctx: Context, source: Source, checkout: Checkout): Promise<UnitResult[]> {
  let units: Unit[]
  try {
    units = enumerateUnits(checkout.dir, { ...source, path: undefined })
  } catch (error) {
    return [{
      name: `${source.repo}@${source.ref}`, skills: 0, outcome: 'failed',
      detail: error instanceof Error ? error.message : String(error), notes: [],
    }]
  }
  const results: UnitResult[] = []
  for (const unit of units) {
    if (existsSync(join(ctx.root, unit.name))) continue
    try {
      const notes = await applyUnit(ctx, source, unit, checkout.commit, false)
      results.push({ name: unit.name, skills: unit.skills.length, outcome: 'new', detail: checkout.commit, notes })
    } catch (error) {
      results.push({
        name: unit.name, skills: unit.skills.length, outcome: 'failed',
        detail: error instanceof Error ? error.message : String(error), notes: [],
      })
    }
  }
  return results
}

/** Update installed units. Without a name this also adds official units that
 *  are not installed yet, so it matches background sync. */
export async function skillUpdate(arg?: string, options: ManageOptions = {}): Promise<SkillOutcome> {
  const ctx = context(options)
  const name = arg?.trim()
  if (name && !isValidSkillName(name)) return { notice: `invalid skill name: ${name}` }

  let units = installedUnits(ctx.root)
  if (name) {
    units = units.filter((unit) => unit.name === name)
    if (!units.length) return { notice: `skill not installed: ${name}` }
    if (!units[0]!.record) {
      return { notice: `${name} has no install source (local); nothing to update` }
    }
  }

  const groups = groupBySource(units, ctx.env)
  const catalog = name ? null : resolveSource(undefined, ctx.env)
  if (catalog && !groups.some(({ source }) => sameSource(source, catalog))) {
    groups.push({ source: catalog, members: [] })
  }
  if (!groups.length) return { notice: 'no updatable skills installed' }

  const results: UnitResult[] = []
  for (const { source, members } of groups) {
    let checkout: Checkout
    try {
      checkout = await ctx.fetch(source, ctx.progress)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      for (const unit of members) {
        results.push({ name: unit.name, skills: 1, outcome: 'failed', detail, notes: [] })
      }
      if (!members.length) {
        results.push({ name: `${source.repo}@${source.ref}`, skills: 0, outcome: 'failed', detail, notes: [] })
      }
      continue
    }
    try {
      for (const unit of members) results.push(await updateOne(ctx, source, checkout, unit))
      if (catalog && sameSource(source, catalog)) {
        results.push(...await installNewOfficial(ctx, source, checkout))
      }
    } finally {
      await discardCheckout(checkout)
    }
  }

  for (const unit of units) {
    if (!unit.record) {
      results.push({ name: unit.name, skills: 1, outcome: 'skipped', detail: 'local', notes: [] })
    }
  }
  return { view: { title: 'Updated', units: results, total: installedSkillCount(ctx.root) } }
}

export function skillRemove(name: string, root = skillsRoot()): { notice: string; removed: boolean } {
  const trimmed = name.trim()
  if (!isValidSkillName(trimmed)) return { notice: `invalid skill name: ${trimmed}`, removed: false }

  const unitDir = join(root, trimmed)
  if (existsSync(unitDir)) {
    const skills = scanSkillDir(root).filter((entry) => entry.dir.startsWith(`${unitDir}/`))
    removeDirs([unitDir])
    return {
      notice: skills.length
        ? `removed skill group: ${trimmed} (${skills.length} skills)`
        : `removed skill: ${trimmed}`,
      removed: true,
    }
  }

  const nested = scanSkillDir(root).find((entry) => entry.name === trimmed && entry.group)
  if (nested) {
    removeDirs([nested.dir])
    return { notice: `removed skill: ${trimmed} (from group ${nested.group})`, removed: true }
  }
  return { notice: `skill not found: ${trimmed}`, removed: false }
}
