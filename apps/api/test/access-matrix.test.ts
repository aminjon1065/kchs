import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  call,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Обязательные негативные тесты доступа (04-verification.md §2), сгенерированные
 * из реестра типов: у каждого зарегистрированного типа должна быть фикстура,
 * иначе тест падает — новый тип нельзя добавить без покрытия.
 *
 * Субъекты: посторонний (нет прав) и читатель (view, без edit).
 */
// Встречи и запись (ADR-0089, ADR-0092): фикстуры типов `meeting` и `recording`
// требуют настроенного медиасервера; сам Egress подменён — в матрице проверяются
// права, а не медиасервер
vi.mock('../src/modules/meetings/domain/recording-egress.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/meetings/domain/recording-egress.js')>()
  let started = 0
  return {
    ...actual,
    startRoomRecording: async () => ({ egressId: `EG_matrix_${++started}` }),
    stopRoomRecording: async () => undefined,
    egressInfo: async () => null,
  }
})

registerLifecycle()

const { listObjectTypes } = await import('../src/kernel/objects/registry.js')
const { ObjectService } = await import('../src/kernel/objects/service.js')
const { LinkService } = await import('../src/kernel/links/service.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { indexObject } = await import('../src/kernel/search/index-service.js')
const { canJoin } = await import('../src/kernel/realtime/gateway.js')
const { buildUserCtx } = await import('../src/kernel/context-builder.js')
const { systemCtx } = await import('../src/shared/context.js')
const { resetConfigCache } = await import('../src/shared/config/index.js')
const { registeredRoutes } = await import('../src/shared/http/route.js')
const { JobService } = await import('../src/kernel/jobs/service.js')
const {
  basemaps,
  cases,
  pipelines,
  serviceLayers,
  sources,
  correspondents,
  documentTypes,
  journals,
  templates,
  territories,
  territoryClosure,
  uploadSessions,
  views,
} = await import('../src/db-schema.js')

interface Created {
  id: string
  title: string
}

interface Request {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  payload?: unknown
}

interface TypeFixture {
  /** Создаёт объект типа от имени владельца; читатель получает view, посторонний — ничего. */
  create: (fx: TestContext, title: string) => Promise<Created>
  /** Маршруты модуля для чтения объекта; `:id` заменяется идентификатором. */
  readPaths: string[]
  /** Скачивание, экспорт, печать. */
  exportPaths?: string[]
  /** Действия модуля выше уровня view: читатель получает 403. */
  viewerForbidden?: (fx: TestContext, id: string) => Request[]
}

const run = Date.now().toString(36)

/**
 * Объект каждого типа из матрицы: посторонний его не видит. По нему тест маршрутов
 * (ADR-0186) подставляет параметр пути, не создавая объектов заново.
 */
const matrixObjects = new Map<string, string>()

async function createFolder(fx: TestContext, name: string, spaceId = fx.spaceId): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId },
  })
  expect(response.statusCode).toBe(200)
  return response.json().id
}

/** Файл-источник для попытки импорта читателем (готовится при создании датасета). */
let datasetSourceFileId = ''

/** Командный календарь в пространстве матрицы: читатель видит его по роли пространства. */
async function createMatrixCalendar(fx: TestContext, title: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/calendars',
    as: fx.admin,
    payload: { kind: 'team', title, spaceId: fx.spaceId },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id
}

/** Датасет-источник графика в пространстве матрицы. */
async function createMatrixDataset(fx: TestContext, title: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: title,
      spaceId: fx.spaceId,
      fields: [{ key: 'code', label: { ru: 'Код' }, type: 'identifier' }],
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id
}

/** Датасет с геометрией — источник слоя в пространстве матрицы. */
async function createMatrixGeoDataset(fx: TestContext, title: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: title,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
        { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
      ],
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id
}

/** Встреча администратора без участников: доступ читателю выдаётся записью ACL. */
async function createMatrixMeeting(fx: TestContext, title: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/meetings',
    as: fx.admin,
    payload: { title, participantIds: [] },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id
}

/** Уровень `view` читателю: объекты в закрытых пространствах роль не раздаёт. */
async function grantView(fx: TestContext, objectId: string): Promise<void> {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/objects/${objectId}/access`,
    as: fx.admin,
    payload: {
      grants: [{ principal: { type: 'user', id: fx.users.viewer.id }, level: 'view' }],
    },
  })
  expect(response.statusCode, response.body).toBe(200)
}

const FIXTURES: Record<string, TypeFixture> = {
  space: {
    create: async (fx, title) => {
      const ctx = systemCtx('test')
      const id = await db().transaction((tx) =>
        SpaceService.create(tx, ctx, {
          key: `matrix-${run}`,
          name: title,
          kind: 'team',
          ownerId: fx.admin.id,
        }),
      )
      await db().transaction((tx) =>
        SpaceService.addMember(tx, ctx, id, fx.users.viewer.id, 'viewer'),
      )
      await redis().del(`kchs:principals:${fx.users.viewer.id}`)
      return { id, title }
    },
    readPaths: ['/spaces/:id', '/spaces/:id/members'],
    viewerForbidden: (fx, id) => [
      {
        method: 'POST',
        url: `/spaces/${id}/members`,
        payload: { userId: fx.users.stranger.id, role: 'viewer' },
      },
    ],
  },

  folder: {
    create: async (fx, title) => ({ id: await createFolder(fx, title), title }),
    readPaths: [],
    viewerForbidden: (fx, id) => [
      {
        method: 'POST',
        url: '/folders',
        payload: { name: 'x', spaceId: fx.spaceId, parentId: id },
      },
    ],
  },

  file: {
    create: async (fx, title) => {
      const file = await uploadFile(fx.app, fx.admin, {
        spaceId: fx.spaceId,
        name: title,
        content: `Содержимое файла ${title}`,
      })
      return { id: file.id, title }
    },
    readPaths: ['/files/:id', '/files/:id/versions', '/files/:id/previews', '/files/:id/text'],
    exportPaths: ['/files/:id/download'],
    viewerForbidden: (fx, id) => [
      {
        method: 'POST',
        url: '/files/upload-sessions',
        payload: { name: 'v2.txt', size: 1, mime: 'text/plain', spaceId: fx.spaceId, fileId: id },
      },
    ],
  },

  view: {
    create: async (fx, title) => {
      const ctx = systemCtx('test', { initiatorId: fx.admin.id })
      const object = await db().transaction(async (tx) => {
        const created = await ObjectService.create(tx, ctx, {
          type: 'view',
          spaceId: fx.spaceId,
          title,
          ownerId: fx.admin.id,
        })
        await tx.insert(views).values({ id: created.id, objectType: 'file', definition: {} })
        return created
      })
      return { id: object.id, title }
    },
    readPaths: ['/views/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/views/${id}`, payload: { title: 'правка читателя' } },
    ],
  },

  conversation: {
    create: async (fx, title) => {
      const folderId = await createFolder(fx, title)
      const posted = await call(fx.app, {
        method: 'POST',
        url: `/objects/${folderId}/discussion/messages`,
        as: fx.admin,
        payload: {
          body: { type: 'doc', content: [] },
          text: 'Сообщение для проверки доступа',
          attachments: [],
          mentions: [],
          mentionedObjectIds: [],
        },
      })
      expect(posted.statusCode).toBe(200)
      const discussion = await call(fx.app, {
        url: `/objects/${folderId}/discussion`,
        as: fx.admin,
      })
      const conversation = discussion.json().conversation as { id: string; title?: string }
      const summary = await ObjectService.summaries([conversation.id])
      return { id: conversation.id, title: summary.get(conversation.id)?.title ?? title }
    },
    readPaths: ['/conversations/:id/messages'],
    viewerForbidden: (_fx, id) => [
      {
        method: 'POST',
        url: `/conversations/${id}/messages`,
        payload: {
          body: { type: 'doc', content: [] },
          text: 'читатель не пишет',
          attachments: [],
          mentions: [],
          mentionedObjectIds: [],
        },
      },
    ],
  },

  chart: {
    create: async (fx, title) => {
      const dataset = await createMatrixDataset(fx, `${title} — данные`)
      const response = await call(fx.app, {
        method: 'POST',
        url: '/charts',
        as: fx.admin,
        payload: {
          name: title,
          spaceId: fx.spaceId,
          spec: {
            version: 1,
            type: 'table',
            data: { query: { version: 1, source: { kind: 'dataset', id: dataset }, steps: [] } },
            encoding: {},
          },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/charts/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/charts/${id}`, payload: { name: 'правка читателя' } },
    ],
  },

  metric: {
    create: async (fx, title) => {
      const dataset = await createMatrixDataset(fx, `${title} — данные`)
      const response = await call(fx.app, {
        method: 'POST',
        url: '/metrics',
        as: fx.admin,
        payload: {
          name: title,
          spaceId: fx.spaceId,
          datasetId: dataset,
          definition: { measure: { agg: 'count' }, period: null },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/metrics/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/metrics/${id}`, payload: { name: 'правка читателя' } },
    ],
  },

  form: {
    create: async (fx, title) => {
      const dataset = await createMatrixDataset(fx, `${title} — данные`)
      const response = await call(fx.app, {
        method: 'POST',
        url: '/forms',
        as: fx.admin,
        payload: {
          name: title,
          spaceId: fx.spaceId,
          definition: {
            datasetId: dataset,
            fields: [{ key: 'code', required: false }],
            schedule: { periodicity: 'monthly' },
          },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/forms/:id', '/forms/:id/schema', '/forms/:id/control'],
    viewerForbidden: (_fx, id) => [
      { method: 'POST', url: `/forms/${id}/enabled`, payload: { enabled: true } },
      { method: 'PUT', url: `/forms/${id}`, payload: { name: 'правка читателя' } },
    ],
  },

  alert: {
    create: async (fx, title) => {
      const dataset = await createMatrixDataset(fx, `${title} — данные`)
      const metric = await call(fx.app, {
        method: 'POST',
        url: '/metrics',
        as: fx.admin,
        payload: {
          name: `${title} — показатель`,
          spaceId: fx.spaceId,
          datasetId: dataset,
          definition: { measure: { agg: 'count' }, period: null },
        },
      })
      expect(metric.statusCode, metric.body).toBe(200)
      const response = await call(fx.app, {
        method: 'POST',
        url: '/alerts',
        as: fx.admin,
        payload: {
          name: title,
          spaceId: fx.spaceId,
          definition: {
            metricId: metric.json().id,
            condition: { kind: 'threshold', op: 'gt', value: 0 },
            schedule: { cron: '0 9 * * *', timezone: 'Asia/Dushanbe' },
          },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/alerts/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'POST', url: `/alerts/${id}/enabled`, payload: { enabled: true } },
      { method: 'POST', url: `/alerts/${id}/check`, payload: { dryRun: true } },
    ],
  },

  dashboard: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/dashboards',
        as: fx.admin,
        payload: { name: title, spaceId: fx.spaceId },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/dashboards/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/dashboards/${id}`, payload: { name: 'правка читателя' } },
    ],
  },

  layer: {
    create: async (fx, title) => {
      const dataset = await createMatrixGeoDataset(fx, `${title} — данные`)
      const response = await call(fx.app, {
        method: 'POST',
        url: '/gis/layers',
        as: fx.admin,
        payload: { name: title, spaceId: fx.spaceId, datasetId: dataset },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: [
      '/gis/layers/:id',
      '/gis/layers/:id/features',
      '/gis/layers/:id/editing',
      '/gis/layers/:id/edits',
    ],
    exportPaths: ['/gis/layers/:id/tiles/6/44/24.pbf', '/gis/layers/:id/features/1'],
    viewerForbidden: (_fx, id) => {
      const geometry = { type: 'Point', coordinates: [69, 38.5] }
      return [
        { method: 'PATCH', url: `/gis/layers/${id}`, payload: { name: 'правка читателя' } },
        // Правка объектов (ADR-0076): напрямую и проверка — edit, предложение — comment
        { method: 'POST', url: `/gis/layers/${id}/features`, payload: { geometry } },
        {
          method: 'PATCH',
          url: `/gis/layers/${id}/features/1`,
          payload: { values: {}, geometry, ver: 1 },
        },
        { method: 'DELETE', url: `/gis/layers/${id}/features/1?ver=1` },
        { method: 'POST', url: `/gis/layers/${id}/edits`, payload: { op: 'create', geometry } },
        {
          method: 'POST',
          url: `/gis/layers/${id}/edits/1/review`,
          payload: { decision: 'approve' },
        },
      ]
    },
  },

  map: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/gis/maps',
        as: fx.admin,
        payload: { name: title, spaceId: fx.spaceId },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/gis/maps/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/gis/maps/${id}`, payload: { name: 'правка читателя' } },
    ],
  },

  // Анализ без запуска: карточка — маршрут чтения, перезапуск — право правки (ADR-0069)
  analysis: {
    create: async (fx, title) => {
      const dataset = await call(fx.app, {
        method: 'POST',
        url: '/datasets',
        as: fx.admin,
        payload: {
          name: `${title} — данные`,
          spaceId: fx.spaceId,
          fields: [{ key: 'place', label: { ru: 'Место' }, type: 'geometry' }],
        },
      })
      expect(dataset.statusCode, dataset.body).toBe(200)
      const response = await call(fx.app, {
        method: 'POST',
        url: '/analyses',
        as: fx.admin,
        payload: {
          name: title,
          spaceId: fx.spaceId,
          run: false,
          query: {
            version: 1,
            source: { kind: 'dataset', id: dataset.json().id },
            steps: [{ type: 'spatial', op: 'buffer', params: { distance: 100 } }],
          },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/analyses/:id'],
    viewerForbidden: (_fx, id) => [{ method: 'POST', url: `/analyses/${id}/run` }],
  },

  notebook: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/notebooks',
        as: fx.admin,
        payload: { name: title, spaceId: fx.spaceId, cells: [{ id: 'intro', kind: 'text' }] },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/notebooks/:id'],
    // Правка тела — через /collab (права проверяет сервер совместной правки, collab.test.ts);
    // ячейки от сервера — тоже только с правом edit
    viewerForbidden: (_fx, id) => [
      {
        method: 'POST',
        url: `/notebooks/${id}/cells`,
        payload: { cells: [{ id: 'm1', kind: 'metric' }] },
      },
    ],
  },

  report: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/reports',
        as: fx.admin,
        payload: {
          name: title,
          spaceId: fx.spaceId,
          blocks: [
            { id: 'intro', kind: 'text' },
            { id: 'brk', kind: 'page_break' },
          ],
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/reports/:id', '/reports/:id/runs', '/reports/:id/schedule', '/print/reports/:id'],
    // Шаблон правится через /collab; рассылку задаёт только управляющий отчётом.
    // «Сформировать» читателю доступно — под его правами (ADR-0078)
    viewerForbidden: (fx, id) => [
      {
        method: 'PUT',
        url: `/reports/${id}/schedule`,
        payload: {
          frequency: 'daily',
          timezone: 'Asia/Dushanbe',
          recipients: [fx.users.viewer.id],
          channels: ['inbox'],
        },
      },
      { method: 'DELETE', url: `/reports/${id}/schedule` },
      { method: 'POST', url: `/reports/${id}/schedule/run` },
    ],
  },

  // Справочник открыт всем выдачей everyone:*; без неё территория подчиняется
  // общим правилам ядра, как любой объект, — это и проверяет матрица
  territory: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'territory', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx.insert(territories).values({
          id: object.id,
          code: `MATRIX-${run}`,
          level: 'district',
          name: { ru: title },
        })
        await tx
          .insert(territoryClosure)
          .values({ territoryId: object.id, ancestorId: object.id, depth: 0 })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/territories/:id'],
  },

  // Подложки установки глобальны (ACL everyone:view, ADR-0066); матрице — объект в
  // пространстве теста: права идут от роли в пространстве, как у любого объекта
  basemap: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'basemap', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx.insert(basemaps).values({ id: object.id, key: `matrix-${run}`, kind: 'none' })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/gis/basemaps/:id', '/gis/basemaps/:id/style.json'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/gis/basemaps/${id}`, payload: { name: 'правка читателя' } },
      { method: 'POST', url: `/gis/basemaps/${id}/default` },
      { method: 'DELETE', url: `/gis/basemaps/${id}` },
    ],
  },

  // Пайплайн и источник — объекты пространства (ADR-0106, ADR-0107)
  pipeline: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'pipeline', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx.insert(pipelines).values({
          id: object.id,
          definition: {
            version: 1,
            source: { kind: 'dataset', id: object.id },
            steps: [],
            outputName: title,
          },
        })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/pipelines/:id', '/pipelines/:id/runs'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/pipelines/${id}`, payload: { enabled: false } },
      { method: 'POST', url: `/pipelines/${id}/run` },
    ],
  },

  source: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'source', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx.insert(sources).values({
          id: object.id,
          integrationId: object.id,
          config: { query: { kind: 'table', schema: 'public', table: 'none' }, columns: [] },
        })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/sources/:id', '/sources/:id/runs'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/sources/${id}`, payload: { enabled: false } },
      { method: 'POST', url: `/sources/${id}/sync` },
    ],
  },

  // Слой-ссылка принадлежит установке, как подложка: видят все, ведут — управляющие
  service_layer: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'service_layer', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx.insert(serviceLayers).values({
          id: object.id,
          kind: 'xyz',
          url: 'https://tiles.example.org/{z}/{x}/{y}.png',
          params: { kind: 'xyz' },
        })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/gis/service-layers/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/gis/service-layers/${id}`, payload: { name: 'правка читателя' } },
      { method: 'POST', url: `/gis/service-layers/${id}/check` },
    ],
  },

  dataset: {
    create: async (fx, title) => {
      const file = await uploadFile(fx.app, fx.admin, {
        spaceId: fx.spaceId,
        name: `${title}.csv`,
        content: 'code\nA-1\n',
        mime: 'text/csv',
      })
      datasetSourceFileId = file.id
      const response = await call(fx.app, {
        method: 'POST',
        url: '/datasets',
        as: fx.admin,
        payload: {
          name: title,
          spaceId: fx.spaceId,
          fields: [{ key: 'code', label: { ru: 'Код' }, type: 'identifier' }],
          primaryKey: ['code'],
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/datasets/:id', '/datasets/:id/versions', '/datasets/:id/imports'],
    viewerForbidden: (_fx, id) => [
      {
        method: 'POST',
        url: `/datasets/${id}/rows`,
        payload: { rows: [{ values: { code: 'V-1' } }] },
      },
      {
        method: 'POST',
        url: `/datasets/${id}/fields`,
        payload: { key: 'extra', label: { ru: 'Ещё' }, type: 'text' },
      },
      { method: 'GET', url: `/datasets/${id}/policies` },
      {
        method: 'POST',
        url: `/datasets/${id}/policies/rows`,
        payload: {
          principal: { type: 'everyone', id: '*' },
          filter: { field: 'code', op: 'eq', value: 'A-1' },
        },
      },
      {
        method: 'POST',
        url: '/datasets/imports',
        payload: {
          fileId: datasetSourceFileId,
          target: { kind: 'existing', datasetId: id, mode: 'append' },
          mapping: [
            {
              column: 0,
              fieldKey: 'code',
              label: { ru: 'Код' },
              type: 'identifier',
              semantic: 'identifier',
            },
          ],
        },
      },
    ],
  },

  task: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/tasks',
        as: fx.admin,
        payload: { title, spaceId: fx.spaceId },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/tasks/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/tasks/${id}`, payload: { title: 'правка читателя' } },
      { method: 'POST', url: `/tasks/${id}/status`, payload: { status: 'in_progress' } },
    ],
  },

  // Серия повторяющихся задач (ADR-0156) — в пространстве матрицы, как задача
  task_series: {
    create: async (fx, title) => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
      const response = await call(fx.app, {
        method: 'POST',
        url: '/task-series',
        as: fx.admin,
        payload: {
          template: { kind: 'task', title, spaceId: fx.spaceId },
          rule: { freq: 'daily', interval: 1, time: '09:00' },
          startsOn: tomorrow,
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/task-series/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/task-series/${id}`, payload: { title: 'правка читателя' } },
      { method: 'POST', url: `/task-series/${id}/pause` },
    ],
  },

  // Документ живёт в системном пространстве документооборота без участников:
  // читатель получает view явной записью, как любой участник документа
  document: {
    create: async (fx, title) => {
      const types = await call(fx.app, { url: '/document-types', as: fx.admin })
      let typeId = (types.json().items as Array<{ id: string }>)[0]?.id
      if (!typeId) {
        const created = await call(fx.app, {
          method: 'POST',
          url: '/document-types',
          as: fx.admin,
          payload: { key: `matrix_${run}`, name: { ru: 'Матрица' }, direction: 'internal' },
        })
        expect(created.statusCode, created.body).toBe(200)
        typeId = created.json().id as string
      }
      const response = await call(fx.app, {
        method: 'POST',
        url: '/documents',
        as: fx.admin,
        payload: { typeId, subject: title },
      })
      expect(response.statusCode, response.body).toBe(200)
      const id = response.json().id as string
      const grant = await call(fx.app, {
        method: 'POST',
        url: `/objects/${id}/access`,
        as: fx.admin,
        payload: {
          grants: [{ principal: { type: 'user', id: fx.users.viewer.id }, level: 'view' }],
        },
      })
      expect(grant.statusCode, grant.body).toBe(200)
      return { id, title }
    },
    readPaths: [
      '/documents/:id',
      '/documents/:id/versions',
      '/documents/:id/correspondence',
      '/documents/:id/dispatches',
      '/documents/:id/cases',
    ],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/documents/${id}`, payload: { subject: 'правка читателя' } },
      { method: 'POST', url: `/documents/${id}/register`, payload: {} },
      { method: 'POST', url: `/documents/${id}/cancel`, payload: { reason: 'аннулирую чужое' } },
      {
        method: 'POST',
        url: `/documents/${id}/versions`,
        payload: { mainFileId: '01900000-0000-7000-8000-000000000000' },
      },
      // Отправка и подшивка — делопроизводителю с правом правки (ADR-0086)
      {
        method: 'POST',
        url: `/documents/${id}/dispatches`,
        payload: { addressee: 'адресат читателя', method: 'post', sentOn: '2026-09-19' },
      },
      {
        method: 'POST',
        url: `/documents/${id}/file`,
        payload: { caseId: '01900000-0000-7000-8000-000000000000' },
      },
    ],
  },

  // Дело номенклатуры (ADR-0086): права — по общим правилам ядра, ведение — manage
  case: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'case', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx
          .insert(cases)
          .values({ id: object.id, index: `M-${run}`, title, year: 2026, retentionYears: 5 })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/cases/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/cases/${id}`, payload: { title: 'правка читателя' } },
      { method: 'POST', url: `/cases/${id}/close`, payload: {} },
      { method: 'POST', url: `/cases/${id}/archive`, payload: {} },
    ],
  },

  // Справочники документооборота открыты всем выдачей everyone:*; в матрице — объекты
  // в пространстве теста: права по общим правилам ядра, как у территорий
  document_type: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'document_type', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx.insert(documentTypes).values({
          id: object.id,
          key: `matrix_type_${run}`,
          name: { ru: title },
          direction: 'internal',
        })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/document-types/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/document-types/${id}`, payload: { name: { ru: 'правка' } } },
    ],
  },

  journal: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'journal', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx
          .insert(journals)
          .values({ id: object.id, name: title, prefix: 'М', format: '{prefix}-{seq}' })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/journals/:id', '/journals/:id/reservations'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/journals/${id}`, payload: { name: 'правка читателя' } },
      {
        method: 'POST',
        url: `/journals/${id}/reservations`,
        payload: { count: 1, note: 'резерв читателя' },
      },
    ],
  },

  // Шаблон документа (ADR-0085) — справочник, как тип документа
  template: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'template', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx.insert(templates).values({ id: object.id, name: title })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/document-templates/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/document-templates/${id}`, payload: { name: 'правка читателя' } },
      {
        method: 'POST',
        url: `/document-templates/${id}/file`,
        payload: { fileId: '01900000-0000-7000-8000-000000000000' },
      },
    ],
  },

  correspondent: {
    create: async (fx, title) => {
      const id = await db().transaction(async (tx) => {
        const object = await ObjectService.create(
          tx,
          systemCtx('test', { initiatorId: fx.admin.id }),
          { type: 'correspondent', spaceId: fx.spaceId, title, meta: {} },
        )
        await tx.insert(correspondents).values({ id: object.id, name: title })
        return object.id
      })
      return { id, title }
    },
    readPaths: ['/correspondents/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/correspondents/${id}`, payload: { name: 'правка читателя' } },
    ],
  },

  project: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/projects',
        as: fx.admin,
        payload: { key: `M${run.toUpperCase().slice(-6)}`, name: title, spaceId: fx.spaceId },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/projects/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/projects/${id}`, payload: { name: 'правка читателя' } },
      { method: 'POST', url: '/tasks', payload: { title: 'задача читателя', projectId: id } },
    ],
  },

  // Календарь пространства: права — от ролей пространства, как у любого объекта (ADR-0081)
  calendar: {
    create: async (fx, title) => ({ id: await createMatrixCalendar(fx, title), title }),
    readPaths: ['/calendars/:id', '/calendars/:id/feeds'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/calendars/${id}`, payload: { color: 'red' } },
      {
        method: 'POST',
        url: '/events',
        payload: {
          calendarId: id,
          title: 'событие читателя',
          startsAt: '2031-05-05T05:00:00Z',
          endsAt: '2031-05-05T06:00:00Z',
        },
      },
      {
        method: 'POST',
        url: `/calendars/${id}/import`,
        payload: { ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' },
      },
    ],
  },

  // Открытое событие наследует доступ календаря; «личное» — отдельной проверкой ниже
  event: {
    create: async (fx, title) => {
      const calendarId = await createMatrixCalendar(fx, `${title} — календарь`)
      const response = await call(fx.app, {
        method: 'POST',
        url: '/events',
        as: fx.admin,
        payload: {
          calendarId,
          title,
          startsAt: '2031-05-06T05:00:00Z',
          endsAt: '2031-05-06T06:00:00Z',
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/events/:id'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/events/${id}`, payload: { title: 'правка читателя' } },
      { method: 'POST', url: `/events/${id}/cancel`, payload: { scope: 'series' } },
    ],
  },
  // Встреча живёт в системном пространстве встреч без участников (ADR-0089):
  // читатель получает view явной записью, как приглашённый участник
  meeting: {
    create: async (fx, title) => {
      const id = await createMatrixMeeting(fx, title)
      await grantView(fx, id)
      return { id, title }
    },
    readPaths: ['/meetings/:id', '/meetings/:id/recordings'],
    viewerForbidden: (_fx, id) => [
      // Вход в комнату — уровень «комментарий»; ведение встречи, ссылка гостя,
      // заявки, запись и протокол — «управление»
      { method: 'POST', url: `/meetings/${id}/join` },
      { method: 'POST', url: `/meetings/${id}/end` },
      { method: 'POST', url: `/meetings/${id}/guest-link`, payload: { ttlMinutes: 60 } },
      { method: 'GET', url: `/meetings/${id}/knocks` },
      { method: 'POST', url: `/meetings/${id}/recording/start` },
      { method: 'POST', url: `/meetings/${id}/protocol` },
    ],
  },

  recording: {
    create: async (fx, title) => {
      const meeting = await call(fx.app, {
        method: 'POST',
        url: '/meetings',
        as: fx.admin,
        payload: { title, participantIds: [fx.users.viewer.id] },
      })
      expect(meeting.statusCode, meeting.body).toBe(200)
      const started = await call(fx.app, {
        method: 'POST',
        url: `/meetings/${meeting.json().id}/recording/start`,
        as: fx.admin,
      })
      expect(started.statusCode, started.body).toBe(200)
      // Название записи совпадает с названием встречи — по нему её ищут
      return { id: started.json().id, title }
    },
    readPaths: ['/recordings/:id', '/recordings/:id/transcript'],
    viewerForbidden: (_fx, id) => [{ method: 'POST', url: `/recordings/${id}/stop` }],
  },

  rule: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/automation/rules',
        as: fx.admin,
        payload: {
          spaceId: fx.spaceId,
          definition: {
            name: { ru: title },
            enabled: false,
            // Выключенному правилу служебная запись не обязательна (ADR-0130)
            runAs: null,
            trigger: { kind: 'event', type: 'object.created', filter: {} },
            conditions: null,
            actions: [
              {
                type: 'notify',
                to: [`user:${fx.users.member.id}`],
                text: 'Создан объект {{object.title}}',
              },
            ],
          },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/automation/rules/:id', '/automation/rules/:id/runs'],
    viewerForbidden: (_fx, id) => [
      {
        method: 'POST',
        url: `/automation/rules/${id}/enabled`,
        payload: { enabled: true },
      },
    ],
  },

  page: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/pages',
        as: fx.admin,
        payload: { title, spaceId: fx.spaceId, template: 'instruction' },
      })
      expect(response.statusCode, response.body).toBe(200)
      return { id: response.json().id, title }
    },
    readPaths: ['/pages/:id', '/pages/:id/versions', '/pages/:id/versions/compare'],
    // Правка тела — через /collab (права проверяет сервер совместной правки);
    // блоки от сервера, публикация, версии, пересмотр и ознакомление — выше view
    viewerForbidden: (_fx, id) => [
      {
        method: 'POST',
        url: `/pages/${id}/blocks`,
        payload: { blocks: [{ id: 'b1', kind: 'text' }] },
      },
      { method: 'POST', url: `/pages/${id}/publish`, payload: {} },
      { method: 'POST', url: `/pages/${id}/versions`, payload: {} },
      { method: 'PATCH', url: `/pages/${id}`, payload: { reviewAt: null } },
      { method: 'POST', url: `/pages/${id}/acknowledgments`, payload: { userIds: [] } },
    ],
  },

  protocol: {
    create: async (fx, title) => {
      const meetingId = await createMatrixMeeting(fx, `${title} — встреча`)
      const response = await call(fx.app, {
        method: 'POST',
        url: `/meetings/${meetingId}/protocol`,
        as: fx.admin,
      })
      expect(response.statusCode, response.body).toBe(200)
      const id = response.json().id as string
      // Читатель видит протокол явной записью ACL: участие дало бы ему и правку
      await grantView(fx, id)
      return { id, title: response.json().title as string }
    },
    readPaths: ['/protocols/:id'],
    viewerForbidden: (_fx, id) => [
      {
        method: 'POST',
        url: `/protocols/${id}/blocks`,
        payload: { blocks: [{ id: 'b1', kind: 'note' }] },
      },
      { method: 'POST', url: `/protocols/${id}/confirm` },
      { method: 'POST', url: `/protocols/${id}/acknowledgments`, payload: {} },
    ],
  },

  // Интеграции и вебхуки (ADR-0097): справочник установки, читателю его
  // выдаёт только запись ACL — способности `automation.manage` у него нет
  integration: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/integrations',
        as: fx.admin,
        payload: {
          key: `matrix-int-${run}`,
          kind: 'http',
          name: title,
          config: { url: 'https://example.org/api' },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      const id = response.json().id as string
      await grantView(fx, id)
      return { id, title }
    },
    readPaths: ['/integrations/:id', '/integrations/:id/syncs'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/integrations/${id}`, payload: { enabled: false } },
      { method: 'POST', url: `/integrations/${id}/check` },
      { method: 'POST', url: `/integrations/${id}/inbound-secret` },
      { method: 'DELETE', url: `/integrations/${id}` },
    ],
  },

  webhook: {
    create: async (fx, title) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/webhooks',
        as: fx.admin,
        payload: { name: title, url: 'http://127.0.0.1:9/matrix', eventTypes: ['object.*'] },
      })
      expect(response.statusCode, response.body).toBe(200)
      const id = response.json().webhook.id as string
      await grantView(fx, id)
      return { id, title }
    },
    readPaths: ['/webhooks/:id', '/webhooks/:id/deliveries'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/webhooks/${id}`, payload: { status: 'paused' } },
      { method: 'POST', url: `/webhooks/${id}/secret` },
      { method: 'DELETE', url: `/webhooks/${id}` },
    ],
  },
}

let fx: TestContext

beforeAll(async () => {
  // Ключи медиасервера — как в установке со встречами: иначе типы `meeting` и
  // `recording` завести нечем (ADR-0089, ADR-0092)
  process.env.LIVEKIT_URL = 'ws://127.0.0.1:7880'
  process.env.LIVEKIT_API_KEY = 'matrix_key'
  process.env.LIVEKIT_API_SECRET = 'matrix_secret_at_least_32_characters_long'
  resetConfigCache()
  fx = await setupFixture()
})

async function userCtx(user: TestUser) {
  return buildUserCtx(
    { sessionId: `test-${user.id}`, userId: user.id, onBehalfOf: null, mfaEnrolled: true },
    {
      id: 'test',
      ip: null,
      headers: {},
    } as never,
  )
}

async function searchTitles(user: TestUser, q: string): Promise<string[]> {
  const response = await call(fx.app, { url: `/search?q=${encodeURIComponent(q)}`, as: user })
  expect(response.statusCode).toBe(200)
  return (response.json().hits as Array<{ objectId: string }>).map((h) => h.objectId)
}

describe('матрица доступа по реестру типов', () => {
  it('у каждого зарегистрированного типа есть фикстура', () => {
    const missing = listObjectTypes()
      .map((definition) => definition.type)
      .filter((type) => !FIXTURES[type])
    expect(missing).toEqual([])
  })
})

for (const [type, fixture] of Object.entries(FIXTURES)) {
  describe(`тип «${type}»`, () => {
    let target: Created
    let hubId: string
    const path = (template: string) => template.replace(':id', target.id)

    beforeAll(async () => {
      target = await fixture.create(fx, `Матрица ${type} ${run}`)
      matrixObjects.set(type, target.id)

      // «Хаб» — объект, который посторонний видит: из него идут связь и зависимость
      hubId = await createFolder(fx, `Хаб ${type} ${run}`, fx.orgSpaceId)
      const grant = await call(fx.app, {
        method: 'POST',
        url: `/objects/${hubId}/access`,
        as: fx.admin,
        payload: {
          grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'view' }],
        },
      })
      expect(grant.statusCode).toBe(200)
      const link = await call(fx.app, {
        method: 'POST',
        url: `/objects/${hubId}/links`,
        as: fx.admin,
        payload: { targetId: target.id, kind: 'related' },
      })
      expect(link.statusCode).toBe(200)
      await db().transaction((tx) => LinkService.setDependencies(tx, hubId, [target.id]))
    })

    describe('посторонний', () => {
      it('прямой URL, маршруты модуля и служебные маршруты объекта — 404', async () => {
        const urls = [
          `/objects/${target.id}`,
          `/objects/${target.id}/activity`,
          `/objects/${target.id}/discussion`,
          `/objects/${target.id}/access`,
          `/objects/${target.id}/links`,
          ...fixture.readPaths.map(path),
        ]
        for (const url of urls) {
          const response = await call(fx.app, { url, as: fx.users.stranger })
          expect(response.statusCode, url).toBe(404)
        }
      })

      it('изменение, удаление, доступ и избранное — 404, а не 403', async () => {
        const requests: Request[] = [
          { method: 'PATCH', url: `/objects/${target.id}`, payload: { title: 'взлом' } },
          { method: 'DELETE', url: `/objects/${target.id}` },
          {
            method: 'POST',
            url: `/objects/${target.id}/access`,
            payload: {
              grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'owner' }],
            },
          },
          { method: 'PUT', url: `/objects/${target.id}/favorite` },
        ]
        for (const request of requests) {
          const response = await call(fx.app, { ...request, as: fx.users.stranger })
          expect(response.statusCode, `${request.method} ${request.url}`).toBe(404)
        }
      })

      it('списки и пакетная выборка не выдают объект', async () => {
        const list = await call(fx.app, {
          url: `/objects?q=${encodeURIComponent(target.title)}&limit=100`,
          as: fx.users.stranger,
        })
        expect(list.statusCode).toBe(200)
        expect(list.json().items.map((i: { id: string }) => i.id)).not.toContain(target.id)

        const batch = await call(fx.app, {
          method: 'POST',
          url: '/objects/batch-get',
          as: fx.users.stranger,
          payload: { ids: [target.id] },
        })
        expect(batch.statusCode).toBe(200)
        const item = batch.json().items[0]
        expect(item.accessible).toBe(false)
        expect(item.title).toBe('')
        expect(item.spaceName ?? null).toBeNull()
        expect(item.ownerId).toBeNull()
      })

      it('поиск не находит объект, хотя администратор находит', async () => {
        await indexObject(target.id)
        const deadline = Date.now() + 10_000
        let found: string[] = []
        while (Date.now() < deadline) {
          found = await searchTitles(fx.admin, target.title)
          if (found.includes(target.id)) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        expect(found).toContain(target.id)
        expect(await searchTitles(fx.users.stranger, target.title)).not.toContain(target.id)
      })

      it('связь и зависимость из доступного объекта — без названия и владельца', async () => {
        const response = await call(fx.app, {
          url: `/objects/${hubId}/links`,
          as: fx.users.stranger,
        })
        expect(response.statusCode).toBe(200)
        const body = response.json() as {
          links: Array<{ object: Record<string, unknown> }>
          uses: Array<Record<string, unknown>>
        }
        const viaLink = body.links.find((l) => l.object.id === target.id)?.object
        const viaDependency = body.uses.find((u) => u.id === target.id)
        for (const summary of [viaLink, viaDependency]) {
          expect(summary).toBeDefined()
          expect(summary?.accessible).toBe(false)
          expect(summary?.title).toBe('')
          expect(summary?.ownerId).toBeNull()
          expect(summary?.spaceName ?? null).toBeNull()
        }
      })

      it('realtime-комната отклонена', async () => {
        const ctx = await userCtx(fx.users.stranger)
        expect(await canJoin(ctx, `object:${target.id}`)).toBe(false)
      })

      it('скачивание и экспорт — 404', async () => {
        for (const url of (fixture.exportPaths ?? []).map(path)) {
          const response = await call(fx.app, { url, as: fx.users.stranger })
          expect(response.statusCode, url).toBe(404)
        }
      })
    })

    describe('читатель (view без edit)', () => {
      it('видит объект и маршруты чтения модуля', async () => {
        for (const url of [`/objects/${target.id}`, ...fixture.readPaths.map(path)]) {
          const response = await call(fx.app, { url, as: fx.users.viewer })
          expect(response.statusCode, url).toBe(200)
        }
        const ctx = await userCtx(fx.users.viewer)
        expect(await canJoin(ctx, `object:${target.id}`)).toBe(true)
      })

      it('находит объект в поиске: кто видит объект, тот его и находит', async () => {
        await indexObject(target.id)
        const deadline = Date.now() + 10_000
        let found: string[] = []
        while (Date.now() < deadline) {
          found = await searchTitles(fx.users.viewer, target.title)
          if (found.includes(target.id)) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        // Модуль не может подменить фильтр прав документа (раньше файлы индексировались
        // с пустым aclPrincipals и находились только администратором)
        expect(found).toContain(target.id)
      })

      it('не изменяет, не удаляет и не делится — 403', async () => {
        const requests: Request[] = [
          { method: 'PATCH', url: `/objects/${target.id}`, payload: { title: 'правка читателя' } },
          { method: 'DELETE', url: `/objects/${target.id}` },
          {
            method: 'POST',
            url: `/objects/${target.id}/access`,
            payload: {
              grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'view' }],
            },
          },
          ...(fixture.viewerForbidden?.(fx, target.id) ?? []),
        ]
        for (const request of requests) {
          const response = await call(fx.app, { ...request, as: fx.users.viewer })
          expect(response.statusCode, `${request.method} ${request.url}`).toBe(403)
        }
      })
    })
  })
}

describe('сквозные правила доступа', () => {
  it('после отзыва доступа к объекту его обсуждение недоступно и первому комментатору', async () => {
    const folderId = await createFolder(fx, `Отзыв ${run}`)
    const grant = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'comment' }],
      },
    })
    expect(grant.statusCode).toBe(200)

    const posted = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/discussion/messages`,
      as: fx.users.stranger,
      payload: {
        body: { type: 'doc', content: [] },
        text: 'Первое сообщение',
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
      },
    })
    expect(posted.statusCode).toBe(200)
    const discussion = await call(fx.app, {
      url: `/objects/${folderId}/discussion`,
      as: fx.users.stranger,
    })
    const conversationId = discussion.json().conversation.id as string

    const revoke = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${folderId}/access`,
      as: fx.admin,
      payload: { principal: { type: 'user', id: fx.users.stranger.id } },
    })
    expect(revoke.statusCode).toBe(200)

    for (const url of [
      `/objects/${folderId}/discussion`,
      `/conversations/${conversationId}/messages`,
    ]) {
      const response = await call(fx.app, { url, as: fx.users.stranger })
      expect(response.statusCode, url).toBe(404)
    }
  })

  it('объект нельзя перенести в папку, к которой нет доступа', async () => {
    const own = await createFolder(fx, `Своя ${run}`)
    const grant = await call(fx.app, {
      method: 'POST',
      url: `/objects/${own}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'manage' }],
      },
    })
    expect(grant.statusCode).toBe(200)
    const foreign = await createFolder(fx, `Чужая ${run}`, fx.orgSpaceId)

    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${own}`,
      as: fx.users.stranger,
      payload: { parentId: foreign },
    })
    expect(moved.statusCode).toBe(404)
  })

  it('файл нельзя прикрепить к объекту без права edit на него', async () => {
    const foreign = await createFolder(fx, `Недоступная ${run}`)
    const personal = await call(fx.app, { url: '/me', as: fx.users.stranger })
    const personalSpaceId = personal.json().personalSpaceId as string | undefined
    expect(personalSpaceId).toBeTruthy()

    const session = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.users.stranger,
      payload: {
        name: 'подброс.txt',
        size: 3,
        mime: 'text/plain',
        spaceId: personalSpaceId,
        attachToObjectId: foreign,
      },
    })
    expect(session.statusCode).toBe(404)
  })

  it('комната задания доступна только инициатору', async () => {
    const { JobService } = await import('../src/kernel/jobs/service.js')
    const jobId = await JobService.enqueue(systemCtx('test', { initiatorId: fx.users.viewer.id }), {
      queue: 'maintenance',
      name: 'test.room',
      data: {},
    })
    expect(await canJoin(await userCtx(fx.users.viewer), `job:${jobId}`)).toBe(true)
    expect(await canJoin(await userCtx(fx.users.stranger), `job:${jobId}`)).toBe(false)
    expect(await canJoin(await userCtx(fx.users.stranger), 'object:not-a-uuid')).toBe(false)
  })

  it('чужое личное событие: не видно в списке, поиске, ICS и подборе времени — только «занято»', async () => {
    const calendarId = await createMatrixCalendar(fx, `Личное матрицы ${run}`)
    const title = `Личное событие ${run}`
    const created = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: fx.admin,
      payload: {
        calendarId,
        title,
        startsAt: '2031-05-07T05:00:00Z',
        endsAt: '2031-05-07T06:00:00Z',
        visibility: 'private',
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const eventId = created.json().id as string

    // Прямой адрес и маршрут модуля — 404: читатель видит календарь, но не событие
    for (const url of [`/objects/${eventId}`, `/events/${eventId}`]) {
      const response = await call(fx.app, { url, as: fx.users.viewer })
      expect(response.statusCode, url).toBe(404)
    }
    // Список объектов и пакетная выборка — без названия
    const list = await call(fx.app, {
      url: `/objects?q=${encodeURIComponent(title)}&limit=100`,
      as: fx.users.viewer,
    })
    expect(list.json().items.map((item: { id: string }) => item.id)).not.toContain(eventId)
    // Календарь — «занято» без названия и идентификатора
    const range = await call(fx.app, {
      url: `/calendar/range?from=2031-05-07T00:00:00Z&to=2031-05-08T00:00:00Z&calendarIds=${calendarId}`,
      as: fx.users.viewer,
    })
    expect(range.statusCode, range.body).toBe(200)
    const busy = (range.json().items as Array<{ busy: boolean; eventId: string | null }>)[0]
    expect(busy?.busy).toBe(true)
    expect(busy?.eventId).toBeNull()
    expect(range.body).not.toContain(title)
    // Поиск: администратор находит, читатель — нет
    await indexObject(eventId)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !(await searchTitles(fx.admin, title)).includes(eventId)) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(await searchTitles(fx.admin, title)).toContain(eventId)
    expect(await searchTitles(fx.users.viewer, title)).not.toContain(eventId)
    // Подбор времени — интервал без названия
    const freeBusy = await call(fx.app, {
      url: `/calendar/free-busy?from=2031-05-07T00:00:00Z&to=2031-05-08T00:00:00Z&userIds=${fx.admin.id}`,
      as: fx.users.viewer,
    })
    expect(freeBusy.statusCode, freeBusy.body).toBe(200)
    expect(freeBusy.json().people[0].busy[0].title).toBeNull()
    expect(freeBusy.body).not.toContain(title)
    // ICS-подписка читателя на календарь — «Занято»
    const feed = await call(fx.app, {
      method: 'POST',
      url: `/calendars/${calendarId}/feeds`,
      as: fx.users.viewer,
    })
    expect(feed.statusCode, feed.body).toBe(200)
    const ics = await call(fx.app, { url: new URL(feed.json().url as string).pathname })
    expect(ics.statusCode).toBe(200)
    expect(ics.body).toContain('CLASS:PRIVATE')
    expect(ics.body).not.toContain(title)
    // Посторонний не выпускает ленту чужого календаря
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/calendars/${calendarId}/feeds`,
      as: fx.users.stranger,
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('поиск не допускает выход из фильтра прав через параметры', async () => {
    const secret = await createFolder(fx, `Секрет инъекции ${run}`)
    await indexObject(secret)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if ((await searchTitles(fx.admin, `Секрет инъекции ${run}`)).includes(secret)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const injected = await call(fx.app, {
      url: `/search?q=${encodeURIComponent(`Секрет инъекции ${run}`)}&spaceIds=${encodeURIComponent('x") OR (type EXISTS')}`,
      as: fx.users.stranger,
    })
    expect(injected.statusCode).toBe(400)

    const { search } = await import('../src/kernel/search/index-service.js')
    const ctx = await userCtx(fx.users.stranger)
    const direct = await search(ctx, {
      q: `Секрет инъекции ${run}`,
      spaceIds: ['x") OR (type EXISTS'],
      limit: 20,
      offset: 0,
      mode: 'words' as const,
    })
    expect(direct.hits.map((h) => h.objectId)).not.toContain(secret)
  })
})

// ─── Маршруты с объектом в пути: посторонний не видит (ADR-0186) ─────────────

/**
 * Тип объекта маршрута `{ action }` по адресу: ядро проверяет право до обработчика
 * по любому объекту, но берётся объект своего типа, если он есть в матрице.
 */
const PATH_TYPES: Array<[RegExp, string]> = [
  [/^\/gis\/layers\//, 'layer'],
  [/^\/gis\/maps\//, 'map'],
  [/^\/gis\/basemaps\//, 'basemap'],
  [/^\/gis\/service-layers\//, 'service_layer'],
  [/^\/gis\/territories\//, 'territory'],
  [/^\/datasets\//, 'dataset'],
  [/^\/files\//, 'file'],
  [/^\/folders\//, 'folder'],
  [/^\/documents\//, 'document'],
  [/^\/document-types\//, 'document_type'],
  [/^\/document-templates\//, 'template'],
  [/^\/journals\//, 'journal'],
  [/^\/cases\//, 'case'],
  [/^\/correspondents\//, 'correspondent'],
  [/^\/tasks\//, 'task'],
  [/^\/task-series\//, 'task_series'],
  [/^\/projects\//, 'project'],
  [/^\/charts\//, 'chart'],
  [/^\/dashboards\//, 'dashboard'],
  [/^\/metrics\//, 'metric'],
  [/^\/notebooks\//, 'notebook'],
  [/^\/reports\//, 'report'],
  [/^\/forms\//, 'form'],
  [/^\/alerts\//, 'alert'],
  [/^\/analyses\//, 'analysis'],
  [/^\/pipelines\//, 'pipeline'],
  [/^\/sources\//, 'source'],
  [/^\/pages\//, 'page'],
  [/^\/meetings\//, 'meeting'],
  [/^\/recordings\//, 'recording'],
  [/^\/protocols\//, 'protocol'],
  [/^\/calendars\//, 'calendar'],
  [/^\/events\//, 'event'],
  [/^\/automation\/rules\//, 'rule'],
  [/^\/integrations\//, 'integration'],
  [/^\/webhooks\//, 'webhook'],
  [/^\/spaces\//, 'space'],
  [/^\/views\//, 'view'],
  [/^\/conversations\//, 'conversation'],
  [/^\/territories\//, 'territory'],
]

/** Объекты для `objectType: 'any'`: разные типы с разными политиками. */
const ANY_TYPES = ['folder', 'document', 'page']

/**
 * Вложенные ресурсы без своей фикстуры здесь: где посторонний для них проверен.
 * Новый ресурс в объявлении `delegated` без фикстуры и без строки здесь — падение.
 */
const RESOURCES_ELSEWHERE: Record<string, string> = {
  process: 'ход маршрута объекта — test/processes.test.ts, test/document-routes.test.ts',
  submission: 'ответ формы — test/forms.test.ts, test/forms-table.test.ts',
  import:
    'импорт датасета (нужен движок) — test/data-datasets.test.ts, test/data-import-review.test.ts',
  report_run: 'запуск отчёта (нужен движок) — test/reports.test.ts',
  render: 'рендер документа (нужен движок) — test/documents-print.test.ts',
  rule_run: 'запуск правила — test/automation.test.ts',
  office_session: 'страница редактора вне реестра API — test/office-editor.test.ts',
}

/**
 * Маршруты, которые тест не может довести до проверки прав: схема отвергает
 * собранный из неё запрос раньше обработчика или функция выключена на стенде.
 * Каждый — с причиной; маршрут, который стал проверяться, из списка убирается.
 */
const CHECKED_MANUALLY: Record<string, string> = {}

/**
 * Тела, которые схема из своего описания не даёт собрать: уточнения (`refine`) —
 * срок датой или числом, непустой список получателей, хотя бы одно изменение.
 * Накладываются на собранное из схемы, чтобы запрос дошёл до проверки прав.
 */
const PAYLOADS: Record<string, () => Record<string, unknown> | Array<Record<string, unknown>>> = {
  // Обе ветки: сразу и заданием (`async`) — право проверяется до постановки задания
  'POST /datasets/:id/rows/batch': () => [{ delete: ['1'] }, { delete: ['1'], async: true }],
  'POST /tasks/:id/extension': () => ({ dueWorkingDays: 3, reason: 'посторонний' }),
  'PATCH /tasks/:id/checklist/:itemId': () => ({ done: true }),
  'POST /documents/:id/resolutions': () => ({
    text: 'посторонний',
    responsibleId: randomUUID(),
    dueDate: '2099-01-01',
  }),
  'POST /documents/:id/acknowledgments': () => ({ userIds: [randomUUID()] }),
  'POST /documents/:id/dispatches': () => ({
    addressee: 'посторонний',
    method: 'post',
    sentOn: '2026-09-19',
  }),
}

function pathType(url: string): string {
  for (const [pattern, type] of PATH_TYPES) {
    if (pattern.test(url) && matrixObjects.has(type)) return type
  }
  return 'folder'
}

function defaultParam(name: string): string {
  if (name === 'rowId') return '1'
  if (name === 'key') return 'code'
  if (name === 'index') return '0'
  if (name === 'z' || name === 'x' || name === 'y') return '0'
  return randomUUID()
}

function fillPath(url: string, values: Record<string, string>): string {
  return url.replace(/:([A-Za-z_]\w*)/g, (_, name: string) => values[name] ?? defaultParam(name))
}

type JsonSchema = Record<string, unknown>

/** Минимальное значение по JSON Schema: обязательные поля, первые варианты, нижние границы. */
function sampleJson(schema: JsonSchema | undefined, root: JsonSchema, depth = 0): unknown {
  if (!schema || depth > 8) return undefined
  const ref = schema.$ref
  if (typeof ref === 'string') {
    const name = ref.split('/').pop() ?? ''
    const defs = (root.$defs ?? root.definitions ?? {}) as Record<string, JsonSchema>
    return sampleJson(defs[name], root, depth + 1)
  }
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  if ('default' in schema) return schema.default
  const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined
  if (variants?.length) {
    const concrete = variants.find((v) => v.type !== 'null') ?? variants[0]
    return sampleJson(concrete, root, depth + 1)
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign(
      {},
      ...(schema.allOf as JsonSchema[]).map((part) => sampleJson(part, root, depth + 1)),
    )
  }
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== 'null')
    : (schema.type as string | undefined)
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
      for (const key of (schema.required as string[] | undefined) ?? []) {
        out[key] = sampleJson(properties[key], root, depth + 1)
      }
      return out
    }
    case 'array':
      return Array.from({ length: Number(schema.minItems ?? 0) }, () =>
        sampleJson(schema.items as JsonSchema, root, depth + 1),
      )
    case 'string': {
      if (schema.format === 'uuid') return randomUUID()
      if (schema.format === 'date-time') return new Date().toISOString()
      if (schema.format === 'date') return '2026-01-01'
      if (schema.format === 'email') return 'stranger@example.org'
      // Числовой идентификатор строкой (строка датасета, сообщение)
      if (typeof schema.pattern === 'string' && schema.pattern.includes('\\d')) return '1'
      return 'x'.repeat(Math.max(1, Number(schema.minLength ?? 1)))
    }
    case 'integer':
    case 'number':
      return Number(schema.minimum ?? Number(schema.exclusiveMinimum ?? 0) + 1)
    case 'boolean':
      return false
    case 'null':
      return null
    default:
      return undefined
  }
}

function sampleOf(schema: unknown): unknown {
  if (!schema) return undefined
  try {
    const json = z.toJSONSchema(schema as z.ZodType, {
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchema
    return sampleJson(json, json)
  } catch {
    return undefined
  }
}

function queryOf(schema: unknown): string {
  const value = sampleOf(schema)
  if (!value || typeof value !== 'object') return ''
  const params = new URLSearchParams()
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || item === null) continue
    params.set(key, Array.isArray(item) ? item.join(',') : String(item))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

describe('маршруты с объектом в пути: посторонний не видит (ADR-0186)', () => {
  /** Вложенные ресурсы администратора, к которым у постороннего нет доступа. */
  const resources = new Map<string, Record<string, string>>()

  beforeAll(async () => {
    const folderId = await createFolder(fx, `Ресурсы маршрутов ${run}`)
    const posted = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/discussion/messages`,
      as: fx.admin,
      payload: {
        body: { type: 'doc', content: [] },
        text: 'Сообщение для проверки маршрутов',
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
      },
    })
    expect(posted.statusCode, posted.body).toBe(200)
    resources.set('message', { messageId: posted.json().id as string })

    const jobId = await JobService.enqueue(systemCtx('test', { initiatorId: fx.admin.id }), {
      queue: 'maintenance',
      name: 'test.echo',
      objectId: folderId,
      data: {},
    })
    resources.set('job', { id: jobId })
    // Служебные учётные записи видят администраторы: проверка — до поиска записи
    resources.set('service_account', { id: randomUUID() })
  })

  it('у каждого ресурса делегированного маршрута — фикстура или тест, где он проверен', () => {
    const missing = new Set<string>()
    for (const route of registeredRoutes()) {
      const auth = route.auth
      if (typeof auth !== 'object' || !('delegated' in auth) || !auth.resource) continue
      if (!resources.has(auth.resource) && !RESOURCES_ELSEWHERE[auth.resource]) {
        missing.add(`${auth.resource}: ${route.method} ${route.url}`)
      }
    }
    expect([...missing]).toEqual([])
  })

  it('каждый маршрут с объектом в пути отвечает постороннему 403 или 404', async () => {
    const violations: string[] = []
    const unverified: string[] = []
    const verifiedListed: string[] = []
    let calls = 0

    for (const route of registeredRoutes()) {
      const auth = route.auth
      if (typeof auth !== 'object') continue
      const key = `${route.method} ${route.url}`
      const targets: Array<Record<string, string>> = []
      if ('action' in auth) {
        const id = matrixObjects.get(pathType(route.url))
        if (id) targets.push({ [auth.objectParam ?? 'id']: id })
      } else if ('delegated' in auth) {
        if (auth.resource) {
          const values = resources.get(auth.resource)
          if (values) targets.push(values)
        } else if (auth.objectType) {
          const types =
            auth.objectType === 'any'
              ? ANY_TYPES
              : typeof auth.objectType === 'string'
                ? [auth.objectType]
                : [...auth.objectType]
          for (const type of types) {
            const id = matrixObjects.get(type)
            if (id) targets.push({ [auth.objectParam ?? 'id']: id })
          }
        }
      } else {
        continue
      }

      for (const values of targets) {
        const url = fillPath(route.url, values) + queryOf(route.schema?.querystring)
        const sampled =
          route.method === 'GET' || !route.schema?.body ? undefined : sampleOf(route.schema.body)
        const override = PAYLOADS[key]?.()
        const variants = override === undefined ? [undefined] : [override].flat()
        for (const variant of variants) {
          const payload = variant ? { ...(sampled as object | undefined), ...variant } : sampled
          const response = await call(fx.app, {
            method: route.method,
            url,
            as: fx.users.stranger,
            ...(payload === undefined ? {} : { payload }),
          })
          calls += 1
          const status = response.statusCode
          if (status === 403 || status === 404) {
            if (CHECKED_MANUALLY[key]) verifiedListed.push(key)
            continue
          }
          if (status === 400 || status === 422 || status === 503) {
            if (!CHECKED_MANUALLY[key]) {
              unverified.push(`${key} → ${status}: ${response.body.slice(0, 160)}`)
            }
            continue
          }
          violations.push(`${key} → ${status}: ${response.body.slice(0, 160)}`)
        }
      }
    }

    expect(calls).toBeGreaterThan(300)
    // Посторонний получил ответ по чужому объекту — нарушение прав
    expect(violations).toEqual([])
    // Схема отвергла собранный запрос: маршрут — в CHECKED_MANUALLY с причиной
    expect(unverified).toEqual([])
    // Маршрут из списка теперь проверяется сам — строку из CHECKED_MANUALLY убрать
    expect(verifiedListed).toEqual([])
  }, 600_000)

  /**
   * Свои ресурсы без фикстуры здесь: где проверено, что чужой не открывается.
   * Справочники `open` — явным списком: новый справочник проходит через ревью.
   */
  const OWNED_ELSEWHERE: Record<string, string> = {
    'DELETE /me/delegations/:id': 'завершает только назначивший — test/kernel.test.ts',
    'DELETE /me/passkeys/:keyId': 'только свой ключ — test/passkeys.test.ts',
    'DELETE /assistant/threads/:id': 'только свой разговор — test/assistant.test.ts',
    'GET /datasets/exports/:jobId/download': 'только инициатор экспорта — test/data-export.test.ts',
    'POST /inbox/:id/act': 'только дела получателя (фильтр по userId) — test/inbox-bulk.test.ts',
    'POST /inbox/:id/snooze': 'только дела получателя (фильтр по userId) — test/inbox-bulk.test.ts',
  }
  /**
   * Идемпотентная отмена: ищет только среди своих, чужое не трогает, и ответ один
   * для любого id — о существовании ресурса посторонний не узнаёт. Проверяется,
   * что ресурс администратора после вызова постороннего цел.
   */
  const IDEMPOTENT = new Set(['DELETE /files/upload-sessions/:id'])
  const OPEN_ROUTES = new Set([
    'GET /users/:id',
    'GET /gis/glyphs/:fontstack/:range',
    'GET /gis/sprites/:file',
    'GET /gis/territories/tiles/:z/:x/:y.pbf',
    'GET /system-datasets/:name',
  ])

  it('свои ресурсы: посторонний не открывает чужой; справочники — явным списком', async () => {
    const route = (key: string) => {
      const found = registeredRoutes().find((r) => `${r.method} ${r.url}` === key)
      if (!found) throw new Error(`нет маршрута ${key}`)
      return found
    }

    // Ресурсы администратора: сессия загрузки, токен API, шаблон резолюции, дело «Входящих»
    const upload = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.admin,
      payload: { name: 'чужая.txt', size: 1, mime: 'text/plain', spaceId: fx.spaceId },
    })
    expect(upload.statusCode, upload.body).toBe(200)
    const token = await call(fx.app, {
      method: 'POST',
      url: '/me/api-tokens',
      as: fx.admin,
      payload: { ...(sampleOf(route('POST /me/api-tokens').schema?.body) as object), name: run },
    })
    expect(token.statusCode, token.body).toBe(200)
    const templateText = `Чужой шаблон ${run}`
    const templates = await call(fx.app, {
      method: 'POST',
      url: '/resolution-templates',
      as: fx.admin,
      payload: { text: templateText, shared: false },
    })
    expect(templates.statusCode, templates.body).toBe(200)
    const templateId = (templates.json().items as Array<{ id: string; text: string }>).find(
      (item) => item.text === templateText,
    )?.id

    const owned: Record<string, Record<string, string> | undefined> = {
      'POST /files/upload-sessions/:id/complete': { id: upload.json().uploadId },
      'GET /files/upload-sessions/:id': { id: upload.json().uploadId },
      'DELETE /files/upload-sessions/:id': { id: upload.json().uploadId },
      'DELETE /me/api-tokens/:id': { id: token.json().token.id },
      'PATCH /resolution-templates/:id': templateId ? { id: templateId } : undefined,
      'DELETE /resolution-templates/:id': templateId ? { id: templateId } : undefined,
    }

    // Фикстура без настоящего id проверяла бы случайный идентификатор
    for (const [key, values] of Object.entries(owned)) {
      for (const value of Object.values(values ?? {})) {
        expect(typeof value === 'string' && value.length > 0, key).toBe(true)
      }
    }

    const problems: string[] = []
    for (const registered of registeredRoutes()) {
      const auth = registered.auth
      if (typeof auth !== 'object') continue
      const key = `${registered.method} ${registered.url}`
      if ('open' in auth) {
        if (!OPEN_ROUTES.has(key)) problems.push(`${key}: справочник не в списке OPEN_ROUTES`)
        continue
      }
      if (!('owned' in auth)) continue
      if (OWNED_ELSEWHERE[key]) continue
      const values = owned[key]
      if (!values) {
        problems.push(`${key}: нет ресурса администратора и строки в OWNED_ELSEWHERE`)
        continue
      }
      const payload =
        registered.method === 'GET' || !registered.schema?.body
          ? undefined
          : sampleOf(registered.schema.body)
      const response = await call(fx.app, {
        method: registered.method,
        url: fillPath(registered.url, values) + queryOf(registered.schema?.querystring),
        as: fx.users.stranger,
        ...(payload === undefined ? {} : { payload }),
      })
      if (IDEMPOTENT.has(key) && response.statusCode === 200) continue
      if (response.statusCode !== 403 && response.statusCode !== 404) {
        problems.push(`${key} → ${response.statusCode}: ${response.body.slice(0, 160)}`)
      }
    }
    expect(problems).toEqual([])
    // Сессия загрузки администратора после «отмены» постороннего — не отменена
    const { eq } = await import('drizzle-orm')
    const [session] = await db()
      .select({ status: uploadSessions.status })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, upload.json().uploadId))
    expect(session?.status).toBeDefined()
    expect(session?.status).not.toBe('aborted')
  })
})
