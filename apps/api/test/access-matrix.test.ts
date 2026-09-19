import { beforeAll, describe, expect, it } from 'vitest'
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
registerLifecycle()

const { listObjectTypes } = await import('../src/kernel/objects/registry.js')
const { ObjectService } = await import('../src/kernel/objects/service.js')
const { LinkService } = await import('../src/kernel/links/service.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { indexObject } = await import('../src/kernel/search/index-service.js')
const { canJoin } = await import('../src/kernel/realtime/gateway.js')
const { buildUserCtx } = await import('../src/kernel/context-builder.js')
const { systemCtx } = await import('../src/shared/context.js')
const { basemaps, correspondents, documentTypes, journals, territories, territoryClosure, views } =
  await import('../src/shared/db/schema/index.js')

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
    readPaths: ['/documents/:id', '/documents/:id/versions'],
    viewerForbidden: (_fx, id) => [
      { method: 'PATCH', url: `/documents/${id}`, payload: { subject: 'правка читателя' } },
      { method: 'POST', url: `/documents/${id}/register`, payload: {} },
      { method: 'POST', url: `/documents/${id}/cancel`, payload: { reason: 'аннулирую чужое' } },
      {
        method: 'POST',
        url: `/documents/${id}/versions`,
        payload: { mainFileId: '01900000-0000-7000-8000-000000000000' },
      },
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
}

let fx: TestContext

beforeAll(async () => {
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
    })
    expect(direct.hits.map((h) => h.objectId)).not.toContain(secret)
  })
})
