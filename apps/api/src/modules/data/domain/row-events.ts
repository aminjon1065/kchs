import type { StoredFieldType } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { TerritoryIndex } from '~/modules/gis/public.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import type { DatasetStorage, StoredField } from './dataset-service.js'

/**
 * Правка больше стольких строк за раз публикует только сводное `dataset.rows_changed`
 * (ADR-0133): пакетная вставка из буфера или массовая правка не должна превращаться в
 * тысячи запусков правил. Импорт файла событий строк не публикует вовсе.
 */
export const ROW_EVENTS_LIMIT = 200

/** Строка для события: значения полей после правки, у правки — прежние значения. */
export interface RowEventInput {
  rowId: string
  values: Record<string, unknown>
  changed?: string[]
  previous?: Record<string, unknown>
}

interface RowTerritory {
  id: string
  code: string
  name: string
  /** Коды от страны до самой единицы: правило проверяет `contains(…path, 'TJ-GB')`. */
  path: string[]
}

/**
 * Значение поля для события: чувствительные поля не публикуются (их увидели бы
 * получатели уведомлений правила), геометрия — только точка: полигоны велики, а
 * правилу из них нужна разве что территория.
 */
function eventValue(field: StoredField, value: unknown): { include: boolean; value: unknown } {
  if (field.sensitive) return { include: false, value: null }
  if ((field.type as StoredFieldType) === 'geometry') {
    const point =
      value !== null && typeof value === 'object' && (value as { type?: unknown }).type === 'Point'
    return { include: point, value }
  }
  return { include: true, value }
}

/** Подпись варианта выбора; у множественного — через запятую. */
function optionLabel(field: StoredField, value: unknown): string | null {
  if (!field.options?.length) return null
  const label = (item: unknown) => {
    const option = field.options?.find((candidate) => candidate.value === String(item))
    return option ? option.label.ru : String(item)
  }
  if (Array.isArray(value)) return value.length > 0 ? value.map(label).join(', ') : null
  return value === null || value === undefined ? null : label(value)
}

function territoryOf(index: TerritoryIndex, id: string): RowTerritory | null {
  const unit = index.byId.get(id)
  if (!unit) return null
  return {
    id: unit.id,
    code: unit.code,
    name: unit.name.ru,
    path: [...index.ancestors(id).map((item) => item.code), unit.code],
  }
}

/** Полезная нагрузка события строки: значения, подписи и территории. */
export function rowEventPayload(
  storage: Pick<DatasetStorage, 'fields'>,
  territories: TerritoryIndex | null,
  row: RowEventInput,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  const labels: Record<string, string> = {}
  const units: Record<string, RowTerritory> = {}
  const byKey = new Map(storage.fields.map((field) => [field.key, field]))
  for (const [key, raw] of Object.entries(row.values)) {
    const field = byKey.get(key)
    if (!field) continue
    const { include, value } = eventValue(field, raw)
    if (!include) continue
    values[key] = value ?? null
    const option = optionLabel(field, value)
    if (option !== null) labels[key] = option
    if (field.type === 'territory' && typeof value === 'string' && territories) {
      const unit = territoryOf(territories, value)
      if (unit) {
        units[key] = unit
        labels[key] = unit.name
      }
    }
  }
  const payload: Record<string, unknown> = {
    rowId: row.rowId,
    values,
    labels,
    territories: units,
  }
  if (row.changed) {
    const visible = row.changed.filter((key) => key in values)
    payload.changed = visible
    payload.previous = Object.fromEntries(
      visible.map((key) => [key, row.previous?.[key] ?? null] as const),
    )
  }
  return payload
}

/**
 * События строк для правил автоматизации (ADR-0133): включены настройкой датасета
 * `rowEvents` и правка не больше `ROW_EVENTS_LIMIT` строк. Объект события — датасет:
 * получатели уведомлений правила — те, кто его видит.
 */
export async function publishRowEvents(
  tx: Executor,
  ctx: Ctx,
  storage: DatasetStorage,
  territories: TerritoryIndex | null,
  op: 'created' | 'updated' | 'deleted',
  rows: RowEventInput[],
): Promise<number> {
  if (!storage.settings.rowEvents || rows.length === 0 || rows.length > ROW_EVENTS_LIMIT) return 0
  const [object] = await tx
    .select({ spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, storage.id))
    .limit(1)
  for (const row of rows) {
    const payload = rowEventPayload(storage, territories, row)
    await publishEvent(tx, ctx, {
      type: `dataset.row_${op}`,
      object: {
        id: storage.id,
        type: 'dataset',
        spaceId: object?.spaceId ?? null,
        title: object?.title,
      },
      payload,
      ...(op === 'updated' ? { changedFields: payload.changed as string[] } : {}),
    })
  }
  return rows.length
}
