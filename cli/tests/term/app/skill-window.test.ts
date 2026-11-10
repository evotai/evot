import { SELECTOR_OWNER } from '../../../src/ui/selector-identity.js'
import { describe, expect, test } from 'bun:test'
import { handleSelectorControl } from '../../../src/term/app/selector/selector-control.js'
import {
  createSkillSelectorState,
  SKILL_SELECTOR_TITLE,
} from '../../../src/term/app/selector/skill-window.js'

describe('skill command window', () => {
  test('builds a searchable read-only inventory from installed skills', () => {
    const state = createSkillSelectorState([
      { name: 'review', dir: '/skills/review' },
      { name: 'deploy', dir: '/skills/cloud/deploy', group: 'cloud' },
    ])

    expect(state.title).toBe(SKILL_SELECTOR_TITLE)
    expect(state.subtitle).toBeUndefined()
    expect(state.presentation).toBe('skill')
    expect(state.items.map(item => item.label)).toEqual(['review', 'cloud/'])
    expect(state.allItems[2]?.searchText).toContain('cloud')
    expect(state.allItems[2]?.searchText).not.toContain('/skills/cloud/deploy')
    expect(state.hints).toEqual([
      { keys: ['up', 'down'], action: 'select' },
      { keys: 'type', action: 'search' },
      { keys: 'escape', action: 'close' },
    ])
  })

  test('supports filtering after focus transfer', () => {
    const state = createSkillSelectorState([
      { name: 'review', dir: '/skills/review' },
      { name: 'deploy', dir: '/skills/cloud/deploy', group: 'cloud' },
    ])
    const action = handleSelectorControl(state, { type: 'char', char: 'cloud' })

    expect(action.kind).toBe('update')
    if (action.kind === 'update') {
      expect(action.state.items.map(item => item.label)).toEqual(['cloud/', 'deploy'])
    }
  })

  test('shows an explicit empty state', () => {
    const state = createSkillSelectorState([])
    expect(state.emptyMessage).toBe('No skills installed')
    expect(state.items).toEqual([])
  })

  test('assigns skill ownership independently of the display title', () => {
    const state = { ...createSkillSelectorState([{ name: 'review', dir: '/skills/review' }]), title: 'Models' }
    expect(state.owner).toBe(SELECTOR_OWNER.skill)
    expect(handleSelectorControl(state, { type: 'enter' })).toEqual({ kind: 'none' })
  })
})
