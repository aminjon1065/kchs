import { type ObjectSummary, QUALITY_STATUSES } from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { registerAuditActions } from '~/kernel/audit/registry.js'
import { registerNotificationCategory } from '~/kernel/notifications/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { objects } from '~/kernel/objects/schema.js'
import { db } from '~/shared/db/client.js'
import { registerAnalysisObjectType } from './analysis-module.js'
import { DATA_AUDIT } from './domain/audit-actions.js'
import { QualityService } from './domain/quality-service.js'
import { Physical } from './infra/physical.js'
import { registerNotebookType } from './notebook-module.js'
import { registerPipelineObjectType } from './pipeline-module.js'
import { datasetFields, datasetQualityRuns, datasets } from './schema.js'
import { registerSourceObjectType } from './source-module.js'

/** Последняя проверка качества датасета — подзапросом поля списка (ADR-0101). */
const qualityRun = alias(datasetQualityRuns, 'quality_run')

/** Типы объектов модуля «Данные» (06-analytics-engine.md). */
export function registerDataObjectTypes(): void {
  registerNotificationCategory('data', { app: 'immediate', email: 'digest' })
  registerAuditActions('data', DATA_AUDIT)
  registerObjectType({
    type: 'dataset',
    labelKey: 'objects.types.dataset',
    icon: 'dataset',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      /** Правка строк в таблице. */
      edit: { minLevel: 'edit' },
      import: { minLevel: 'edit' },
      export: { minLevel: 'view', capability: 'data.export' },
      /** Схема, политики строк и столбцов. */
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    // Подписи полей входят в документ поиска, а правка схемы публикует только своё
    // событие (ADR-0170, ADR-0182)
    reindexOn: ['dataset.schema_changed'],
    listFields: [
      {
        key: 'rows',
        labelKey: 'data.fields.rows',
        type: 'integer',
        sql: sql`(${objects.meta}->>'rows')::bigint`,
        sortable: true,
      },
      // Бейдж качества в каталоге (ADR-0101): последняя проверка датасета
      {
        key: 'quality',
        labelKey: 'data.quality.title',
        type: 'select',
        sql: sql`(select ${qualityRun.status} from ${qualityRun}
          where ${qualityRun.datasetId} = ${objects.id}
          order by ${qualityRun.checkedAt} desc limit 1)`,
        sortable: true,
        options: QUALITY_STATUSES.filter((value) => value !== 'unknown').map((value) => ({
          value,
          labelKey: `data.quality.statuses.${value}`,
        })),
      },
    ],
    summary: async (ids) => {
      const [rows, quality] = await Promise.all([
        db()
          .select({ id: datasets.id, rows: datasets.rowCount, version: datasets.currentVersion })
          .from(datasets)
          .where(inArray(datasets.id, ids)),
        // Бейдж качества в каталоге и карточке (ADR-0101)
        QualityService.statuses(ids),
      ])
      return new Map(
        rows.map((row) => [
          row.id,
          {
            meta: {
              rows: row.rows,
              version: row.version,
              quality: quality.get(row.id) ?? 'unknown',
            },
          } as Partial<ObjectSummary>,
        ]),
      )
    },
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          description: datasets.description,
        })
        .from(datasets)
        .innerJoin(objects, eq(objects.id, datasets.id))
        .where(eq(datasets.id, id))
        .limit(1)
      if (!row) return null
      // В поиск идут название, описание и подписи полей — не строки данных
      const fields = await db()
        .select({ label: datasetFields.label, key: datasetFields.key })
        .from(datasetFields)
        .where(eq(datasetFields.datasetId, id))
      return {
        parentId: row.parentId,
        type: 'dataset',
        spaceId: row.spaceId,
        title: row.title,
        body: [row.description ?? '', ...fields.map((field) => `${field.label.ru} ${field.key}`)]
          .join('\n')
          .slice(0, 20_000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
    lifecycle: {
      // Окончательное удаление — вместе с физическими таблицами
      onDelete: async (tx, _ctx, object) => Physical.dropTables(tx, object.id),
    },
  })

  // График, дашборд и показатель: права на объект не открывают данные — данные
  // плиток, графиков и значения показателей считаются с политиками смотрящего
  // (03-access-model.md)
  for (const type of ['chart', 'dashboard', 'metric'] as const) {
    registerObjectType({
      type,
      labelKey: `objects.types.${type}`,
      icon: type,
      route: (id) => `/o/${id}`,
      levels: ['view', 'comment', 'edit', 'manage', 'owner'],
      actions: {
        view: { minLevel: 'view' },
        comment: { minLevel: 'comment' },
        edit: { minLevel: 'edit' },
        manage: { minLevel: 'manage' },
        share: { minLevel: 'manage' },
        delete: { minLevel: 'manage' },
      },
      discussable: true,
      linkable: true,
      hasParentTree: true,
      searchable: async (id) => {
        const [row] = await db()
          .select({
            title: objects.title,
            subtitle: objects.subtitle,
            spaceId: objects.spaceId,
            parentId: objects.parentId,
            ownerId: objects.ownerId,
            updatedAt: objects.updatedAt,
          })
          .from(objects)
          .where(eq(objects.id, id))
          .limit(1)
        if (!row) return null
        return {
          parentId: row.parentId,
          type,
          spaceId: row.spaceId,
          title: row.title,
          body: row.subtitle ?? '',
          ownerId: row.ownerId,
          updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
          meta: {},
        }
      },
    })
  }

  registerAnalysisObjectType()
  registerNotebookType()
  registerPipelineObjectType()
  registerSourceObjectType()
}
