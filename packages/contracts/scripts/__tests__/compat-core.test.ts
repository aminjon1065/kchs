import { describe, expect, it } from 'vitest'
import { compareApi, compareEvents } from '../compat-core.mjs'

type Schema = Record<string, unknown>
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const str = { type: 'string' }
const num = { type: 'number' }
const event = (schema: Schema, version = 1) => ({ version, schema })
const kinds = (result: { errors: Array<{ kind: string }> }) => result.errors.map((e) => e.kind)

/** Правила совместимости контрактов (ADR-0189). */
describe('совместимость событий', () => {
  const base = { 'x.done': event(obj({ id: str, title: str })) }

  it('без изменений и с новым необязательным полем — совместимо', () => {
    expect(compareEvents(base, base, {}).errors).toEqual([])
    const added = { 'x.done': event(obj({ id: str, title: str, note: str }, ['id', 'title'])) }
    expect(compareEvents(base, added, {}).errors).toEqual([])
  })

  it('удалённое поле, новое обязательное, смена типа, необязательность — ломают', () => {
    expect(kinds(compareEvents(base, { 'x.done': event(obj({ id: str })) }, {}))).toEqual([
      'поле удалено',
    ])
    expect(
      kinds(compareEvents(base, { 'x.done': event(obj({ id: str, title: str, at: str })) }, {})),
    ).toEqual(['новое обязательное поле'])
    expect(
      kinds(compareEvents(base, { 'x.done': event(obj({ id: str, title: num })) }, {})),
    ).toEqual(['тип сузился', 'тип расширился'])
    expect(
      kinds(compareEvents(base, { 'x.done': event(obj({ id: str, title: str }, ['id'])) }, {})),
    ).toEqual(['поле стало необязательным'])
  })

  it('удалённое событие ломает; с повышенной версией изменение допускается', () => {
    expect(kinds(compareEvents(base, {}, {}))).toEqual(['событие удалено'])
    const bumped = compareEvents(base, { 'x.done': event(obj({ id: str }), 2) }, {})
    expect(bumped.errors).toEqual([])
    expect(bumped.notes.join(' ')).toContain('версия 1 → 2')
    expect(kinds(compareEvents({ 'x.done': event(obj({ id: str }), 2) }, base, {}))).toEqual([
      'версия уменьшилась',
    ])
  })

  it('исключение со ссылкой на ADR пропускает ломающее изменение; ненужное — в заметках', () => {
    const result = compareEvents(
      base,
      { 'x.done': event(obj({ id: str })) },
      {
        'x.done': 'ADR-0189: проверка',
      },
    )
    expect(result.errors).toEqual([])
    expect(result.permitted).toHaveLength(1)
    const unused = compareEvents(base, base, { 'x.done': 'ADR-0189: проверка' })
    expect(unused.notes.join(' ')).toContain('исключения не понадобились')
  })

  it('формат, ограничения, список значений, убранный вариант — ломают', () => {
    const one = (field: Schema) => ({ 'x.done': event(obj({ id: str, title: field })) })
    const change = (from: Schema, to: Schema) => kinds(compareEvents(one(from), one(to), {}))
    expect(change({ type: 'string', format: 'uuid' }, { type: 'string', format: 'email' })).toEqual(
      ['формат сменился'],
    )
    expect(change(str, { type: 'string', maxLength: 10 })).toEqual(['ограничение ужесточилось'])
    expect(change({ type: 'string', maxLength: 10 }, { type: 'string', maxLength: 20 })).toEqual([])
    expect(change(str, { type: 'string', enum: ['a', 'b'] })).toEqual(['значения ограничены'])
    // Новое значение перечисления — не поломка: получатель терпит незнакомые значения
    expect(change({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] })).toEqual(
      [],
    )
    expect(change({ anyOf: [str, num, { type: 'boolean' }] }, { anyOf: [str, num] })).toEqual([
      'тип сузился',
      'вариант убран',
    ])
  })

  it('nullable-обёртка: поля внутри сравниваются', () => {
    const wrap = (inner: Schema) => ({ anyOf: [inner, { type: 'null' }] })
    const was = { 'x.done': event(obj({ id: str, meta: wrap(obj({ a: str })) })) }
    const now = { 'x.done': event(obj({ id: str, meta: obj({ a: str, b: str }) })) }
    expect(compareEvents(was, now, {}).errors.map((e) => `${e.path}: ${e.kind}`)).toEqual([
      'meta: тип сузился',
      'meta.b: новое обязательное поле',
    ])
  })
})

describe('совместимость API', () => {
  const op = (body: Schema | null, response: Schema, parameters: Schema[] = []) => ({
    parameters,
    body: body ? { required: true, content: { 'application/json': body } } : null,
    responses: { '200': { 'application/json': response } },
  })
  const api = (operations: Record<string, unknown>, defs: Record<string, unknown> = {}) => ({
    operations,
    defs,
  })
  const base = api({ 'POST /x': op(obj({ name: str }), obj({ id: str, name: str })) })

  it('новое необязательное поле тела и ответа, новая операция — совместимо', () => {
    const current = api({
      'POST /x': op(
        obj({ name: str, note: str }, ['name']),
        obj({ id: str, name: str, extra: str }, ['id', 'name']),
      ),
      'GET /x': op(null, obj({ id: str })),
    })
    expect(compareApi(base, current, {}).errors).toEqual([])
  })

  it('удалённая операция, поле ответа, новое обязательное поле тела — ломают', () => {
    expect(kinds(compareApi(base, api({}), {}))).toEqual(['операция удалена'])
    expect(
      kinds(compareApi(base, api({ 'POST /x': op(obj({ name: str }), obj({ id: str })) }), {})),
    ).toEqual(['поле удалено'])
    expect(
      kinds(
        compareApi(
          base,
          api({ 'POST /x': op(obj({ name: str, code: str }), obj({ id: str, name: str })) }),
          {},
        ),
      ),
    ).toEqual(['новое обязательное поле'])
  })

  it('поле ответа стало nullable — ломает читающих; новый обязательный параметр — пишущих', () => {
    const nullable = { anyOf: [str, { type: 'null' }] }
    expect(
      kinds(
        compareApi(
          base,
          api({ 'POST /x': op(obj({ name: str }), obj({ id: str, name: nullable })) }),
          {},
        ),
      ),
    ).toEqual(['тип расширился'])
    const param = { in: 'query', name: 'q', required: true, schema: str }
    expect(
      kinds(
        compareApi(
          base,
          api({ 'POST /x': op(obj({ name: str }), obj({ id: str, name: str }), [param]) }),
          {},
        ),
      ),
    ).toEqual(['новый обязательный параметр'])
  })

  it('общие схемы разворачиваются: ссылка и та же схема на месте — без различий', () => {
    const shared = api(
      { 'POST /x': op({ $ref: 'body1' }, { $ref: 'resp1' }) },
      { body1: obj({ name: str }), resp1: obj({ id: str, name: str }) },
    )
    expect(compareApi(shared, base, {}).errors).toEqual([])
    expect(compareApi(base, shared, {}).errors).toEqual([])
  })
})
