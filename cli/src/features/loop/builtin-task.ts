import type { LoopTask } from './parser.js'

/**
 * What a bare `/loop` does: carry on with whatever this conversation is
 * doing. The model reads the transcript on its first wakeup and decides the
 * shape of the job itself; the prompt only names the common shapes and the
 * facts the model cannot see from inside one wakeup. The pull-request flow is
 * spelled out because it recurs in the repos this ships to and has a known
 * rhythm (an automated reviewer such as Codex answers within minutes of a
 * push or trigger comment, bots leave reports that are not reviews); it is
 * one branch, not the task. Judgement calls, whether a review is current,
 * whether a thread deserves a change, when the job is settled, stay with the
 * model, since hard rules stall on the first project that works differently.
 */
export const BUILTIN_LOOP_PROMPT = [
  'Keep the work in this conversation moving. On the first wakeup, read the',
  'transcript and decide what the job is; record it with `loop_plan` as the',
  'rules describe, including every verification step this conversation',
  'already ran for this work, and hold to it on later wakeups rather than',
  're-deriving it from the checkout, which other work may have moved. Don\'t',
  'switch a branch someone else is using.',
  '',
  'If the conversation is driving a pull request, move it toward merge:',
  '- Review feedback. Many repos use an automated reviewer such as Codex: it',
  '  reviews on open and on a trigger comment like `@codex review`, answers',
  '  within minutes, and labels findings P1/P2. Handle every open thread on',
  '  the current head: fix it, or explain in the thread why you won\'t (a P2',
  '  nit may not be worth a change), then resolve it. After pushing fixes,',
  '  ask for one more review and wait for it rather than re-triggering.',
  '  Judge from the PR itself whether the latest review covers the head.',
  '  Review rounds are cheap; full CI is not. If the repo has a way to hold',
  '  heavy CI while iterating (a `hold-ci` label, draft status), use it',
  '  before pushing review fixes and lift it once review has converged, so',
  '  CI runs once on the final head rather than on every round.',
  '- Failing checks on the head commit: read the log, fix, push. Bot',
  '  reports (timing, job analysis) are not reviews.',
  '- Merge conflicts with the base branch: rebase, push.',
  '',
  'Otherwise, follow the flow the conversation already established, for',
  'example analyse, change, deploy, verify, re-check, with the same tools and',
  'standards it used. Finish what was left unfinished; watch what the user',
  'asked to watch; report what changed since last time.',
  '',
  'Nothing to do: say so in one line. Don\'t invent work.',
  '',
  'Irreversible actions (push to another branch, force-push, merge, close,',
  'delete, deploy) only when this conversation already asked for them.',
  'Keep a short cursor in each status line (what the job is, head sha or',
  'last timestamp, last reviewer comment, open items) so you can tell what',
  'changed.',
  '',
  'Stop (`schedule_wakeup` with `stop: true`) when every checklist item is',
  'done, the PR is merged or closed, or you\'re confident things are settled',
  'and a wait found nothing new. If unsure, wait once more rather than stop.',
].join('\n')

export const BUILTIN_LOOP_TASK: LoopTask = { prompt: BUILTIN_LOOP_PROMPT, label: 'continue this work' }
