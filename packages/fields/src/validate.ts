import type { FieldDef, FieldType } from '@kchs/contracts'
import { z } from 'zod'

/** Базовая zod-схема значения по типу поля. */
function baseSchema(field: FieldDef): z.ZodTypeAny {
  const type = field.type as FieldType
  const v = field.validation ?? {}
  switch (type) {
    case 'text':
    case 'identifier': {
      let s = z.string().max(v.maxLength ?? 1000)
      if (v.minLength) s = s.min(v.minLength)
      if (v.pattern) s = s.regex(new RegExp(v.pattern))
      return s
    }
    case 'long_text':
      return field.rich ? z.record(z.string(), z.unknown()) : z.string().max(v.maxLength ?? 100_000)
    case 'url':
      return z.url()
    case 'email':
      return z.email()
    case 'phone':
      return z.string().regex(/^\+?[0-9\s()-]{5,32}$/, 'некорректный телефон')
    case 'integer': {
      let n = z.coerce.number().int()
      if (v.min !== undefined) n = n.min(v.min)
      if (v.max !== undefined) n = n.max(v.max)
      return n
    }
    case 'number':
    case 'decimal':
    case 'money':
    case 'percent':
    case 'duration': {
      let n = z.coerce.number()
      if (v.min !== undefined) n = n.min(v.min)
      if (v.max !== undefined) n = n.max(v.max)
      return n
    }
    case 'boolean':
      return z.coerce.boolean()
    case 'date':
      return z.iso.date()
    case 'datetime':
      return z.iso.datetime({ offset: true })
    case 'time':
      return z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/)
    case 'select':
      return field.options?.length
        ? z.enum(field.options.map((o) => o.value) as [string, ...string[]])
        : z.string()
    case 'multi_select':
      return z.array(z.string())
    case 'user':
    case 'unit':
    case 'territory':
    case 'object_ref':
    case 'file':
      return z.uuid()
    case 'geometry':
      return z.record(z.string(), z.unknown())
    case 'json':
      return z.unknown()
    default:
      return z.unknown()
  }
}

/**
 * Схема одного поля с учётом обязательности и nullable. Обязательное поле
 * не принимает пустое значение (null), даже если колонка допускает null.
 */
export function fieldSchema(field: FieldDef, required = field.required): z.ZodTypeAny {
  let schema = baseSchema(field)
  if (required) return schema
  schema = schema.optional()
  if (field.nullable !== false) schema = schema.nullable()
  return schema
}

/** Схема всей формы/карточки: `{ [key]: value }`; `requiredIf` — по значениям. */
export function schemaFor(
  fields: FieldDef[],
  values: Record<string, unknown> = {},
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of fields) {
    if (['formula', 'lookup', 'rollup'].includes(field.type)) continue
    shape[field.key] = fieldSchema(field, isRequired(field, values))
  }
  return z.object(shape)
}

/** Текстовые типы, для которых пустая строка — значение, а не «пусто». */
const TEXT_TYPES = new Set(['text', 'long_text', 'identifier'])

/**
 * Значения из полей ввода: пустая строка в нетекстовом поле означает «не задано»
 * (иначе приведение превратило бы пустое число в 0). Обязательное текстовое
 * поле из одних пробелов тоже пустое.
 */
export function normalizeValues(
  fields: FieldDef[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values }
  for (const field of fields) {
    const value = out[field.key]
    if (typeof value !== 'string') continue
    if (value.trim() === '' && (!TEXT_TYPES.has(field.type) || isRequired(field, values))) {
      out[field.key] = null
    }
  }
  return out
}

export interface FieldIssue {
  path: string
  message: string
  code?: string
  /** Границы проверки для локализованного сообщения: `{min}`, `{max}`. */
  params?: Record<string, string | number>
}

export function validateValues(
  fields: FieldDef[],
  values: Record<string, unknown>,
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: FieldIssue[] } {
  const visible = fields.filter((f) => isVisible(f, values))
  const normalized = normalizeValues(visible, values)
  const result = schemaFor(visible, normalized).safeParse(normalized)
  if (result.success) return { ok: true, data: result.data }
  return {
    ok: false,
    issues: result.error.issues.map((i) => {
      const bounds = i as { minimum?: unknown; maximum?: unknown; format?: unknown }
      const params: Record<string, string | number> = {}
      if (typeof bounds.minimum === 'number' || typeof bounds.minimum === 'bigint') {
        params.min = Number(bounds.minimum)
      }
      if (typeof bounds.maximum === 'number' || typeof bounds.maximum === 'bigint') {
        params.max = Number(bounds.maximum)
      }
      if (typeof bounds.format === 'string') params.format = bounds.format
      return { path: i.path.join('.'), message: i.message, code: i.code, params }
    }),
  }
}

/** Условная видимость поля: `visibleIf: {field, op, value}`. */
export function isVisible(field: FieldDef, values: Record<string, unknown>): boolean {
  const cond = field.visibleIf
  if (!cond) return true
  const actual = values[cond.field]
  switch (cond.op) {
    case 'eq':
      return actual === cond.value
    case 'neq':
      return actual !== cond.value
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(actual as never)
    case 'not_empty':
      return actual !== null && actual !== undefined && actual !== ''
    case 'is_empty':
      return actual === null || actual === undefined || actual === ''
    case 'is_true':
      return actual === true
    case 'is_false':
      return actual === false
    default:
      return true
  }
}

export function isRequired(field: FieldDef, values: Record<string, unknown>): boolean {
  if (field.required) return true
  if (!field.requiredIf) return false
  return isVisible({ ...field, visibleIf: field.requiredIf }, values)
}
