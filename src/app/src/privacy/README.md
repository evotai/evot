# Compatibility-preserving privacy hardening

This iteration keeps the existing settings schema, placeholder format,
host/tool exceptions, shell sender rules, proxy/redirect behavior and streaming
behavior. Existing enforcement is not replaced by shadow decisions.

## Internal changes

- Reversible placeholder allocation detects an occupied tag bound to a different
  value and returns an error without rebinding it or logging either value. The
  historical eight-character format and tolerant restoration remain unchanged.
- Tool-effect state has its own lock. Its basename index uses immutable `Arc`
  snapshots instead of rebuilding and copying every filename for each call.
  Snapshots are released before writes so sequential taint updates remain cheap.
- Each tainted path records why (`TaintOrigin`: the kind found, the pack rule,
  the writing tool). A refused call's notice names the marked files it reads
  with that origin, the program that makes the command send (`node`, `curl`),
  and each `/privacy ...` command that lifts the block; it prints no
  placeholder when none applies. `/privacy untaint FILE` (`privacy::untaint`)
  drops one path's mark for the rest of the process; nothing is persisted.
- A guarded call reads configuration and checks arguments in one blocking I/O
  batch. Cancellation is checked before execution, between argument scans,
  before candidate-path filesystem checks and during multi-file rule loading. A regex scan already in progress still
  finishes before cancellation is observed.
- Cache identities include metadata length and modification time, and file
  identity/change time on Unix. Directory and metadata errors are propagated,
  rather than interpreted as an empty rule directory. Configuration edits from
  another process are still checked on every call; there is no stale-cache TTL.
- Settings validation and atomic writes run off the async runtime. Settings
  writes and cache publication share the invalidation lock. Repairing settings
  does not require user packs to be valid.

## Shadow observations

`Masker::shadow_summary()` and `privacy::shadow_summary().await` expose two
in-memory counters:

- sensitive shell calls not classified as senders by the current rules;
- sensitive calls permitted based on destinations inferred from argument text.

They record no arguments, values, hosts, filenames or session identifiers, do
not write audit records, and never change execution. These are candidate policy
differences, not proof that a permitted call is malicious. Counters reset when
the masker is rebuilt. No new persistent settings or addon contracts are added.

## Validation

```sh
make check
make test-cli
cd cli && bunx tsc --noEmit
```

The offline release benchmark uses a child process with a disposable HOME and
mock tools. It performs no external network requests, reads no real credentials,
and writes records only inside temporary directories:

```sh
cargo test --release -p evot --test integration \
  privacy_performance_test::privacy_performance -- --ignored --nocapture
```

It reports p50/p95 for raw tools, fixed-masker checks, production configuration
loading plus checks, 100 KB writes, large scans with 10,000 known values and
10,000 tainted paths, blocked calls including audit writes, and user-pack cache
checks. Compilation and warmup are reported separately. The benchmark is
opt-in, not a wall-clock timing assertion in ordinary tests.

## Representative local release measurements

Numbers are p50 / p95 per call on this machine, not CI thresholds. Samples
include the full guard where the label says `guard`; pure scans are separate.

| Scenario | After hardening |
| --- | --- |
| Production guard, short command | 15.2 / 16.4 µs |
| Production guard, 100 KB write | 1.23 / 1.31 ms |
| Production guard, cached user pack | 26.2 / 47.5 µs |
| Blocked guard including audit write, 10K known values and taints | 56.9 / 94.3 µs |
| Pure short-command scan, 10K known values and taints | 0.79 / 0.92 µs |
| Pure 1 MB scan, 10K known values and taints | 14.6 / 15.1 ms |

In the recorded pre-change run, short scans with 10K taints took 467 µs p50,
blocked calls including records took 524 µs, and populating 10K taints took
2.52 s. Those became 0.79 µs, 56.9 µs, and 27.6 ms respectively. Large-text
costs did not improve: the 100 KB guarded write changed from 1.08 ms to 1.23 ms,
and the populated 1 MB scan from 13.0 ms to 14.6 ms. Keep that small regression
visible rather than claiming every path became faster. Built-in cold compilation
was approximately 60–73 ms across these runs and is cached.

For native/TUI validation, the local Xcode linker produced an unloadable release
addon (`mis-aligned LINKEDIT string pool`). The same code loaded successfully
when linked with the installed CommandLineTools toolchain; no shared build
configuration was changed:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo rustc --release \
  -p evot-napi --target aarch64-apple-darwin -- \
  -C linker=/Library/Developer/CommandLineTools/usr/bin/clang \
  -C link-arg=-fuse-ld=/Library/Developer/CommandLineTools/usr/bin/ld
```

## Deliberately unchanged limitations

The shell/network checks remain heuristic, not an OS/network sandbox. This
iteration does not change partial-message delivery, arbitrary JSON/replay
coverage, dynamic shell interpretation, file-alias handling, state persistence
across restarts, restoration scope across sessions, or the existing capacity
policy. Closing those gaps may alter normal use and requires a separate,
explicitly reviewed rollout. Shadow counters are not a claim that those gaps
are fixed.
