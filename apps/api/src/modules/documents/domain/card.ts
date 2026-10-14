import type { DocumentDirection, FieldDef } from '@kchs/contracts'
import { validateValues } from '@kchs/fields'
import { errors } from '~/shared/errors.js'

/**
 * Поля карточки типа (cardSchema) проверяются системой типов полей
 * (packages/fields). Черновик сохраняется с незаполненными обязательными
 * полями — обязательность проверяется при регистрации.
 */
export function validateCardFields(
  fields: FieldDef[],
  values: Record<string, unknown>,
  options: { strict: boolean },
): Record<string, unknown> {
  const schema = options.strict
    ? fields
    : fields.map((field) => ({ ...field, required: false, requiredIf: undefined }))
  const result = validateValues(schema, values)
  if (!result.ok) {
    throw errors.validation(
      'Проверьте поля карточки',
      result.issues.map((issue) => ({
        path: `fields.${issue.path}`,
        message: issue.message,
        ...(issue.code ? { code: issue.code } : {}),
      })),
    )
  }
  // Только поля схемы: неизвестные ключи в карточку не попадают
  const known = new Set(fields.map((field) => field.key))
  const data = Object.fromEntries(
    Object.entries(result.data).filter(([key, value]) => known.has(key) && value !== undefined),
  )
  // Точка карточки (ADR-0221): строго GeoJSON Point в границах координат, без лишних ключей
  const issues: Array<{ path: string; message: string; code: string }> = []
  for (const field of fields) {
    const value = data[field.key]
    if (field.type !== 'geometry' || value === null || value === undefined) continue
    const point = cardPoint(value)
    if (point) data[field.key] = point
    else
      issues.push({ path: `fields.${field.key}`, message: 'invalid_point', code: 'invalid_point' })
  }
  if (issues.length > 0) throw errors.validation('Проверьте поля карточки', issues)
  return data
}

/** GeoJSON Point с долготой −180…180 и широтой −90…90 — или `null`. */
function cardPoint(value: unknown): { type: 'Point'; coordinates: [number, number] } | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, coordinates } = value as { type?: unknown; coordinates?: unknown }
  if (type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2) return null
  const [lon, lat] = coordinates as unknown[]
  if (typeof lon !== 'number' || typeof lat !== 'number') return null
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null
  return { type: 'Point', coordinates: [lon, lat] }
}

/** Реквизиты, без которых документ направления не регистрируется (08-documents.md §5). */
export interface Requisites {
  subject: string
  correspondentId: string | null
  receivedDate: string | null
}

export function assertRequisites(direction: DocumentDirection, card: Requisites): void {
  const issues: Array<{ path: string; message: string; code: string }> = []
  if (!card.subject.trim()) issues.push({ path: 'subject', message: 'required', code: 'required' })
  if (direction === 'incoming') {
    if (!card.correspondentId) {
      issues.push({ path: 'correspondentId', message: 'required', code: 'required' })
    }
    if (!card.receivedDate) {
      issues.push({ path: 'receivedDate', message: 'required', code: 'required' })
    }
  }
  if (issues.length > 0) {
    throw errors.validation('Заполните реквизиты для регистрации', issues)
  }
}
