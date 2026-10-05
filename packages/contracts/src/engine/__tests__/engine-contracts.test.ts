import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { STORED_FIELD_TYPES } from '../../data/dataset.js'
import { COLUMNAR_FIELD_TYPES, FIELD_STORAGE } from '../../data/field-storage.js'
import { QUEUE_RUNTIME } from '../../jobs/job.js'
import { TRANSCRIBE_JOB } from '../../meetings/recording.js'
import { ENGINE_CALLBACKS } from '../callbacks.js'
import { ENGINE_JOBS, engineJobRef, engineJobSpec } from '../jobs.js'

/**
 * Контракт заданий движка (ADR-0190): из этих схем `gen:engine` пишет
 * `kchs_engine/contracts/jobs.json`, по ним движок сверяет свои модели.
 */
describe('задания движка', () => {
  it('ключ — очередь и имя, очередь исполняет движок', () => {
    for (const [key, job] of Object.entries(ENGINE_JOBS)) {
      expect(key).toBe(`${job.queue}:${job.name}`)
      expect(QUEUE_RUNTIME[job.queue], key).toBe('engine')
      expect(engineJobSpec(job.queue, job.name)).toBe(job)
    }
    expect(engineJobSpec('maintenance', 'engine.echo')).toBeUndefined()
    expect(engineJobRef('media:media.transcribe')).toEqual(TRANSCRIBE_JOB)
  })

  it('нагрузка и результат выражаются JSON Schema без потерь', () => {
    for (const [key, job] of Object.entries(ENGINE_JOBS)) {
      // Без `unrepresentable: 'any'`: тип, которого нет в JSON Schema, — ошибка генерации
      expect(() => z.toJSONSchema(job.payload, { io: 'output' }), key).not.toThrow()
      expect(() => z.toJSONSchema(job.result, { io: 'input' }), key).not.toThrow()
    }
  })

  it('колоночная копия хранит все хранимые типы, кроме геометрии', () => {
    expect([...COLUMNAR_FIELD_TYPES].sort()).toEqual(
      STORED_FIELD_TYPES.filter((type) => type !== 'geometry').sort(),
    )
    for (const type of COLUMNAR_FIELD_TYPES) expect(FIELD_STORAGE[type].arrow, type).not.toBeNull()
  })

  it('нагрузку разбирает схема: значения по умолчанию подставлены', () => {
    const payload = ENGINE_JOBS['imports:dataset.normalize'].payload.parse({
      importId: '0195f6b6-1c1a-7a00-8000-000000000001',
      bucket: 'files',
      storageKey: 'imports/x/source.csv',
      fileName: 'x.csv',
      options: {},
      mapping: [
        { column: 0, fieldKey: 'name', label: { ru: 'Имя' }, type: 'text', semantic: 'dimension' },
      ],
      geometry: null,
      geometryField: null,
      output: { bucket: 'files', normalizedKey: 'n.csv', errorsKey: 'e.csv' },
    })
    expect(payload.mapping[0]?.required).toBe(false)
  })
})

describe('обратные вызовы движка', () => {
  it('внутренние маршруты с одним параметром пути', () => {
    for (const [name, callback] of Object.entries(ENGINE_CALLBACKS)) {
      expect(callback.path, name).toMatch(/^\/internal\//)
      expect(callback.path.match(/:[A-Za-z_]\w*/g), name).toHaveLength(1)
      if (callback.body) expect(() => z.toJSONSchema(callback.body, { io: 'input' })).not.toThrow()
      expect(() => z.toJSONSchema(callback.reply, { io: 'output' }), name).not.toThrow()
    }
  })
})
