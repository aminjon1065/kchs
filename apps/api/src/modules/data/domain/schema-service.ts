import type {
  DatasetFieldConvertInput,
  DatasetFieldConvertReport,
  DatasetFieldInput,
  DatasetFieldPatch,
  DatasetUpdateInput,
  StoredFieldType,
} from '@kchs/contracts'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { pgErrorCode, UNIQUE_VIOLATION } from '~/shared/db/pg-error.js'
import { datasetFields, datasets, imports, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { castExpression, columnName, Physical } from '../infra/physical.js'
import {
  DatasetService,
  defaultSemantic,
  fieldValues,
  type StoredField,
} from './dataset-service.js'

const MAX_FIELDS = 500
const ACTIVE_IMPORTS = ['queued', 'normalizing', 'loading']
/** Типы, которые не могут быть ключом строки. */
const NOT_KEY_TYPES = new Set<string>(['geometry', 'json', 'long_text', 'multi_select'])

type SchemaChange = 'added' | 'updated' | 'removed' | 'type_changed'

/**
 * Датасет блокируется на время правки схемы: правки идут по очереди, а идущий
 * импорт — конфликт (его загрузка опирается на типы столбцов на момент запуска).
 */
async function lockForSchema(tx: Executor, datasetId: string, ddl = true) {
  const [row] = await tx
    .select({
      table: datasets.physicalTable,
      nextColumn: datasets.nextColumn,
      primaryKey: datasets.primaryKey,
      timeField: datasets.timeField,
      territoryField: datasets.territoryField,
      rowCount: datasets.rowCount,
    })
    .from(datasets)
    .where(eq(datasets.id, datasetId))
    .for('update')
  if (!row) throw errors.notFound('Датасет')
  if (ddl) await assertNoActiveImport(tx, datasetId)
  const storage = await DatasetService.storage(datasetId, tx)
  return { ...row, fields: storage.fields, settings: storage.settings }
}

async function assertNoActiveImport(tx: Executor, datasetId: string): Promise<void> {
  const [active] = await tx
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.datasetId, datasetId), inArray(imports.status, ACTIVE_IMPORTS)))
    .limit(1)
  if (active) {
    throw errors.conflict('Идёт импорт в датасет — схему можно изменить после его завершения')
  }
}

function fieldOf(fields: StoredField[], key: string): StoredField {
  const field = fields.find((item) => item.key === key)
  if (!field) throw errors.notFound('Поле')
  return field
}

/**
 * Схема изменилась: растёт номер схемы (ключ кэша запросов), структурная правка
 * даёт версию `schema` (ADR-0047), событие — в той же транзакции.
 */
async function schemaChanged(
  tx: Executor,
  ctx: Ctx,
  input: {
    datasetId: string
    change: SchemaChange
    fields: string[]
    structural: boolean
    rowCount: number
  },
): Promise<void> {
  await tx
    .update(datasets)
    .set({ schemaVersion: sql`${datasets.schemaVersion} + 1`, updatedAt: sql`now()` })
    .where(eq(datasets.id, input.datasetId))
  if (input.structural) {
    await DatasetService.bumpVersion(tx, ctx, {
      datasetId: input.datasetId,
      origin: 'schema',
      rowCount: input.rowCount,
      diff: { added: 0, updated: 0, deleted: 0 },
    })
  }
  const [object] = await tx
    .select({ spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, input.datasetId))
    .limit(1)
  await publishEvent(tx, ctx, {
    type: 'dataset.schema_changed',
    object: {
      id: input.datasetId,
      type: 'dataset',
      spaceId: object?.spaceId ?? null,
      title: object?.title,
    },
    payload: { change: input.change, fields: input.fields },
  })
}

async function setFieldCount(tx: Executor, datasetId: string, count: number): Promise<void> {
  await tx
    .update(objects)
    .set({ meta: sql`${objects.meta} || ${JSON.stringify({ fields: count })}::jsonb` })
    .where(eq(objects.id, datasetId))
}

/**
 * Правка схемы датасета (P1-E01 S01–S02, ADR-0047). Ключ поля неизменен,
 * физическое имя столбца стабильно; структурные правки — версия `schema`.
 */
export const SchemaService = {
  async addField(
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    input: DatasetFieldInput,
  ): Promise<void> {
    const locked = await lockForSchema(tx, datasetId)
    if (locked.fields.some((field) => field.key === input.key)) {
      throw errors.conflict(`Поле «${input.key}» уже есть`)
    }
    if (locked.fields.length >= MAX_FIELDS) {
      throw errors.validation(`В датасете не больше ${MAX_FIELDS} полей`)
    }
    const physical = columnName(locked.nextColumn)
    const order = input.order || locked.fields.length
    await tx.insert(datasetFields).values(fieldValues(datasetId, input, physical, order))
    await Physical.addColumn(tx, locked.table, {
      name: physical,
      type: input.type as StoredFieldType,
      precision: input.format?.precision,
      indexed: input.indexed,
    })
    await tx
      .update(datasets)
      .set({ nextColumn: locked.nextColumn + 1 })
      .where(eq(datasets.id, datasetId))
    await setFieldCount(tx, datasetId, locked.fields.length + 1)
    await schemaChanged(tx, ctx, {
      datasetId,
      change: 'added',
      fields: [input.key],
      structural: true,
      rowCount: locked.rowCount,
    })
  },

  /** Описание поля: подпись, семантика, формат, справочник, индекс. */
  async updateField(
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    key: string,
    patch: DatasetFieldPatch,
  ): Promise<void> {
    const locked = await lockForSchema(tx, datasetId, false)
    const field = fieldOf(locked.fields, key)
    // Индекс — DDL: во время импорта его не строим; остальное описание менять можно
    const indexChange = patch.indexed !== undefined && patch.indexed !== field.indexed
    if (indexChange) await assertNoActiveImport(tx, datasetId)

    if (patch.lookup) {
      // Справочник: пользователь должен видеть его, поля ключа и подписи — существовать
      await authorize(ctx, 'view', patch.lookup.datasetId)
      const reference =
        patch.lookup.datasetId === datasetId
          ? locked.fields
          : (await DatasetService.storage(patch.lookup.datasetId, tx)).fields
      for (const refKey of [patch.lookup.keyField, patch.lookup.labelField]) {
        if (!reference.some((item) => item.key === refKey)) {
          throw errors.validation(`В справочнике нет поля «${refKey}»`)
        }
      }
    }

    const [row] = await tx
      .select({ definition: datasetFields.definition })
      .from(datasetFields)
      .where(eq(datasetFields.id, field.id))
      .limit(1)
    await tx
      .update(datasetFields)
      .set({
        ...(patch.label ? { label: patch.label } : {}),
        ...(patch.semantic ? { semantic: patch.semantic } : {}),
        ...(patch.format !== undefined ? { format: patch.format ?? null } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
        ...(patch.required !== undefined ? { required: patch.required } : {}),
        ...(patch.indexed !== undefined ? { indexed: patch.indexed } : {}),
        ...(patch.sensitive !== undefined ? { sensitive: patch.sensitive } : {}),
        ...(patch.order !== undefined ? { order: patch.order } : {}),
        ...(patch.lookup !== undefined ? { lookup: patch.lookup } : {}),
        ...(patch.options !== undefined
          ? { definition: { ...(row?.definition ?? {}), options: patch.options } }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(datasetFields.id, field.id))

    if (indexChange && field.type !== 'geometry') {
      if (patch.indexed) {
        await Physical.createColumnIndex(tx, locked.table, {
          name: field.physical,
          type: field.type as StoredFieldType,
        })
      } else {
        await Physical.dropColumnIndexes(tx, locked.table, field.physical)
      }
    }
    await schemaChanged(tx, ctx, {
      datasetId,
      change: 'updated',
      fields: [key],
      structural: false,
      rowCount: locked.rowCount,
    })
  },

  async removeField(tx: Executor, ctx: Ctx, datasetId: string, key: string): Promise<void> {
    const locked = await lockForSchema(tx, datasetId)
    const field = fieldOf(locked.fields, key)
    if (locked.primaryKey.includes(key)) {
      throw errors.conflict('Поле входит в ключ строки — сначала измените ключ')
    }
    // Поле может быть ключом или подписью справочника в других датасетах
    const [usage] = await tx
      .select({ title: objects.title })
      .from(datasetFields)
      .innerJoin(objects, eq(objects.id, datasetFields.datasetId))
      .where(
        and(
          sql`${datasetFields.lookup}->>'datasetId' = ${datasetId}`,
          sql`(${datasetFields.lookup}->>'keyField' = ${key} OR ${datasetFields.lookup}->>'labelField' = ${key})`,
          ne(datasetFields.id, field.id),
        ),
      )
      .limit(1)
    if (usage) {
      throw errors.conflict(`Поле используется справочником в датасете «${usage.title}»`)
    }
    await tx.delete(datasetFields).where(eq(datasetFields.id, field.id))
    await Physical.dropColumn(tx, locked.table, field.physical)
    await tx
      .update(datasets)
      .set({
        ...(locked.timeField === key ? { timeField: null } : {}),
        ...(locked.territoryField === key ? { territoryField: null } : {}),
      })
      .where(eq(datasets.id, datasetId))
    await setFieldCount(tx, datasetId, locked.fields.length - 1)
    await schemaChanged(tx, ctx, {
      datasetId,
      change: 'removed',
      fields: [key],
      structural: true,
      rowCount: locked.rowCount,
    })
  },

  /**
   * Смена типа: пробный прогон считает значения, которые не приводятся;
   * применение — одна перезапись таблицы, потеря значений — только с согласия.
   */
  async convertField(
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    key: string,
    input: DatasetFieldConvertInput,
  ): Promise<DatasetFieldConvertReport> {
    const locked = await lockForSchema(tx, datasetId)
    const field = fieldOf(locked.fields, key)
    const from = field.type as StoredFieldType
    const precision = input.format?.precision
    if (from === input.type && precision === field.format?.precision) {
      throw errors.validation('Тип поля не меняется')
    }
    if (locked.primaryKey.includes(key) && NOT_KEY_TYPES.has(input.type)) {
      throw errors.validation('Поле ключа строки не может получить этот тип')
    }
    const cast = castExpression(field.physical, from, input.type, precision)
    const report = await Physical.conversionReport(tx, locked.table, cast)
    if (input.dryRun) return { ...report, applied: false }
    if (report.failed > 0 && !input.allowLoss) {
      throw errors.conflict('Часть значений не приводится к новому типу', {
        failed: report.failed,
      })
    }

    // Индексы старого типа (trigram для текста) к новому не подходят — строятся заново
    await Physical.dropColumnIndexes(tx, locked.table, field.physical)
    try {
      await Physical.convertColumn(tx, locked.table, field.physical, input.type, precision, cast)
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) {
        throw errors.conflict('После смены типа значения ключа строки совпадают')
      }
      throw error
    }
    if (field.indexed && input.type !== 'geometry') {
      await Physical.createColumnIndex(tx, locked.table, {
        name: field.physical,
        type: input.type,
        precision,
      })
    }
    await tx
      .update(datasetFields)
      .set({
        type: input.type,
        format: input.format ?? null,
        // Семантика по умолчанию следует за типом; выбранную вручную не трогаем
        ...(field.semantic === defaultSemantic(from)
          ? { semantic: defaultSemantic(input.type) }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(datasetFields.id, field.id))
    await schemaChanged(tx, ctx, {
      datasetId,
      change: 'type_changed',
      fields: [key],
      structural: true,
      rowCount: locked.rowCount,
    })
    return { ...report, applied: true }
  },

  /** Описание, ключ строки, поля времени и территории, правка и история. */
  async update(
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    input: DatasetUpdateInput,
  ): Promise<void> {
    const locked = await lockForSchema(tx, datasetId, false)
    const keyChange =
      input.primaryKey !== undefined &&
      JSON.stringify(input.primaryKey) !== JSON.stringify(locked.primaryKey)
    if (keyChange) await assertNoActiveImport(tx, datasetId)
    const byKey = new Map(locked.fields.map((field) => [field.key, field]))
    const changed: string[] = []

    if (input.timeField) {
      const field = byKey.get(input.timeField)
      if (!field || !['date', 'datetime'].includes(field.type)) {
        throw errors.validation('Поле времени — поле типа «дата» или «дата и время»')
      }
    }
    if (input.territoryField && !byKey.has(input.territoryField)) {
      throw errors.validation(`Нет поля «${input.territoryField}»`)
    }

    if (keyChange && input.primaryKey) {
      const columns = input.primaryKey.map((key) => {
        const field = byKey.get(key)
        if (!field) throw errors.validation(`Нет поля «${key}»`)
        if (NOT_KEY_TYPES.has(field.type)) {
          throw errors.validation(`Поле «${key}» не может входить в ключ строки`)
        }
        return field.physical
      })
      if (new Set(input.primaryKey).size !== input.primaryKey.length) {
        throw errors.validation('Поля ключа повторяются')
      }
      const duplicates =
        columns.length > 0 ? await Physical.keyDuplicates(tx, locked.table, columns) : 0
      if (duplicates > 0) {
        throw errors.conflict('Значения ключа повторяются в строках датасета', { duplicates })
      }
      await Physical.replaceKeyIndex(tx, locked.table, columns)
      changed.push(...input.primaryKey)
    }
    if (input.settings?.trackHistory) await Physical.ensureHistory(tx, datasetId)

    await tx
      .update(datasets)
      .set({
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(keyChange ? { primaryKey: input.primaryKey } : {}),
        ...(input.timeField !== undefined ? { timeField: input.timeField } : {}),
        ...(input.territoryField !== undefined ? { territoryField: input.territoryField } : {}),
        ...(input.settings ? { settings: { ...locked.settings, ...input.settings } } : {}),
      })
      .where(eq(datasets.id, datasetId))
    if (input.description !== undefined) {
      await tx
        .update(objects)
        .set({ subtitle: input.description, updatedAt: sql`now()` })
        .where(eq(objects.id, datasetId))
    }
    await schemaChanged(tx, ctx, {
      datasetId,
      change: 'updated',
      fields: changed,
      structural: keyChange,
      rowCount: locked.rowCount,
    })
  },
}
