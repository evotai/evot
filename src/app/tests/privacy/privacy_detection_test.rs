//! Default detection is deliberately small: formats, explicit credential
//! contexts, and confirmed values. No command-output or entropy guessing.
use evot::privacy::Action;
use evot::privacy::Confidence;
use evot::privacy::Masker;
use evot::privacy::Pack;
use evot::privacy::PrivacySettings;
use evot::privacy::Target;
use evot_engine::provider::StreamConfig;
use evot_engine::types::Content;
use evot_engine::types::Message;
use evot_engine::types::StopReason;
use serde_json::json;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn masker() -> Result<Masker, evot::base::error::EvotError> {
    Masker::new(&PrivacySettings::default(), [19; 32])
}

fn config(messages: Vec<Message>) -> StreamConfig {
    StreamConfig {
        model: "fixture".into(),
        system_prompt: String::new(),
        messages,
        tools: vec![],
        thinking_level: Default::default(),
        api_key: "fixture".into(),
        max_tokens: None,
        model_config: None,
        cache_config: Default::default(),
        prompt_cache_key: None,
        client: None,
    }
}

/// A request of session `id`: findings carry over between its requests.
fn in_session(id: &str, messages: Vec<Message>) -> StreamConfig {
    StreamConfig {
        prompt_cache_key: Some(id.into()),
        ..config(messages)
    }
}

fn user(text: &str) -> Message {
    Message::User {
        content: vec![Content::Text { text: text.into() }],
        timestamp: 0,
        provenance: None,
    }
}

/// A Bash tool call and its result, as the model saw them.
fn bash_exchange(command: &str, output: &str) -> Vec<Message> {
    vec![
        Message::Assistant {
            content: vec![Content::ToolCall {
                id: "c".into(),
                name: "Bash".into(),
                arguments: json!({"command": command}),
                metadata: None,
            }],
            stop_reason: StopReason::Stop,
            model: "fixture".into(),
            provider: "fixture".into(),
            usage: Default::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        },
        Message::ToolResult {
            tool_call_id: "c".into(),
            tool_name: "Bash".into(),
            content: vec![Content::Text {
                text: output.into(),
            }],
            is_error: false,
            timestamp: 0,
            retention: Default::default(),
        },
    ]
}

fn placeholder_in(text: &str) -> Option<&str> {
    let start = text.find("{{")?;
    let end = text[start..].find("}}")? + start + 2;
    Some(&text[start..end])
}

fn first_text(message: &Message) -> &str {
    let content = match message {
        Message::User { content, .. }
        | Message::Assistant { content, .. }
        | Message::ToolResult { content, .. } => content,
    };
    content
        .iter()
        .find_map(|c| match c {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or_default()
}

#[test]
fn default_detection_has_only_two_small_explicit_rule_groups() -> TestResult {
    let packs = masker()?.packs();
    assert_eq!(
        packs
            .iter()
            .map(|p| (p.id.as_str(), p.rules))
            .collect::<Vec<_>>(),
        vec![("core", 0), ("formats", 16), ("contexts", 8),]
    );
    Ok(())
}

#[test]
fn every_default_rule_is_high_confidence_and_has_positive_and_negative_cases() -> TestResult {
    for text in [
        include_str!("../../src/privacy/rules/data/formats.json"),
        include_str!("../../src/privacy/rules/data/contexts.json"),
    ] {
        let pack: Pack = serde_json::from_str(&text.replace(evot::privacy::CUT, ""))?;
        for rule in pack.rules {
            assert_eq!(rule.confidence, Confidence::High, "{}", rule.id);
            // No default rule runs on every text: keywords prefilter them all.
            assert!(!rule.keywords.is_empty(), "{} needs keywords", rule.id);
            assert!(
                !rule.examples.matches.is_empty(),
                "{} needs positive cases",
                rule.id
            );
            assert!(
                !rule.examples.ignores.is_empty(),
                "{} needs negative cases",
                rule.id
            );
        }
        for field in pack.fields {
            assert_eq!(field.confidence, Confidence::High, "{}", field.id);
            assert!(!field.examples.matches.is_empty() && !field.examples.ignores.is_empty());
        }
    }
    Ok(())
}

#[test]
fn source_scoped_user_rules_remain_an_explicit_opt_in() -> TestResult {
    let pack: Pack = serde_json::from_value(json!({
        "schema_version": 1, "id": "local-env",
        "rules": [{"id": "local-env.color", "kind": "SECRET", "scope": "sensitive", "regex": "(?m)^COLOR=([A-Za-z0-9]+)$"}],
        "fields": [{"id": "local-env.custom-field", "kind": "SECRET", "key": "custom_credential", "text": true}]
    }))?;
    let masker = Masker::with_packs(&PrivacySettings::default(), [19; 32], &[pack])?;
    let value = "Zx8Ab9Cd7Ef6";
    let call = json!({"type": "tool_call", "id": "c", "name": "read", "input": {"path": ".env"}});
    let result =
        json!({"type": "tool_result", "tool_call_id": "c", "content": format!("COLOR={value}")});
    assert!(masker.inspect(&format!("COLOR={value}"), None).is_empty());
    let context = masker.upload_context(&json!([call, result]));
    let mut later_batch = json!([result]);
    masker.scrub_with(&mut later_batch, Some(&context))?;
    assert!(!later_batch.to_string().contains(value));
    assert!(!masker
        .inspect("custom_credential: abcd1234EFGH5678", None)
        .is_empty());
    Ok(())
}

#[test]
fn unknown_random_values_and_source_paths_are_not_credentials() -> TestResult {
    let masker = masker()?;
    for text in [
        "COLOR=abcd1234EFGH5678ijkl9012MNOP3456",
        "key=abcd1234EFGH5678ijkl9012MNOP3456",
        "token=abcd1234EFGH5678ijkl9012MNOP3456",
        "secret=abcd1234EFGH5678ijkl9012MNOP3456",
        "request_id=abcd1234EFGH5678ijkl9012MNOP3456",
        "Output: /Users/me/.evotai/sessions/s/tool-results/task-bash-output.txt",
        "zhipu 1234567890abcdef1234567890abcdef.AbCdEfGh12345678",
        "custom_sk_abcd1234EFGH5678ijkl9012MNOP3456",
        "?key=abcd1234EFGH5678ijkl9012MNOP3456",
        "密钥为 2048 位",
        "Bearer authentication is described here",
        "const tokenizer = new Tokenizer(options);",
        "password_hash: String;",
        "secret_name: production-database-credentials",
        "token = get_token()",
        "token: string;",
    ] {
        assert!(
            masker.inspect(text, None).is_empty(),
            "false positive: {text}"
        );
    }
    for field in [
        "key",
        "token",
        "secret",
        "request_id",
        "secret_name",
        "token_count",
        "api_key_id",
        "token_url",
    ] {
        assert!(
            masker
                .inspect("abcd1234EFGH5678ijkl9012MNOP3456", Some(field))
                .is_empty(),
            "field: {field}"
        );
    }
    Ok(())
}

#[test]
fn credential_contexts_mask_short_and_long_values_without_entropy_thresholds() -> TestResult {
    for (text, value) in [
        ("DB_PASSWORD=query", "query"),
        ("DB_PASSWORD=1234", "1234"),
        ("password: query", "query"),
        ("api_key: Zx8Ab9Cd7Ef6", "Zx8Ab9Cd7Ef6"),
        (r#"{"password": "string"}"#, "string"),
        (
            "DB_PASSWORD='long lowercase password'",
            "long lowercase password",
        ),
        ("api_key=abcdefghijklmnop", "abcdefghijklmnop"),
        ("postgres://user:query@db.internal/app", "query"),
        ("curl -s -u root:query https://example.org", "query"),
        ("Authorization: Bearer abcd1234EFGH5678", "abcd1234EFGH5678"),
        ("密码：Abc12345!", "Abc12345!"),
    ] {
        let masker = masker()?;
        let mut request = config(vec![user(text)]);
        let report = masker.mask_request(&mut request)?;
        assert!(!report.is_empty(), "missed: {text}");
        let masked = first_text(&request.messages[0]);
        assert!(!masked.contains(value), "sent credential: {text}");
        assert_eq!(masker.restore_text(masked, false), text);
        let mut upload = json!({"text": text});
        masker.scrub(&mut upload)?;
        assert!(
            !upload.to_string().contains(value),
            "uploaded credential: {text}"
        );
    }
    Ok(())
}

#[test]
fn discovered_short_passwords_do_not_poison_code_or_kind_labels() -> TestResult {
    let masker = masker()?;
    // A different short ordinary word must behave the same way: no word allowlist.
    for value in ["query", "build", "PASSWORD"] {
        let ordinary =
            format!("fn execute_{value}() {{ {value}.execute(); }}\nflight_sql_service/{value}.rs");
        let mut request = config(vec![
            user(&format!("DB_PASSWORD='{value}'")),
            user(&ordinary),
        ]);
        masker.mask_request(&mut request)?;
        assert!(
            !first_text(&request.messages[0]).contains(&format!("'{value}'")),
            "explicit context must mask"
        );
        assert_eq!(first_text(&request.messages[1]), ordinary);
        let record = masker
            .mask_request(&mut config(vec![user(&ordinary)]))?
            .record(Target::Llm);
        assert!(record.values.is_empty(), "short value escaped its context");
        let mut upload = json!({"text": format!("DB_PASSWORD='{value}'\n{ordinary}")});
        masker.scrub(&mut upload)?;
        assert!(upload["text"]
            .as_str()
            .is_some_and(|s| s.ends_with(&ordinary)));
    }
    Ok(())
}

#[test]
fn confirmed_long_values_still_mask_embedded_and_incremental_reappearances() -> TestResult {
    let masker = masker()?;
    let value = "Abc12345Zyx98765";
    let mut first = in_session("s", vec![user(&format!("DB_PASSWORD={value}"))]);
    masker.mask_request(&mut first)?;
    for text in [
        format!("prefix{value}suffix"),
        format!("https://example.org/x/{value}/y"),
    ] {
        let mut later = in_session("s", vec![user(&text)]);
        masker.mask_request(&mut later)?;
        assert!(!first_text(&later.messages[0]).contains(value));
        let mut upload = json!({"text": text});
        masker.scrub(&mut upload)?;
        assert!(!upload.to_string().contains(value));
    }
    // Explicitly registered real credentials do not depend on detection length.
    masker.remember_secret("q7Wx");
    let mut request = config(vec![user("use q7Wx")]);
    masker.mask_request(&mut request)?;
    assert!(!first_text(&request.messages[0]).contains("q7Wx"));
    Ok(())
}

#[test]
fn env_shebang_and_background_metadata_cannot_create_session_wide_secrets() -> TestResult {
    for command in [
        "cat > /tmp/run.py <<'PY'\n#!/usr/bin/env python3\nprint('done')\nPY\npython3 /tmp/run.py",
        "cat .env",
        "ssh -i ~/.ssh/id_ed25519 host 'cargo test'",
        "env",
    ] {
        let masker = masker()?;
        let path = "/Users/me/.evotai/sessions/s/tool-results/task-bash-output.txt";
        let output = format!(
            "Task ID: task\nOutput: {path}\nCOLOR=abcd1234EFGH5678\nDB_PASSWORD=Abc12345Zyx98765\n"
        );
        let mut request = config(bash_exchange(command, &output));
        let record = masker.mask_request(&mut request)?.record(Target::Llm);
        let masked = first_text(&request.messages[1]);
        assert!(
            masked.contains(path) && masked.contains("COLOR=abcd1234EFGH5678"),
            "{command}"
        );
        assert!(!masked.contains("Abc12345Zyx98765"), "{command}");
        assert_eq!(record.values.len(), 1, "{command}");
        assert!(record
            .values
            .iter()
            .all(|v| v.rule.as_deref() == Some("contexts.password-assignment")));
        let mut later = config(vec![user(path)]);
        assert!(masker.mask_request(&mut later)?.is_empty());
    }
    Ok(())
}

#[test]
fn password_contexts_report_the_password_kind() -> TestResult {
    let value = "Zx8vAb9q";
    let mut settings = PrivacySettings::default();
    settings.actions.insert("PASSWORD".into(), Action::Block);
    let blocking = Masker::new(&settings, [19; 32])?;
    for text in [
        format!("DB_PASSWORD={value}"),
        format!("--password={value}"),
        format!("db-password: {value}"),
        format!("密码：{value}"),
        format!("postgres://app:{value}@db.internal/x"),
    ] {
        let report = blocking.mask_request(&mut config(vec![user(&text)]))?;
        assert!(report.blocked(), "a PASSWORD action must cover: {text}");
    }
    assert_eq!(masker()?.inspect(value, Some("dbPassword")).kinds(), vec![
        "PASSWORD".to_string()
    ]);

    // One password, one placeholder, whichever context revealed it.
    let masker = masker()?;
    let mut request = config(vec![
        user(&format!("DB_PASSWORD={value}")),
        user(&format!("postgres://app:{value}@db.internal/x")),
    ]);
    masker.mask_request(&mut request)?;
    let first = placeholder_in(first_text(&request.messages[0])).ok_or("not masked")?;
    let second = placeholder_in(first_text(&request.messages[1])).ok_or("not masked")?;
    assert!(first.starts_with("{{PASSWORD_"), "{first}");
    assert_eq!(first, second);
    Ok(())
}

#[test]
fn credential_names_match_in_any_naming_style() -> TestResult {
    let value = "Zx8vAb9qLm3n";
    for text in [
        format!("--password={value}"),
        format!("db-password: {value}"),
        format!("dbPassword = \"{value}\""),
        format!("spring.datasource.password={value}"),
        format!("X-Api-Key: {value}"),
        format!("client-secret: {value}"),
        format!("authToken: {value}"),
        format!("--access-token={value}"),
    ] {
        let masker = masker()?;
        let mut request = config(vec![user(&text)]);
        assert!(
            !masker.mask_request(&mut request)?.is_empty(),
            "missed: {text}"
        );
        assert!(!first_text(&request.messages[0]).contains(value), "{text}");
    }
    for text in [
        "if password == expected",
        "password_length: 16",
        "password_hash: abc123def456",
        "Password reset link sent",
    ] {
        assert!(
            masker()?.inspect(text, None).is_empty(),
            "false positive: {text}"
        );
    }
    Ok(())
}

#[test]
fn url_passwords_holding_an_at_sign_are_masked_whole() -> TestResult {
    let masker = masker()?;
    let text = "mysql://root:p@ss9word@db.internal/app";
    let mut request = config(vec![user(text)]);
    masker.mask_request(&mut request)?;
    let masked = first_text(&request.messages[0]);
    assert!(!masked.contains("ss9word"), "{masked}");
    assert!(
        masked.starts_with("mysql://root:{{PASSWORD_") && masked.ends_with("}}@db.internal/app")
    );
    assert_eq!(masker.restore_text(masked, false), text);
    assert!(masker
        .inspect("https://github.com:443/org/repo@main", None)
        .is_empty());
    Ok(())
}

#[test]
fn sensitive_scoped_user_rules_ignore_shebangs_and_comments() -> TestResult {
    let pack: Pack = serde_json::from_value(json!({
        "schema_version": 1, "id": "local-env",
        "rules": [{"id": "local-env.color", "kind": "SECRET", "scope": "sensitive", "keywords": ["color="], "regex": "(?m)^COLOR=([A-Za-z0-9]+)$"}]
    }))?;
    let output = "COLOR=Zx8vAb9qLm3n\n";
    for (command, sensitive) in [
        ("cat > /tmp/run.py <<'PY'\n#!/usr/bin/env python3\nprint('done')\nPY\npython3 /tmp/run.py", false),
        ("# cat .env\ncargo test", false),
        ("cat .env", true),
        ("grep '#' .env", true),
        ("cargo test # cat .env", true),
    ] {
        let masker = Masker::with_packs(&PrivacySettings::default(), [19; 32], std::slice::from_ref(&pack))?;
        let mut request = config(bash_exchange(command, output));
        masker.mask_request(&mut request)?;
        let masked = first_text(&request.messages[1]);
        assert_eq!(!masked.contains("Zx8vAb9qLm3n"), sensitive, "{command}");
    }
    Ok(())
}

/// Code names a credential far more often than it holds one. A reference,
/// a type, a call argument or a sentence after a credential name is not a
/// value, whatever the language; only a literal is.
#[test]
fn code_and_prose_after_a_credential_name_are_not_values() -> TestResult {
    let samples = [
        // JavaScript / TypeScript
        "const headers = { 'x-api-key': this.apiKey, 'content-type': 'application/json' };",
        "const client = new Client({ apiKey: options.apiKey, model });",
        "if (apiKey === storedKey) {",
        "  authToken: AuthToken",
        "  apiKey?: string;",
        "  refreshToken: Promise<string>;",
        // Rust
        "    password: hashed_password,",
        "fn connect(password: &str) -> Result<()> {",
        "let perf_query_token = self.next_query_token();",
        "    secret_key: Option<SecretString>,",
        "let token = ctx.token.clone();",
        "    access_token = refresh_token",
        "let client_secret = config::client_secret();",
        // Go
        "\tc.WebhookToken = c.APIToken",
        "\tSecretKey  string // APP_SECRET_KEY: encrypts connector secrets at rest",
        "\tPassword string `json:\"password\"`",
        // Python
        "client = Client(api_key=api_key, timeout=30)",
        "    connect(host, password=pw)",
        "api_key = os.environ[\"API_KEY\"]",
        "token = request.headers.get(\"X-Token\")",
        // Documentation and comments
        "Pass it as ?token=..., an Authorization: Bearer header, or X-Webhook-Secret.",
        "# Clients send \"Authorization: Bearer <token>\".",
        "// DB_PASSWORD: required when the database has authentication enabled",
        "export API_TOKEN=\"$(cat ~/.config/token)\"",
    ];
    for text in samples {
        let masker = masker()?;
        assert!(
            masker.inspect(text, None).is_empty(),
            "false positive: {text}"
        );
        // Nothing is learned from them either: the same names stay intact
        // in the rest of the session.
        let mut request = in_session("code", vec![user(text), user(&format!("again: {text}"))]);
        assert!(masker.mask_request(&mut request)?.is_empty(), "{text}");
        assert_eq!(first_text(&request.messages[0]), text);
    }
    Ok(())
}

/// The other side of the same grammar: a literal after a credential name is
/// a value in every language and config format, and so is an unquoted value
/// that ends its line, a tight `--flag=value` or a quoted header.
#[test]
fn literal_credentials_in_code_config_and_commands_are_masked() -> TestResult {
    let value = "Zx8vAb9qLm3n";
    let short = "hunter";
    for text in [
        format!("const DB_PASSWORD: &str = \"{value}\";"),
        format!("password := \"{value}\""),
        format!("let apiKey = '{value}';"),
        format!("client = Client(api_key=\"{value}\")"),
        format!("const client = new Client({{ apiKey: \"{value}\", model }});"),
        format!("val authToken: String = \"{value}\""),
        format!("curl -H \"X-Api-Key: {value}\" https://api.example.org"),
        format!("curl -H 'Authorization: Bearer {value}' https://api.example.org"),
        format!("DB_PASSWORD={value} ./migrate"),
        format!("mysql --password={value} -h db.internal"),
        format!("API_TOKEN={value}  # production"),
        format!("SECRET_KEY={value}"),
        format!("  client_secret: {value}"),
        format!("{{\"password\": \"{value}\"}}"),
        format!("here is the password: {value}"),
        format!("config:\n  access_token: {value}\n  region: eu-west-1"),
        format!("Authorization: Bearer {value}"),
        // Short and alphabetic values still count in a credential context.
        format!("  password: {short}"),
        format!("password = {short}"),
        format!("DB_PASSWORD='{short}'"),
    ] {
        let secret = if text.contains(short) { short } else { value };
        let masker = masker()?;
        let mut request = config(vec![user(&text)]);
        assert!(
            !masker.mask_request(&mut request)?.is_empty(),
            "missed: {text}"
        );
        let masked = first_text(&request.messages[0]);
        assert!(!masked.contains(secret), "sent: {text}");
        assert_eq!(masker.restore_text(masked, false), text);
        let mut upload = json!({ "text": text });
        masker.scrub(&mut upload)?;
        assert!(!upload.to_string().contains(secret), "uploaded: {text}");
    }
    Ok(())
}

/// A value found by its context is looked for elsewhere only when no word,
/// name, path, version or date reads like it. Shapes, not words: each of
/// these is masked where its context says so and nowhere else.
#[test]
fn only_opaque_values_are_looked_for_beyond_their_context() -> TestResult {
    let masker = masker()?;
    for value in [
        "CorrectHorseBatteryStaple",
        "nightly-2026-10-25",
        "release_cache_v2",
        "2026-11-17T10:00:00",
        "src/query/service.rs",
        "base64Encode",
        "12345678901234",
    ] {
        let elsewhere = format!("see {value} and x{value}y");
        let mut request = in_session("shapes", vec![
            user(&format!("password: {value}")),
            user(&elsewhere),
        ]);
        masker.mask_request(&mut request)?;
        assert!(
            !first_text(&request.messages[0]).contains(value),
            "context must mask: {value}"
        );
        assert_eq!(first_text(&request.messages[1]), elsewhere, "{value}");
    }
    for value in [
        "Zx8vAb9qLm3n",
        "p@ss-w0rd!",
        "Abc12345Zyx98765",
        "dXNlcjpwYXNzd29yZA==",
    ] {
        let elsewhere = format!("see {value} here");
        let mut request = in_session("shapes", vec![
            user(&format!("password: {value}")),
            user(&elsewhere),
        ]);
        masker.mask_request(&mut request)?;
        assert!(
            !first_text(&request.messages[1]).contains(value),
            "opaque value escaped: {value}"
        );
    }
    Ok(())
}
