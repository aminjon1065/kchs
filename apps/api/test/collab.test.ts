import type { AddressInfo } from 'node:net'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { NOTEBOOK_DOC, type NotebookRecord } from '@kchs/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  call,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Совместное редактирование (P2-E05 S01–S02, ADR-0070/0071): вход в документ
 * по сессии и CSRF-токену, права `view`/`edit`, правка видна соавторам сразу,
 * состояние и JSON-снимок тетради сохраняются и восстанавливаются, сервер
 * добавляет ячейки в открытый документ, отзыв доступа закрывает подключение.
 * Клиент — настоящий HocuspocusProvider, сервер — api на случайном порту.
 */
registerLifecycle()

const { startCollab, stopCollab } = await import('../src/kernel/collab/server.js')
const { COLLAB_CHANNEL } = await import('../src/kernel/collab/registry.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { NotebookService } = await import('../src/modules/data/domain/notebook-service.js')
const { dependencies, yjsDocuments } = await import('../src/shared/db/schema/index.js')

let fx: TestContext
let url: string
let notebookId: string
let datasetId: string
const run = Date.now().toString(36)
const opened: Client[] = []

type Outcome = { scope: string } | { denied: string }

interface Client {
  doc: Y.Doc
  provider: HocuspocusProvider
  /** Итог входа: право подключения или причина отказа. */
  ready: Promise<Outcome>
  /** Причина, по которой сервер закрыл документ. */
  closed: Promise<string>
  close: () => void
}

/** Подключение как в браузере: cookie сессии на апгрейде, CSRF-токен — в поле token. */
function connect(user: TestUser | null, options: { token?: string; name?: string } = {}): Client {
  const headers = user ? { cookie: user.cookie } : {}
  // WebSocket Node (undici) принимает заголовки рукопожатия вторым аргументом
  class CookieSocket extends WebSocket {
    constructor(address: string | URL) {
      super(address, { headers } as unknown as string[])
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: CookieSocket,
    maxAttempts: 1,
  })
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: options.name ?? notebookId,
    document: doc,
    token: options.token ?? user?.csrf ?? '',
  })
  const ready = new Promise<Outcome>((resolve) => {
    provider.on('synced', () => resolve({ scope: provider.authorizedScope ?? '' }))
    provider.on('authenticationFailed', ({ reason }: { reason: string }) =>
      resolve({ denied: reason }),
    )
  })
  const closed = new Promise<string>((resolve) => {
    provider.on('close', ({ event }: { event: { reason: string } }) => resolve(event.reason))
  })
  provider.attach()
  const client: Client = {
    doc,
    provider,
    ready,
    closed,
    close: () => {
      provider.destroy()
      socket.destroy()
    },
  }
  opened.push(client)
  return client
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('условие не выполнено вовремя')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Текст первой текстовой ячейки документа клиента. */
function introText(doc: Y.Doc): string {
  const cell = doc.getMap<Y.Map<unknown>>(NOTEBOOK_DOC.cells).get('intro')
  const body = cell?.get('body')
  return body instanceof Y.XmlFragment ? body.toString() : ''
}

/** Дописать в первый абзац текстовой ячейки — как это делает Tiptap через y-prosemirror. */
function appendToIntro(doc: Y.Doc, text: string): void {
  const body = doc.getMap<Y.Map<unknown>>(NOTEBOOK_DOC.cells).get('intro')?.get('body')
  if (!(body instanceof Y.XmlFragment)) throw new Error('нет текста ячейки intro')
  const node = (body.get(0) as Y.XmlElement).get(0) as Y.XmlText
  node.insert(node.length, text, {})
}

async function snapshot(as: TestUser = fx.users.member): Promise<NotebookRecord> {
  const response = await call(fx.app, { url: `/notebooks/${notebookId}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

function closeAll(): void {
  for (const client of opened.splice(0)) client.close()
}

beforeAll(async () => {
  fx = await setupFixture()
  await fx.app.listen({ port: 0, host: '127.0.0.1' })
  url = `ws://127.0.0.1:${(fx.app.server.address() as AddressInfo).port}/collab`
  startCollab(fx.app.server, { resolveSession: (token) => AuthService.resolveSession(token) })

  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.users.member,
    payload: {
      name: `Тетрадь ${run}`,
      spaceId: fx.spaceId,
      fields: [{ key: 'district', label: { ru: 'Район' }, type: 'text' }],
    },
  })
  expect(dataset.statusCode, dataset.body).toBe(200)
  datasetId = dataset.json().id

  const created = await call(fx.app, {
    method: 'POST',
    url: '/notebooks',
    as: fx.users.member,
    payload: {
      name: `Сводка ${run}`,
      spaceId: fx.spaceId,
      cells: [
        {
          id: 'intro',
          kind: 'text',
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Сводка' }] }],
          },
        },
        { id: 'q1', kind: 'query', datasetId },
      ],
      params: { period: { unit: 'month', from: 0, to: 0 } },
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  notebookId = created.json().id
})

afterAll(async () => {
  closeAll()
  await stopCollab()
})

describe('тетрадь: REST', () => {
  it('создание: снимок, состояние Yjs и зависимость от датасета', async () => {
    const record = await snapshot()
    expect(record.cells.map((cell) => `${cell.id}:${cell.kind}`)).toEqual([
      'intro:text',
      'q1:query',
    ])
    expect(record.params).toEqual({ period: { unit: 'month', from: 0, to: 0 }, territory: null })
    const [state] = await db()
      .select({ id: yjsDocuments.objectId })
      .from(yjsDocuments)
      .where(eq(yjsDocuments.objectId, notebookId))
    expect(state?.id).toBe(notebookId)
    const uses = await db()
      .select({ toId: dependencies.toId })
      .from(dependencies)
      .where(eq(dependencies.fromId, notebookId))
    expect(uses.map((row) => row.toId)).toEqual([datasetId])
  })

  it('права: чужой не видит, зритель читает, но не добавляет ячейки', async () => {
    const hidden = await call(fx.app, { url: `/notebooks/${notebookId}`, as: fx.users.stranger })
    expect(hidden.statusCode).toBe(404)
    expect((await snapshot(fx.users.viewer)).id).toBe(notebookId)
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/notebooks/${notebookId}/cells`,
      as: fx.users.viewer,
      payload: { cells: [{ id: 'm1', kind: 'metric' }] },
    })
    expect(denied.statusCode).toBe(403)
  })

  it('ячейка со ссылкой на невидимый автору датасет не создаётся', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/notebooks',
      as: fx.users.stranger,
      payload: {
        name: 'Чужая',
        spaceId: fx.orgSpaceId,
        cells: [{ id: 'q', kind: 'query', datasetId }],
      },
    })
    expect([403, 404]).toContain(response.statusCode)
  })
})

describe('совместное редактирование', () => {
  it('вход: без сессии и с чужим CSRF — отказ, без доступа — «не найдено»', async () => {
    expect(await connect(null).ready).toEqual({ denied: 'unauthorized' })
    expect(await connect(fx.users.member, { token: 'не-тот-токен' }).ready).toEqual({
      denied: 'unauthorized',
    })
    expect(await connect(fx.users.stranger).ready).toEqual({ denied: 'not_found' })
    expect(await connect(fx.users.member, { name: 'не-uuid' }).ready).toEqual({
      denied: 'not_found',
    })
    // Документ без совместной правки (датасет) через /collab не открывается
    expect(await connect(fx.users.member, { name: datasetId }).ready).toEqual({
      denied: 'not_found',
    })
    closeAll()
  })

  it('редактор правит, зритель видит правку сразу, но сам править не может', async () => {
    const editor = connect(fx.users.member)
    const reader = connect(fx.users.viewer)
    expect(await editor.ready).toEqual({ scope: 'read-write' })
    expect(await reader.ready).toEqual({ scope: 'readonly' })
    expect(introText(reader.doc)).toContain('Сводка')

    appendToIntro(editor.doc, ' за сентябрь')
    await waitFor(() => introText(reader.doc).includes('Сводка за сентябрь'))

    // Правка зрителя остаётся у него: сервер её не применяет и не рассылает
    appendToIntro(reader.doc, ' (зритель)')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(introText(editor.doc)).not.toContain('(зритель)')

    // Последний отключившийся — документ сразу сохраняется
    closeAll()
    await waitFor(async () =>
      JSON.stringify((await snapshot()).cells).includes('Сводка за сентябрь'),
    )
    expect(JSON.stringify((await snapshot()).cells)).not.toContain('(зритель)')
  })

  it('снимок: версия объекта, событие notebook.updated, текст в поиске', async () => {
    const events = await db().execute(
      sql`SELECT event FROM ops.outbox WHERE type = 'notebook.updated' AND event->'object'->>'id' = ${notebookId}`,
    )
    expect(events.length).toBeGreaterThan(0)
    const envelope = (events[0] as { event: { actor: { userId: string }; payload: unknown } }).event
    expect(envelope.actor.userId).toBe(fx.users.member.id)
    expect(envelope.payload).toEqual({ changed: ['cells'] })
    expect((await snapshot()).version).toBeGreaterThan(1)
    const search = await NotebookService.searchable(notebookId)
    expect(search?.body).toContain('Сводка за сентябрь')
  })

  it('восстановление: новый клиент получает сохранённое состояние, без него — из JSON-снимка', async () => {
    const again = connect(fx.users.member)
    await again.ready
    expect(introText(again.doc)).toContain('Сводка за сентябрь')
    closeAll()

    // Документа Yjs нет (объект создан до совместной правки) — строится из снимка
    await waitFor(async () => {
      const [row] = await db()
        .select({ id: yjsDocuments.objectId })
        .from(yjsDocuments)
        .where(eq(yjsDocuments.objectId, notebookId))
      return Boolean(row)
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    await db().delete(yjsDocuments).where(eq(yjsDocuments.objectId, notebookId))
    const fresh = connect(fx.users.member)
    await fresh.ready
    expect(introText(fresh.doc)).toContain('Сводка за сентябрь')
    expect(fresh.doc.getArray(NOTEBOOK_DOC.order).toArray()).toEqual(['intro', 'q1'])
    closeAll()
  })

  it('ячейки от сервера сразу появляются у тех, кто открыл тетрадь', async () => {
    const editor = connect(fx.users.member)
    await editor.ready
    const response = await call(fx.app, {
      method: 'POST',
      url: `/notebooks/${notebookId}/cells`,
      as: fx.users.member,
      payload: { cells: [{ id: 'intro', kind: 'ai', datasetId, question: 'Сколько паводков?' }] },
    })
    expect(response.statusCode, response.body).toBe(200)
    // Занятый идентификатор получил суффикс, снимок уже записан
    const record = response.json() as NotebookRecord
    expect(record.cells.map((cell) => cell.id)).toEqual(['intro', 'q1', 'intro-2'])
    await waitFor(() => editor.doc.getArray(NOTEBOOK_DOC.order).length === 3)
    closeAll()
  })

  it('объект в корзине: подключение закрывается, повторный вход — отказ', async () => {
    const reader = connect(fx.users.viewer)
    expect(await reader.ready).toEqual({ scope: 'readonly' })
    const trashed = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${notebookId}`,
      as: fx.admin,
    })
    expect(trashed.statusCode, trashed.body).toBeLessThan(300)
    // Подписчик событий (worker) шлёт то же сообщение после `object.trashed`
    await redis().publish(COLLAB_CHANNEL, JSON.stringify({ objectId: notebookId }))
    expect(await reader.closed).toBe('access_changed')
    expect(await connect(fx.users.viewer).ready).toEqual({ denied: 'not_found' })
    closeAll()

    const restored = await call(fx.app, {
      method: 'POST',
      url: `/objects/${notebookId}/restore`,
      as: fx.admin,
    })
    expect(restored.statusCode, restored.body).toBeLessThan(300)
    const [row] = await db()
      .select({ id: yjsDocuments.objectId })
      .from(yjsDocuments)
      .where(and(eq(yjsDocuments.objectId, notebookId)))
    expect(row?.id).toBe(notebookId)
  })
})
