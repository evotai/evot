import { expect, test } from 'bun:test'
import { prepareResume } from '../../../src/term/app/session/prepare-resume.js'
import type { SessionMeta } from '../../../src/native/contracts/results.js'
import fixtures from '../../fixtures/contracts/native-results-legacy.json'

const full: SessionMeta = { ...fixtures.session, provider: 'fixture', thinking_level: 'high' }

test('resume preparation fills only missing fields without changing caller data', async () => {
  const partial = { ...full, model: '', cwd: '', thinking_level: null }
  const before = JSON.stringify(partial)
  const result = await prepareResume({ loadResumeTranscript: async () => [], findSession: async () => full }, partial)
  expect(result.model).toBe(full.model)
  expect(result.cwd).toBe(full.cwd)
  expect(result.thinkingLevel).toBeNull()
  expect(JSON.stringify(partial)).toBe(before)
})

test('complete metadata does not trigger an extra lookup', async () => {
  const transcript = [{ future: true }]
  const result = await prepareResume({ loadResumeTranscript: async () => transcript, findSession: async () => { throw new Error('unexpected lookup') } }, full)
  expect(result.transcript).toBe(transcript)
  expect(result.thinkingLevel).toBe('high')
})

test('read failures propagate before any session switch and missing records are tolerated', async () => {
  await expect(prepareResume({ loadResumeTranscript: async () => { throw new Error('read failed') }, findSession: async () => full }, full)).rejects.toThrow('read failed')
  const result = await prepareResume({ loadResumeTranscript: async () => [], findSession: async () => null }, fixtures.session)
  expect(result.provider).toBeUndefined()
  expect(result.model).toBe(fixtures.session.model)
})
