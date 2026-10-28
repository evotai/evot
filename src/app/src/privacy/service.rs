//! Process-wide privacy state and the entry points the rest of evot uses.
//!
//! Everything fails closed: if the settings cannot be read, a rule does not
//! compile or masking panics, nothing is sent. The placeholder key is the
//! one exception, as a key kept only in memory leaks nothing; it costs only
//! placeholder stability across restarts.
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use parking_lot::Mutex;
use rand::RngCore;
use serde::Deserialize;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::masker;
use super::masker::Masker;
use super::notice::blocked_message;
use super::notice::unavailable_message;
use super::policy::PrivacySettings;
use super::policy::SETTINGS_SCHEMA_VERSION;
use super::record;
use super::record::LiveNotice;
use super::record::Record;
use super::record::Summary;
use super::record::Target;
use super::rules::file_stamp;
use super::rules::read_user_packs;
use super::rules::user_stamp;
use super::rules::FileStamp;
use super::rules::KindInfo;
use super::rules::PackInfo;
use super::rules::UserStamp;
use super::scrub::UploadContext;
use super::vault::Vault;
use crate::blocking::blocking_io;
use crate::error::EvotError;
use crate::error::Result;

const KEY_SCHEMA_VERSION: u32 = 1;

fn privacy_dir() -> Result<PathBuf> {
    Ok(crate::conf::paths::state_root_dir()?.join("privacy"))
}

fn settings_path() -> Result<PathBuf> {
    Ok(privacy_dir()?.join("settings.json"))
}

/// The user's own rule packs.
fn rules_dir() -> Result<PathBuf> {
    Ok(privacy_dir()?.join("rules"))
}

fn records_dir() -> Result<PathBuf> {
    Ok(privacy_dir()?.join("records"))
}

// ---- key and vault ---------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct KeyFile {
    #[serde(default)]
    schema_version: u32,
    key: String,
}

/// The process's vault: one key, one set of placeholders and known values
/// across every masker the settings produce.
fn vault() -> Arc<Vault> {
    static VAULT: OnceLock<Arc<Vault>> = OnceLock::new();
    VAULT
        .get_or_init(|| {
            Arc::new(Vault::new(load_key().unwrap_or_else(|error| {
                tracing::warn!(%error, "privacy: placeholder key kept in memory only");
                random_key()
            })))
        })
        .clone()
}

fn random_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    key
}

fn read_key(path: &Path) -> Result<Option<[u8; 32]>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let file: KeyFile = serde_json::from_str(&text)?;
    if file.schema_version > KEY_SCHEMA_VERSION {
        return Err(EvotError::Conf(
            "privacy key schema is newer than this evot".into(),
        ));
    }
    let bytes: Vec<u8> = (0..file.key.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(file.key.get(i..i + 2)?, 16).ok())
        .collect();
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| EvotError::Conf("privacy key is malformed".into()))?;
    Ok(Some(key))
}

fn load_key() -> Result<[u8; 32]> {
    let path = privacy_dir()?.join("key.json");
    if let Some(key) = read_key(&path)? {
        return Ok(key);
    }
    let key = random_key();
    let file = KeyFile {
        schema_version: KEY_SCHEMA_VERSION,
        key: key.iter().map(|b| format!("{b:02x}")).collect(),
    };
    if crate::atomic_file::create_private_atomic(&path, &serde_json::to_vec(&file)?)? {
        return Ok(key);
    }
    // Another process created it first: use theirs.
    read_key(&path)?.ok_or_else(|| EvotError::Conf("privacy key vanished".into()))
}

// ---- settings --------------------------------------------------------------------

type Stamp = (PathBuf, Option<FileStamp>, UserStamp);

struct Cached {
    stamp: Stamp,
    masker: Arc<Masker>,
}

static CURRENT: Mutex<Option<Cached>> = Mutex::new(None);

fn read_settings(path: &Path) -> Result<PrivacySettings> {
    match std::fs::read_to_string(path) {
        Ok(text) => PrivacySettings::parse(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PrivacySettings::default())
        }
        Err(error) => Err(error.into()),
    }
}

/// The masker for the current settings and packs, rebuilt when the
/// settings file or a user pack changes (another evot process may have
/// saved it).
pub(super) fn current(cancel: &CancellationToken) -> Result<Arc<Masker>> {
    if cancel.is_cancelled() {
        return Err(crate::blocking::cancelled("privacy settings"));
    }
    let path = settings_path()?;
    let rules = rules_dir()?;
    // Keep compilation single-flight. Saving settings takes the same lock,
    // so an old in-flight load cannot republish a cache after invalidation.
    let mut cached = CURRENT.lock();
    if cancel.is_cancelled() {
        return Err(crate::blocking::cancelled("privacy settings"));
    }
    let modified = file_stamp(&path)?;
    let stamp: Stamp = (path.clone(), modified, user_stamp(&rules, cancel)?);
    if let Some(c) = cached.as_ref().filter(|c| c.stamp == stamp) {
        return Ok(c.masker.clone());
    }
    let engine = masker::engine(&read_user_packs(&stamp.2, cancel)?)?;
    if cancel.is_cancelled() {
        return Err(crate::blocking::cancelled("privacy settings"));
    }
    let masker = Arc::new(Masker::with_vault(
        &read_settings(&path)?,
        engine,
        vault(),
        Some(records_dir()?),
    )?);
    *cached = Some(Cached {
        stamp,
        masker: masker.clone(),
    });
    Ok(masker)
}

/// The current masker, read off the async runtime.
pub(super) async fn current_masker() -> Result<Arc<Masker>> {
    blocking_io("privacy settings", current).await
}

pub async fn settings() -> Result<PrivacySettings> {
    blocking_io("privacy settings", |_| read_settings(&settings_path()?)).await
}

/// Validate and save `settings`; the next request uses them.
pub async fn save_settings(mut settings: PrivacySettings) -> Result<PrivacySettings> {
    settings.schema_version = SETTINGS_SCHEMA_VERSION;
    blocking_io("privacy settings", move |cancel| {
        // Keep settings repair independent of broken user packs, as before;
        // compilation and validation must not run on an async worker.
        Masker::new(&settings, [0; 32])?;
        if cancel.is_cancelled() {
            return Err(crate::blocking::cancelled("privacy settings"));
        }
        let path = settings_path()?;
        let mut cached = CURRENT.lock();
        if cancel.is_cancelled() {
            return Err(crate::blocking::cancelled("privacy settings"));
        }
        crate::atomic_file::write_private_atomic(&path, &serde_json::to_vec_pretty(&settings)?)?;
        *cached = None;
        Ok(settings)
    })
    .await
}

/// A reply for a chat channel, scrubbed for good with `masker`. Only
/// values not already in `seen` are recorded, so a progressively edited
/// message records each value once. A blocked reply becomes the notice.
pub(super) async fn scrub_delivery(
    masker: &Arc<Masker>,
    text: &str,
    seen: &Mutex<std::collections::BTreeSet<String>>,
) -> Result<String> {
    let worker = masker.clone();
    let text = text.to_string();
    let (text, report) = blocking_io("privacy scrub", move |_| {
        let mut value = serde_json::Value::String(text);
        let report = worker.scrub(&mut value)?;
        Ok((value.as_str().unwrap_or_default().to_string(), report))
    })
    .await?;
    if report.is_empty() {
        return Ok(text);
    }
    let mut record = report.record(Target::Delivery);
    let kinds = record.blocked_kinds();
    let blocked = record.blocked;
    {
        let mut seen = seen.lock();
        record.values.retain(|value| seen.insert(value.tag.clone()));
    }
    if !record.values.is_empty() {
        keep(masker, record).await;
    }
    if blocked {
        return Ok(blocked_message(Target::Delivery, &kinds));
    }
    Ok(text)
}

/// The masker for the current settings, or the privacy error saying why
/// there is none.
pub(super) async fn masker_or_unavailable() -> Result<Arc<Masker>> {
    current_masker()
        .await
        .map_err(|error| EvotError::Privacy(unavailable_message(error)))
}

/// The kinds and packs in force (built-in plus the user's), for `/privacy`.
pub async fn rules_status() -> Result<(Vec<KindInfo>, Vec<PackInfo>)> {
    let masker = current_masker().await?;
    Ok((masker.kinds(), masker.packs()))
}

/// What was masked, warned of and blocked over the last `days` days.
pub async fn summary(days: u32) -> Result<Summary> {
    blocking_io("privacy summary", move |_| {
        record::summarize(&records_dir()?, days.max(1))
    })
    .await
}

/// Mask these values wherever they appear from now on: variables injected
/// into the shell, provider keys, tokens.
pub fn remember_secrets<I, S>(values: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    // Every request fails closed when the packs do not compile; nothing to
    // remember for then.
    let Ok(engine) = masker::engine(&[]) else {
        return;
    };
    let vault = vault();
    for value in values {
        let value = value.as_ref().trim();
        if value.chars().count() >= engine.known.min_secret_len {
            vault.remember("SECRET", value);
        }
    }
}

/// The last records this process made, for the TUI to show as they happen.
/// Bounded; a client that has not asked for a while sees the newest only.
const LIVE_KEPT: usize = 64;
static LIVE: Mutex<(u64, std::collections::VecDeque<LiveNotice>)> =
    Mutex::new((0, std::collections::VecDeque::new()));

/// Records made after `after` (a `seq` from an earlier call; 0 for all
/// kept), oldest first, with the newest `seq` to pass next time. In-memory
/// and process-wide: nothing is read from disk.
pub fn live_notices(after: u64) -> (u64, Vec<LiveNotice>) {
    let live = LIVE.lock();
    let notices = live
        .1
        .iter()
        .filter(|notice| notice.seq > after)
        .cloned()
        .collect();
    (live.0, notices)
}

/// Write `record` where `masker` keeps them; failing to is logged, never fatal.
pub(super) async fn keep(masker: &Masker, record: Record) {
    {
        let mut live = LIVE.lock();
        live.0 += 1;
        let seq = live.0;
        if live.1.len() >= LIVE_KEPT {
            live.1.pop_front();
        }
        live.1.push_back(LiveNotice::of(seq, &record));
    }
    let Some(dir) = masker.records().cloned() else {
        return;
    };
    let result = blocking_io("privacy record", move |_| record::append(&dir, &record)).await;
    if let Err(error) = result {
        tracing::warn!(%error, "privacy: could not record masking");
    }
}

// ---- uploads ---------------------------------------------------------------------

/// The context for uploading part of a session: its whole local history,
/// read once per upload (not per batch).
pub async fn upload_context<T: Serialize>(history: &T) -> Result<UploadContext> {
    let history = serde_json::to_value(history)?;
    let masker = masker_or_unavailable().await?;
    blocking_io("privacy context", move |_| {
        Ok(masker.upload_context(&history))
    })
    .await
}

/// `payload` as JSON bytes with secrets and personal data scrubbed for
/// good, for an upload to `target`, under the current settings and packs.
/// See [`scrub_upload_with`].
pub async fn scrub_upload<T: Serialize>(
    target: Target,
    session: &str,
    payload: &T,
    context: Option<&UploadContext>,
) -> Result<Vec<u8>> {
    scrub_upload_with(
        &masker_or_unavailable().await?,
        target,
        session,
        payload,
        context,
    )
    .await
}

/// Scrub `payload` for `target` with `masker`. A blocked kind fails it,
/// as does masking that cannot run. `context` is the session's history when
/// the payload is only part of it.
///
/// A task definition is stricter: it runs later from what the server
/// holds, so a value scrubbed out of it would change what the task does.
/// Any finding fails it; secrets belong in the task's env file.
pub async fn scrub_upload_with<T: Serialize>(
    masker: &Arc<Masker>,
    target: Target,
    session: &str,
    payload: &T,
    context: Option<&UploadContext>,
) -> Result<Vec<u8>> {
    let value = serde_json::to_value(payload)?;
    let worker = masker.clone();
    let context = context.cloned();
    let (bytes, report) = blocking_io("privacy scrub", move |_| {
        let mut value = value;
        let report = worker.scrub_with(&mut value, context.as_ref())?;
        Ok((serde_json::to_vec(&value)?, report))
    })
    .await?;
    if report.is_empty() {
        return Ok(bytes);
    }
    let mut record = report.record(target);
    record.session = (!session.is_empty()).then(|| session.to_string());
    if target == Target::Task {
        record.block_all_but_warned();
    }
    let kinds = record.blocked_kinds();
    let blocked = record.blocked;
    keep(masker, record).await;
    if blocked {
        return Err(EvotError::Privacy(blocked_message(target, &kinds)));
    }
    Ok(bytes)
}
