# Privacy

Privacy has one detector shared by model requests and uploads. The default
policy favors clear evidence over broad coverage: distinctive credential
formats, explicit credential contexts, and confirmed values. There is no
entropy heuristic, bulk third-party catalog, or rule treating every line of
an `.env` file as a secret.

## Module boundaries

| Responsibility | Module | What belongs here |
| --- | --- | --- |
| Fixed formats | `rules/data/formats.json` | Private keys, vendor prefixes/lengths, JWT structure, vendor webhook URLs |
| Explicit contexts | `rules/data/contexts.json` | Authorization headers, credential-bearing URLs, exact credential field/assignment names, curl credentials, explicit password declarations |
| Shared vocabulary | `rules/data/core.json` | Kinds, small reusable exclusions, encoded-text scanning and wire structure; no detection rules |
| Rule execution | `rules/engine.rs`, `scan.rs` | Compile packs, locate spans, resolve overlaps and apply policy; no vendor-specific decisions |
| Confirmed values | `known.rs` | Registration, opaque-only automatic discovery, indexed re-matching |
| Placeholders | `vault.rs`, `stream.rs` | Stable keyed tags, collision protection, reply restoration and the scope of confirmed values |
| Boundaries | `request.rs`, `scrub.rs` | Traverse request/upload data without changing protocol structure |
| Policy and records | `policy.rs`, `record.rs`, `notice.rs` | Mask/block/warn, value-free audit records and UI notices |

The built-ins have 16 format rules and 8 context rules (including two JSON
field rules). No generated imports. Every built-in rule has keywords, so the
prefilter skips it on text that cannot match. A new default rule must name
its concrete credential evidence and include positive and negative examples
and keywords. Avoid generic
`key`, identifier-shaped values, arbitrary URL parameters and "random-looking"
strings. User rule packs remain an explicit extension under
`~/.evotai/privacy/rules/*.json`; their schema and source-scoped rules still
work, but do not broaden the built-in policy.

## Detection contract

- A vendor format is recognized wherever it appears, independent of the tool,
  file name or command that produced it. An unknown opaque value needs an
  explicit credential context such as `DB_PASSWORD=...` or `api_key`.
  Credential names match in snake, kebab, dotted and camel case and as CLI
  flags (`--password=`, `X-Api-Key:`, `dbPassword`). Password contexts
  report `PASSWORD`, other credential names `SECRET`, so a per-kind action
  covers a value whichever context revealed it.
- Bare `key=...`, build IDs, output paths and ordinary assignments are not
  credential evidence, even inside an env file. A command segment starting
  with `#` is a comment, so a `#!/usr/bin/env python3` shebang cannot mark a
  result as an env dump for `scope: "sensitive"` user rules.
- After a credential name only a literal is a value, by grammar rather than
  word lists: a quoted string (after `=`, `:`, `:=` or a type annotation), an
  unquoted value that ends its line (`.env`, YAML, INI, prose; a trailing
  comment allowed), a tight `--flag=value` / `NAME=value cmd`, or a quoted
  `"Name: value"` header. A reference (`this.apiKey`, `c.APIToken`,
  `config::secret()`), a type (`&str`, `Option<T>`, `Promise<string>`), an
  identifier naming a credential (`refresh_token`), a call argument
  (`f(password=pw)`) or a sentence going on after the value is not one.
  `Authorization` likewise needs its credential to end the header.
- Context rules do not require entropy or mixed case. Short, numeric and
  lowercase passwords still mask in explicit credential contexts.
- Automatic discovery promotes only opaque values of at least
  `known.min_secret_len` (8 characters by default): ones holding a character
  no name has (`@`, `!`, `+`, `=`, …) or whose letter/digit runs alternate at
  least three times. Words, identifiers, paths, versions, dates and numbers
  mask at their context but are not looked for elsewhere, so a password of
  `query` does not rewrite `execute_query` or later prose. Allocating a
  placeholder never implicitly registers a value for global matching.
- Confirmed values are scoped (`vault.rs`). Registered values apply to every
  request and upload. A value a request found applies to the rest of its
  session (`prompt_cache_key`) only; a request outside a session keeps its
  findings to itself, and `/new` starts clean. One-way scrubbing (uploads,
  deliveries) also takes every opaque value a request masked. An upload's
  history scan (`UploadContext`) is used by that upload only and never
  teaches requests.
- `Masker::remember_secret` is authoritative from 4 bytes. Values the
  runtime registers wholesale (`remember_secrets`: shell variables, provider
  keys) need `known.min_secret_len`, since such lists also hold short
  non-secret settings. Long confirmed values continue to mask when embedded in
  URLs or longer strings; token boundaries are not a leak bypass.
- Base64 and percent-encoded runs still go through the same rules. Tool schema
  structure, signed protocol data and binary payloads are not ordinary text.

## Boundaries

- **Model requests** (`provider.rs`): mask before the inner provider sees the
  request; restore replies and streamed deltas. Tool-call arguments get real
  values back because tools need them. A kind set to `block` stops the request.
- **Uploads** (`scrub.rs`, `service::scrub_upload*`): share, sync, task definitions,
  reports and chat deliveries are scrubbed irreversibly (`[REDACTED:KIND]`).
  This stays on even when model masking is disabled.
- **Execution**: tool calls run with real values. Privacy does not decide which
  commands may run or watch where a tool sends credentials.

## Records and configuration

Each request/upload with a finding appends a value-free JSONL record under
`~/.evotai/privacy/records/<day>.jsonl`: kind, rule, keyed placeholder, length,
count and masked origin labels, with up to 16 source lines per origin when a
text `read` result can be located. No raw value, prefix or suffix is recorded.
`/privacy` shows recent origins and rules in a report card. Routine masking uses
compact cards for new findings rather than repeating the same history each turn;
resume seeds tags from past records. Blocked requests link each blocking rule and
kind to its source and available line numbers, separate from findings that were
only masked or warned. No credential value or snippet is shown.
Historical settings, packs and records remain readable; no schema change is
needed to narrow the default detection policy.

Packs are compiled once per configuration. User-pack cache identities include
file length, mtime and Unix inode/ctime. Configuration I/O runs off the async
runtime, writes are atomic, and broken user packs do not prevent repairing
settings.

## Validation

```sh
cargo test -p evot --test integration privacy
cd cli && bun test tests/commands/privacy-command.test.ts
```

`privacy_detection_test.rs` pins the small built-in surface and pairs real
credential cases with code, paths, short-word and background-task regressions.
`privacy_scope_test.rs` pins which session, request and upload may learn a
confirmed value from which.
The other privacy tests cover encoding, extension packs, schema compatibility,
request/stream restoration, upload boundaries and value-free audit records.

## Deliberate limits

Unknown credentials with no distinctive format, explicit context or prior
registration are not guessed from their randomness or file of origin. Values
shaped like words, names, dates or numbers repeated without context are not
automatically rediscovered, nor is a value found in one session looked for in
another. An unquoted credential followed by more code on the same line
(`connect(password=hunter2)`) needs quotes, a format or registration. Heredoc bodies are not parsed as commands. Pagination-style
names such as `page_token` count as credential names. Register known values or
add an explicit user rule when that coverage is required. This is a
conservative default, not a claim to find all secrets.
