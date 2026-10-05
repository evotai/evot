import { expect, test } from 'bun:test'
import { taskRunError } from '../src/task/run-error.js'

test('historical errors without a machine stay readable and never guess the local host', () => {
  expect(taskRunError('run error: Feishu channel is not configured')).toEqual({
    message: 'run error: Feishu channel is not configured', executor: 'Not recorded',
  })
})

test('new failure reports separate the reporting host from the complete error', () => {
  expect(taskRunError('run error: request failed\nconnection refused\nExecutor: build-server')).toEqual({
    message: 'run error: request failed\nconnection refused', executor: 'build-server',
  })
})

test('only the trailing executor line is metadata; terminal escapes are stripped', () => {
  expect(taskRunError('Executor: in the message\nstill an error').executor).toBe('Not recorded')
  expect(taskRunError('failed\nExecutor: \x1b[31mlaptop\x1b[0m\u202e')).toEqual({
    message: 'failed', executor: 'laptop',
  })
  expect(taskRunError('failed\nExecutor:   ').executor).toBe('Not recorded')
})
