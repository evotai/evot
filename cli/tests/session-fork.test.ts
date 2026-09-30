import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { SessionMeta } from '../src/native/index.js'
import { formatForkTrail, forkTrailTitles, sessionLabel } from '../src/term/viewmodel/fork-trail.js'
import { backNotice, exitLineageHint, forkNotice, resolveBackTarget } from '../src/term/app/fork-nav.js'
import { orderAsForkTree } from '../src/term/app/fork-tree.js'
import { formatSessionItems } from '../src/term/app/resume.js'
import { blocksToLines } from '../src/term/viewmodel/types.js'
import { buildPromptBlocks, type PromptVMInput } from '../src/term/viewmodel/prompt.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { parseArgs, argvForRestart } from '../src/cli.js'
import * as results from '../src/native/contracts/results.js'

function meta(id: string, title: string, parent?: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: id, title, model: 'm', cwd: '/work', source: 'repl', turns: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...(parent ? { parent_session_id: parent } : {}),
    ...extra,
  }
}

const identity = (text: string) => text
const root = meta('aaaaaaaa-0000', '重构 session 存储')
const child = meta('bbbbbbbb-0000', '抽 Storage trait', root.session_id)
const grandchild = meta('cccccccc-0000', '修测试 helper', child.session_id)
const lineage = [root, child, grandchild]

describe('fork trail', () => {
  test('roots and unknown sessions render no trail', () => {
    expect(forkTrailTitles([])).toEqual([])
    expect(forkTrailTitles([root])).toEqual([])
    expect(formatForkTrail(['only'], 80)).toBe('')
  })

  test('custom title beats automatic title beats id', () => {
    expect(sessionLabel(meta('12345678-x', 'auto', undefined, { custom_title: 'mine' }))).toBe('mine')
    expect(sessionLabel(meta('12345678-x', 'auto'))).toBe('auto')
    expect(sessionLabel(meta('12345678-x', '', undefined, { title: null }))).toBe('12345678')
  })

  test('names only the parent, whatever the depth', () => {
    expect(formatForkTrail(['root', 'child'], 80)).toBe('fork of root')
    expect(formatForkTrail(['root', 'child', 'grandchild'], 80)).toBe('fork of child')
    expect(formatForkTrail(['a', 'b'], 0)).toBe('')
  })

  test('long parent titles are cut, never the label', () => {
    const long = 'feishu 我和 winter 昨天讨论的一个subaent需求，看看他是什么'
    const text = formatForkTrail([long, 'child'], 200)
    expect(text.startsWith('fork of ')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
    expect(stringWidth(text)).toBeLessThanOrEqual(48)
    const tight = formatForkTrail([long, 'child'], 20)
    expect(stringWidth(tight)).toBeLessThanOrEqual(20)
    expect(formatForkTrail([long, 'child'], 6)).toBe('fork')
  })
})

describe('fork trail row', () => {
  function prompt(overrides: Partial<PromptVMInput> = {}): string[] {
    const input: PromptVMInput = {
      lines: [''], cursorLine: 0, cursorCol: 0, active: true, completion: null, ghostHint: '',
      columns: 120, rows: 24, placeholder: true, exitHint: false,
      model: 'sonnet', provider: '', thinkingLevel: '', planning: false, logMode: false,
      dashboardUrl: null, cwd: '/work', gitBranch: 'main', contextTokens: 0, contextWindow: 0,
      backgroundProcessCount: 0, backgroundPanelDownAvailable: false, ...overrides,
    }
    return blocksToLines(buildPromptBlocks(input)).map(l => stripAnsi(l).replaceAll(CURSOR_MARKER, ''))
  }
  const statusIndex = (lines: string[]) => lines.findIndex(l => l.includes('/work (main)'))

  test('a session that never forked looks unchanged', () => {
    const plain = prompt()
    expect(plain.join('\n')).not.toContain('└─')
    expect(prompt({ forkTrail: [] })).toEqual(plain)
  })

  test('the fork row sits right under the status line and names the parent', () => {
    const lines = prompt({ forkTrail: forkTrailTitles(lineage) })
    const at = statusIndex(lines)
    expect(at).toBeGreaterThan(0)
    expect(lines[at]).not.toContain('└─')
    expect(lines[at + 1]).toBe('└─ fork of 抽 Storage trait')
    expect(lines.length).toBe(prompt().length + 1)
  })

  test('the row stays inside a narrow terminal', () => {
    const lines = prompt({ forkTrail: forkTrailTitles(lineage), columns: 24 })
    const row = lines[statusIndex(lines) + 1] ?? ''
    expect(row.startsWith('└─ fork')).toBe(true)
    expect(stringWidth(row)).toBeLessThanOrEqual(24)
  })
})

describe('/back resolution', () => {
  test('root has nowhere to go', () => {
    expect(resolveBackTarget([root], '')).toEqual({ kind: 'root' })
    expect(resolveBackTarget([], '')).toEqual({ kind: 'root' })
  })

  test('defaults to one level and clamps to the root', () => {
    const one = resolveBackTarget(lineage, '')
    expect(one.kind === 'move' && one.target.session_id).toBe(child.session_id)
    expect(one.kind === 'move' && one.skipped).toEqual([])
    const two = resolveBackTarget(lineage, '2')
    expect(two.kind === 'move' && two.target.session_id).toBe(root.session_id)
    expect(two.kind === 'move' && two.skipped.map(s => s.session_id)).toEqual([child.session_id])
    const far = resolveBackTarget(lineage, '99')
    expect(far.kind === 'move' && far.target.session_id).toBe(root.session_id)
    const toRoot = resolveBackTarget(lineage, 'root')
    expect(toRoot.kind === 'move' && toRoot.target.session_id).toBe(root.session_id)
  })

  test('refuses arguments it cannot interpret', () => {
    expect(resolveBackTarget(lineage, '0')).toEqual({ kind: 'invalid', levels: '0' })
    expect(resolveBackTarget(lineage, 'up')).toEqual({ kind: 'invalid', levels: 'up' })
  })
})

describe('notices', () => {
  test('fork notice names both sides and the way back', () => {
    const lines = forkNotice(child, root, identity, identity).map(l => l.text)
    expect(lines[0]).toContain('Forked → 抽 Storage trait  (bbbbbbbb)')
    expect(lines[1]).toContain('from     重构 session 存储  (aaaaaaaa)')
    expect(lines[2]).toContain(`/back  ·  evot --resume ${root.session_id}`)
  })

  test('back notice lists skipped levels so nothing is forgotten', () => {
    const lines = backNotice(grandchild, root, [child], identity, identity).map(l => l.text)
    expect(lines[0]).toContain('Back from 修测试 helper')
    expect(lines.some(l => l.includes('skipped  抽 Storage trait') && l.includes(`--resume ${child.session_id}`))).toBe(true)
    expect(lines.some(l => l.includes(`return   evot --resume ${grandchild.session_id}`))).toBe(true)
    expect(lines.at(-1)).toContain('now      重构 session 存储')
  })

  test('exit hint shows parent and root once each', () => {
    expect(exitLineageHint([root])).toEqual([])
    expect(exitLineageHint([root, child])).toEqual([`Parent: evot --resume ${root.session_id}  重构 session 存储`])
    const deep = exitLineageHint(lineage)
    expect(deep).toHaveLength(2)
    expect(deep[0]).toContain(child.session_id)
    expect(deep[1]).toContain(root.session_id)
  })
})

describe('fork tree in /sessions', () => {
  test('children follow their parent depth-first; orphans are roots', () => {
    const other = meta('dddddddd-0000', 'unrelated')
    const orphan = meta('eeeeeeee-0000', 'orphan', 'gone-parent')
    const rows = orderAsForkTree([other, grandchild, child, orphan, root])
    expect(rows.map(r => [r.session.session_id, r.depth])).toEqual([
      [other.session_id, 0],
      [orphan.session_id, 0],
      [root.session_id, 0],
      [child.session_id, 1],
      [grandchild.session_id, 2],
    ])
  })

  test('edges draw a git-log style graph', () => {
    const second = meta('ffffffff-0000', 'second fork', root.session_id)
    const deeper = meta('99999999-0000', 'under second', second.session_id)
    const rows = orderAsForkTree([root, child, grandchild, second, deeper])
    expect(rows.map(r => `${r.edge}${r.session.session_id.slice(0, 8)}`)).toEqual([
      'aaaaaaaa',
      '├─ bbbbbbbb',
      '│  └─ cccccccc',
      '└─ ffffffff',
      '   └─ 99999999',
    ])
  })

  test('cyclic links still list every session', () => {
    const a = meta('a', 'a', 'b')
    const b = meta('b', 'b', 'a')
    expect(orderAsForkTree([a, b]).map(r => r.session.session_id).sort()).toEqual(['a', 'b'])
  })

  test('resume rows lead with title and retain graph edges and real ids', () => {
    const rows = formatSessionItems([grandchild, child, root], '/work').filter(i => !i.header)
    expect(rows.map(i => i.label)).toEqual(['重构 session 存储', '└─ 抽 Storage trait', '   └─ 修测试 helper'])
    const details = rows.map(i => stripAnsi(i.detail ?? ''))
    expect(details[1]).toContain('bbbbbbbb')
    expect(details.join('\n')).not.toContain('⑂')
    // Selecting a row still resolves to the real id.
    expect(rows.map(i => i.id)).toEqual([root.session_id, child.session_id, grandchild.session_id])
  })
})

describe('--fork flag', () => {
  test('takes an optional session id', async () => {
    expect((await parseArgs(['--fork'])).fork).toEqual({})
    expect((await parseArgs(['--fork', 'abc123'])).fork).toEqual({ sessionId: 'abc123' })
    expect((await parseArgs(['--fork', '--port', '9000'])).fork).toEqual({})
  })

  test('restart drops --fork and pins --resume', () => {
    expect(argvForRestart(['--fork', 'abc', '--model', 'm'], 'sid')).toEqual(['--model', 'm', '--resume', 'sid'])
    expect(argvForRestart(['--fork'], 'sid')).toEqual(['--resume', 'sid'])
  })
})

describe('SessionMeta contract', () => {
  test('reads metadata with and without fork fields', () => {
    const legacy = results.sessionMeta.read({
      session_id: 's', cwd: '/w', model: 'm', title: null, turns: 0, created_at: '', updated_at: '',
    }, 'meta')
    expect(legacy.parent_session_id).toBeUndefined()
    const forked = results.sessionMeta.read({
      session_id: 's', cwd: '/w', model: 'm', title: null, turns: 0, created_at: '', updated_at: '',
      parent_session_id: 'p', fork_seq: 4,
    }, 'meta')
    expect(forked.parent_session_id).toBe('p')
    expect(forked.fork_seq).toBe(4)
  })
})
