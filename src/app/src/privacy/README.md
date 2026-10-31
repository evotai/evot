# Privacy

What leaves this machine for a model or a server is masked or scrubbed
first. Tool calls are not judged: the agent's work is running commands with
the credentials it was given, and a check on every `bash` line produced far
more noise than signal.

## Boundaries

- **Model requests** (`provider.rs`): every request is masked before the
  inner provider sees it; placeholders are restored in the reply and in each
  streamed delta (`stream.rs`). Tool-call arguments come back with real
  values: the tool needs them. A kind set to `block` stops the request.
- **Uploads** (`scrub.rs`, `service::scrub_upload*`): share, sync, task
  definitions, task reports and chat deliveries are scrubbed for good
  (`[REDACTED:KIND]`); nothing is kept to undo it. Always on, whatever
  `enabled` says.
- **Known values** (`vault.rs`): a value found once is masked wherever it
  appears again; values evot injects into the shell and the provider key
  are registered up front (`remember_secrets`).

## Records and the live feed

Each request or upload with a finding appends one line to
`~/.evotai/privacy/records/<day>.jsonl` (`record.rs`): kind, rule,
placeholder, length, count, and for model requests where each value sat
(`origins`: `user`, `system prompt`, `Bash call`, `Bash result` with the
call's label). Labels are read from the request *after* masking, so a
command that carried a value names it by placeholder. Never a value.
`/privacy` summarizes them.

The same records enter a bounded in-memory feed (`service::live_notices`,
per process). The TUI reads it after each step and shows a card only when a
request masks a placeholder tag the session has not seen before, so
re-masking the same history each turn stays silent. On resume the CLI
seeds "seen" from the session's records (`session_tags`) so the first
request does not report the whole history as new. A blocked request's
error card takes model, origins and rules from the latest blocked notice.

## Rules

Packs under `rules/data/*.json` plus the user's `~/.evotai/privacy/rules`
are compiled once per configuration (`rules/engine.rs`). Cache identities
include file length, mtime and, on Unix, inode/ctime; another process's
edits are seen on the next request. Configuration loading and settings
writes run off the async runtime; settings writes are atomic. Settings can
be repaired without valid user packs.

## Validation

```sh
cargo test -p evot --test integration privacy
cd cli && bun test tests/privacy-*.test.ts && bunx tsc --noEmit
```

## Limitations

Masking is regex and context driven: a secret the rules do not recognize,
or one spread across fields, can reach the model. Tool calls run with real
values and nothing watches where they send them.
