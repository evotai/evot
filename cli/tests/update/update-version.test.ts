import { describe, expect, test } from 'bun:test'
import { compareVersions, isNewer, isPrerelease, parseVersion } from '../../src/update/version.js'

describe('parseVersion', () => {
  test('parses CalVer with any number of segments', () => {
    expect(parseVersion('2026.4.13')).toEqual({ release: [2026n, 4n, 13n], prerelease: [] })
    expect(parseVersion('2026.4.13.2')).toEqual({ release: [2026n, 4n, 13n, 2n], prerelease: [] })
  })

  test('parses prerelease tails', () => {
    expect(parseVersion('2026.4.13-beta.1')).toEqual({
      release: [2026n, 4n, 13n],
      prerelease: ['beta', '1'],
    })
  })

  test('tolerates a leading v and strips build metadata', () => {
    expect(parseVersion('v2026.4.13')).toEqual({ release: [2026n, 4n, 13n], prerelease: [] })
    expect(parseVersion('2026.4.13+cached')).toEqual({ release: [2026n, 4n, 13n], prerelease: [] })
  })

  test('rejects unorderable input', () => {
    for (const bad of ['', '   ', 'nightly', '2026..13', '2026.x.13', '2026.4.13-', undefined, null]) {
      expect(parseVersion(bad as string)).toBeNull()
    }
  })

  test('rejects prerelease identifiers with leading zeros', () => {
    expect(parseVersion('2026.4.13-beta.007')).toBeNull()
  })
})

describe('compareVersions', () => {
  test('orders release segments numerically, not lexically', () => {
    expect(compareVersions('2026.4.13', '2026.10.1')).toBe(-1)
    expect(compareVersions('2026.10.1', '2026.4.13')).toBe(1)
  })

  test('treats missing trailing segments as zero', () => {
    expect(compareVersions('2026.4.13', '2026.4.13.0')).toBe(0)
    expect(compareVersions('2026.4.13', '2026.4.13.1')).toBe(-1)
  })

  test('sorts a prerelease before its own release', () => {
    expect(compareVersions('2026.4.13-beta.1', '2026.4.13')).toBe(-1)
    expect(compareVersions('2026.4.13', '2026.4.13-beta.1')).toBe(1)
  })

  test('compares numeric prerelease identifiers numerically', () => {
    expect(compareVersions('2026.4.13-beta.2', '2026.4.13-beta.10')).toBe(-1)
  })

  test('keeps long numeric identifiers exact beyond Number precision', () => {
    expect(
      compareVersions('2026.4.13-beta.9007199254740992', '2026.4.13-beta.9007199254740993'),
    ).toBe(-1)
  })

  test('sorts numeric identifiers before alphanumeric ones', () => {
    expect(compareVersions('2026.4.13-beta.1', '2026.4.13-beta.rc')).toBe(-1)
  })

  test('a shorter prerelease chain sorts first', () => {
    expect(compareVersions('2026.4.13-beta', '2026.4.13-beta.1')).toBe(-1)
  })

  test('treats unparseable input as the older side', () => {
    expect(compareVersions('garbage', '2026.4.13')).toBe(-1)
    expect(compareVersions('2026.4.13', 'garbage')).toBe(1)
    expect(compareVersions('garbage', 'also-garbage')).toBe(0)
  })
})

describe('isNewer', () => {
  test('offers stable releases to beta users in the same month', () => {
    // The previous numeric-split implementation returned false for all of
    // these: Number("13-beta") is NaN, so every comparison fell through.
    expect(isNewer('2026.4.13-beta.1', '2026.4.13')).toBe(true)
    expect(isNewer('2026.4.13-beta.1', '2026.4.20')).toBe(true)
    expect(isNewer('2026.4.13-beta.9', '2026.4.20')).toBe(true)
  })

  test('does not offer an older release to a newer install', () => {
    expect(isNewer('2026.4.20', '2026.4.13')).toBe(false)
    expect(isNewer('2026.4.13', '2026.4.13')).toBe(false)
    expect(isNewer('2026.4.13', '2026.4.13-beta.1')).toBe(false)
  })

  test('never offers an unnameable remote version', () => {
    expect(isNewer('2026.4.13', 'nightly')).toBe(false)
    expect(isNewer('garbage', 'garbage')).toBe(false)
  })

  test('offers a real release to an unreadable local version', () => {
    expect(isNewer('unknown', '2026.4.13')).toBe(true)
  })
})

describe('isPrerelease', () => {
  test('detects beta builds', () => {
    expect(isPrerelease('2026.4.13-beta.1')).toBe(true)
    expect(isPrerelease('2026.4.13')).toBe(false)
    expect(isPrerelease('garbage')).toBe(false)
  })
})
