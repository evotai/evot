---
name: harden
description: "Stress-test a proposed strategy, plan, or current git changes by hunting loopholes before implementation or commit. Trigger phrases: harden, stress test, poke holes, find loopholes."
---

# Harden

Stress-test a proposed strategy, design, or plan by actively hunting loopholes
and iterating fixes until the remaining risks are either closed or explicitly
accepted.

## When to Use

- User asks you to validate, pressure-test, or "poke holes in" a plan,
  strategy, or conclusion before coding starts. For a bare `/harden`, treat the
  immediately preceding plan/conclusion as the primary subject.
- User explicitly asks you to harden current git changes before commit or merge. In this
  case, inspect the diff to infer the implementation strategy, then harden that
  strategy.
- You have a proposed approach but suspect gaps and want a disciplined pass
  before committing.
- Do NOT use this as a line-by-line code review of diffs or PRs — use the
  `review` skill for that. Harden evaluates whether the strategy behind the
  change is robust.
- Do NOT use this as a default reflex after every small change. Invoke it when
  the blast radius of being wrong is high.

## Inputs

The subject of hardening is one of:

- the currently-proposed plan, strategy, or conclusion from the previous turn
  or the user's message. This is the default subject for a bare
  `/harden` request;
- the current git changes, when the user explicitly asks to harden local work
  (for example, `harden changes` or `/harden changes`). Inspect staged and
  unstaged diffs, summarize the inferred strategy, then harden that strategy
  rather than reviewing every changed line;
- the architecture, when the user asks to harden architecture (for example,
  `harden arch` or `/harden arch`). Evaluate the structural design of the
  changes or plan — focus on simplicity, decoupling, clarity of responsibility,
  and cohesion. The output must include an annotated file tree (see Output);
- when a plan/strategy/conclusion is available and local git changes also exist,
  use the diff only as supporting context. Combine relevant findings from the
  diff with the hardening pass, but do not switch the primary subject from the
  previous conclusion to the diff.

If no plan, strategy, or git change is available, ask the user to state the
subject in one paragraph before starting.

## The Loop

Repeat until convergence:

1. **Enumerate loopholes.** List concrete, named weaknesses. Each item must say
   *what* breaks and *under what condition*. Reject vague worries. Cover at
   least:
   - Edge cases: empty input, max size, concurrency, partial failure, retries,
     migration from existing state.
   - Assumptions: behaviors you inferred without reading the code. Mark them.
   - Integration: conventions in the codebase the plan bypasses or duplicates.
   - Verification: tests or checks that would not actually catch a regression.
   - Reversibility: what's hard to undo if this ships and is wrong.
   - Structure (when subject is architecture): module boundary violations,
     responsibility overlap between modules, naming/directory confusion,
     unnecessary coupling.
2. **Fix or accept.** For each loophole, either:
   - update the plan or strategy with a specific change;
   - if hardening current git changes, identify the specific implementation
     adjustment needed; or
   - explicitly mark it as accepted risk with the reason (scope, cost, low
     probability).
   Do not close a loophole by waving at it.
3. **Ablate and re-check.** Before converging, run an ablation experiment on
   the revised plan or change: actively look for unnecessary abstractions and
   design, and simplify them while preserving required behavior and constraints.
   Use judgment and codebase context rather than mechanically targeting specific
   patterns or forcing a removal. Then ask whether the fixes or simplifications
   introduced new loopholes. If yes, go to step 1. If no, stop.

Typical runs converge in 2-3 iterations. If you're past 4 iterations and still
finding substantive new loopholes, the underlying design is probably wrong —
surface that to the user instead of patching further.

## Anti-patterns

Hardening fails when it degrades into these:

- **Fallback sprawl.** Adding normalizers, retries, and defensive wrappers for
  scenarios that cannot happen. A plan is not safer because it handles more
  imaginary cases.
- **Abstraction creep.** Introducing new layers or indirection "just in case".
- **Vague confidence claims.** "I'm now confident" is not a stopping condition.
  The stopping condition is: remaining loopholes are fixed or named as risks.
- **Scope drift.** Hardening the plan should not grow the feature. If a
  loophole reveals the feature is too small, say so; don't silently expand it.

## Output

Use the conversation language established before the harden invocation. Treat
the invocation command and target selector as language-neutral. If no prior
conversation language is available, use the invocation's natural-language
prose. An explicit output-language request takes precedence. Never infer the
output language from the subject being hardened. Localize prose and section
headings; preserve code, diffs, identifiers, paths, logs, and quoted material.

When you converge, present:

- **Subject** — the plan, strategy, or current git changes being hardened.
- **Closed loopholes** — each one as: `condition → fix`, one line.
- **Accepted risks** — each one as: `condition → why it's acceptable`, one line.
- **Final plan** — the revised plan, rewritten as a self-contained, ready-to-execute
  specification that already incorporates every closed loophole. Do not describe
  it as a diff against the original or a list of adjustments — write it as if the
  original plan never existed. It must be concrete enough that the next step is
  implementation, not another round of planning. When the subject is current
  git changes rather than a forward-looking plan, replace this with
  **Implementation adjustments** — the specific file-level edits still needed
  to close the loopholes. When the subject is architecture, replace this with
  **Architecture** — include the following:
  - A brief assessment of simplicity, decoupling, and clarity of responsibility.
  - An annotated file tree showing the proposed directory structure with change
    markers. Each entry uses `[Add]`, `[Modify]`, or `[Delete]` to indicate the
    structural change, followed by a short comment explaining the role or reason.
    Example format:
    ```
    src/
      engine/
        src/
          provider/    # [Add] LLM provider trait, decoupled from agent loop
          tools/       # [Modify] extract tool registry into standalone module
          old_exec/    # [Delete] merged into provider/
      app/
        src/
          agent/       # [Modify] prompt assembly now delegates to skill dispatch
          storage/     # [Add] persistence layer (SQLite, file-based)
    ```
    Unchanged directories may be listed without markers for context, but keep
    them minimal. The tree must reflect the state after all loophole fixes are
    applied.
- **Iterations** — a short count (e.g. "converged after 2 passes").

Put **Final plan** (or **Implementation adjustments** or **Architecture**) last
so the reader ends on the actionable output and does not need to ask "now give
me the revised plan".

Keep it compact. One page is usually enough, but do not shrink the final plan
to the point it loses the detail needed to execute.
