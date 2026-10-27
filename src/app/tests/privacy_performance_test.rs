//! Opt-in, offline release benchmarks. The child has an isolated HOME, so
//! the production settings and record paths never touch the user's data.
use std::hint::black_box;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use evot::privacy::GuardedTool;
use evot::privacy::Masker;
use evot::privacy::PrivacySettings;
use evot_engine::AgentTool;
use serde_json::json;

use crate::privacy_egress_test::context;
use crate::privacy_egress_test::Recorder;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn summarize(label: &str, mut samples: Vec<Duration>) {
    samples.sort_unstable();
    let n = samples.len();
    println!(
        "PRIVACY_BENCH {label}: n={n} p50={:?} p95={:?}",
        samples[n / 2],
        samples[(n * 95 / 100).min(n - 1)]
    );
}

fn scan(masker: &Masker, cwd: &Path, label: &str, bytes: usize) {
    let line = "fn handle(req: Request) -> Result<Response> { let count = req.items.len(); Ok(response(count)) }\n";
    let args = json!({"path":"src/handler.rs", "content":line.repeat(bytes / line.len())});
    black_box(masker.check_call("write", &args, cwd));
    let mut samples = Vec::new();
    for _ in 0..25 {
        let start = Instant::now();
        black_box(masker.check_call("write", &args, cwd));
        samples.push(start.elapsed());
    }
    summarize(label, samples);
}

async fn execute(
    tool: &dyn AgentTool,
    cwd: &Path,
    label: &str,
    args: serde_json::Value,
    blocked: bool,
) {
    let mut samples = Vec::new();
    for i in 0..251 {
        let ctx = context(tool.name(), cwd);
        let start = Instant::now();
        let result = tool.execute(args.clone(), ctx).await;
        let elapsed = start.elapsed();
        assert_eq!(
            result.is_err(),
            blocked,
            "unexpected benchmark verdict: {result:?}"
        );
        let _ = black_box(result);
        if i > 0 {
            samples.push(elapsed);
        }
    }
    summarize(label, samples);
}

#[test]
#[ignore = "offline release benchmark: cargo test --release -p evot --test integration privacy_performance -- --ignored --nocapture"]
fn privacy_performance() -> TestResult {
    let home = tempfile::tempdir()?;
    let output = std::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "privacy_performance_test::privacy_performance_child",
            "--ignored",
            "--nocapture",
        ])
        .env("EVOT_PRIVACY_BENCH_CHILD", "1")
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .output()?;
    assert!(
        output.status.success(),
        "benchmark failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    print!("{}", String::from_utf8_lossy(&output.stdout));
    Ok(())
}

#[tokio::test]
#[ignore = "launched by privacy_performance with an isolated HOME"]
async fn privacy_performance_child() -> TestResult {
    if std::env::var_os("EVOT_PRIVACY_BENCH_CHILD").is_none() {
        return Ok(());
    }
    let dir = tempfile::tempdir()?;
    let cwd = dir.path();
    let start = Instant::now();
    let masker = Masker::new(&PrivacySettings::default(), [31; 32])?;
    println!("PRIVACY_BENCH cold_builtin_compile={:?}", start.elapsed());
    let raw = Recorder {
        name: "bash",
        ran: Arc::new(AtomicBool::new(false)),
    };
    execute(
        &raw,
        cwd,
        "raw_tool",
        json!({"command":"cargo test -p evot"}),
        false,
    )
    .await;
    let fixed = GuardedTool::with_masker(
        Box::new(Recorder {
            name: "bash",
            ran: raw.ran.clone(),
        }),
        Arc::new(masker),
    );
    execute(
        &fixed,
        cwd,
        "guard_fixed_short",
        json!({"command":"cargo test -p evot"}),
        false,
    )
    .await;
    let dynamic = GuardedTool::new(
        Box::new(Recorder {
            name: "bash",
            ran: raw.ran.clone(),
        }),
        None,
    );
    let start = Instant::now();
    dynamic
        .execute(json!({"command":"git status"}), context("bash", cwd))
        .await?;
    println!("PRIVACY_BENCH cold_production_guard={:?}", start.elapsed());
    execute(
        &dynamic,
        cwd,
        "guard_production_short",
        json!({"command":"cargo test -p evot"}),
        false,
    )
    .await;
    let line = "let count = response.items.len(); // local source code\n";
    let writer = GuardedTool::new(
        Box::new(Recorder {
            name: "write",
            ran: raw.ran.clone(),
        }),
        None,
    );
    execute(
        &writer,
        cwd,
        "guard_production_write_100KB",
        json!({"path":"src/x.rs", "content":line.repeat(100_000 / line.len())}),
        false,
    )
    .await;
    let populated = Masker::new(&PrivacySettings::default(), [32; 32])?;
    scan(&populated, cwd, "scan_write_1MB_empty", 1_000_000);
    for i in 0..10_000 {
        populated.remember_secret(&format!("bench-fixture-{i:08}-not-a-live-credential"));
    }
    scan(&populated, cwd, "scan_write_1MB_10K_known", 1_000_000);
    let fixture = "bench-fixture-00000000-not-a-live-credential";
    let start = Instant::now();
    for i in 0..10_000 {
        black_box(populated.check_call(
            "write",
            &json!({"path":format!("file-{i}.txt"), "content":fixture}),
            cwd,
        ));
    }
    println!("PRIVACY_BENCH populate_10K_taints={:?}", start.elapsed());
    scan(
        &populated,
        cwd,
        "scan_write_1MB_10K_known_10K_taints",
        1_000_000,
    );
    let args = json!({"command":"git status"});
    let mut samples = Vec::new();
    for _ in 0..500 {
        let start = Instant::now();
        black_box(populated.check_call("bash", &args, cwd));
        samples.push(start.elapsed());
    }
    summarize("scan_short_10K_known_10K_taints", samples);
    let records = tempfile::tempdir()?;
    let recorded = Arc::new(populated.with_records(records.path().to_path_buf()));
    let sender = GuardedTool::with_masker(
        Box::new(Recorder {
            name: "mcp_post",
            ran: raw.ran.clone(),
        }),
        recorded,
    );
    execute(
        &sender,
        cwd,
        "guard_blocked_with_record",
        json!({"text":fixture}),
        true,
    )
    .await;
    // Also cover compilation/caching with user packs, not just built-ins.
    let root = Path::new(&std::env::var_os("HOME").ok_or("missing isolated HOME")?)
        .join(".evotai/privacy/rules");
    std::fs::create_dir_all(&root)?;
    std::fs::write(
        root.join("bench.json"),
        serde_json::to_vec(&json!({
            "schema_version":1,"id":"benchmark","kinds":[{"name":"BENCH_MARKER","category":"secret"}],
            "rules":[{"id":"marker","kind":"BENCH_MARKER","regex":"BENCHMARK_ONLY_[0-9]{12}"}]
        }))?,
    )?;
    execute(
        &dynamic,
        cwd,
        "guard_production_user_pack",
        json!({"command":"git status"}),
        false,
    )
    .await;
    Ok(())
}
