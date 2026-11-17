---
name: harden
description: "Stress-test a plan, strategy, conclusion, current git changes, or a module/directory layout by hunting loopholes before implementation or commit. Trigger phrases: harden, stress test, poke holes, find loopholes."
---

# Harden

Find what would break, fix it in the plan or the change, simplify, and repeat
until everything left is either closed or knowingly accepted. Judge whether the
approach holds up; this is not a line-by-line code review.

## What to harden

- Bare `/harden`: the plan, strategy, or conclusion just discussed. Local git
  changes are supporting evidence, not the subject.
- `/harden changes`: the staged and unstaged diff. Infer the strategy behind it
  and harden that.
- `/harden <target>`: whatever is named: a strategy in words, a design doc, a
  file, a directory, or a module layout. The named target is the subject; the
  conversation and the diff are context.
- Nothing to harden: ask for the subject in one paragraph.

## How

1. Read before judging: the code, the project's rules (`AGENTS.md`, guard
   tests), real callers and imports. Mark anything you assumed without checking.
2. List concrete loopholes: what breaks, under which condition. Look where it
   usually hurts: edge cases and existing state, concurrency and partial
   failure, conventions the change bypasses or duplicates, tests that would not
   catch a regression, things that are hard to undo, and structure.
3. Fix each one with a specific change, or accept it with a reason.
4. Ablate: cut abstractions, layers, and fallbacks the requirement does not
   need. Check whether the fixes or cuts opened new holes, and repeat. Two or
   three passes are typical; if fundamental problems keep appearing after four,
   say the design is probably wrong. Do not add fallbacks for impossible
   cases, layers just in case, or new feature scope, and name what remains
   instead of claiming confidence.

When files, modules, or directories are involved, check the structure too: one
job per module, named by domain rather than kind; dependencies point one way;
callers go through a narrow entry, not a sibling's internals; what changes
together lives together; wiring stays thin. Tie every move to a concrete
problem; no reshuffles for taste.

## Output

Write in the language the user has been using. Words the user typed after
`/harden` count; selectors such as `changes`, host-written instructions, and
the material being hardened (code, diffs, docs) do not. Keep code, paths, and
identifiers as they are. Roughly this shape, about one page.
Drop empty sections, and say in each heading where its items stand.

Tag every loophole and risk with a priority, and list each section highest
first:

- `P0`: wrong results, data loss, security, or a broken published contract on a
  normal path; must be fixed before shipping. A P0 never goes under Accepted
  risks; if it cannot be fixed here, list it in the final plan as blocking and
  say why.
- `P1`: fails under a specific but plausible condition, or breaks a project
  rule; fix in this change unless accepted with a reason.
- `P2`: unlikely, cosmetic, or cheap to fix later.

~~~markdown
## Subject
<what was hardened> · <N passes>

## Closed loopholes (<already in the code | still to do below>)
- L1 [P0] <condition> → <fix>

## Accepted risks (<who accepted them; confirm?>)
- R1 [P2] <condition> → <why it is acceptable>

## Ablation
- A1 <what> → <simpler alternative>

## Final plan
<Self-contained and ready to execute, written as if the original never existed,
not as a diff of it. For `changes`, title it "Implementation adjustments": only
what still needs editing, or "None". Include the tree only when files or
structure change, and start it with the layering `a → b → c`.>

```text
path/
├── file.rs   [Add | Modify | Delete | Move from <path>] reason (L1)
└── …
```

1. <step> — verify: <command or check>
~~~
