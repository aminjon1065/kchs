import { describe, expect, it } from 'vitest'
import { AssigneeSyntaxError, checkAssignee, formatAssignee, parseAssignee } from '../src/index.js'

const ID = '11111111-1111-4111-8111-111111111111'

describe('разбор выражений назначений', () => {
  it.each([
    [`user:${ID}`, { kind: 'user', id: ID }],
    [`group:${ID}`, { kind: 'group', id: ID }],
    [`unit:${ID}`, { kind: 'unit', id: ID }],
    ['role:registrar', { kind: 'role', key: 'registrar' }],
    ['role_in_space:legal', { kind: 'role_in_space', key: 'legal' }],
    ['var:signer', { kind: 'var', name: 'signer' }],
    ['field:responsible_id', { kind: 'field', path: ['responsible_id'] }],
    ['field:card.controller', { kind: 'field', path: ['card', 'controller'] }],
    ['author', { kind: 'author' }],
    ['author.unit', { kind: 'author_unit' }],
    ['initiator', { kind: 'initiator' }],
    ['chosen_by_initiator', { kind: 'chosen_by_initiator' }],
    ['previous_step.assignees', { kind: 'previous_step' }],
    ['step.assignee', { kind: 'step_assignees' }],
    ['unit_head(author.unit)', { kind: 'unit_head', unit: { kind: 'author_unit' } }],
    ['manager(author)', { kind: 'manager', of: { kind: 'author' } }],
    [
      'manager(unit_head(author.unit))',
      { kind: 'manager', of: { kind: 'unit_head', unit: { kind: 'author_unit' } } },
    ],
    ["unit_head('FIN')", { kind: 'unit_head', unit: { kind: 'unit_code', code: 'FIN' } }],
    // Запись через вызов из 02-platform-kernel.md
    ["role_in_space('legal')", { kind: 'role_in_space', key: 'legal' }],
    ["field('responsible')", { kind: 'field', path: ['responsible'] }],
    ['  manager( author )  ', { kind: 'manager', of: { kind: 'author' } }],
  ])('%s', (source, expected) => {
    expect(parseAssignee(source)).toMatchObject(expected)
  })

  it('каноническая запись', () => {
    expect(formatAssignee(parseAssignee("role_in_space('legal')"))).toBe('role_in_space:legal')
    expect(formatAssignee(parseAssignee('manager( unit_head( author.unit ) )'))).toBe(
      'manager(unit_head(author.unit))',
    )
    expect(formatAssignee(parseAssignee(`USER:${ID}`.toLowerCase()))).toBe(`user:${ID}`)
  })

  it.each([
    ['', 'Пустое выражение', 0],
    ['user:42', '«42» — не идентификатор', 5],
    ['boss', 'Неизвестное выражение «boss»', 0],
    ['author.boss', 'Неизвестное выражение «author.boss»', 0],
    ['manager(author', 'Ожидалось «)», а встретилось конец выражения', 14],
    ['head(author)', 'Неизвестная функция «head»', 0],
    ['position:chief', 'Неизвестный вид «position:»', 0],
    ['author author', 'Лишнее «author»', 7],
    ['var:', 'После «var:» ожидается значение', 4],
    ["unit_head('FIN)", 'Строка не закрыта кавычкой', 10],
    ['role:Юрист', '«Юрист» — не ключ роли', 5],
  ])('ошибка «%s»', (source, message, position) => {
    let error: unknown
    try {
      parseAssignee(source)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AssigneeSyntaxError)
    expect((error as AssigneeSyntaxError).message).toBe(message)
    expect((error as AssigneeSyntaxError).position).toBe(position)
  })
})

describe('проверка смысла назначений', () => {
  const variables = {
    signer: { type: 'user' },
    reviewers: { type: 'users' },
    department: { type: 'unit' },
    board: { type: 'group' },
    note: { type: 'text' },
  }

  it.each([
    'var:signer',
    'var:reviewers',
    'var:board',
    'var:department',
    'unit_head(var:department)',
    'unit_head(field:unit_id)',
    `unit_head(unit:${ID})`,
    'manager(var:signer)',
    'manager(role:registrar)',
    'author.unit',
  ])('допустимо: %s', (source) => {
    expect(checkAssignee(source, { variables }).problem).toBeNull()
  })

  it.each([
    ['var:missing', 'Нет переменной «missing»'],
    ['var:note', 'Переменная «note» не задаёт людей'],
    ['unit_head(var:signer)', 'Переменная «signer» — не подразделение'],
    ['unit_head(author)', 'unit_head ожидает подразделение, а «author» — люди'],
    ['unit_head(manager(author))', 'unit_head ожидает подразделение, а «manager(author)» — люди'],
    ["'FIN'", 'Код подразделения в кавычках допустим только в unit_head(…)'],
    ['step.assignee', 'step.assignee доступно только в таймерах'],
  ])('ошибка: %s', (source, message) => {
    expect(checkAssignee(source, { variables }).problem?.message).toBe(message)
  })

  it('step.assignee — в таймерах', () => {
    expect(checkAssignee('manager(step.assignee)', { variables, timer: true }).problem).toBeNull()
  })
})
