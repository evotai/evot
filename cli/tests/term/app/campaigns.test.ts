import { describe, expect, test } from 'bun:test'
import { refreshCampaigns } from '../../../src/term/app/campaigns.js'
import { createAdSlotState, triggerAdSlot, campaignFingerprint, type AdContent } from '../../../src/term/viewmodel/ad-slot.js'

const notice: AdContent = { id: 'n', kind: 'notice', title: 'News', body: 'copy' }
const ad: AdContent = { id: 'a', kind: 'ad', title: 'Ad', body: '' }

describe('campaign catalog reconciliation', () => {
  test('unchanged catalog preserves all timing and seen state', () => {
    const state = createAdSlotState([notice, ad])
    triggerAdSlot(state, 1000)
    state.queuedId = ad.id
    const before = { ...state }
    refreshCampaigns(state, [notice, ad], false, 2000)
    expect(state).toEqual(before)
    expect(state.played).toBe(before.played)
  })

  test('edited visible copy retypes without resetting the rotation deadline', () => {
    const state = createAdSlotState([notice, ad])
    triggerAdSlot(state, 1000)
    state.queuedId = ad.id
    const deadline = state.rotationDueAt
    refreshCampaigns(state, [{ ...notice, body: 'changed' }, ad], false, 2000)
    expect(state.shownAt).toBe(2000)
    expect(state.queuedId).toBeNull()
    expect(state.rotationDueAt).toBe(deadline)
  })

  test('removed current content clears the stale transition', () => {
    const state = createAdSlotState([notice, ad])
    triggerAdSlot(state, 1000)
    state.queuedId = ad.id
    refreshCampaigns(state, [ad], false, 2000)
    expect(state.currentId).toBeNull()
    expect(state.queuedId).toBeNull()
  })

  test('premium upgrade removes ads and does not replay announced copy', () => {
    const state = createAdSlotState([notice, ad])
    state.played.add(campaignFingerprint(notice))
    refreshCampaigns(state, [notice, ad], true, 1000)
    expect(state.premium).toBe(true)
    expect(state.ads).toEqual([])
    // The notice stays listed (so a showing one survives refresh) but is played.
    expect(triggerAdSlot(state, 1000)).toBeNull()
  })

  test('first available content starts an untriggered slot', () => {
    const state = createAdSlotState([])
    refreshCampaigns(state, [notice], false, 1000)
    expect(state.triggered).toBe(true)
    expect(state.currentId).toBe(notice.id)
    expect(state.shownAt).toBe(1000)
  })
})
