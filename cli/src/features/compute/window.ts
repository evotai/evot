import { createAppSelectorState } from '../../ui/selector-identity.js'
import { browseWindow } from '../../ui/browse-window.js'
import { PREVIEW_ALERT_PREFIX, PREVIEW_SECTION_PREFIX, type SelectorItem, type SelectorState } from '../../ui/selector.js'
import { relativeTime } from '../../ui/format.js'
import { checkStatusLabel, hardwareLabel, machineLabel, needsAttention, toolsLabel } from './format.js'
import type { ComputeMachine } from './types.js'

const hints = [
  { keys: ['up', 'down'], action: 'select' },
  { keys: 'tab', action: 'details' },
  { keys: '/', action: 'search' },
  { keys: 'n', action: 'new' },
  { keys: 'e', action: 'edit' },
  { keys: 'r', action: 'check now' },
  { keys: 'space', action: 'pause/resume' },
  { keys: 'd', action: 'delete' },
  { keys: 'escape', action: 'close' },
]

function dateTime(iso: string): string {
  const value = Date.parse(iso)
  if (!iso || Number.isNaN(value)) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function machineState(machine: ComputeMachine): string {
  if (!machine.enabled) return 'Paused'
  if (needsAttention(machine)) return 'Attention'
  return 'On'
}

function lastCheck(machine: ComputeMachine): string {
  const check = machine.last_check
  if (!check) return 'Never'
  return `${checkStatusLabel(check.status)} · ${relativeTime(check.checked_at)}`
}

function preview(machine: ComputeMachine): string[] {
  const check = machine.last_check
  const issue = check && check.status !== 'ok' ? [
    `${PREVIEW_SECTION_PREFIX}Latest issue`,
    `Checked  ${dateTime(check.checked_at)}`,
    check.message || checkStatusLabel(check.status),
    '',
  ] : []
  // A compact overview first; the description is the long body, like a
  // Task's instructions.
  return [
    machine.name,
    `SSH  ${machine.ssh_target}`,
    `Machine  ${machineLabel(machine.profile) || 'Not checked yet'}`,
    '',
    ...issue,
    `${PREVIEW_SECTION_PREFIX}Configuration`,
    `Last check  ${lastCheck(machine)}`,
    `Tools  ${machine.profile ? toolsLabel(machine.profile) : '—'}`,
    '',
    `${PREVIEW_SECTION_PREFIX}Use for`,
    ...machine.description.split('\n'),
  ]
}

function item(machine: ComputeMachine): SelectorItem {
  const state = machineState(machine)
  return {
    id: machine.id,
    label: machine.name,
    status: { text: state, tone: state === 'Attention' ? 'attention' : 'muted' },
    detail: [machine.ssh_target, hardwareLabel(machine.profile)].filter(Boolean).join(' · '),
    searchText: [
      machine.name, machine.description, machine.ssh_target,
      machine.profile?.os ?? '', ...(machine.profile?.tools ?? []),
    ].join(' '),
    preview: preview(machine),
    hints,
  }
}

export function createComputeWindow(machines: ComputeMachine[], focusId?: string): SelectorState {
  const items = machines.map(item)
  const index = focusId ? items.findIndex(row => row.id === focusId) : 0
  return {
    ...browseWindow(createAppSelectorState('compute', 'Compute', items), true),
    focusIndex: index >= 0 ? index : 0,
    searchHint: 'names and descriptions',
    hints: items.length ? hints : [{ keys: 'n', action: 'new' }, { keys: 'escape', action: 'close' }],
    subtitle: '',
    emptyMessage: 'No compute machines · n to create',
  }
}
