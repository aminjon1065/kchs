import { describe, expect, it } from 'vitest'
import { compileQuery, QueryCompileError } from '../src/index.js'
import { ctx, q, src } from './fixtures.js'

/**
 * Шаг `unpivot` и функция `cast()` (ADR-0106): столбцы в строки одним
 * `CROSS JOIN LATERAL (VALUES …)` и безопасное приведение типа, при котором
 * негодное значение становится пустым, а не рушит весь запрос.
 */
describe('шаг unpivot', () => {
  it('разворачивает столбцы в пары «имя, значение»', () => {
    const compiled = compileQuery(
      q(src('inc'), [
        {
          type: 'unpivot',
          keep: ['inc.title'],
          fields: ['inc.victims', 'inc.ratio'],
          nameField: 'metric',
          valueField: 'value',
          dropNulls: true,
        },
      ]),
      ctx(),
    )
    expect(compiled.sql).toContain('CROSS JOIN LATERAL (VALUES')
    expect(compiled.sql).toContain('IS NOT NULL')
    expect(compiled.fields.map((field) => field.name)).toEqual(['title', 'metric', 'value'])
    // Имена столбцов уходят параметрами, а не текстом запроса
    expect(compiled.params).toContain('inc.victims')
  })

  it('оставляет пустые значения, когда dropNulls выключен', () => {
    const compiled = compileQuery(
      q(src('inc'), [
        {
          type: 'unpivot',
          keep: [],
          fields: ['inc.victims'],
          nameField: 'name',
          valueField: 'value',
          dropNulls: false,
        },
      ]),
      ctx(),
    )
    expect(compiled.sql).not.toContain('IS NOT NULL')
  })

  it('геометрию в строки не разворачивает', () => {
    expect(() =>
      compileQuery(
        q(src('inc'), [
          {
            type: 'unpivot',
            keep: [],
            fields: ['inc.geom'],
            nameField: 'name',
            valueField: 'value',
            dropNulls: true,
          },
        ]),
        ctx(),
      ),
    ).toThrow(QueryCompileError)
  })

  it('разнотипные поля приводит к тексту', () => {
    const compiled = compileQuery(
      q(src('inc'), [
        {
          type: 'unpivot',
          keep: [],
          fields: ['inc.title', 'inc.victims'],
          nameField: 'name',
          valueField: 'value',
          dropNulls: true,
        },
      ]),
      ctx(),
    )
    expect(compiled.sql).toContain('::text')
    expect(compiled.fields.at(-1)?.type).toBe('text')
  })
})

describe('функция cast()', () => {
  it('текст в число — через проверку значения, негодное даёт пусто', () => {
    const compiled = compileQuery(
      q(src('inc'), [
        { type: 'compute', fields: [{ name: 'n', expr: "cast(inc.title, 'number')" }] },
      ]),
      ctx(),
    )
    expect(compiled.sql).toContain('pg_input_is_valid')
    expect(compiled.fields.at(-1)?.type).toBe('number')
  })

  it('число в текст', () => {
    const compiled = compileQuery(
      q(src('inc'), [
        { type: 'compute', fields: [{ name: 's', expr: "cast(inc.victims, 'text')" }] },
      ]),
      ctx(),
    )
    expect(compiled.sql).toContain('::text')
    expect(compiled.fields.at(-1)?.type).toBe('text')
  })

  it('неизвестный тип — ошибка с подсказкой', () => {
    expect(() =>
      compileQuery(
        q(src('inc'), [
          { type: 'compute', fields: [{ name: 'x', expr: "cast(inc.title, 'money')" }] },
        ]),
        ctx(),
      ),
    ).toThrow(QueryCompileError)
  })

  it('геометрию к числу не приводит', () => {
    expect(() =>
      compileQuery(
        q(src('inc'), [
          { type: 'compute', fields: [{ name: 'x', expr: "cast(inc.geom, 'number')" }] },
        ]),
        ctx(),
      ),
    ).toThrow(QueryCompileError)
  })
})
