# Coding Standards

- Never use `unwrap()` or `expect()`
- Always propagate errors with `?` or handle them explicitly using `match` / `if let`

# Architecture

- **Workspace members**: `src/engine`, `src/app`, `cli/addon`
  - `evotengine` (src/engine) — agent runtime: provider abstraction, agent loop, context, tools, retry
  - `evot` (src/app) — application layer: session, storage, config, server, commands, skills, delivery, search
  - `evotaddon` (cli/addon) — Rust NAPI addon bridging engine/app to the TypeScript CLI
- **CLI**: TypeScript (Bun) in `cli/src/`, renders TUI, handles input, sessions, updates
- `mod.rs` / `lib.rs`: only module declarations, re-exports, and `use` statements — no business logic

## Layering

Each list is lowest layer first. A module uses only modules listed before it; guard tests fail on an upward dependency.

- **`src/engine/src`**: `time`, `media`, `spill` → `types` → `provider` → `context`, `retry` → `event`, `tools`, `host` → `runner` → `agent` (guard: `src/engine/tests/architecture.rs`)
- **`src/app/src`**: `base` → `types` → `auth` → `conf` → `observability`, `privacy` → `session` → `cloud` → `agent` → `suggestion` → `surface` → `api` (guard: `src/app/tests/base/architecture_test.rs`)
  - `base`: `error`, `blocking`, `atomic_file`, `http`, `paths`
  - `session`: `conversation` → `storage` → `search` → session state (`Session`, `SessionService`, …) → `compact`
  - `cloud`: `compute`, `share` → `sync`
  - `agent`: agent runtime plus `bootstrap`, `models`, `command`
  - `surface`: `delivery` → `gateway` → `automation`, `acp`, `contracts` → `service`
- **`cli/src`**: `native` → `ui` → `markdown` → `render` → `session` → `features` → `commands` → `update` → `term` → `headless`; `index.ts` and `cli.ts` are the entry points (guard: `cli/tests/architecture-boundaries.test.ts`)
  - `ui`: terminal primitives with no application knowledge (selector, keys, theme, wrap, progress)
  - `features`: `task`, `compute`, `loop`, `channels`, `models`
  - `term`: `repl.ts` wiring, `host/` REPL controllers, `app/` feature logic grouped by concern, `viewmodel/` layout, `screen/` terminal backend, `widgets/`, `input/` editor
  - `term/host`: `state.ts` holds all mutable REPL state (`ReplState`); each controller is `createXController(st, deps)` with an explicit `XDeps` port interface. `repl.ts` owns services, startup and teardown, and exposes them through the `host` getter table. New mutable state goes in `ReplState`, never a `let` in `startRepl`; controllers import each other as types only.
- Tests mirror the source layout: `src/app/tests/<module>/`, `cli/tests/<dir>/`

# Blocking Filesystem Work

- Write a batch of local file I/O (directory scans, read + parse, lock + write) as one synchronous worker `fn(..., cancel: &CancellationToken) -> Result<T>` instead of awaiting each `tokio::fs` call.
- In `src/app`, enter workers only through `crate::base::blocking::blocking_io(label, worker)`; do not call `tokio::task::spawn_blocking` directly. Dropping the future cancels the token.
- Workers that touch many files must poll `cancel.is_cancelled()` between operations and return `crate::base::blocking::cancelled(label)`; single-file workers may ignore the token.
- `src/engine` workers already use the same `&CancellationToken` signature (`walk`, `glob`, `grep`, search index); keep that shape.

# Testing

- All tests go in the crate's `tests/` directory, never inline
- Rust targeted tests: `cargo test -p <crate> <test-name>` or the narrowest relevant `cargo test` command
- TS targeted tests: `cd cli && bun test <test-file>` for the changed area
- Run full `cargo test` or full `cd cli && bun test` only when changes are broad or cross-cutting
- Keep tests explicit and fast; focus on core logic
- A change to one workspace crate can break another: before committing Rust changes, run the full suite once — `make test-rust` (or `make check`, which includes it)

# Schema Compatibility

Files under `~/.evotai`, remote API DTOs, addon JSON, and stored sessions are published contracts.

- Every added field must be backward-readable via `#[serde(default)]`, `Option<T>`, or an explicit migration.
- Do not change a published field's type or meaning in place; add a new field and migrate.
- Persistent formats need a schema version independent of server/catalog versions. Missing versions must map to legacy v0; reject unsupported future versions clearly.
- Keep compatibility fields out of business decisions. Wire/persistent DTOs may retain fields that domain logic ignores.
- Treat custom provider entries in `~/.evotai/evot.env` as user data. Cloud login/reconcile and settings rewrites must preserve their selection, secrets, URLs, models, protocols, capability fields, and non-evot preamble lines.
- Every schema change requires historical fixtures and both directions of contract testing: old data → current reader, and current writer → strict legacy reader.
- Persistent state writes must use a same-directory temporary file, flush/sync, and atomic rename; never truncate the live JSON file in place.

# Pre-commit

- Before committing, run the relevant targeted tests for the files changed
- Run `make check` before committing only when Rust code, shared build config, or cross-workspace behavior changed
