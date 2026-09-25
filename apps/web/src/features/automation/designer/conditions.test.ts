import { describe, expect, it } from 'vitest'
import { conditionText, fromConditionNode, toConditionNode } from './conditions.js'

describe('условия правила в конструкторе', () => {
  const tree = {
    and: [
      { expr: "contains(path, 'TJ')" },
      {
        or: [
          { and: [{ expr: 'magnitude >= 4' }, { expr: 'age < 24' }] },
          { expr: "level in ('orange', 'red')" },
        ],
      },
      { not: { expr: 'muted' } },
    ],
  }

  it('группы «все» / «любое» и «не» — узлами, туда и обратно без потери смысла', () => {
    const root = toConditionNode(tree)
    expect(root).toMatchObject({ kind: 'group', op: 'and', negated: false })
    expect(root.kind === 'group' && root.items[1]).toMatchObject({ kind: 'group', op: 'or' })
    expect(root.kind === 'group' && root.items[2]).toEqual({
      kind: 'expr',
      expr: 'muted',
      negated: true,
    })
    expect(fromConditionNode(root)).toEqual(tree)
  })

  it('пустые строки и группы отбрасываются, группа из одного — сам узел', () => {
    expect(toConditionNode(null)).toEqual({ kind: 'group', op: 'and', items: [], negated: false })
    expect(fromConditionNode(toConditionNode(null))).toBeNull()
    expect(
      fromConditionNode({
        kind: 'group',
        op: 'or',
        negated: false,
        items: [
          { kind: 'expr', expr: ' ', negated: false },
          { kind: 'expr', expr: 'a = 1', negated: false },
          { kind: 'group', op: 'and', items: [], negated: true },
        ],
      }),
    ).toEqual({ expr: 'a = 1' })
    // Отрицание корня: корень — всегда группа, отрицание остаётся у её единственного узла
    expect(toConditionNode({ not: { or: [{ expr: 'a' }, { expr: 'b' }] } })).toMatchObject({
      kind: 'group',
      op: 'and',
      items: [{ kind: 'group', op: 'or', negated: true }],
    })
  })

  it('дерево одной строкой — со скобками там, где они меняют смысл', () => {
    const nested = {
      or: [{ and: [{ expr: 'x > 1' }, { not: { expr: 'y = 2' } }] }, { expr: 'z = 3 or x = 0' }],
    }
    expect(conditionText(nested)).toBe('(x > 1 and not y = 2) or (z = 3 or x = 0)')
  })
})
