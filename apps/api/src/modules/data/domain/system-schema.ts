import type { SystemDatasetSchema } from '@kchs/contracts'
import { systemDataset } from '~/kernel/system-datasets.js'
import type { Ctx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'

/**
 * Схема системного датасета для смотрящего (ADR-0082): поля без служебных и
 * скрытых политикой столбцов — подписи разрезов, условий и поля времени
 * показателя над системным датасетом.
 */
export async function systemDatasetSchema(
  ctx: Ctx,
  name: SystemDatasetSchema['name'],
): Promise<SystemDatasetSchema> {
  const definition = systemDataset(name)
  if (!definition) throw errors.notFound('Системный датасет')
  const resolved = await definition.resolve(ctx)
  const hidden = new Set(resolved.columnPolicy.hide)
  return {
    name,
    timeField: definition.timeField ?? null,
    fields: resolved.fields
      .filter((field) => !hidden.has(field.key) && field.semantic !== 'system')
      .map((field) => ({
        key: field.key,
        label: field.label ?? { ru: field.key },
        type: field.type,
        semantic: field.semantic ?? null,
      })),
  }
}
