use serde::Deserialize;
use serde::Serialize;

/// Transport failures are not evidence that there is no plausible intent.
#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionStatus {
    Ready,
    #[default]
    Empty,
    Failed,
    Unavailable,
    TimedOut,
    /// The suggestion route rejected its credentials. Unlike `Failed`, this
    /// will not recover by retrying with the same key, so clients should tell
    /// the user once and stop automatic sampling until the key changes.
    Unauthorized,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct SuggestionOutcome {
    #[serde(default)]
    pub candidates: Vec<String>,
    #[serde(default)]
    pub status: SuggestionStatus,
}

impl SuggestionOutcome {
    pub fn status(status: SuggestionStatus) -> Self {
        Self {
            candidates: Vec::new(),
            status,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionMessage {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionCommand {
    pub name: String,
    pub description: String,
    pub usage: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct SuggestionImage {
    pub id: u64,
    pub media_type: String,
    pub data: String,
}

/// The composer draft beyond the transcript. Candidates form one fixed batch;
/// the deprecated rejected field remains readable/writable for older clients.
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct SuggestionHints {
    /// Explicit Tab may follow interruption or an empty session.
    #[serde(default, skip_serializing_if = "is_false")]
    pub explicit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    /// Optional workflow evidence; absent on legacy callers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<Box<super::workflow::SuggestionWorkflow>>,
    #[serde(default)]
    pub draft: Option<String>,
    /// Existing text after the caret. Presence requests replacement suffixes
    /// as a JSON array, so prefixes and candidates can contain line breaks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<SuggestionCommand>,
    /// Current draft attachments; absent in legacy requests.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<SuggestionImage>,
    /// Deprecated wire field; ignored by prediction and local cycling.
    #[serde(default)]
    pub rejected: Vec<String>,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl SuggestionHints {
    pub fn draft(&self) -> Option<&str> {
        self.draft
            .as_deref()
            .filter(|draft| !draft.trim().is_empty())
    }

    pub fn is_explicit(&self) -> bool {
        self.explicit || self.draft().is_some() || self.suffix.is_some()
    }
}

/// Addon contract. The legacy shape is a bare message array; the object shape
/// carries the same messages plus composer hints.
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum SuggestionRequest {
    Messages(Vec<SuggestionMessage>),
    Detailed {
        messages: Vec<SuggestionMessage>,
        #[serde(flatten)]
        hints: Box<SuggestionHints>,
    },
}

impl<'de> Deserialize<'de> for SuggestionRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        // Selecting by shape preserves useful nested errors (in particular an
        // unsupported workflow version) instead of untagged's generic error.
        if value.is_array() {
            return serde_json::from_value(value)
                .map(Self::Messages)
                .map_err(serde::de::Error::custom);
        }
        #[derive(Deserialize)]
        struct Detailed {
            messages: Vec<SuggestionMessage>,
            #[serde(flatten)]
            hints: SuggestionHints,
        }
        let detailed: Detailed = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self::Detailed {
            messages: detailed.messages,
            hints: Box::new(detailed.hints),
        })
    }
}

impl SuggestionRequest {
    pub fn into_parts(self) -> (Vec<SuggestionMessage>, SuggestionHints) {
        match self {
            Self::Messages(messages) => (messages, SuggestionHints::default()),
            Self::Detailed { messages, hints } => (messages, *hints),
        }
    }
}
