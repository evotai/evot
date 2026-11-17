//! Who learns from whom. Registered values go everywhere. A value one
//! request found goes to the rest of its session only. One-way scrubbing
//! also takes what requests masked. Nothing an upload scan finds flows back
//! into requests.
use evot::privacy::Masker;
use evot::privacy::PrivacySettings;
use evot_engine::provider::StreamConfig;
use evot_engine::types::Content;
use evot_engine::types::Message;
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;

const VALUE: &str = "Qm7vLx2pRt9wKz4n";

fn masker() -> Result<Masker, evot::base::error::EvotError> {
    Masker::new(&PrivacySettings::default(), [23; 32])
}

fn user(text: &str) -> Message {
    Message::User {
        content: vec![Content::Text { text: text.into() }],
        timestamp: 0,
        provenance: None,
    }
}

fn request(session: Option<&str>, text: &str) -> StreamConfig {
    StreamConfig {
        model: "fixture".into(),
        system_prompt: String::new(),
        messages: vec![user(text)],
        tools: vec![],
        thinking_level: Default::default(),
        api_key: "fixture".into(),
        max_tokens: None,
        model_config: None,
        cache_config: Default::default(),
        prompt_cache_key: session.map(str::to_string),
        client: None,
    }
}

/// What the provider would see of `text` sent in `session`.
fn sent(
    masker: &Masker,
    session: Option<&str>,
    text: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut config = request(session, text);
    masker.mask_request(&mut config)?;
    match &config.messages[0] {
        Message::User { content, .. } => match &content[0] {
            Content::Text { text } => Ok(text.clone()),
            _ => Err("not text".into()),
        },
        _ => Err("not a user message".into()),
    }
}

#[test]
fn a_sessions_findings_stay_in_that_session() -> TestResult {
    let masker = masker()?;
    let bare = format!("value {VALUE}");
    assert!(!sent(&masker, Some("a"), &format!("API_TOKEN={VALUE}"))?.contains(VALUE));
    // The rest of session a looks for it without context…
    assert!(!sent(&masker, Some("a"), &bare)?.contains(VALUE));
    // …another session, a fresh one after `/new`, and a request outside any
    // session do not.
    assert_eq!(sent(&masker, Some("b"), &bare)?, bare);
    assert_eq!(sent(&masker, None, &bare)?, bare);
    // A request outside any session keeps what it found to itself.
    assert!(!sent(&masker, None, &format!("API_TOKEN={VALUE}x"))?.contains(VALUE));
    assert_eq!(
        sent(&masker, None, &format!("value {VALUE}x"))?,
        format!("value {VALUE}x")
    );
    Ok(())
}

#[test]
fn registered_values_go_to_every_session() -> TestResult {
    let masker = masker()?;
    masker.remember_secret(VALUE);
    for session in [Some("a"), Some("b"), None] {
        assert!(!sent(&masker, session, &format!("echo {VALUE}"))?.contains(VALUE));
    }
    Ok(())
}

#[test]
fn upload_scans_never_teach_requests() -> TestResult {
    let masker = masker()?;
    let history = json!([
        {"role": "user", "content": [{"type": "text", "text": format!("API_TOKEN={VALUE}")}]}
    ]);
    let context = masker.upload_context(&history);
    // The later batch of that upload is scrubbed against its history…
    let mut batch =
        json!([{"role": "user", "content": [{"type": "text", "text": format!("again {VALUE}")}]}]);
    masker.scrub_with(&mut batch, Some(&context))?;
    assert!(!batch.to_string().contains(VALUE));
    // …but requests, in any session, and other uploads learned nothing.
    let bare = format!("value {VALUE}");
    assert_eq!(sent(&masker, Some("a"), &bare)?, bare);
    assert_eq!(sent(&masker, None, &bare)?, bare);
    let mut other = json!({ "text": bare });
    masker.scrub(&mut other)?;
    assert_eq!(other["text"], bare);
    Ok(())
}

#[test]
fn one_way_scrubbing_takes_what_requests_masked() -> TestResult {
    let masker = masker()?;
    sent(&masker, Some("a"), &format!("API_TOKEN={VALUE}"))?;
    // A reply delivered to a chat carries the restored value with no context.
    let mut delivery = json!(format!("done with {VALUE}"));
    masker.scrub(&mut delivery)?;
    assert!(!delivery.to_string().contains(VALUE));
    // A short, word-shaped finding is not taken out of context anywhere.
    sent(&masker, Some("a"), "password: hunter")?;
    let mut delivery = json!("hunter of the north");
    masker.scrub(&mut delivery)?;
    assert_eq!(delivery, json!("hunter of the north"));
    assert_eq!(
        sent(&masker, Some("a"), "hunter of the north")?,
        "hunter of the north"
    );
    Ok(())
}
