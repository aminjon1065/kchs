import { describe, expect, it } from 'vitest'
import { validateDefinition } from '../src/index.js'
import { CONTRACT_EXAMPLE } from './fixtures.js'

type Input = Record<string, unknown>

function route(steps: Record<string, unknown>, extra: Input = {}): Input {
  return {
    version: 1,
    key: 'test_route',
    objectType: 'document',
    name: { ru: 'Проверка' },
    start: Object.keys(steps)[0],
    steps,
    ...extra,
  }
}

function codes(input: Input): string[] {
  return validateDefinition(input)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.code} ${issue.path}`)
}

describe('проверка определения', () => {
  it('корректный маршрут с вложенными параллельными группами', () => {
    const input = route({
      fork: { type: 'parallel', branches: [['legal', 'inner'], ['finance']], next: 'sign' },
      legal: { type: 'approval', assignees: ['role_in_space:legal'], onReject: 'back' },
      inner: { type: 'parallel', branches: [['it'], ['security']], join: 'any' },
      it: { type: 'approval', assignees: ['role:it'] },
      security: { type: 'approval', assignees: ['role:security'], onReject: 'continue' },
      finance: { type: 'approval', assignees: ['role:finance'], onReject: 'end:rejected' },
      sign: { type: 'sign', assignees: ['author'], next: 'end' },
      back: { type: 'return', next: 'fork' },
      end: { type: 'end' },
    })
    expect(codes(input)).toEqual([])
  })

  it('ссылки на несуществующие шаги', () => {
    const input = route({
      a: { type: 'approval', assignees: ['author'], next: 'nowhere', onReject: 'ghost' },
      c: {
        type: 'condition',
        branches: [{ if: 'true', next: 'missing' }],
        else: 'end',
      },
      end: { type: 'end' },
    })
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        'unknown_step steps.a.next',
        'unknown_step steps.a.onReject',
        'unknown_step steps.c.branches.0.next',
      ]),
    )
  })

  it('недостижимый шаг и отсутствие завершения', () => {
    expect(
      codes(
        route({
          a: { type: 'approval', assignees: ['author'], next: 'end' },
          orphan: { type: 'notify', to: 'author', next: 'end' },
          end: { type: 'end' },
        }),
      ),
    ).toEqual(['unreachable steps.orphan'])

    expect(
      codes(
        route({
          a: { type: 'approval', assignees: ['author'], onReject: 'back', next: 'back' },
          back: { type: 'return', next: 'a' },
        }),
      ),
    ).toContain('end_required steps')
  })

  it('цикл без return — ошибка; цикл через return — нормально', () => {
    const loop = route({
      a: { type: 'approval', assignees: ['author'], next: 'b' },
      b: { type: 'condition', branches: [{ if: 'var.again', next: 'a' }], else: 'end' },
      end: { type: 'end' },
    })
    expect(codes(loop)).toContain('cycle_without_return steps.a')
    const message = validateDefinition(loop).issues.find(
      (issue) => issue.code === 'cycle_without_return',
    )?.message
    expect(message).toBe('Цикл без шага return: a → b → a')

    const viaReturn = route({
      a: { type: 'approval', assignees: ['author'], onReject: 'r', next: 'end' },
      r: { type: 'return', next: 'a' },
      end: { type: 'end' },
    })
    expect(codes(viaReturn)).toEqual([])
  })

  it('цикл, у которого есть и путь через return, и путь без него', () => {
    const input = route({
      a: { type: 'approval', assignees: ['author'], onReject: 'r', next: 'b' },
      b: { type: 'condition', branches: [{ if: 'true', next: 'a' }], else: 'end' },
      r: { type: 'return', next: 'a' },
      end: { type: 'end' },
    })
    expect(codes(input)).toContain('cycle_without_return steps.a')
  })

  it('шаг без пути к завершению', () => {
    const input = route({
      a: { type: 'approval', assignees: ['author'], onReject: 'r', next: 'end' },
      r: { type: 'return', next: 'r2' },
      r2: { type: 'return', next: 'r' },
      end: { type: 'end' },
    })
    expect(codes(input)).toEqual(
      expect.arrayContaining(['no_path_to_end steps.r', 'no_path_to_end steps.r2']),
    )
  })

  it('правила параллельных ветвей', () => {
    const input = route({
      fork: { type: 'parallel', branches: [['x', 'y'], ['x2']], next: 'end' },
      x: { type: 'approval', assignees: ['author'], next: 'end' },
      y: { type: 'return', next: 'fork' },
      x2: { type: 'approval', assignees: ['author'], onReject: 'x' },
      other: { type: 'parallel', branches: [['x2']], next: 'end' },
      jump: { type: 'notify', to: 'author', next: 'x' },
      end: { type: 'end' },
    })
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        'branch_next steps.x.next',
        'branch_step_type steps.y.type',
        'target_in_branch steps.x2.onReject',
        'branch_duplicate steps.other.branches.0.0',
        'target_in_branch steps.jump.next',
      ]),
    )
  })

  it('next обязателен у шагов верхнего уровня, else — у условия', () => {
    expect(
      codes(
        route({
          a: { type: 'approval', assignees: ['author'] },
          c: { type: 'condition', branches: [{ if: 'true', next: 'end' }] },
          end: { type: 'end' },
        }),
      ),
    ).toEqual(expect.arrayContaining(['next_required steps.a.next', 'else_required steps.c.else']))
  })

  it('выражения назначений и условий', () => {
    const input = route(
      {
        a: {
          type: 'approval',
          assignees: ['manager(author', 'var:nobody', 'unit_head(author)'],
          next: 'c',
        },
        c: {
          type: 'condition',
          branches: [{ if: 'amount > 5', next: 'end' }],
          else: 'w',
        },
        w: { type: 'wait', filter: 'event.payload.x = 1', until: 'someday', next: 'end' },
        end: { type: 'end' },
      },
      {
        conditions: [
          {
            if: 'steps.a.outcome = 1',
            insertBefore: 'end',
            step: { type: 'notify', to: 'step.assignee' },
          },
        ],
        timers: [
          { step: 'ghost', onOverdue: [{ action: 'notify', to: 'manager(step.assignee)' }] },
        ],
      },
    )
    const issues = validateDefinition(input).issues
    const byPath = Object.fromEntries(issues.map((issue) => [issue.path, issue.message]))
    expect(byPath['steps.a.assignees.0']).toBe(
      'Ожидалось «)», а встретилось конец выражения (позиция 15)',
    )
    expect(byPath['steps.a.assignees.1']).toBe('Нет переменной «nobody» (позиция 1)')
    expect(byPath['steps.a.assignees.2']).toContain('unit_head ожидает подразделение')
    expect(byPath['steps.c.branches.0.if']).toContain('Неизвестное имя «amount»')
    expect(byPath['steps.w.filter']).toBe('Фильтр задаётся вместе с событием (event)')
    expect(byPath['steps.w.until']).toBe('Срок: дата, момент ISO 8601, var:<имя> или field:<путь>')
    expect(byPath['conditions.0.if']).toContain('Неизвестное имя «steps»')
    expect(byPath['conditions.0.step.to']).toBe(
      'step.assignee доступно только в таймерах (позиция 1)',
    )
    expect(byPath['timers.0.step']).toBe('Нет шага «ghost»')
  })

  it('ожидание без события и срока', () => {
    expect(
      codes(
        route({
          w: { type: 'wait', next: 'end' },
          end: { type: 'end' },
        }),
      ),
    ).toEqual(['wait_empty steps.w'])
  })

  it('условие запуска: цель, ключ, next вставляемого шага', () => {
    const input = {
      ...CONTRACT_EXAMPLE,
      conditions: [
        {
          if: 'true',
          insertBefore: 'nowhere',
          key: 'sign',
          step: { type: 'notify', to: 'author', next: 'end' },
        },
      ],
    }
    expect(codes(input)).toEqual(
      expect.arrayContaining([
        'unknown_step conditions.0.insertBefore',
        'duplicate_key conditions.0.key',
        'inserted_next conditions.0.step.next',
      ]),
    )
  })

  it('предупреждения не мешают публикации', () => {
    const result = validateDefinition(
      route({
        a: {
          type: 'approval',
          mode: 'any',
          quorum: 2,
          assignees: ['previous_step.assignees'],
          next: 'end',
        },
        end: { type: 'end' },
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      'no_previous_step',
      'quorum_ignored',
    ])
  })

  it('ошибки схемы — с путём', () => {
    const result = validateDefinition({ ...CONTRACT_EXAMPLE, start: 42 })
    expect(result.ok).toBe(false)
    expect(result.definition).toBeNull()
    expect(result.issues[0]).toMatchObject({ path: 'start', code: 'schema', severity: 'error' })
  })
})
