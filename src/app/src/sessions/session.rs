use std::sync::Arc;

use chrono::Utc;
use tokio::sync::Mutex;
use tokio::sync::RwLock;

use super::locator::SessionLocator;
use crate::error::Result;
use crate::storage::Storage;
use crate::types::ListTranscriptEntries;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::TranscriptItem;

/// Outcome of appending one engine-turn batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnAppend {
    /// Transcript generation after the batch.
    pub next_seq: u64,
    /// Context items (user / assistant / tool) another writer persisted
    /// between the caller's expected generation and where the batch actually
    /// landed. Stats, notices, and markers never count: they do not enter the
    /// model context, so a compaction planned without them loses nothing.
    pub interleaved_context_items: usize,
}

pub struct Session {
    storage: Arc<dyn Storage>,
    meta: RwLock<SessionMeta>,
    state: Mutex<SessionState>,
}

struct SessionState {
    transcript: Vec<TranscriptItem>,
    engine_transcript: Vec<evot_engine::AgentMessage>,
    next_seq: u64,
    /// Cross-compaction state derived from the latest persisted `Compact`
    /// item. Seeds the engine's in-run auto-compaction so a follow-up
    /// compaction updates the previous summary instead of re-summarizing it
    /// as plain conversation text.
    compact_seed: Option<evot_engine::CompactionState>,
    /// Hash of the last persisted `LlmCallStarted` request payload (system
    /// prompt + tool schemas). Repeats are delta-stripped before storage.
    llm_payload_hash: Option<u64>,
}

impl Session {
    fn init(
        storage: Arc<dyn Storage>,
        meta: SessionMeta,
        transcript: Vec<TranscriptItem>,
        engine_transcript: Vec<evot_engine::AgentMessage>,
        next_seq: u64,
        compact_seed: Option<evot_engine::CompactionState>,
    ) -> Arc<Self> {
        Arc::new(Self {
            storage,
            meta: RwLock::new(meta),
            state: Mutex::new(SessionState {
                transcript,
                engine_transcript,
                next_seq,
                compact_seed,
                llm_payload_hash: None,
            }),
        })
    }

    pub async fn new(
        session_id: String,
        cwd: String,
        model: String,
        storage: Arc<dyn Storage>,
    ) -> Result<Arc<Self>> {
        Self::new_with_source(session_id, cwd, model, "", storage).await
    }

    pub async fn new_with_source(
        session_id: String,
        cwd: String,
        model: String,
        source: &str,
        storage: Arc<dyn Storage>,
    ) -> Result<Arc<Self>> {
        Self::new_with_provider_source(session_id, cwd, "".into(), model, source, storage).await
    }

    pub async fn new_with_provider_source(
        session_id: String,
        cwd: String,
        provider: String,
        model: String,
        source: &str,
        storage: Arc<dyn Storage>,
    ) -> Result<Arc<Self>> {
        let meta = SessionMeta::new(session_id, cwd, model)
            .with_provider(provider)
            .with_source(source);
        storage.save_session(meta.clone()).await?;
        Ok(Self::init(storage, meta, Vec::new(), Vec::new(), 0, None))
    }

    pub async fn open(session_id: &str, storage: Arc<dyn Storage>) -> Result<Option<Arc<Self>>> {
        let meta = match storage.get_session(session_id).await? {
            Some(meta) => meta,
            None => return Ok(None),
        };

        let entries = storage.load_active_entries(session_id).await?;

        let next_seq = entries.last().map(|e| e.seq).unwrap_or(0);
        let transcript = crate::compact::context_view::resolve_context_items(&entries);
        let (engine_transcript, compact_seed) =
            crate::compact::context_view::resolve_engine_context_with_state(&entries);

        Ok(Some(Self::init(
            storage,
            meta,
            transcript,
            engine_transcript,
            next_seq,
            compact_seed,
        )))
    }

    /// Open an existing session by locator, or create a new one.
    /// This is the single entry point for all channel-based session resolution.
    pub async fn open_or_create(
        locator: &SessionLocator,
        cwd: &str,
        model: &str,
        storage: Arc<dyn Storage>,
    ) -> Result<Arc<Self>> {
        Self::open_or_create_with_provider(locator, cwd, "", model, storage).await
    }

    pub async fn open_or_create_with_provider(
        locator: &SessionLocator,
        cwd: &str,
        provider: &str,
        model: &str,
        storage: Arc<dyn Storage>,
    ) -> Result<Arc<Self>> {
        let id = locator.session_id();
        match Self::open(&id, storage.clone()).await? {
            Some(session) => {
                session
                    .set_model_selection(provider.to_string(), model.to_string())
                    .await?;
                Ok(session)
            }
            None => {
                Self::new_with_provider_source(
                    id,
                    cwd.to_string(),
                    provider.to_string(),
                    model.to_string(),
                    &locator.stable_key(),
                    storage,
                )
                .await
            }
        }
    }

    pub async fn set_model(&self, model: String) {
        self.meta.write().await.model = model;
    }

    pub async fn set_model_selection(&self, provider: String, model: String) -> Result<()> {
        let audit_provider = provider.clone();
        let audit_model = model.clone();
        let (changed, prev_provider, prev_model) = self
            .update_meta(|meta| {
                let previous = (meta.provider.clone(), meta.model.clone());
                let changed = previous.0 != provider || previous.1 != model;
                meta.provider = provider;
                meta.model = model;
                Ok((changed, previous.0, previous.1))
            })
            .await?;
        // Metadata is the authoritative model selection. The transcript audit
        // is diagnostic only, so a failed audit append must not report that an
        // already-persisted model switch failed.
        if changed && !prev_model.is_empty() {
            if let Err(error) = self
                .write_items(vec![TranscriptItem::Stats {
                    kind: "model_change".to_string(),
                    data: serde_json::json!({
                        "from_provider": prev_provider,
                        "from_model": prev_model,
                        "to_provider": audit_provider,
                        "to_model": audit_model,
                    }),
                }])
                .await
            {
                tracing::warn!(%error, "failed to persist model change audit");
            }
        }
        Ok(())
    }

    /// Return Engine history, compaction seed, and transcript generation atomically.
    pub async fn context_snapshot(
        &self,
    ) -> (
        Vec<evot_engine::AgentMessage>,
        Option<evot_engine::CompactionState>,
        u64,
    ) {
        let state = self.state.lock().await;
        (
            state.engine_transcript.clone(),
            state.compact_seed.clone(),
            state.next_seq,
        )
    }

    /// Snapshot both context representations for manual compaction.
    pub async fn compaction_snapshot(
        &self,
    ) -> (
        Vec<TranscriptItem>,
        Vec<evot_engine::AgentMessage>,
        Option<evot_engine::CompactionState>,
        u64,
    ) {
        let state = self.state.lock().await;
        (
            state
                .transcript
                .iter()
                .filter(|item| item.is_context_item())
                .cloned()
                .collect(),
            state.engine_transcript.clone(),
            state.compact_seed.clone(),
            state.next_seq,
        )
    }

    /// Cross-compaction seed for the engine's auto-compaction (see field doc).
    pub async fn compaction_seed(&self) -> Option<evot_engine::CompactionState> {
        self.state.lock().await.compact_seed.clone()
    }

    /// Set the session's persisted thinking level (lowercase level name, or
    /// `None` when the model has no selectable level). Persisted by `save()`.
    pub async fn set_thinking_level(&self, level: Option<String>) {
        self.meta.write().await.thinking_level = level;
    }

    /// Append one logical transcript batch. Sequence allocation, persistence,
    /// and publication to the in-memory context are serialized as one commit.
    pub async fn write_items(&self, items: Vec<TranscriptItem>) -> Result<()> {
        if items.iter().any(|item| {
            matches!(
                item,
                TranscriptItem::Compact { .. } | TranscriptItem::Marker { .. }
            )
        }) {
            return Err(crate::error::EvotError::Session(
                "control points require an atomic Session API".to_string(),
            ));
        }
        self.commit_items(items, None, None, false).await?;
        Ok(())
    }

    /// Append items produced by an Engine turn. If another writer advanced the
    /// session after the turn was built, append this logical batch at the new
    /// tail instead of surfacing a sequence conflict, and report how many
    /// *context* items landed in between so the caller can tell a harmless
    /// stats/notice write from conversation content the engine never saw.
    pub async fn write_items_at(
        &self,
        items: Vec<TranscriptItem>,
        expected_seq: u64,
    ) -> Result<TurnAppend> {
        let (base_seq, next_seq) = self
            .commit_items(items, None, Some(expected_seq), false)
            .await?;
        let interleaved_context_items = if base_seq == expected_seq {
            0
        } else {
            self.count_context_items_between(expected_seq, base_seq)
                .await?
        };
        Ok(TurnAppend {
            next_seq,
            interleaved_context_items,
        })
    }

    /// Context items persisted with `from_seq < seq <= to_seq`.
    async fn count_context_items_between(&self, from_seq: u64, to_seq: u64) -> Result<usize> {
        if to_seq <= from_seq {
            return Ok(0);
        }
        let session_id = self.meta.read().await.session_id.clone();
        let entries = self
            .storage
            .list_entries(ListTranscriptEntries {
                session_id,
                run_id: None,
                after_seq: Some(from_seq),
                limit: None,
            })
            .await?;
        Ok(entries
            .iter()
            .filter(|entry| entry.seq <= to_seq && entry.item.is_context_item())
            .count())
    }

    /// Persist a compact control point and publish its replacement context in
    /// the same Session transaction. `expected_seq` is the storage generation
    /// used to build the compaction plan; if another write advanced the session,
    /// the stale plan is rejected before its marker is persisted.
    pub async fn write_compact(
        &self,
        mut item: TranscriptItem,
        mut new_context: Vec<TranscriptItem>,
        expected_seq: u64,
    ) -> Result<()> {
        if !matches!(item, TranscriptItem::Compact { .. }) {
            return Err(crate::error::EvotError::Session(
                "write_compact requires a compact item".to_string(),
            ));
        }
        crate::compact::context_view::normalize_compact_item(&mut item, &mut new_context);
        self.commit_items(vec![item], Some(new_context), Some(expected_seq), true)
            .await?;
        Ok(())
    }

    /// Returns `(base_seq, next_seq)`: the generation the batch was appended
    /// onto and the generation after it.
    async fn commit_items(
        &self,
        mut items: Vec<TranscriptItem>,
        replacement: Option<Vec<TranscriptItem>>,
        expected_seq: Option<u64>,
        is_compaction: bool,
    ) -> Result<(u64, u64)> {
        const MAX_CONFLICT_RETRIES: usize = 8;

        let mut state = self.state.lock().await;
        if items.is_empty() {
            return Ok((state.next_seq, state.next_seq));
        }
        let mut payload_hash = state.llm_payload_hash;
        dedupe_llm_request_payload(&mut payload_hash, &mut items);

        let (session_id, turn) = {
            let meta = self.meta.read().await;
            (meta.session_id.clone(), meta.turns)
        };

        for attempt in 0..=MAX_CONFLICT_RETRIES {
            if is_compaction {
                if let Some(expected) = expected_seq {
                    if state.next_seq != expected {
                        return Err(stale_write_error(true, expected, state.next_seq));
                    }
                }
            }
            let entries = items
                .iter()
                .enumerate()
                .map(|(offset, item)| {
                    TranscriptEntry::new(
                        session_id.clone(),
                        None,
                        state
                            .next_seq
                            .saturating_add(offset as u64)
                            .saturating_add(1),
                        turn,
                        item.clone(),
                    )
                })
                .collect::<Vec<_>>();

            // Storage is authoritative. Do not advance sequence numbers,
            // context, or compaction state until the complete logical batch is
            // accepted against the same persisted generation.
            if self
                .storage
                .compare_and_append_entries(state.next_seq, entries)
                .await?
            {
                let base_seq = state.next_seq;
                state.next_seq = state.next_seq.saturating_add(items.len() as u64);
                state.llm_payload_hash = payload_hash;
                update_compact_seed(&mut state.compact_seed, &items);
                match replacement.clone() {
                    Some(context) => {
                        state.engine_transcript =
                            compact_engine_messages(&items).unwrap_or_else(|| {
                                crate::conversation::convert::into_agent_messages(&context)
                            });
                        state.transcript = context;
                    }
                    None => {
                        state.engine_transcript.extend(
                            crate::conversation::convert::into_agent_messages(
                                &items
                                    .iter()
                                    .filter(|item| item.is_context_item())
                                    .cloned()
                                    .collect::<Vec<_>>(),
                            ),
                        );
                        state.transcript.extend(items.clone());
                    }
                }
                return Ok((base_seq, state.next_seq));
            }

            let persisted = self
                .storage
                .list_entries(ListTranscriptEntries {
                    session_id: session_id.clone(),
                    run_id: None,
                    after_seq: None,
                    limit: None,
                })
                .await?;
            let persisted_seq = persisted.iter().map(|entry| entry.seq).max().unwrap_or(0);
            if is_compaction {
                if let Some(expected) = expected_seq {
                    return Err(stale_write_error(true, expected, persisted_seq));
                }
            }
            if attempt == MAX_CONFLICT_RETRIES {
                return Err(crate::error::EvotError::Session(
                    "transcript remained busy after conflict retries".to_string(),
                ));
            }

            // Ordinary turn writes are append-only. Rebase them onto the latest
            // persisted tail and retry so concurrent writers preserve both
            // logical batches. Context-replacing compactions remain strict.
            state.next_seq = persisted_seq;
            state.transcript = crate::compact::context_view::resolve_context_items(&persisted);
            let (engine_transcript, compact_seed) =
                crate::compact::context_view::resolve_engine_context_with_state(&persisted);
            state.engine_transcript = engine_transcript;
            state.compact_seed = compact_seed;
        }

        Err(crate::error::EvotError::Session(
            "unreachable transcript commit state".to_string(),
        ))
    }

    /// Increment the turn counter. Call once per real conversation turn.
    pub async fn increment_turn(&self) {
        self.meta.write().await.turns += 1;
    }

    /// Accumulate billed token usage from a finished run into the session's
    /// running totals. Persisted by the next `save()`.
    pub async fn add_usage(&self, input: u64, output: u64) {
        let mut meta = self.meta.write().await;
        meta.total_input_tokens = meta.total_input_tokens.saturating_add(input);
        meta.total_output_tokens = meta.total_output_tokens.saturating_add(output);
    }

    /// Persist session meta (title, updated_at, context usage, etc.).
    pub async fn save(&self) -> Result<()> {
        // Derive meta fields under the state lock by reference: the active
        // context can be tens of MB on long sessions, so it is never cloned.
        let (title, context_usage, message_count, span_count) = {
            let state = self.state.lock().await;
            let transcript = &state.transcript;
            (
                build_title(transcript),
                last_context_usage(transcript),
                transcript.iter().filter(|i| i.is_context_item()).count() as u32,
                // Accurate span count = assistant LLM-call entries, matching
                // the trace viewer.
                transcript
                    .iter()
                    .filter(|i| matches!(i, TranscriptItem::Assistant { .. }))
                    .count() as u32,
            )
        };

        let mut meta = self.meta.write().await;
        // Build title from first + last user messages so the resume list
        // shows both the original topic and the most recent activity. When the
        // active context holds no real user turn, an already-polluted title is
        // cleared instead of being kept forever: compaction used to derive it
        // from its own synthetic summary message, which made every compacted
        // session look identical in the resume list.
        match title {
            Some(title) => meta.title = Some(title),
            None => {
                let polluted = meta
                    .title
                    .as_deref()
                    .is_some_and(crate::compact::context_view::is_compact_summary_text);
                if polluted {
                    meta.title = None;
                }
            }
        }
        // Extract latest context window usage from compaction stats.
        if let Some((tokens, budget)) = context_usage {
            meta.context_tokens = tokens;
            meta.context_budget = budget;
        }
        meta.message_count = message_count;
        meta.span_count = Some(span_count);
        meta.updated_at = Utc::now().to_rfc3339();
        self.storage.save_session(meta.clone()).await
    }

    pub async fn meta(&self) -> SessionMeta {
        self.meta.read().await.clone()
    }

    /// Atomically mutate `SessionMeta`, persist, and return a result.
    ///
    /// The closure runs against a clone; on success the new value is
    /// written through storage **before** swapping into the in-memory
    /// `RwLock`. If the write fails the in-memory value is left
    /// untouched, so callers see consistent state across restarts.
    pub async fn update_meta<T, F>(&self, mutate: F) -> Result<T>
    where F: FnOnce(&mut SessionMeta) -> Result<T> {
        let mut guard = self.meta.write().await;
        let mut working = guard.clone();
        let value = mutate(&mut working)?;
        working.updated_at = Utc::now().to_rfc3339();
        self.storage.save_session(working.clone()).await?;
        *guard = working;
        Ok(value)
    }

    pub async fn transcript(&self) -> Vec<TranscriptItem> {
        self.state.lock().await.transcript.clone()
    }

    pub async fn session_id(&self) -> String {
        self.meta.read().await.session_id.clone()
    }

    // -- marker methods -------------------------------------------------------

    /// Write a `/clear` marker and publish an empty context atomically.
    pub async fn write_clear_marker(&self) -> Result<()> {
        let item = TranscriptItem::Marker {
            kind: crate::types::MarkerKind::Clear,
            messages: vec![],
        };
        self.commit_items(vec![item], Some(Vec::new()), None, false)
            .await?;
        Ok(())
    }

    /// Load all raw transcript entries from storage.
    pub async fn load_all_entries(&self) -> Result<Vec<TranscriptEntry>> {
        let session_id = self.meta.read().await.session_id.clone();
        self.storage
            .list_entries(ListTranscriptEntries {
                session_id,
                run_id: None,
                after_seq: None,
                limit: None,
            })
            .await
    }
}

fn compact_engine_messages(items: &[TranscriptItem]) -> Option<Vec<evot_engine::AgentMessage>> {
    items.iter().rev().find_map(|item| match item {
        TranscriptItem::Compact {
            engine_messages, ..
        } => Some(engine_messages.clone()),
        _ => None,
    })
}

fn stale_write_error(is_compaction: bool, expected: u64, current: u64) -> crate::error::EvotError {
    let operation = if is_compaction {
        "stale compaction plan"
    } else {
        "stale transcript write"
    };
    crate::error::EvotError::Session(format!(
        "{operation}: expected transcript seq {expected}, current seq {current}"
    ))
}

fn update_compact_seed(seed: &mut Option<evot_engine::CompactionState>, items: &[TranscriptItem]) {
    for item in items {
        match item {
            TranscriptItem::Compact { state, .. } => *seed = Some(state.as_ref().clone()),
            TranscriptItem::Marker { .. } => *seed = None,
            _ => {}
        }
    }
}

/// Delta-persist LLM request payloads: `LlmCallStarted` stats carry the full
/// system prompt and tool schemas only when they differ from the previous
/// persisted call. The payload rarely changes within a session, and repeating
/// it on every call dominates transcript size on long sessions. Readers
/// resolve a span's payload from the nearest non-empty record (see the
/// dashboard trace view).
fn dedupe_llm_request_payload(last_hash: &mut Option<u64>, items: &mut [TranscriptItem]) {
    use crate::observability::TranscriptStats;

    for item in items {
        let Some(TranscriptStats::LlmCallStarted(mut stats)) = TranscriptStats::try_from_item(item)
        else {
            continue;
        };
        let hash = llm_payload_hash(&stats.system_prompt, &stats.tool_definitions);
        if *last_hash == Some(hash) {
            stats.system_prompt = String::new();
            stats.tool_definitions = Vec::new();
            *item = TranscriptStats::LlmCallStarted(stats).to_item();
        } else {
            *last_hash = Some(hash);
        }
    }
}

fn llm_payload_hash(system_prompt: &str, tools: &[crate::observability::ToolDef]) -> u64 {
    use std::hash::Hash;
    use std::hash::Hasher;

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    system_prompt.hash(&mut hasher);
    serde_json::to_string(tools)
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}

fn build_title(items: &[TranscriptItem]) -> Option<String> {
    // Compaction injects a synthetic first User item whose text is the summary
    // wrapper. Including it rewrites the resume-list title to the boilerplate
    // prefix ("The conversation history before this point..."), making the
    // session look "gone" after compact. Skip those synthetic prompts so the
    // title keeps tracking real user turns.
    let user_texts: Vec<String> = items
        .iter()
        .filter_map(|item| {
            if let TranscriptItem::User { text, .. } = item {
                if crate::compact::context_view::is_compact_summary_text(text) {
                    return None;
                }
                // A host-expanded command titles the session by what the
                // user typed, not by the attached instructions.
                let text = crate::conversation::input::authored_text(item)?;
                let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !normalized.is_empty() {
                    return Some(normalized);
                }
            }
            None
        })
        .collect();

    let first = user_texts.first()?;
    let last = user_texts.last()?;

    if first == last || user_texts.len() == 1 {
        // Single unique message — truncate to 80 chars
        let mut title: String = first.chars().take(80).collect();
        if first.chars().count() > 80 {
            title.push_str("...");
        }
        return Some(title);
    }

    // head … tail — split budget between first and last
    let max_half = 40;
    let mut head: String = first.chars().take(max_half).collect();
    if first.chars().count() > max_half {
        head.push_str("..");
    }
    let mut tail: String = last.chars().take(max_half).collect();
    if last.chars().count() > max_half {
        tail.push_str("..");
    }
    Some(format!("{head} … {tail}"))
}

/// Extract the latest context usage (estimated_tokens, budget_tokens) from
/// compaction-started stats entries in the transcript.
fn last_context_usage(items: &[TranscriptItem]) -> Option<(usize, usize)> {
    items.iter().rev().find_map(|item| {
        if let TranscriptItem::Stats { kind, data } = item {
            if kind == "context_compaction_started" {
                let tokens = data.get("estimated_tokens")?.as_u64()? as usize;
                let budget = data.get("budget_tokens")?.as_u64()? as usize;
                return Some((tokens, budget));
            }
        }
        None
    })
}
