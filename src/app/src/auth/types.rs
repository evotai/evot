use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

/// Fields this build does not know about. Carried through every cache
/// load/save so an older client rewriting `models.cache.json` (for example
/// to refresh notices) never strips fields a newer client relies on.
pub type ExtraFields = Map<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudUser {
    pub id: String,
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthState {
    /// Schema marker. Absent in auth.json files written before versioning
    /// existed — default to 0 so upgrades from those versions keep loading.
    #[serde(default)]
    pub version: u32,
    pub server_base_url: String,
    pub user: CloudUser,
    #[serde(rename = "cli_token")]
    pub cli_token: String,
    #[serde(rename = "refresh_token")]
    pub refresh_token: String,
    pub models_synced_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginCodeResponse {
    pub code: String,
    pub login_url: String,
    pub expires_at: i64,
    pub expires_in_ms: i64,
    pub interval_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FreeModelOption {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub tagline: String,
    #[serde(default)]
    pub is_new: bool,
    /// Wire protocol this model speaks. Absent on older servers.
    #[serde(default)]
    pub protocol: String,
    /// `base` (open to everyone) or `special` (granted per account).
    #[serde(default)]
    pub tier: String,
    /// Cloud provider this model is presented under, e.g. `evot-free`.
    #[serde(default)]
    pub provider: String,
    /// Thinking level to apply when this model is selected. Empty on older
    /// servers, or when the catalog leaves the client's current effort alone.
    #[serde(default)]
    pub thinking_level: String,
    /// Display rank within its provider group (higher shows earlier). Zero on
    /// older servers, which keeps the catalog's own order.
    #[serde(default)]
    pub sort_order: i64,
    /// `chat` (default) answers in the conversation; `judge` answers typed
    /// questions about it (TypeSafe Jev) and never generates text. Judges are
    /// kept out of the picker and used for side decisions such as pruning.
    #[serde(default)]
    pub role: String,
    /// Context window in tokens, when the server publishes it. Zero (and
    /// absent on older servers) means unknown: the client falls back to its
    /// own per-model default.
    #[serde(default)]
    pub context_window: u32,
    /// Public capability profile id, independent of the private upstream route.
    /// Empty on historical catalogs: resolve the wire id or use the fallback.
    #[serde(default)]
    pub capability_profile: String,
    /// Independent output limit; absent/zero leaves the profile's limit intact.
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    #[serde(flatten, default)]
    pub extra: ExtraFields,
}

impl FreeModelOption {
    /// The published window, if any.
    pub fn context_window(&self) -> Option<u32> {
        (self.context_window > 0).then_some(self.context_window)
    }

    pub fn is_judge(&self) -> bool {
        self.role.eq_ignore_ascii_case("judge")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Notice {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body_md: String,
    #[serde(flatten, default)]
    pub extra: ExtraFields,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudProviderConfig {
    pub name: String,
    /// Heading the picker shows for this group, pushed by the server.
    #[serde(default)]
    pub label: String,
    /// Where this group sits relative to the others.
    #[serde(default)]
    pub sort_order: i64,
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    /// Retained only so caches written by this version remain readable by
    /// older clients. Model selection ignores it and follows `sort_order`.
    #[serde(default)]
    pub default_model: String,
    pub models: Vec<String>,
    #[serde(flatten, default)]
    pub extra: ExtraFields,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsResponse {
    /// Absent in caches written by early versions; 0 marks those as legacy.
    #[serde(default)]
    pub version: i64,
    /// The wire id every new session of this account lands on. Empty (and
    /// absent in caches from older servers) means "follow catalog rank". The
    /// server blanks it while the pinned model is unavailable to the user.
    #[serde(default)]
    pub default_model: String,
    /// One entry per (tier, protocol) pair in use, so a single account can mix
    /// Anthropic and OpenAI models.
    #[serde(default)]
    pub providers: Vec<CloudProviderConfig>,
    #[serde(default)]
    pub models: Vec<FreeModelOption>,
    #[serde(default)]
    pub notices: Vec<Notice>,
    #[serde(flatten, default)]
    pub extra: ExtraFields,
}

/// Current on-disk schema for `models.cache.json`.
pub const MODELS_CACHE_SCHEMA_VERSION: u32 = 1;

/// What `auth.json` persists from a models sync — enough to register the
/// provider offline on every subsequent startup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsCache {
    /// Independent from the server catalog version. Missing means legacy v0.
    #[serde(default)]
    pub schema_version: u32,
    pub synced_at: i64,
    pub response: ModelsResponse,
    #[serde(flatten, default)]
    pub extra: ExtraFields,
}

impl ModelsCache {
    pub fn new(synced_at: i64, response: ModelsResponse) -> Self {
        Self {
            schema_version: MODELS_CACHE_SCHEMA_VERSION,
            synced_at,
            response,
            extra: ExtraFields::new(),
        }
    }
}
