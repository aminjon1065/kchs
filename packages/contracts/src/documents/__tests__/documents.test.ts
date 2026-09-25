import { describe, expect, it } from 'vitest'
import {
  allowedConfidentiality,
  clearancesFor,
  confidentialityRank,
  isRedacted,
  parseConfidentiality,
  strictest,
  withinClearance,
} from '../../access/confidentiality.js'
import { JournalCreateInput } from '../journal.js'
import { canTransition, DOCUMENT_STATUSES, DOCUMENT_TRANSITIONS } from '../lifecycle.js'
import { counterYear, formatRegNumber, numberFormatIssue } from '../numbering.js'

describe('нумерация журнала', () => {
  const parts = { prefix: 'ВХ', sequence: 7, date: '2026-09-19', unitCode: '01-15' }

  it('шаблон по умолчанию: префикс, номер с нулями, две цифры года', () => {
    expect(formatRegNumber('{prefix}-{seq:04}/{yy}', parts)).toBe('ВХ-0007/26')
  })

  it('полный год, месяц, индекс подразделения и номер без ширины', () => {
    expect(formatRegNumber('{unit.code}/{seq} от {mm}.{yyyy}', parts)).toBe('01-15/7 от 09.2026')
  })

  it('номер шире маски не обрезается', () => {
    expect(formatRegNumber('{seq:02}', { ...parts, sequence: 1234 })).toBe('1234')
  })

  it('без индекса подразделения подстановка пустая', () => {
    expect(formatRegNumber('{unit.code}-{seq}', { ...parts, unitCode: null })).toBe('-7')
  })

  it('проверка шаблона: ровно один {seq}, только известные подстановки', () => {
    expect(numberFormatIssue('{prefix}-{seq:04}/{yy}')).toBeNull()
    expect(numberFormatIssue('{prefix}/{yy}')).toBe('no_seq')
    expect(numberFormatIssue('{seq}-{seq}')).toBe('many_seq')
    expect(numberFormatIssue('{seq}-{department}')).toBe('unknown_token')
    expect(numberFormatIssue('{prefix:2}-{seq}')).toBe('unknown_token')
    expect(numberFormatIssue('{seq}-{')).toBe('unknown_token')
    expect(numberFormatIssue('   ')).toBe('empty')
    expect(numberFormatIssue(`{seq}${'x'.repeat(80)}`)).toBe('too_long')
  })

  it('контракт журнала отклоняет неверный шаблон', () => {
    expect(JournalCreateInput.safeParse({ name: 'Входящие', format: '{prefix}' }).success).toBe(
      false,
    )
    expect(JournalCreateInput.parse({ name: 'Входящие' }).format).toBe('{prefix}-{seq:04}/{yy}')
  })

  it('год счётчика: сброс по году — год даты, без сброса — общий счётчик', () => {
    expect(counterYear('year', '2027-01-02')).toBe(2027)
    expect(counterYear('never', '2027-01-02')).toBe(0)
  })
})

describe('жизненный цикл документа', () => {
  it('граф — диаграмма 08-documents.md §3', () => {
    expect(canTransition('draft', 'registered')).toBe(true)
    expect(canTransition('draft', 'cancelled')).toBe(true)
    // Маршрут без согласования — сразу на подпись; возвращённый — аннулируется (ADR-0083)
    expect(canTransition('draft', 'on_signing')).toBe(true)
    expect(canTransition('returned', 'on_signing')).toBe(true)
    expect(canTransition('returned', 'cancelled')).toBe(true)
    expect(canTransition('approved', 'registered')).toBe(false)
    expect(canTransition('signed', 'registered')).toBe(true)
    expect(canTransition('registered', 'cancelled')).toBe(true)
    expect(canTransition('registered', 'draft')).toBe(false)
    expect(canTransition('on_approval', 'registered')).toBe(false)
    expect(canTransition('cancelled', 'draft')).toBe(false)
    expect(canTransition('archived', 'filed')).toBe(false)
  })

  it('из каждого статуса переходы только в известные статусы', () => {
    for (const status of DOCUMENT_STATUSES) {
      for (const next of DOCUMENT_TRANSITIONS[status]) {
        expect(DOCUMENT_STATUSES).toContain(next)
      }
    }
    expect(DOCUMENT_TRANSITIONS.archived).toEqual([])
    expect(DOCUMENT_TRANSITIONS.cancelled).toEqual([])
  })
})

describe('грифы и допуски', () => {
  it('упорядочены по строгости', () => {
    expect(confidentialityRank('public')).toBeLessThan(confidentialityRank('internal'))
    expect(confidentialityRank('internal')).toBeLessThan(confidentialityRank('confidential'))
  })

  it('допуск открывает грифы не строже себя', () => {
    expect(allowedConfidentiality('internal')).toEqual(['public', 'internal'])
    expect(clearancesFor('internal')).toEqual(['internal', 'confidential'])
    expect(withinClearance('confidential', 'internal')).toBe(false)
    expect(withinClearance('internal', 'confidential')).toBe(true)
  })

  it('действующий гриф — самый строгий; содержание скрыто от «конфиденциально»', () => {
    expect(strictest('internal', 'confidential', 'public')).toBe('confidential')
    expect(strictest()).toBe('public')
    expect(isRedacted('internal')).toBe(false)
    expect(isRedacted('confidential')).toBe(true)
    expect(isRedacted(undefined)).toBe(false)
  })

  it('неизвестное значение атрибута — допуск по умолчанию', () => {
    expect(parseConfidentiality('top-secret')).toBe('internal')
    expect(parseConfidentiality(undefined)).toBe('internal')
    expect(parseConfidentiality(null, 'public')).toBe('public')
  })

  it('снятый гриф «Секретно» читается самым строгим из оставшихся, а не ДСП', () => {
    expect(parseConfidentiality('secret')).toBe('confidential')
    expect(parseConfidentiality('secret', 'public')).toBe('confidential')
  })
})
