import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import cases from './fixtures/suggestion-generality.json'

// Explicit opt-in: this test uses the real suggestion service and real account.
// Normal test runs must never access credentials or issue external requests.
const enabled = process.env.EVOT_TEST_SUGGESTION_LIVE === '1'
const addon = process.env.EVOT_TEST_SUGGESTION_ADDON

test.skipIf(!enabled || !addon)('real service generalizes across workflow, conversation and draft contexts', async () => {
  const { NapiAgent } = createRequire(import.meta.url)(addon!)
  const agent = await NapiAgent.create(null, null)
  const results: { name: string; round: number; status: string; candidates: string[]; passed: boolean }[] = []
  for (let round = 1; round <= 2; round++) {
    for (const scenario of cases) {
      const source = scenario.request
      const request = { explicit: true, suffix: '', ...source,
        // Exercise both plain conversation and restored structured context.
        workflow: 'workflow' in source ? source.workflow : round === 1 ? {
          schema_version: 1, session: 'active', last_turn: 'answered', pending_tools: 0,
          runtime: { execution: 'idle', mode: 'normal', queued_inputs: 0, background_tasks: 0 },
        } : undefined,
      }
      const outcome = await agent.suggestNextPrompt(JSON.stringify(request)).outcome()
      const candidates = outcome.candidates as string[]
      const empty = outcome.status === 'empty' && candidates.length === 0
      const expected = scenario.expected === 'abstain' ? empty
        : (scenario.expected === 'optional' && empty) || (outcome.status === 'ready' && candidates.length > 0)
      const matches = (scenario.expected === 'optional' && empty) || !('any_match' in scenario) || !scenario.any_match
        || candidates.some(candidate => new RegExp(scenario.any_match!, 'i').test(candidate))
      const excludes = !('none_match' in scenario) || !scenario.none_match
        || candidates.every(candidate => !new RegExp(scenario.none_match!, 'i').test(candidate))
      const result = { name: scenario.name, round, status: outcome.status, candidates, passed: expected && matches && excludes }
      results.push(result)
      console.log(JSON.stringify(result))
    }
  }
  // Assertions evaluate output behavior, not wording inside the prompt. Regexes
  // are test rubrics only; prediction code never sees them or the expectations.
  const failures = results.filter(result => !result.passed)
  const completed = (status: string) => status === 'ready' || status === 'empty'
  expect(failures.filter(result => completed(result.status)), 'Semantic mismatches').toEqual([])
  expect(failures.filter(result => !completed(result.status)), 'Request failures').toEqual([])
}, 300_000)
