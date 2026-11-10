import { expect, test } from 'bun:test'
import { BackgroundVisibility } from '../../../src/term/app/background/background-visibility.js'
import type { BackgroundProcess } from '../../../src/native/contracts/results.js'
const task = (task_id: string, status: BackgroundProcess['status']): BackgroundProcess => ({ task_id, status, command: 'fixture', cwd: '/tmp', output_path: '/tmp/out', elapsed_ms: 0, exit_code: null, output_file_truncated: false, stopped_by_user: false })
test('old completed tasks hide while inherited live work and new completions stay visible', () => {
  const scope = new BackgroundVisibility()
  scope.begin([task('old', 'completed'), task('inherited', 'running')])
  const next = [task('old', 'completed'), task('inherited', 'completed'), task('new', 'completed')]
  expect(scope.visible(next).map(p => p.task_id)).toEqual(['inherited', 'new'])
  scope.begin(next)
  expect(scope.visible(next)).toEqual([])
  expect(next).toHaveLength(3)
})
