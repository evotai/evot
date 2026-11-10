import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'
import { displayWidth, clipDisplayText } from '../../src/ui/format.js'

const CLAIMED_RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [0x3000, 0x3029, 2],
  [0x3030, 0x303e, 2],
  [0x3041, 0x3096, 2],
  [0x30a0, 0x30ff, 2],
  [0x3400, 0x4dbf, 2],
  [0x4e00, 0x9fff, 2],
  [0xac00, 0xd7a3, 2],
  [0xf900, 0xfaff, 2],
  [0xff01, 0xff60, 2],
  [0xffe0, 0xffe6, 2],
  [0x0020, 0x007e, 1],
  [0x00a1, 0x00ac, 1],
  [0x00ae, 0x00ff, 1],
  [0x0100, 0x017f, 1],
  [0x2010, 0x2029, 1],
  [0x202f, 0x205e, 1],
]

describe('display width fast path', () => {
  test('every claimed code point matches string-width alone and in context', () => {
    const bases = ['中', 'A', 'あ', '한', '㽳']
    const mismatches: string[] = []
    let checked = 0
    for (const [lo, hi, expected] of CLAIMED_RANGES) {
      for (let cp = lo; cp <= hi; cp++) {
        const ch = String.fromCodePoint(cp)
        checked++
        if (displayWidth(ch) !== stringWidth(ch) || displayWidth(ch) !== expected) {
          if (mismatches.length < 10) {
            mismatches.push(`U+${cp.toString(16).toUpperCase()} alone: fast=${displayWidth(ch)} ref=${stringWidth(ch)} claimed=${expected}`)
          }
          continue
        }
        for (const base of bases) {
          const pair = base + ch
          if (displayWidth(pair) !== stringWidth(pair)) {
            if (mismatches.length < 10) {
              mismatches.push(`U+${cp.toString(16).toUpperCase()} after ${base}: fast=${displayWidth(pair)} ref=${stringWidth(pair)}`)
            }
            break
          }
        }
      }
    }
    expect(mismatches).toEqual([])
    expect(checked).toBeGreaterThan(40_000)
  })

  test('excluded ranges still defer to string-width', () => {
    for (const cp of [0x1100, 0x1160, 0x115f, 0x3099, 0x309a, 0x302a, 0x00ad]) {
      const ch = String.fromCodePoint(cp)
      expect(displayWidth(ch)).toBe(stringWidth(ch))
    }
  })

  test('a combining mark after a base character is measured correctly', () => {
    for (const mark of ['\u302e', '\u302f', '\u3099', '\u309a']) {
      for (const base of ['中', 'A', 'あ', '㽳']) {
        const pair = base + mark
        expect(displayWidth(pair)).toBe(stringWidth(pair))
      }
    }
  })

  test('agrees with string-width on mixed and exotic strings', () => {
    const samples = [
      '',
      'plain ascii text',
      '现在粘贴大的图片到输入框',
      'commit and push to remote main … 现在粘贴大的图',
      'rawpic是我家楼的周边情况原始照片，你分析下',
      'ひらがなカタカナ混在',
      '한글 음절 텍스트',
      'ＦＵＬＬＷＩＤＴＨ',
      'emoji 👍 mixed 🎉 in text',
      '👨‍👩‍👧‍👦 family zwj sequence',
      'combining e\u0301 accent',
      'flag 🇯🇵 sequence',
      'keycap 1\u20e3',
      '\u200bzero width space',
      'देवनागरी script',
      'العربية text',
      'tab\tseparated',
      '…—–“”‘’·×éü',
      'mixed 中文 and English 混排 text',
    ]
    for (const sample of samples) {
      expect(displayWidth(sample)).toBe(stringWidth(sample))
    }
  })

  test('agrees with string-width on random code point soup', () => {
    let seed = 12345
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 3000; i++) {
      let s = ''
      const len = 1 + Math.floor(rand() * 8)
      for (let j = 0; j < len; j++) {
        const pick = rand()
        let cp: number
        if (pick < 0.4) {
          const [lo, hi] = CLAIMED_RANGES[Math.floor(rand() * CLAIMED_RANGES.length)]!
          cp = rand() < 0.5 ? lo - 1 + Math.floor(rand() * 3) : hi - 1 + Math.floor(rand() * 3)
        } else {
          cp = 0x20 + Math.floor(rand() * 0xfff0)
        }
        if (cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0x41
        s += String.fromCodePoint(cp)
      }
      if (displayWidth(s) !== stringWidth(s)) {
        throw new Error(`disagreement on ${JSON.stringify(s)}: fast=${displayWidth(s)} string-width=${stringWidth(s)}`)
      }
    }
  })
})

describe('clipDisplayText after the single-pass rewrite', () => {
  test('never exceeds the column budget', () => {
    for (const sample of ['中'.repeat(50), 'a'.repeat(50), '现在粘贴大的图片到输入框']) {
      for (const n of [0, 1, 2, 8, 30]) {
        expect(displayWidth(clipDisplayText(sample, n))).toBeLessThanOrEqual(n)
      }
    }
  })

  test('returns text unchanged when it already fits', () => {
    expect(clipDisplayText('中文', 10)).toBe('中文')
    expect(clipDisplayText('short', 10)).toBe('short')
  })

  test('a zero budget yields nothing', () => {
    expect(clipDisplayText('anything', 0)).toBe('')
  })
})
