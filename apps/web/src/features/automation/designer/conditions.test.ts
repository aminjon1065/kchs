import { describe, expect, it } from 'vitest'
import { conditionList, conditionOf, conditionText } from './conditions.js'

describe('условия правила в конструкторе', () => {
  it('верхнее «и» — строками, вложенные «или» и «не» — одной строкой со скобками', () => {
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
    expect(conditionList(tree)).toEqual([
      "contains(path, 'TJ')",
      "(magnitude >= 4 and age < 24) or level in ('orange', 'red')",
      'not muted',
    ])
    expect(conditionList(null)).toEqual([])
    expect(conditionList({ or: [{ expr: 'a = 1 or b = 2' }, { expr: 'c = 3' }] })).toEqual([
      '(a = 1 or b = 2) or c = 3',
    ])
  })

  it('строки обратно в дерево: одно выражение с теми же скобками', () => {
    const tree = {
      or: [{ and: [{ expr: 'x > 1' }, { not: { expr: 'y = 2' } }] }, { expr: 'z = 3 or x = 0' }],
    }
    expect(conditionText(tree)).toBe('(x > 1 and not y = 2) or (z = 3 or x = 0)')
    expect(conditionOf(conditionList(tree))).toEqual({ expr: conditionText(tree) })
    expect(conditionOf(['a = 1', ' ', 'b = 2'])).toEqual({
      and: [{ expr: 'a = 1' }, { expr: 'b = 2' }],
    })
  })
})
