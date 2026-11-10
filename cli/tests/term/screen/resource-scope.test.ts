import { describe, expect, test } from 'bun:test'
import { ResourceScope } from '../../../src/term/screen/resource-scope.js'

describe('partial startup resource ownership', () => {
  test('disposes only registered resources in reverse order once', () => {
    const events: number[] = []
    const scope = new ResourceScope()
    scope.add(() => events.push(1))
    scope.add(() => events.push(2))
    scope.dispose()
    scope.dispose()
    expect(events).toEqual([2, 1])
  })

  test('registration after shutdown immediately releases the resource', () => {
    const scope = new ResourceScope()
    scope.dispose()
    let released = false
    scope.add(() => { released = true })
    expect(released).toBe(true)
  })

  test('an error reporter cannot interrupt teardown', () => {
    let released = false
    const scope = new ResourceScope(() => { throw new Error('report failed') })
    scope.add(() => { released = true })
    scope.add(() => { throw new Error('dispose failed') })
    expect(() => scope.dispose()).not.toThrow()
    expect(released).toBe(true)
  })

  test('a failing disposer cannot prevent remaining cleanup', () => {
    const events: string[] = []
    const scope = new ResourceScope(() => events.push('error'))
    scope.add(() => events.push('release'))
    scope.add(() => { throw new Error('failed') })
    scope.dispose()
    expect(events).toEqual(['error', 'release'])
  })
})
