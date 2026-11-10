import chalk from 'chalk'
import type { OfficialSyncResult } from '../../commands/skill/index.js'
import { currentModelSpec, formatModelLabel, formatModelOptionLabel, hasPremiumModel, isCloudModel, selectModelOption } from '../../features/models/options.js'
import type { ModelOption } from '../../native/contracts/config-info.js'
import { type Agent, authNotices } from '../../native/index.js'
import type { CloudSessionSync } from '../../session/cloud-sessions.js'
import { modelShareEvents } from '../../session/share-events.js'
import type { AuthIdentityTracker } from '../app/auth/auth-identity.js'
import { campaignContent, refreshCampaigns } from '../app/campaigns.js'
import type { CloudSync, ModelAnnouncer } from '../app/session/cloud-sync.js'
import type { PromptSuggestion } from '../app/suggestion/index.js'
import type { CommandWindowController } from './command-window.js'
import type { FrameController } from './frame.js'
import type { ScrollbackController } from './scrollback.js'
import type { ReplState } from './state.js'
import type { TermRenderer } from '../screen/renderer.js'
import { type AdContent, campaignFingerprint, queueAdSlotTransition, triggerAdSlot } from '../viewmodel/ad-slot.js'
import { renderErrorNotice } from '../../ui/command-notice.js'
import { errorText } from '../../ui/format.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface CloudDeps {
  readonly agent: Agent
  readonly cloudModels: () => ModelOption[]
  readonly cloudSessions: CloudSessionSync
  readonly cloudSync: CloudSync<never[]>
  readonly commandWindow: CommandWindowController
  readonly frames: FrameController
  readonly modelAnnouncer: ModelAnnouncer
  readonly refreshConfigInfo: () => void
  readonly refreshOpenModelSelector: () => boolean
  readonly renderer: TermRenderer
  readonly scrollback: ScrollbackController
  readonly suggestions: PromptSuggestion
  readonly taskIdentity: AuthIdentityTracker
}

export interface CloudController {
  activeProviderIsCloud(): boolean
  adoptExternalAuthChange(): void
  flushDeferredCloudUpdates(): void
  handleCloudSessionRevoked(): void
  noteOfficialSkillSync(result: OfficialSyncResult): void
  readonly pinDefaultModel: (spec: string) => Promise<void>
  queryBlockedByCloudLogin(): boolean
  reloadAfterAuthChange(): boolean
  reloadCloudContent(fresh?: AdContent[]): void
  readonly syncCloudNow: (force?: boolean) => Promise<void>
}

/** Cloud login state, catalog reloads, campaigns and session sync. */
export function createCloudController(st: ReplState, deps: CloudDeps): CloudController {
  function showCloudCampaign(campaignId: string): void {
    if (!queueAdSlotTransition(st.adSlot, campaignId)) {
      triggerAdSlot(st.adSlot, Date.now())
    }
  }

  function flushDeferredCloudUpdates(): void {
    if (deps.commandWindow.commandWindowMounted()) return
    const modelNotice = st.deferredCloudModelNotice
    const campaignId = st.deferredCloudCampaignId
    const skillNotice = st.deferredSkillNotice
    st.deferredCloudModelNotice = null
    st.deferredCloudCampaignId = null
    st.deferredSkillNotice = null
    if (modelNotice) deps.scrollback.commitSystem('sys-cloud-models', chalk.dim(modelNotice))
    if (skillNotice) deps.scrollback.commitSystem('sys-skills-sync', chalk.dim(skillNotice))
    if (campaignId) showCloudCampaign(campaignId)
  }

  /** The official catalog moved and this device followed it. Said once, in one
   *  dim line, and never over an open command window. */
  function noteOfficialSkillSync(result: OfficialSyncResult): void {
    const parts = [
      result.installed.length ? `new: ${result.installed.join(', ')}` : '',
      result.updated.length ? `updated: ${result.updated.join(', ')}` : '',
      result.removed.length ? `removed: ${result.removed.join(', ')}` : '',
    ].filter(Boolean)
    if (!parts.length) return
    const notice = `  ↻ Official skills ${parts.join(' · ')}`
    deps.frames.refreshBannerData()
    if (deps.commandWindow.commandWindowMounted()) st.deferredSkillNotice = notice
    else deps.scrollback.commitSystem('sys-skills-sync', chalk.dim(notice))
    deps.renderer.requestRender()
  }

  /** Save the highlighted picker row as the account default (Space in the
   *  picker). Nothing else moves: the live model stays, the picker stays open,
   *  and only the ★ marker jumps to the newly pinned row. */
  async function pinDefaultModel(spec: string): Promise<void> {
    const option = selectModelOption(st.configInfo, spec)
    if (!option) return
    const label = formatModelLabel(option.model, option.provider, option.group_label)
    try {
      const pinned = await deps.agent.pinDefaultModel(option.provider, option.model)
      if (pinned === null) {
        deps.scrollback.commitSystem('sys-model-pin', chalk.dim(`  ${label} is a local provider — its default lives in evot.env, not on your account`))
      } else {
        deps.refreshConfigInfo()
        deps.refreshOpenModelSelector()
        deps.scrollback.commitSystem('sys-model-pin', chalk.dim(`  ★ ${label} is now the default for new sessions on this account`))
      }
    } catch (err) {
      deps.scrollback.commitSystem('sys-model-pin', renderErrorNotice(`Could not save default model: ${errorText(err)}`))
    }
    deps.renderer.requestRender()
  }

  /** Single cloud-session status line; updates replace it in place. */
  function commitCloudSession(text: string, tone: 'dim' | 'ok' | 'warn'): void {
    const paint = tone === 'ok' ? chalk.green : tone === 'warn' ? chalk.yellow : chalk.dim
    deps.scrollback.commitStatusLine({ id: 'sys-cloud-session', kind: 'system', text: paint(text) })
  }

  /**
   * Re-resolve the model after an auth change and report whether one remains.
   * The backend keeps a still-served selection, so this only announces a model
   * the reload actually moved.
   */
  function reloadAfterAuthChange(): boolean {
    deps.taskIdentity.refresh()
    deps.suggestions.credentialsChanged()
    const previousModel = deps.agent.model
    const outcome = deps.agent.reloadSelectionOutcome()
    deps.refreshConfigInfo()
    reloadCloudContent()
    if (outcome === 'unconfigured') return false

    st.appState = { ...st.appState, model: deps.agent.model }
    // Only a different model is worth a line. `kept` and `followed` both
    // leave the user on the same model (`followed` just re-homed it to another
    // catalog group, which is routing, not something they chose or can see).
    // A run in flight keeps repainting its pinned model into `appState`, so
    // diffing display state here would re-announce the same landing on every
    // external catalog write.
    if (outcome !== 'switched') return true
    const next = st.configInfo?.availableModels.find(model => model.spec === currentModelSpec(st.configInfo, deps.agent.model))
    const provider = next?.provider ?? st.configInfo?.provider ?? ''
    const label = formatModelLabel(deps.agent.model, provider, next?.group_label)
    deps.scrollback.commitStatusLine({
      id: 'sys-model',
      kind: 'system',
      text: `  Model → ${label}${chalk.dim(` · ${previousModel} is no longer available`)}`,
      shareEvents: modelShareEvents(provider, deps.agent.model, st.configInfo?.thinkingLevel),
    })
    return true
  }

  function handleCloudSessionRevoked(): void {
    // A dead scoped key is recoverable: the catalog mints a fresh one on read,
    // so only a refused CLI token needs /login.
    if (st.revocationCleanup) return
    commitCloudSession('  ⟳ Cloud session key expired · restoring', 'dim')
    st.revocationCleanup = (async () => {
      try {
        const { authRefreshSession } = await import('../../native/index.js')
        const { planAfterRevocation } = await import('../../commands/login-flow.js')
        const plan = planAfterRevocation(await authRefreshSession())
        if (plan.kind === 'recovered') {
          st.cloudLoginRequired = !reloadAfterAuthChange()
          st.authWatcher?.sync()
          commitCloudSession('  ✓ Cloud session restored · send your message again', 'ok')
        } else if (plan.kind === 'unavailable') {
          // An outage says nothing about the credential; keep it.
          st.cloudLoginRequired = false
          commitCloudSession(`  ⚠ Cannot reach the evot server${plan.error ? ` (${plan.error})` : ''} · try again shortly`, 'warn')
        } else {
          st.cloudLoginRequired = true
          try { reloadAfterAuthChange() } catch { /* no provider left; /login is the fix */ }
          st.authWatcher?.sync()
          commitCloudSession('  ⚠ Cloud session signed out · run /login to reconnect', 'warn')
        }
      } catch (err) {
        st.cloudLoginRequired = true
        commitCloudSession(`  ⚠ Could not restore the cloud session: ${errorText(err)}`, 'warn')
      } finally {
        st.revocationCleanup = null
        deps.renderer.requestRender()
      }
    })()
  }

  function queryBlockedByCloudLogin(): boolean {
    if (st.revocationCleanup) {
      commitCloudSession('  ⟳ Cloud session key expired · restoring', 'dim')
      return true
    }
    if (!st.cloudLoginRequired) return false
    commitCloudSession('  ⚠ Cloud session signed out · run /login to reconnect', 'warn')
    return true
  }

  function activeProviderIsCloud(): boolean {
    const provider = st.configInfo?.provider
    if (!provider) return false
    const active = st.configInfo?.availableModels.find(
      option => option.provider === provider && option.model === st.appState.model,
    )
    return active !== undefined && isCloudModel(active)
  }

  /**
   * Semantic session search for `/resume <query>`: the server ranks recent
   * sessions with a one-shot LLM call (hidden `/_rsearch` command). Shows the
   * ranked list with reasons, then opens the resume selector on the ranked
   * sessions. Falls back to the literal-filter selector on failure.
   */
  function cloudCampaigns(notices = authNotices()) {
    return campaignContent(notices)
  }

  /** Re-read the synced catalog: refresh model config and the ad/notice slot.
   *  Called after login, by the live-sync poller, and on demand. */
  function reloadCloudContent(fresh = cloudCampaigns()): void {
    refreshCampaigns(st.adSlot, fresh, hasPremiumModel(st.configInfo), Date.now())
    try { st.configInfo = deps.agent.configInfo() } catch {}
  }

  /** Adopt a cloud auth change made by another evot process. */
  function adoptExternalAuthChange(): void {
    // A recovery in flight owns the auth state and syncs the stamp itself.
    if (st.revocationCleanup) return
    try {
      const reloaded = reloadAfterAuthChange()
      st.cloudLoginRequired = !reloaded && !st.configInfo?.hasApiKey
      if (st.cloudLoginRequired) {
        commitCloudSession('  ⚠ Cloud session signed out · run /login to reconnect', 'warn')
      } else {
        deps.renderer.requestRender()
      }
    } catch {
      // Half-written file from a concurrent login; the next event retries.
    }
  }

  async function syncCloudNow(force = false): Promise<void> {
    if (st.destroyed) return
    if (st.inflightSync) return st.inflightSync
    st.inflightSync = (async () => {
      // The remote session index rides the same tick; empty when signed out.
      void deps.cloudSessions.refreshIndex()
      // Anything present right before the sync counts as known, even if it
      // arrived through a path other than this sync (e.g. an external login).
      deps.modelAnnouncer.seed(deps.cloudModels().map(m => m.model))
      const knownCampaignIds = new Set([...st.adSlot.notices, ...st.adSlot.ads].map(c => c.id))
      const knownFingerprints = new Set([...st.adSlot.notices, ...st.adSlot.ads].map(campaignFingerprint))

      const synced = await deps.cloudSync.run(force)
      if (st.destroyed || !synced) return
      const { noticesSynced, modelsSynced } = synced
      if (!noticesSynced && !modelsSynced) return

      const addedModels = deps.modelAnnouncer.fresh(deps.cloudModels())
      const campaigns = [...st.adSlot.notices, ...st.adSlot.ads]
      const addedCampaigns = campaigns.filter(c => !knownCampaignIds.has(c.id))
      const copyChanged = campaigns.some(c => !knownFingerprints.has(campaignFingerprint(c)))
      if (addedModels.length > 0) {
        const names = addedModels.slice(0, 3)
          .map(m => formatModelOptionLabel(m))
          .join(', ')
        const more = addedModels.length > 3 ? ` and ${addedModels.length - 3} more` : ''
        const notice = `  ✓ New models available: ${names}${more} — /model to switch`
        if (deps.commandWindow.commandWindowMounted()) st.deferredCloudModelNotice = notice
        else deps.scrollback.commitSystem('sys-cloud-models', chalk.dim(notice))
      }
      if (addedCampaigns.length > 0) {
        // A command window owns stable geometry. Defer the idle campaign
        // transition until it closes rather than inserting rows above it.
        const campaignId = addedCampaigns[0]!.id
        if (deps.commandWindow.commandWindowMounted()) st.deferredCloudCampaignId = campaignId
        else showCloudCampaign(campaignId)
      }
      const refreshedOpenPicker = modelsSynced && deps.refreshOpenModelSelector()
      if (
        refreshedOpenPicker
        || (!deps.commandWindow.commandWindowMounted() && (addedModels.length > 0 || addedCampaigns.length > 0 || copyChanged))
      ) {
        deps.renderer.requestRender()
      }
    })()
    try {
      await st.inflightSync
    } finally {
      st.inflightSync = null
    }
  }

  return { activeProviderIsCloud, adoptExternalAuthChange, flushDeferredCloudUpdates, handleCloudSessionRevoked, noteOfficialSkillSync, pinDefaultModel, queryBlockedByCloudLogin, reloadAfterAuthChange, reloadCloudContent, syncCloudNow }
}
