import {
  DURATION_UNIT,
  FIELD_STORAGE,
  STORED_FIELD_TYPES,
  type StoredFieldType,
} from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { duckdbDialect, postgresDialect } from '../src/dialect.js'
import { sqlTypeOfField } from '../src/value-types.js'

/**
 * Компилятор согласован с реестром хранения полей (ADR-0190): тип, к которому
 * он приводит параметры сравнения с полем, — тот же, что у столбца таблицы
 * датасета в Postgres и у столбца колоночной копии в DuckDB. Реестр читают и
 * `data/infra/physical.ts`, и движок (`field_types.json`).
 */

/** Тип без точности: `numeric(18, 2)` → `numeric`, `geometry(Geometry, 4326)` → `geometry`. */
const base = (type: string) => type.replace(/\(.*\)$/, '').trim()

/**
 * Длительность компилятор читает минутами (`durationMinutes`), а столбец Postgres —
 * интервал; JSON компилятор приводит к `jsonb`/`JSON`, а копия хранит его строкой.
 */
const PG_EXCEPTIONS = new Set<StoredFieldType>(['duration'])
const DUCKDB_EXCEPTIONS = new Set<StoredFieldType>(['duration', 'json'])

describe('реестр хранения полей и компилятор', () => {
  it('приведение к типу поля совпадает с типом столбца Postgres', () => {
    for (const type of STORED_FIELD_TYPES) {
      if (PG_EXCEPTIONS.has(type)) continue
      expect(base(sqlTypeOfField(type)), type).toBe(base(FIELD_STORAGE[type].pg))
    }
  })

  it('приведение в DuckDB совпадает с типом столбца колоночной копии', () => {
    for (const type of STORED_FIELD_TYPES) {
      const storage = FIELD_STORAGE[type].duckdb
      if (storage === null || DUCKDB_EXCEPTIONS.has(type)) continue
      expect(duckdbDialect.cast('x', sqlTypeOfField(type)), type).toBe(`CAST(x AS ${storage})`)
    }
  })

  it('длительность — минутами в обоих диалектах и в колоночной копии', () => {
    expect(DURATION_UNIT).toBe('minute')
    expect(sqlTypeOfField('duration')).toBe('double precision')
    expect(FIELD_STORAGE.duration.duckdb).toBe('DOUBLE')
    expect(postgresDialect.durationMinutes('c')).toContain('/ 60')
    expect(duckdbDialect.durationMinutes('c')).toBe('CAST(c AS DOUBLE)')
  })
})
