import { describe, expect, it } from 'vitest'
import {
  checkEvaluable,
  type EvalScope,
  ExpressionError,
  evaluateCondition,
  evaluateExpression,
  parseExpression,
} from '../src/expr/index.js'
import { checkExpression } from '../src/index.js'

const DATA: Record<string, unknown> = {
  object: {
    title: 'Договор поставки',
    typeKey: 'contract',
    fields: {
      amount: 1_500_000,
      amount_text: '2500000',
      currency: 'TJS',
      tags: ['крупный', 'срочный'],
      signed_on: '2026-09-18',
      empty: null,
      'сумма договора': 10,
    },
  },
  var: { urgent: true, limit: 1000 },
  steps: { legal: { outcome: 'remarks' } },
}

function scope(extra: Partial<EvalScope> = {}): EvalScope {
  return {
    resolve: (path) => {
      let current: unknown = DATA
      for (const part of path) {
        if (current === null || typeof current !== 'object') return undefined
        current = (current as Record<string, unknown>)[part]
      }
      return current
    },
    now: () => new Date('2026-09-19T20:30:00Z'),
    timezone: 'Asia/Dushanbe',
    ...extra,
  }
}

const value = (source: string) => evaluateExpression(source, scope())
const holds = (source: string) => evaluateCondition(source, scope())

describe('составные ссылки', () => {
  it('три части и больше — узел path, две — поле с псевдонимом', () => {
    expect(parseExpression('object.fields.amount')).toMatchObject({
      kind: 'path',
      segments: ['object', 'fields', 'amount'],
      pos: 0,
      end: 20,
    })
    expect(parseExpression('object.fields."сумма договора" > 1')).toMatchObject({
      kind: 'binary',
      left: { kind: 'path', segments: ['object', 'fields', 'сумма договора'] },
    })
    expect(parseExpression('reg.population')).toMatchObject({
      kind: 'field',
      qualifier: 'reg',
      name: 'population',
    })
  })

  it('незаконченный путь — ошибка с позицией', () => {
    expect(() => parseExpression('object.fields.')).toThrowError(
      new ExpressionError('После «object.fields.» ожидается имя поля', 14),
    )
  })

  it('компилятор запросов составную ссылку не принимает', () => {
    const result = checkExpression('a.b.c > 1', { fields: [{ key: 'c', type: 'number' }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issue.message).toContain('Составная ссылка «a.b.c»')
  })
})

describe('вычисление в памяти', () => {
  it.each([
    ['object.fields.amount > 1000000', true],
    ['object.fields.amount > 2000000', false],
    ['object.fields.amount_text > 2000000', true],
    ["object.typeKey == 'contract'", true],
    ["object.typeKey = 'contract' and var.urgent", true],
    ["steps.legal.outcome in ('rejected', 'remarks')", true],
    ["'срочный' in (object.fields.tags)", true],
    ["'обычный' not in (object.fields.tags)", true],
    ['object.fields.missing > 1', false],
    ['object.fields.empty is null', true],
    ['object.fields.missing is not null', false],
    ["object.title like 'Договор%'", true],
    ["object.title like '%аренды%'", false],
    ["contains(object.fields.tags, 'крупный')", true],
    ["contains(object.title, 'постав')", true],
    ['object.fields."сумма договора" * 2 = 20', true],
    ["lower(object.fields.currency) = 'tjs'", true],
    ['year(object.fields.signed_on) = 2026 and month(object.fields.signed_on) = 9', true],
    ['not (object.fields.amount < var.limit)', true],
    ['case when object.fields.amount > 1000000 then true else false end', true],
    ['if(var.urgent, 1, 2) = 1', true],
    ['coalesce(object.fields.empty, 5) = 5', true],
  ])('%s → %s', (source, expected) => {
    expect(holds(source)).toBe(expected)
  })

  it('null поглощает сравнения, and/or трёхзначные', () => {
    expect(value('object.fields.empty > 1')).toBeNull()
    expect(value('object.fields.empty > 1 and false')).toBe(false)
    expect(value('object.fields.empty > 1 or true')).toBe(true)
    expect(value('object.fields.empty > 1 or false')).toBeNull()
    expect(value('not object.fields.empty')).toBeNull()
    expect(value('1 / 0')).toBeNull()
    expect(value("'a' || object.fields.empty")).toBeNull()
  })

  it('разнотипное сравнение — неизвестно, а не ошибка', () => {
    expect(value("object.fields.amount = 'много'")).toBeNull()
    expect(holds("object.fields.amount = 'много'")).toBe(false)
  })

  it('сегодня и сейчас — по поясу вычисления', () => {
    expect(value('today()')).toBe('2026-09-20')
    expect(value('@today')).toBe('2026-09-20')
    expect(value('now()')).toBe('2026-09-19T20:30:00.000Z')
    expect(value("date('2026-09-19T20:30:00Z')")).toBe('2026-09-20')
  })

  it('разница и сдвиг дат — как у компилятора запросов', () => {
    // b − a в целых единицах к нулю
    expect(value("date_diff('2026-09-19T14:00:00Z', now(), 'hour')")).toBe(6)
    expect(value("date_diff(now(), '2026-09-19T14:00:00Z', 'hour')")).toBe(-6)
    expect(value("date_diff('2026-09-19T20:29:30Z', now(), 'minute')")).toBe(0)
    expect(value("date_diff('2026-09-01', '2026-09-19', 'day')")).toBe(18)
    expect(value("date_diff('2026-09-01', '2026-09-19', 'week')")).toBe(2)
    expect(value("date_diff('2026-01-31', '2026-02-28', 'month')")).toBe(0)
    expect(value("date_diff('2026-01-31', '2026-03-01', 'month')")).toBe(1)
    expect(value("date_diff('2025-09-20', '2026-09-19', 'year')")).toBe(0)
    expect(value("date_diff('2025-09-19', '2026-09-19', 'year')")).toBe(1)
    // Дата без времени рядом с моментом — полночь в поясе вычисления (UTC+5)
    expect(value("date_diff('2026-09-20', now(), 'hour')")).toBe(1)
    expect(value("date_diff(object.fields.empty, now(), 'hour')")).toBeNull()
    expect(holds("date_diff('2026-09-19T17:00:00Z', now(), 'hour') < 6")).toBe(true)

    expect(value("date_add(now(), -6, 'hour')")).toBe('2026-09-19T14:30:00.000Z')
    expect(value("date_add('2026-01-31', 1, 'month')")).toBe('2026-02-28')
    expect(value("date_add('2026-09-19', 2, 'week')")).toBe('2026-10-03')
    // Месяц к моменту — по календарю пояса: 31 января 01:00 по Душанбе → 28 февраля
    expect(value("date_add('2026-01-30T20:00:00Z', 1, 'month')")).toBe('2026-02-27T20:00:00.000Z')
    expect(() => value("date_add('2026-09-19', 1, 'hour')")).toThrow(ExpressionError)
    expect(() => value("date_diff(now(), now(), 'сутки')")).toThrow(ExpressionError)
    expect(
      checkEvaluable("date_diff(object.fields.signed_on, today(), 'day') > 1", ['object']),
    ).toBeNull()
  })

  it('строковые функции', () => {
    expect(value("substr('Договор', 2, 3)")).toBe('ого')
    expect(value("replace('a-b-c', '-', '+')")).toBe('a+b+c')
    expect(value("concat('a', null, 1)")).toBe('a1')
    expect(value("upper(trim('  тjs '))")).toBe('ТJS')
    expect(value("length('Договор')")).toBe(7)
    expect(value('length(object.fields.tags)')).toBe(2)
    expect(value('round(2.345, 2)')).toBe(2.35)
    expect(value('greatest(1, 5, 3)')).toBe(5)
    expect(value("nullif('a', 'a')")).toBeNull()
  })

  it('недоступная функция и параметр — ошибка вычисления', () => {
    expect(() => value('sum(object.fields.amount) > 1')).toThrowError(
      'Функция «sum» здесь недоступна',
    )
    expect(() => value('@param:x = 1')).toThrowError('Параметры запроса здесь недоступны')
  })
})

describe('проверка без вычисления', () => {
  const ROOTS = ['object', 'var', 'steps']

  it('корни ссылок, функции и макросы', () => {
    expect(checkEvaluable('object.fields.amount > 1000000', ROOTS)).toBeNull()
    expect(checkEvaluable('amount > 1', ROOTS)).toMatchObject({
      message: 'Неизвестное имя «amount»',
      position: 0,
    })
    expect(checkEvaluable('event.payload.x = 1', ROOTS)?.message).toBe('Неизвестное имя «event»')
    expect(checkEvaluable('st_area(object.geom) > 1', ROOTS)?.message).toBe(
      'Функция «st_area» здесь недоступна',
    )
    expect(checkEvaluable('@me = var.user', ROOTS)?.message).toBe('Макрос «@me» здесь недоступен')
    expect(checkEvaluable('object.fields.amount >', ROOTS)).toBeInstanceOf(ExpressionError)
  })
})
