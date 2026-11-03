//! Tests for compute machines: discovery parsing, probe parsing, field
//! validation, and the `compute.json` contract.

use evot::compute::alias;
use evot::compute::discover;
use evot::compute::probe;
use evot::compute::store;
use evot::compute::CheckStatus;
use evot::compute::ComputeService;
use evot::compute::MachineCheck;
use evot::compute::MachinePatch;
use evot::compute::MachineProfile;
use evot::compute::NewMachine;
use evot::compute::ProbeResult;
use evot::compute::COMPUTE_SCHEMA_VERSION;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

const NOW: i64 = 1_800_000_000;

fn new_machine(name: &str, target: &str) -> NewMachine {
    NewMachine {
        name: name.into(),
        ssh_target: target.into(),
        description: "Rust builds and tests".into(),
        ..NewMachine::default()
    }
}

// ---------------------------------------------------------------------------
// ssh config
// ---------------------------------------------------------------------------

#[test]
fn ssh_config_reads_aliases_and_skips_patterns() {
    let config = discover::parse_ssh_config(
        "Host db0-aws\n  HostName 3.14.81.203\n  User ubuntu\n\nHost *\n  ServerAliveInterval 30\nHost github.com gh\n  HostName=github.com\nMatch host foo\n  User nobody\nInclude config.d/*\n",
    );
    let aliases: Vec<&str> = config.hosts.iter().map(|h| h.alias.as_str()).collect();
    assert_eq!(aliases, vec!["db0-aws", "github.com", "gh"]);
    assert_eq!(config.hosts[0].host_name, "3.14.81.203");
    assert_eq!(config.hosts[0].user, "ubuntu");
    assert_eq!(config.hosts[2].host_name, "github.com");
    assert_eq!(config.includes, vec!["config.d/*"]);
}

#[test]
fn ssh_config_includes_are_followed() -> Result {
    let home = tempfile::tempdir()?;
    let ssh = home.path().join(".ssh");
    std::fs::create_dir_all(ssh.join("config.d"))?;
    std::fs::write(ssh.join("config"), "Include config.d/*.conf\nHost main\n")?;
    std::fs::write(
        ssh.join("config.d/work.conf"),
        "Host build-box\n  HostName 10.0.0.5\n",
    )?;
    std::fs::write(ssh.join("config.d/skip.txt"), "Host ignored\n")?;
    let scan = discover::scan_local(home.path(), None, &Default::default())?;
    let aliases: Vec<&str> = scan.config_hosts.iter().map(|h| h.alias.as_str()).collect();
    assert_eq!(aliases, vec!["build-box", "main"]);
    Ok(())
}

// ---------------------------------------------------------------------------
// shell history
// ---------------------------------------------------------------------------

#[test]
fn ssh_targets_from_commands() {
    let cases = [
        ("ssh ubuntu@3.15.73.38", Some("ubuntu@3.15.73.38")),
        (
            "ssh -i ~/.ssh/key -p 2222 ubuntu@10.0.0.1 uptime",
            Some("ubuntu@10.0.0.1"),
        ),
        ("ssh -l root box", Some("root@box")),
        ("ssh -tt -o StrictHostKeyChecking=no gpu-1", Some("gpu-1")),
        ("ssh -- host-a", Some("host-a")),
        ("ssh git@github.com", None),
        ("ssh -T git@gitlab.com", None),
        ("ssh localhost", None),
        ("ssh $HOST", None),
        ("ssh-keygen -t ed25519", None),
        ("ssh -v", None),
        ("ssh -oProxyCommand=x -- -evil", None),
        ("ssh ssh://user@host", None),
    ];
    for (command, expected) in cases {
        assert_eq!(
            discover::ssh_target_from_command(command).as_deref(),
            expected,
            "{command}"
        );
    }
}

#[test]
fn history_formats_yield_targets_and_times() {
    let zsh = ": 1700000000:0;ssh ubuntu@3.15.73.38\n: 1700000100:0;cd x && ssh box1\n: 1700000200:0;git push\n";
    let hits = discover::parse_history(zsh);
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].target, "ubuntu@3.15.73.38");
    assert_eq!(hits[0].at, Some(1_700_000_000));
    assert_eq!(hits[1].target, "box1");

    let bash = "#1700000300\nsudo ssh admin@web\nls\nssh web2\n";
    let hits = discover::parse_history(bash);
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].target, "admin@web");
    assert_eq!(hits[0].at, Some(1_700_000_300));
    assert_eq!(hits[1].at, None);

    let fish = "- cmd: ssh fishbox\n  when: 1700000400\n- cmd: echo hi\n  when: 1700000500\n";
    let hits = discover::parse_history(fish);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].target, "fishbox");
    assert_eq!(hits[0].at, Some(1_700_000_400));
}

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------

fn scan(config: &str, history: &str) -> discover::LocalScan {
    discover::LocalScan {
        config_hosts: discover::parse_ssh_config(config).hosts,
        history: discover::parse_history(history),
    }
}

#[test]
fn rank_merges_history_into_aliases_and_orders_by_use() {
    let mut history = String::new();
    for i in 0..20 {
        history.push_str(&format!(": {}:0;ssh ubuntu@3.15.73.38\n", NOW - 3600 - i));
    }
    for _ in 0..3 {
        history.push_str(": 1600000000:0;ssh ubuntu@3.14.81.203\n");
    }
    history.push_str(": 1600000000:0;ssh old@18.190.99.38\n");
    let scan = scan(
        "Host db0-aws\n  HostName 3.14.81.203\n  User ubuntu\nHost github.com\n",
        &history,
    );
    let ranked = discover::rank(&scan, &[], &[], NOW);
    let targets: Vec<&str> = ranked.iter().map(|c| c.target.as_str()).collect();
    assert_eq!(targets, vec![
        "ubuntu@3.15.73.38",
        "db0-aws",
        "old@18.190.99.38"
    ]);
    assert_eq!(ranked[0].connections, 20);
    assert_eq!(ranked[0].sources, vec!["shell_history"]);
    assert_eq!(ranked[0].last_used, Some(NOW - 3600));
    assert_eq!(ranked[1].connections, 3);
    assert_eq!(ranked[1].sources, vec!["ssh_config", "shell_history"]);
    assert_eq!(ranked[1].warning, "name suggests a database");
}

#[test]
fn rank_drops_machines_already_added() {
    let scan = scan(
        "Host db0-aws\n  HostName 3.14.81.203\n",
        ": 1:0;ssh ubuntu@3.15.73.38\n: 1:0;ssh other\n",
    );
    let existing = vec![
        "ubuntu@3.15.73.38".to_string(),
        "ubuntu@3.14.81.203".to_string(),
    ];
    let ranked = discover::rank(&scan, &[], &existing, NOW);
    let targets: Vec<&str> = ranked.iter().map(|c| c.target.as_str()).collect();
    assert_eq!(targets, vec!["other"]);
}

#[test]
fn tailscale_peers_join_or_add_candidates() {
    let status = r#"{
      "BackendState": "Running",
      "Peer": {
        "a": {"HostName": "build", "DNSName": "build.tail1.ts.net.", "Online": true, "OS": "linux"},
        "b": {"HostName": "phone", "DNSName": "phone.tail1.ts.net.", "Online": true, "OS": "iOS"},
        "c": {"HostName": "gone", "DNSName": "gone.tail1.ts.net.", "Online": false, "OS": "linux"},
        "d": {"HostName": "box", "DNSName": "box.tail1.ts.net.", "Online": true, "OS": "linux"}
      }
    }"#;
    let peers = discover::parse_tailscale_status(status);
    let names: Vec<&str> = peers.iter().map(|p| p.dns_name.as_str()).collect();
    assert_eq!(names, vec!["box.tail1.ts.net", "build.tail1.ts.net"]);

    let scan = scan("", ": 1:0;ssh me@build.tail1.ts.net\n");
    let ranked = discover::rank(&scan, &peers, &[], NOW);
    assert_eq!(ranked[0].target, "me@build.tail1.ts.net");
    assert_eq!(ranked[0].sources, vec!["shell_history", "tailscale"]);
    assert_eq!(ranked[1].target, "box.tail1.ts.net");
    assert!(discover::parse_tailscale_status(r#"{"BackendState":"Stopped"}"#).is_empty());
}

#[test]
fn caution_flags_database_and_production_names() {
    assert_eq!(discover::caution(&["db0-aws"]), "name suggests a database");
    assert_eq!(
        discover::caution(&["web-prod-2"]),
        "name suggests production"
    );
    assert_eq!(discover::caution(&["dbt-runner", "big-1"]), "");
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

#[test]
fn probe_output_parses_profile_only_when_complete() {
    let out = "os=Ubuntu 24.04 LTS\narch=x86_64\ncpus=64\nmem_gb=126\ntool=git\ntool=cargo\ntool=rm\ntool=git\ntool=tmux\nprobe=ok\n";
    let profile = probe::parse_probe_output(out);
    assert_eq!(
        profile,
        Some(MachineProfile {
            os: "Ubuntu 24.04 LTS".into(),
            arch: "x86_64".into(),
            cpus: 64,
            mem_gb: 126,
            tools: vec!["git".into(), "cargo".into(), "tmux".into()],
        })
    );
    assert_eq!(probe::parse_probe_output("os=Linux\ncpus=4\n"), None);
}

#[test]
fn probe_script_has_no_single_quotes() {
    assert!(!probe::probe_script().contains('\''));
}

#[cfg(unix)]
#[test]
fn probe_script_runs_under_local_sh() -> Result {
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(probe::probe_script())
        .output()?;
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let profile = probe::parse_probe_output(&stdout).ok_or("probe did not complete")?;
    assert!(profile.cpus > 0, "{stdout}");
    assert!(profile.mem_gb > 0, "{stdout}");
    assert!(!profile.os.is_empty());
    assert!(!profile.arch.is_empty());
    Ok(())
}

#[test]
fn ssh_failures_are_classified() {
    let cases = [
        ("ssh: connect to host 1.2.3.4 port 22: Operation timed out", CheckStatus::Unreachable),
        ("ssh: Could not resolve hostname nope: nodename nor servname provided", CheckStatus::Unreachable),
        ("ubuntu@1.2.3.4: Permission denied (publickey).", CheckStatus::Auth),
        ("No ED25519 host key is known for x and you have requested strict checking.\nHost key verification failed.", CheckStatus::NeedsTrust),
        ("@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n", CheckStatus::HostKeyChanged),
        ("something odd", CheckStatus::Error),
    ];
    for (stderr, expected) in cases {
        assert_eq!(probe::classify_failure(stderr).0, expected, "{stderr}");
    }
    assert_eq!(
        probe::classify_failure("ssh: connect to host 1.2.3.4 port 22: Connection refused").1,
        "ssh: connect to host 1.2.3.4 port 22: Connection refused"
    );
}

#[tokio::test]
async fn probe_rejects_option_like_targets() {
    assert!(probe::probe("-oProxyCommand=touch /tmp/x").await.is_err());
    assert!(probe::probe("a b").await.is_err());
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

#[test]
fn field_validation() {
    use evot::compute::validate;
    assert!(validate::name("big-1").is_ok());
    assert!(validate::name("-x").is_err());
    assert!(validate::name("a/b").is_err());
    assert!(validate::name(&"x".repeat(33)).is_err());
    assert!(validate::ssh_target("user@[fe80::1%en0]").is_ok());
    assert!(validate::ssh_target("a;rm -rf").is_err());
    assert!(validate::ssh_target("a@b@c").is_err());
    assert!(validate::description("   ").is_err());
    assert!(validate::description(&"字".repeat(300)).is_ok());
    assert!(validate::description(&"字".repeat(301)).is_err());
}

// ---------------------------------------------------------------------------
// store contract
// ---------------------------------------------------------------------------

fn fixture(name: &str) -> Result<String> {
    Ok(std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/schema")
            .join(name),
    )?)
}

#[test]
fn legacy_v0_document_reads_with_defaults() -> Result {
    let document = store::parse_document(&fixture("compute-v0.json")?)?;
    assert_eq!(document.version, COMPUTE_SCHEMA_VERSION);
    let machine = &document.machines[0];
    assert_eq!(machine.name, "big-1");
    assert!(machine.enabled);
    assert_eq!(machine.description, "");
    assert_eq!(machine.profile, None);
    Ok(())
}

#[test]
fn v1_document_reads_every_field() -> Result {
    let document = store::parse_document(&fixture("compute-v1.json")?)?;
    let machine = &document.machines[0];
    assert!(!machine.enabled);
    assert_eq!(machine.profile.as_ref().map(|p| p.cpus), Some(64));
    assert_eq!(
        machine.last_check.as_ref().map(|c| c.status),
        Some(CheckStatus::HostKeyChanged)
    );
    Ok(())
}

#[test]
fn unknown_check_status_reads_as_error() -> Result {
    let document = store::parse_document(
        r#"{"version":1,"machines":[{"id":"x","name":"a","ssh_target":"a","last_check":{"status":"brand_new"}}]}"#,
    )?;
    assert_eq!(
        document.machines[0].last_check.as_ref().map(|c| c.status),
        Some(CheckStatus::Error)
    );
    Ok(())
}

#[test]
fn future_schema_is_rejected() {
    let error = store::parse_document(r#"{"version":99,"machines":[]}"#);
    assert!(error.is_err());
    let text = error.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(text.contains("update evot"), "{text}");
}

/// The fields a v1 reader requires. Writer output must satisfy it exactly.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct StrictV1Document {
    version: u32,
    machines: Vec<StrictV1Machine>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct StrictV1Machine {
    id: String,
    name: String,
    ssh_target: String,
    description: String,
    enabled: bool,
    profile: Option<serde_json::Value>,
    last_check: Option<serde_json::Value>,
    created_at: String,
    updated_at: String,
}

#[tokio::test]
async fn writer_output_matches_strict_v1_reader() -> Result {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("compute.json");
    let service = ComputeService::new(path.clone());
    service
        .create(new_machine("big-1", "ubuntu@3.15.73.38"))
        .await?;
    let written: StrictV1Document = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    assert_eq!(written.version, 1);
    assert_eq!(written.machines.len(), 1);
    Ok(())
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_update_delete_round_trip() -> Result {
    let dir = tempfile::tempdir()?;
    let service = ComputeService::new(dir.path().join("compute.json"));
    assert!(service.list().await?.is_empty());

    let created = service
        .create(new_machine("big-1", "ubuntu@3.15.73.38"))
        .await?;
    assert!(created.enabled);

    assert!(service.create(new_machine("BIG-1", "other")).await.is_err());
    assert!(service
        .create(new_machine("big-2", "ubuntu@3.15.73.38"))
        .await
        .is_err());
    service.create(new_machine("big-2", "other")).await?;

    let updated = service
        .update(&created.id, MachinePatch {
            description: Some("Rust builds, tests and benchmarks".into()),
            enabled: Some(false),
            ..MachinePatch::default()
        })
        .await?;
    assert_eq!(updated.description, "Rust builds, tests and benchmarks");
    assert!(!updated.enabled);
    assert_eq!(updated.ssh_target, "ubuntu@3.15.73.38");

    let renamed = service
        .update(&created.id, MachinePatch {
            name: Some("big-2".into()),
            ..MachinePatch::default()
        })
        .await;
    assert!(renamed.is_err(), "names stay unique");

    assert!(service.delete(&created.id).await?);
    assert!(!service.delete(&created.id).await?);
    let left: Vec<String> = service.list().await?.into_iter().map(|m| m.name).collect();
    assert_eq!(left, vec!["big-2"]);
    Ok(())
}

#[tokio::test]
async fn failed_check_keeps_last_profile() -> Result {
    let dir = tempfile::tempdir()?;
    let service = ComputeService::new(dir.path().join("compute.json"));
    let created = service.create(new_machine("big-1", "box")).await?;
    let profile = MachineProfile {
        os: "Ubuntu".into(),
        cpus: 8,
        mem_gb: 32,
        ..MachineProfile::default()
    };
    let ok = ProbeResult {
        target: "box".into(),
        check: MachineCheck {
            checked_at: "2026-10-30T00:00:00Z".into(),
            status: CheckStatus::Ok,
            message: String::new(),
        },
        profile: Some(profile.clone()),
        ssh_alias: false,
    };
    service.record_check(&created.id, ok).await?;
    let failed = ProbeResult {
        target: "box".into(),
        check: MachineCheck {
            checked_at: "2026-10-31T00:00:00Z".into(),
            status: CheckStatus::Unreachable,
            message: "timed out".into(),
        },
        profile: None,
        ssh_alias: false,
    };
    let machine = service.record_check(&created.id, failed).await?;
    assert_eq!(machine.profile, Some(profile));
    assert_eq!(
        machine.last_check.map(|c| c.status),
        Some(CheckStatus::Unreachable)
    );
    Ok(())
}

#[tokio::test]
async fn discovery_reads_files_under_home() -> Result {
    let home = tempfile::tempdir()?;
    std::fs::create_dir_all(home.path().join(".ssh"))?;
    std::fs::write(
        home.path().join(".ssh/config"),
        "Host lab\n  HostName 10.1.1.1\n",
    )?;
    std::fs::write(
        home.path().join(".zsh_history"),
        ": 1:0;ssh lab\n: 2:0;ssh me@10.9.9.9\n",
    )?;
    let candidates = evot::compute::discover_in(home.path(), None, None, &[], &Default::default())?;
    let targets: Vec<&str> = candidates.iter().map(|c| c.target.as_str()).collect();
    assert_eq!(targets, vec!["lab", "me@10.9.9.9"]);
    Ok(())
}

// ---------------------------------------------------------------------------
// ssh aliases
// ---------------------------------------------------------------------------

fn ssh_config(home: &std::path::Path) -> Result<String> {
    Ok(std::fs::read_to_string(home.join(".ssh/config"))?)
}

#[test]
fn an_address_becomes_an_alias_named_after_the_machine() -> Result {
    let home = tempfile::tempdir()?;
    let cancel = tokio_util::sync::CancellationToken::new();
    let alias = alias::ensure_alias(home.path(), "big-1", "ubuntu@3.15.73.38", &cancel)?;
    assert_eq!(alias, "big-1");
    assert_eq!(
        ssh_config(home.path())?,
        "# Added by evot /compute\nHost big-1\n  HostName 3.15.73.38\n  User ubuntu\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &std::path::Path| -> Result<u32> {
            Ok(std::fs::metadata(path)?.permissions().mode() & 0o777)
        };
        assert_eq!(mode(&home.path().join(".ssh"))?, 0o700);
        assert_eq!(mode(&home.path().join(".ssh/config"))?, 0o600);
    }
    assert!(alias::is_config_alias(home.path(), "big-1", &cancel));
    assert!(!alias::is_config_alias(
        home.path(),
        "ubuntu@big-1",
        &cancel
    ));

    // Adding the same host under the same name again reuses the alias.
    let again = alias::ensure_alias(home.path(), "big-1", "ubuntu@3.15.73.38", &cancel)?;
    assert_eq!(again, "big-1");
    assert_eq!(ssh_config(home.path())?.matches("Host big-1").count(), 1);

    let ipv6 = alias::ensure_alias(home.path(), "v6", "root@[fe80::1]", &cancel)?;
    assert_eq!(ipv6, "v6");
    assert!(ssh_config(home.path())?.contains("Host v6\n  HostName fe80::1\n  User root\n"));
    Ok(())
}

#[test]
fn existing_aliases_and_the_rest_of_the_config_are_kept() -> Result {
    let home = tempfile::tempdir()?;
    let cancel = tokio_util::sync::CancellationToken::new();
    std::fs::create_dir_all(home.path().join(".ssh"))?;
    let original = "Host *\n  ServerAliveInterval 30\nHost mac2\n  HostName 10.0.0.2";
    std::fs::write(home.path().join(".ssh/config"), original)?;

    // Already an alias: stored as is, nothing written.
    assert_eq!(
        alias::ensure_alias(home.path(), "build", "mac2", &cancel)?,
        "mac2"
    );
    assert_eq!(ssh_config(home.path())?, original);

    // The name is taken by another host: refused, nothing written.
    let taken = alias::ensure_alias(home.path(), "mac2", "ubuntu@3.15.73.38", &cancel);
    assert!(taken
        .err()
        .is_some_and(|e| e.to_string().contains("choose another name")));
    assert_eq!(ssh_config(home.path())?, original);

    alias::ensure_alias(home.path(), "big-1", "3.15.73.38", &cancel)?;
    assert_eq!(
        ssh_config(home.path())?,
        format!("{original}\n\n# Added by evot /compute\nHost big-1\n  HostName 3.15.73.38\n")
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn a_symlinked_ssh_config_is_written_through() -> Result {
    let home = tempfile::tempdir()?;
    let cancel = tokio_util::sync::CancellationToken::new();
    let dotfiles = home.path().join("dotfiles");
    std::fs::create_dir_all(&dotfiles)?;
    std::fs::create_dir_all(home.path().join(".ssh"))?;
    std::fs::write(
        dotfiles.join("ssh_config"),
        "Host mac2\n  HostName 10.0.0.2\n",
    )?;
    std::os::unix::fs::symlink(dotfiles.join("ssh_config"), home.path().join(".ssh/config"))?;
    alias::ensure_alias(home.path(), "big-1", "ubuntu@3.15.73.38", &cancel)?;
    assert!(std::fs::symlink_metadata(home.path().join(".ssh/config"))?
        .file_type()
        .is_symlink());
    assert!(std::fs::read_to_string(dotfiles.join("ssh_config"))?.contains("Host big-1"));
    Ok(())
}

#[tokio::test]
async fn created_machines_store_the_alias_never_the_address() -> Result {
    let dir = tempfile::tempdir()?;
    let service = ComputeService::new(dir.path().join("state/compute.json"))
        .with_ssh_home(dir.path().to_path_buf());
    let created = service
        .create(new_machine("big-1", "ubuntu@3.15.73.38"))
        .await?;
    assert_eq!(created.ssh_target, "big-1");
    let stored = std::fs::read_to_string(dir.path().join("state/compute.json"))?;
    assert!(!stored.contains("3.15.73.38"), "{stored}");
    let section =
        evot::compute::prompt::prompt_section(&service.list().await?).ok_or("no section")?;
    assert!(
        section.contains("- big-1: Rust builds and tests"),
        "{section}"
    );
    assert!(!section.contains("3.15.73.38"));

    // A name already in ~/.ssh/config for another host is refused.
    std::fs::write(
        dir.path().join(".ssh/config"),
        format!("{}Host db0\n  HostName 10.0.0.5\n", ssh_config(dir.path())?),
    )?;
    let taken = service.create(new_machine("db0", "root@10.0.0.9")).await;
    assert!(taken.is_err());
    assert_eq!(service.list().await?.len(), 1);
    Ok(())
}
