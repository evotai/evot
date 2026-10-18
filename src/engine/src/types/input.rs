//! Input provenance is independent of transport roles: providers still see a
//! user message, while presentation can distinguish authored and runtime blocks.
use serde::Deserialize;
use serde::Serialize;

pub const INPUT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum InputSource {
    User,
    Runtime {
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "InputProvenanceWire")]
pub struct InputProvenance {
    pub schema_version: u32,
    /// One source per content block, in the original order.
    pub sources: Vec<InputSource>,
}

#[derive(Deserialize)]
struct InputProvenanceWire {
    #[serde(default)]
    schema_version: u32,
    sources: Vec<InputSource>,
}

impl TryFrom<InputProvenanceWire> for InputProvenance {
    type Error = String;

    fn try_from(value: InputProvenanceWire) -> Result<Self, Self::Error> {
        if value.schema_version > INPUT_SCHEMA_VERSION {
            return Err(format!(
                "unsupported input provenance schema version {}",
                value.schema_version
            ));
        }
        Ok(Self {
            schema_version: value.schema_version,
            sources: value.sources,
        })
    }
}

impl InputProvenance {
    pub fn new(sources: Vec<InputSource>) -> Self {
        Self {
            schema_version: INPUT_SCHEMA_VERSION,
            sources,
        }
    }

    pub fn runtime(blocks: usize, kind: impl Into<String>, display: Option<String>) -> Self {
        Self::new(vec![
            InputSource::Runtime {
                kind: kind.into(),
                display
            };
            blocks
        ])
    }
}
