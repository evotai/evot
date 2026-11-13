//! ACP clients validate saved model IDs against session options before asking
//! the agent to switch. Exercise both published cloud catalog group shapes.

use agent_client_protocol_schema::v1 as acp;
use evot::agent::ToolMode;
use evot::conf::Config;
use evot::conf::Protocol;
use evot_engine::provider::MockProvider;
use serde_json::json;
use serde_json::Value;
use tempfile::TempDir;

use super::acp_test::config;
use super::acp_test::text_prompt;
use super::acp_test::Client;
use super::acp_test::TestResult;

fn cloud_config(tmp: &TempDir, provider: &str, protocol: Protocol) -> Config {
    let mut config = config(tmp);
    let mut profile = config.providers["test"].clone();
    config.providers.clear();
    profile.protocol = protocol;
    profile.models = vec!["default-model".into(), "evot-fast".into()];
    config.providers.insert(provider.into(), profile);
    config.cloud_providers.insert(provider.into());
    config.llm.provider = provider.into();
    config
}

fn choices(response: &Value) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    // Read with the existing ACP v1 schema too, not only ad-hoc JSON access.
    let _: acp::NewSessionResponse = serde_json::from_value(response["result"].clone())?;
    response["result"]["configOptions"][0]["options"]
        .as_array()
        .ok_or_else(|| "missing model options".into())
        .and_then(|options| {
            options
                .iter()
                .map(|option| {
                    option["value"]
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "missing model value".into())
                })
                .collect()
        })
}

async fn switch_saved_choice(
    tmp: &TempDir,
    config: Config,
    saved_spec: &str,
    canonical_spec: &str,
) -> TestResult {
    let (mut client, agent) =
        Client::start_config(tmp, config, ToolMode::Chat, false, MockProvider::text("ok"))?;
    let (response, _) = client
        .request("session/new", json!({"cwd": tmp.path(), "mcpServers": []}))
        .await?;
    let values = choices(&response)?;
    // This is the check T3 performs before session/set_config_option.
    assert!(values.iter().any(|value| value == saved_spec), "{values:?}");
    assert!(
        values.iter().any(|value| value == canonical_spec),
        "{values:?}"
    );
    let unique: std::collections::HashSet<_> = values.iter().collect();
    assert_eq!(values.len(), unique.len(), "duplicate choices: {values:?}");
    let session_id = response["result"]["sessionId"]
        .as_str()
        .ok_or("sessionId")?;
    let (response, _) = client
        .request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": "model", "value": saved_spec}),
        )
        .await?;
    let _: acp::SetSessionConfigOptionResponse =
        serde_json::from_value(response["result"].clone())?;
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"],
        canonical_spec
    );
    // Legacy choices still exist after selecting, so the next turn validates.
    assert!(response["result"]["configOptions"][0]["options"]
        .as_array()
        .ok_or("options")?
        .iter()
        .any(|option| option["value"] == saved_spec));
    assert_eq!(agent.llm().model, "default-model");

    let (response, _) = client
        .request("session/prompt", text_prompt(session_id, "hello"))
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    let mut meta = agent.sessions().find(session_id).await?.ok_or("session")?;
    assert_eq!(format!("{}:{}", meta.provider, meta.model), canonical_spec);

    // A session actually saved under the historical name must also resume
    // with both choices available; fixing only session/new is insufficient.
    let (saved_provider, saved_model) = saved_spec.split_once(':').ok_or("saved spec")?;
    meta.provider = saved_provider.to_string();
    meta.model = saved_model.to_string();
    agent.storage().save_session(meta).await?;
    let (response, _) = client
        .request("session/close", json!({"sessionId": session_id}))
        .await?;
    assert!(response.get("result").is_some(), "{response}");
    let (response, _) = client
        .request(
            "session/resume",
            json!({"sessionId": session_id, "cwd": tmp.path(), "mcpServers": []}),
        )
        .await?;
    let _: acp::ResumeSessionResponse = serde_json::from_value(response["result"].clone())?;
    assert_eq!(
        response["result"]["configOptions"][0]["currentValue"],
        canonical_spec
    );
    assert!(response["result"]["configOptions"][0]["options"]
        .as_array()
        .ok_or("options")?
        .iter()
        .any(|option| option["value"] == saved_spec));
    client.close().await
}

#[tokio::test]
async fn tier_named_choice_survives_split_cloud_group() -> TestResult {
    let tmp = TempDir::new()?;
    switch_saved_choice(
        &tmp,
        cloud_config(&tmp, "evot-pro-anthropic", Protocol::Anthropic),
        "evot-pro:evot-fast",
        "evot-pro-anthropic:evot-fast",
    )
    .await
}

#[tokio::test]
async fn split_choice_survives_tier_named_cloud_group() -> TestResult {
    let tmp = TempDir::new()?;
    let mut config = cloud_config(&tmp, "evot-pro", Protocol::Anthropic);
    // A mixed tier's aliases must use each model's protocol, not the group's.
    config
        .cloud_model_protocols
        .insert("evot-fast".into(), Protocol::OpenAi);
    switch_saved_choice(
        &tmp,
        config,
        "evot-pro-openai:evot-fast",
        "evot-pro:evot-fast",
    )
    .await
}

#[tokio::test]
async fn overlapping_cloud_groups_advertise_only_one_resolvable_alias() -> TestResult {
    let tmp = TempDir::new()?;
    let mut config = cloud_config(&tmp, "evot-pro-anthropic", Protocol::Anthropic);
    let mut other = config.providers["evot-pro-anthropic"].clone();
    other.protocol = Protocol::OpenAi;
    config.providers.insert("evot-pro-openai".into(), other);
    config.cloud_providers.insert("evot-pro-openai".into());
    switch_saved_choice(
        &tmp,
        config,
        "evot-pro:evot-fast",
        "evot-pro-anthropic:evot-fast",
    )
    .await
}

#[tokio::test]
async fn unavailable_models_are_not_advertised_or_resolved_as_aliases() -> TestResult {
    let tmp = TempDir::new()?;
    let config = cloud_config(&tmp, "evot-pro-anthropic", Protocol::Anthropic);
    let (mut client, _) = Client::start_config(
        &tmp,
        config,
        ToolMode::Chat,
        false,
        MockProvider::text("ok"),
    )?;
    let (response, _) = client
        .request("session/new", json!({"cwd": tmp.path(), "mcpServers": []}))
        .await?;
    let values = choices(&response)?;
    assert!(!values.iter().any(|value| value == "evot-pro:retired-model"));
    let session_id = response["result"]["sessionId"]
        .as_str()
        .ok_or("sessionId")?;
    let (response, _) = client
        .request(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": "model", "value": "evot-pro:retired-model"}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32602, "{response}");
    client.close().await
}

#[tokio::test]
async fn byok_provider_names_do_not_get_cloud_aliases() -> TestResult {
    let tmp = TempDir::new()?;
    let mut config = cloud_config(&tmp, "evot-pro-anthropic", Protocol::Anthropic);
    config.cloud_providers.clear();
    let (mut client, _) = Client::start_config(
        &tmp,
        config,
        ToolMode::Chat,
        false,
        MockProvider::text("ok"),
    )?;
    let (response, _) = client
        .request("session/new", json!({"cwd": tmp.path(), "mcpServers": []}))
        .await?;
    assert_eq!(choices(&response)?, [
        "evot-pro-anthropic:default-model",
        "evot-pro-anthropic:evot-fast",
    ]);
    client.close().await
}

#[tokio::test]
async fn configured_provider_owns_its_name_instead_of_aliasing() -> TestResult {
    let tmp = TempDir::new()?;
    let mut config = cloud_config(&tmp, "evot-pro-anthropic", Protocol::Anthropic);
    let mut byok = config.providers["evot-pro-anthropic"].clone();
    byok.models = vec!["user-model".into()];
    config.providers.insert("evot-pro".into(), byok);
    let (mut client, _) = Client::start_config(
        &tmp,
        config,
        ToolMode::Chat,
        false,
        MockProvider::text("ok"),
    )?;
    let (response, _) = client
        .request("session/new", json!({"cwd": tmp.path(), "mcpServers": []}))
        .await?;
    let values = choices(&response)?;
    assert!(values.iter().any(|value| value == "evot-pro:user-model"));
    assert!(!values.iter().any(|value| value == "evot-pro:evot-fast"));
    client.close().await
}

#[tokio::test]
async fn alias_does_not_override_literal_model_id_with_colon() -> TestResult {
    let tmp = TempDir::new()?;
    let mut config = cloud_config(&tmp, "evot-pro-anthropic", Protocol::Anthropic);
    let mut byok = config.providers["evot-pro-anthropic"].clone();
    byok.models = vec!["evot-pro:evot-fast".into()];
    config.providers.insert("custom".into(), byok);
    let (mut client, _) = Client::start_config(
        &tmp,
        config,
        ToolMode::Chat,
        false,
        MockProvider::text("ok"),
    )?;
    let (response, _) = client
        .request("session/new", json!({"cwd": tmp.path(), "mcpServers": []}))
        .await?;
    let values = choices(&response)?;
    assert!(values
        .iter()
        .any(|value| value == "custom:evot-pro:evot-fast"));
    assert!(!values.iter().any(|value| value == "evot-pro:evot-fast"));
    client.close().await
}
