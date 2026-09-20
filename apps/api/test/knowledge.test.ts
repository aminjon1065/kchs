import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * База знаний (P5-E01, ADR-0095): страница — объект реестра с деревом,
 * шаблонами, версиями и сравнением, статусами и сроком пересмотра,
 * ознакомлением ядра, комментариями к фрагментам и поиском по чанкам.
 * Негативные проверки прав обязательны: читатель не правит и не публикует,
 * посторонний не видит.
 */
registerLifecycle()

const { startCollab, stopCollab } = await import('../src/kernel/collab/server.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { registerKnowledgeBackground } = await import('../src/modules/knowledge/module.js')
const { ensurePageChunkIndex, indexPageChunks } = await import(
  '../src/modules/knowledge/domain/page-chunks.js'
)
const { reviewDuePages } = await import('../src/modules/knowledge/domain/page-review.js')
const { setSemanticSource } = await import('../src/modules/knowledge/domain/semantic-port.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { pages } = await import('../src/shared/db/schema/index.js')

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

const run = Date.now().toString(36)

let fx: TestContext
let author: TestUser
let reader: TestUser
let outsider: TestUser

const DAY = 86_400_000
const dateAfter = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)

async function createPage(
  title: string,
  options: { template?: string; parentId?: string; as?: TestUser } = {},
): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/pages',
    as: options.as ?? author,
    payload: {
      title,
      spaceId: fx.spaceId,
      template: options.template ?? 'blank',
      ...(options.parentId ? { parentId: options.parentId } : {}),
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

const pageOf = async (id: string, as = author): Promise<Json> =>
  (await call(fx.app, { url: `/pages/${id}`, as })).json()

async function addBlocks(id: string, blocks: unknown[], as = author) {
  return call(fx.app, { method: 'POST', url: `/pages/${id}/blocks`, as, payload: { blocks } })
}

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

/** Подписчики ядра и базы знаний по неопубликованным событиям outbox — как воркер. */
async function drainOutbox(): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'knowledge-page-chunks')) {
    registerKnowledgeBackground()
  }
  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 2000`,
  )
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (!matchesType(subscriber.types, event.type)) continue
      await subscriber.handle(event as never)
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

async function grant(objectId: string, user: TestUser, level: string): Promise<void> {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/objects/${objectId}/access`,
    as: fx.admin,
    payload: { grants: [{ principal: { type: 'user', id: user.id }, level }] },
  })
  expect(response.statusCode, response.body).toBe(200)
}

beforeAll(async () => {
  fx = await setupFixture()
  await fx.app.listen({ port: 0, host: '127.0.0.1' })
  startCollab(fx.app.server, { resolveSession: (token) => AuthService.resolveSession(token) })
  author = await createUser(fx.app, `kb_author_${run}`, ['employee'])
  reader = await createUser(fx.app, `kb_reader_${run}`, ['employee'])
  outsider = await createUser(fx.app, `kb_out_${run}`, ['employee'])
  // Автор ведёт базу знаний пространства; читатель и посторонний в нём не состоят
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, author.id, 'editor'),
  )
  await redis().del(`kchs:principals:${author.id}`)
  await ensurePageChunkIndex()
})

afterAll(async () => {
  setSemanticSource(null)
  await stopCollab()
})

describe('страница: заведение, шаблон, права', () => {
  let pageId = ''

  it('страница по шаблону: блоки заготовки на месте, состояние — черновик', async () => {
    pageId = await createPage(`Инструкция по оповещению ${run}`, { template: 'instruction' })
    const page = await pageOf(pageId)
    expect(page).toMatchObject({
      status: 'draft',
      template: 'instruction',
      versionNumber: 0,
      acknowledgmentRequested: false,
      can: { edit: true, publish: true, manage: true, requestAcknowledgment: false },
    })
    expect(page.blocks.length).toBeGreaterThan(3)
    expect(page.owner?.id).toBe(author.id)
    // Оглавление собрано из подписей блоков шаблона
    expect(page.outline[0]).toMatchObject({ blockId: page.blocks[0].id, level: 1 })
  })

  it('посторонний не видит страницу — 404', async () => {
    for (const url of [`/pages/${pageId}`, `/pages/${pageId}/versions`, `/objects/${pageId}`]) {
      const response = await call(fx.app, { url, as: outsider })
      expect(response.statusCode, url).toBe(404)
    }
  })

  it('читатель видит, но не правит и не публикует — 403', async () => {
    await grant(pageId, reader, 'view')
    const view = await call(fx.app, { url: `/pages/${pageId}`, as: reader })
    expect(view.statusCode, view.body).toBe(200)
    expect(view.json().can).toMatchObject({ edit: false, publish: false, manage: false })

    const forbidden = [
      {
        method: 'POST' as const,
        url: `/pages/${pageId}/blocks`,
        payload: { blocks: [{ id: 'reader', kind: 'text' }] },
      },
      { method: 'POST' as const, url: `/pages/${pageId}/publish`, payload: {} },
      { method: 'POST' as const, url: `/pages/${pageId}/versions`, payload: {} },
      { method: 'PATCH' as const, url: `/pages/${pageId}`, payload: { reviewAt: null } },
      {
        method: 'POST' as const,
        url: `/pages/${pageId}/acknowledgments`,
        payload: { userIds: [reader.id] },
      },
    ]
    for (const request of forbidden) {
      const response = await call(fx.app, { ...request, as: reader })
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403)
    }
  })

  it('блоки от сервера появляются в снимке, зависимость на чужой объект запрещена', async () => {
    const added = await addBlocks(pageId, [
      { id: 'extra', kind: 'text', title: 'Дополнение', body: paragraph('Оповещать немедленно') },
    ])
    expect(added.statusCode, added.body).toBe(200)
    const ids = added.json().blocks.map((block: { id: string }) => block.id)
    expect(ids).toContain('extra')

    // Встроенный объект, которого автор не видит, на страницу не попадает
    const foreign = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Чужая папка ${run}`, spaceId: fx.orgSpaceId },
    })
    expect(foreign.statusCode, foreign.body).toBe(200)
    const denied = await addBlocks(pageId, [
      { id: 'alien', kind: 'file', fileId: foreign.json().id },
    ])
    expect(denied.statusCode).toBe(404)
  })
})

describe('версии, сравнение и откат', () => {
  let pageId = ''
  let firstVersion = ''

  it('публикация снимает версию и переводит страницу в «опубликована»', async () => {
    pageId = await createPage(`Регламент дежурства ${run}`)
    await addBlocks(pageId, [
      { id: 'body', kind: 'text', title: 'Порядок', body: paragraph('Дежурный принимает смену') },
    ])
    const published = await call(fx.app, {
      method: 'POST',
      url: `/pages/${pageId}/publish`,
      as: author,
      payload: { note: 'Первая редакция', reviewAt: dateAfter(30) },
    })
    expect(published.statusCode, published.body).toBe(200)
    expect(published.json()).toMatchObject({
      status: 'published',
      versionNumber: 1,
      reviewAt: dateAfter(30),
    })
    expect(published.json().publishedBy?.id).toBe(author.id)
    expect(published.json().can.requestAcknowledgment).toBe(true)

    const versions = await call(fx.app, { url: `/pages/${pageId}/versions`, as: author })
    expect(versions.statusCode).toBe(200)
    expect(versions.json().items).toHaveLength(1)
    firstVersion = versions.json().items[0].id
    expect(versions.json().items[0]).toMatchObject({
      number: 1,
      reason: 'publish',
      note: 'Первая редакция',
    })
  })

  it('сравнение с текущим текстом показывает добавленные и удалённые слова', async () => {
    await addBlocks(pageId, [
      { id: 'add', kind: 'text', body: paragraph('Смена сдаётся под запись') },
    ])
    const compare = await call(fx.app, {
      url: `/pages/${pageId}/versions/compare?from=${firstVersion}`,
      as: author,
    })
    expect(compare.statusCode, compare.body).toBe(200)
    const result = compare.json()
    expect(result.from).toMatchObject({ id: firstVersion, number: 1 })
    expect(result.to).toMatchObject({ id: null, number: 0 })
    expect(result.stats.inserted).toBeGreaterThan(0)
    const inserted = result.segments
      .filter((segment: { op: string }) => segment.op === 'insert')
      .map((segment: { text: string }) => segment.text)
      .join('')
    expect(inserted).toContain('запись')
  })

  it('откат возвращает текст версии, а текущий сохраняет новой версией', async () => {
    const restored = await call(fx.app, {
      method: 'POST',
      url: `/pages/${pageId}/versions/${firstVersion}/restore`,
      as: author,
    })
    expect(restored.statusCode, restored.body).toBe(200)
    expect(restored.json()).toMatchObject({ number: 1 })

    const page = await pageOf(pageId)
    expect(page.blocks.map((block: { id: string }) => block.id)).toEqual(['body'])
    const versions = await call(fx.app, { url: `/pages/${pageId}/versions`, as: author })
    expect(versions.json().items[0]).toMatchObject({ number: 2, reason: 'restore' })
  })

  it('читатель версию не откатывает — 403', async () => {
    await grant(pageId, reader, 'view')
    const response = await call(fx.app, {
      method: 'POST',
      url: `/pages/${pageId}/versions/${firstVersion}/restore`,
      as: reader,
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('пересмотр и ознакомление', () => {
  let pageId = ''

  it('подошедший срок переводит страницу на пересмотр и открывает дело владельцу', async () => {
    pageId = await createPage(`Справочник кодов ${run}`)
    await addBlocks(pageId, [{ id: 'body', kind: 'text', body: paragraph('Коды подразделений') }])
    const published = await call(fx.app, {
      method: 'POST',
      url: `/pages/${pageId}/publish`,
      as: author,
      payload: { note: null },
    })
    expect(published.statusCode, published.body).toBe(200)

    // Срок пересмотра — вчера
    await db()
      .update(pages)
      .set({ reviewAt: dateAfter(-1) })
      .where(sql`id = ${pageId}`)
    expect(await reviewDuePages()).toBeGreaterThan(0)
    expect((await pageOf(pageId)).status).toBe('review')

    await drainOutbox()
    const inbox = await call(fx.app, { url: '/inbox?state=open&limit=100', as: author })
    expect(inbox.statusCode, inbox.body).toBe(200)
    const item = (inbox.json().items as Json[]).find(
      (entry) => entry.kind === 'review_page' && entry.object?.id === pageId,
    )
    expect(item, 'дело «Пересмотреть страницу» открыто владельцу').toBeTruthy()

    // Повторный проход дело не дублирует
    expect(await reviewDuePages()).toBe(0)
  })

  it('публикация закрывает дело о пересмотре', async () => {
    const republished = await call(fx.app, {
      method: 'POST',
      url: `/pages/${pageId}/publish`,
      as: author,
      payload: { note: 'Пересмотрено', reviewAt: dateAfter(60) },
    })
    expect(republished.statusCode, republished.body).toBe(200)
    expect(republished.json()).toMatchObject({ status: 'published', versionNumber: 2 })

    const inbox = await call(fx.app, { url: '/inbox?state=open&limit=100', as: author })
    const item = (inbox.json().items as Json[]).find(
      (entry) => entry.kind === 'review_page' && entry.object?.id === pageId,
    )
    expect(item, 'дело закрылось публикацией').toBeUndefined()
  })

  it('ознакомление: черновик знакомить нельзя, опубликованную — можно', async () => {
    const draftId = await createPage(`Черновик памятки ${run}`)
    const early = await call(fx.app, {
      method: 'POST',
      url: `/pages/${draftId}/acknowledgments`,
      as: author,
      payload: { userIds: [reader.id] },
    })
    expect(early.statusCode, early.body).toBe(409)

    await grant(pageId, reader, 'view')
    const requested = await call(fx.app, {
      method: 'POST',
      url: `/pages/${pageId}/acknowledgments`,
      as: author,
      payload: { userIds: [reader.id], dueAt: dateAfter(3) },
    })
    expect(requested.statusCode, requested.body).toBe(200)
    expect(requested.json().requested).toBe(1)
    expect((await pageOf(pageId)).acknowledgmentRequested).toBe(true)

    const list = await call(fx.app, { url: `/objects/${pageId}/acknowledgments`, as: reader })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().mine.pending).toBe(true)

    const marked = await call(fx.app, {
      method: 'POST',
      url: `/objects/${pageId}/acknowledgments/acknowledge`,
      as: reader,
      payload: {},
    })
    expect(marked.statusCode, marked.body).toBe(200)
    expect(marked.json().mine.pending).toBe(false)
  })

  it('без получателей запрос ознакомления не принимается', async () => {
    const empty = await call(fx.app, {
      method: 'POST',
      url: `/pages/${pageId}/acknowledgments`,
      as: author,
      payload: { userIds: [] },
    })
    expect(empty.statusCode).toBe(400)
  })
})

describe('дерево, комментарии к фрагментам и поиск', () => {
  let rootId = ''
  let childId = ''

  it('дерево пространства: вложенная страница под родителем, посторонний её не видит', async () => {
    rootId = await createPage(`Раздел «Паводок» ${run}`)
    childId = await createPage(`Порядок действий ${run}`, { parentId: rootId })
    const tree = await call(fx.app, { url: `/knowledge/tree?spaceId=${fx.spaceId}`, as: author })
    expect(tree.statusCode, tree.body).toBe(200)
    const items = tree.json().items as Json[]
    const root = items.find((item) => item.id === rootId)
    const child = items.find((item) => item.id === childId)
    expect(root).toMatchObject({ hasChildren: true, parentId: null, status: 'draft' })
    expect(child).toMatchObject({ parentId: rootId, hasChildren: false })

    const asOutsider = await call(fx.app, {
      url: `/knowledge/tree?spaceId=${fx.spaceId}`,
      as: outsider,
    })
    expect(asOutsider.statusCode).toBe(404)
  })

  it('поиск по названию сворачивает дерево в плоский список', async () => {
    const found = await call(fx.app, {
      url: `/knowledge/tree?spaceId=${fx.spaceId}&q=${encodeURIComponent('Порядок действий')}`,
      as: author,
    })
    expect(found.statusCode).toBe(200)
    const items = found.json().items as Json[]
    expect(items.map((item) => item.id)).toContain(childId)
    // Родитель в выдачу не попал — узел показывается в корне
    expect(items.find((item) => item.id === childId)?.parentId).toBeNull()
  })

  it('комментарий к фрагменту хранит якорь на блок', async () => {
    await addBlocks(childId, [
      { id: 'step1', kind: 'text', title: 'Шаг 1', body: paragraph('Оповестить дежурного') },
    ])
    const posted = await call(fx.app, {
      method: 'POST',
      url: `/objects/${childId}/discussion/messages`,
      as: author,
      payload: {
        body: paragraph('Уточнить срок оповещения'),
        text: 'Уточнить срок оповещения',
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
        anchor: 'step1',
      },
    })
    expect(posted.statusCode, posted.body).toBe(200)

    const discussion = await call(fx.app, { url: `/objects/${childId}/discussion`, as: author })
    expect(discussion.statusCode, discussion.body).toBe(200)
    const mine = (discussion.json().items as Json[]).find(
      (message) => message.text === 'Уточнить срок оповещения',
    )
    expect(mine?.anchor).toBe('step1')
    // Комментарий без якоря относится ко всему объекту
    const plain = await call(fx.app, {
      method: 'POST',
      url: `/objects/${childId}/discussion/messages`,
      as: author,
      payload: {
        body: paragraph('Общий вопрос по странице'),
        text: 'Общий вопрос по странице',
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
      },
    })
    expect(plain.statusCode, plain.body).toBe(200)
    const again = await call(fx.app, { url: `/objects/${childId}/discussion`, as: author })
    const plainMessage = (again.json().items as Json[]).find(
      (message) => message.text === 'Общий вопрос по странице',
    )
    expect(plainMessage?.anchor).toBeNull()
  })

  it('поиск по чанкам находит кусок страницы и не показывает чужие', async () => {
    const needle = `лавиноопасный${run}`
    await addBlocks(childId, [
      { id: 'search', kind: 'text', title: 'Признаки', body: paragraph(`Участок ${needle}`) },
    ])
    await indexPageChunks(childId)

    const deadline = Date.now() + 15_000
    let items: Json[] = []
    while (Date.now() < deadline) {
      const response = await call(fx.app, {
        url: `/knowledge/search?q=${encodeURIComponent(needle)}`,
        as: author,
      })
      expect(response.statusCode, response.body).toBe(200)
      items = response.json().items
      if (items.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(items.map((item) => item.pageId)).toContain(childId)
    expect(items[0]).toMatchObject({ source: 'text', blockId: 'search' })

    // Посторонний тот же кусок не находит
    const foreign = await call(fx.app, {
      url: `/knowledge/search?q=${encodeURIComponent(needle)}`,
      as: outsider,
    })
    expect(foreign.statusCode).toBe(200)
    expect(foreign.json().items).toEqual([])
  })

  it('порт семантики: без источника — только слова, с источником — смысловые совпадения', async () => {
    // При старте источник подключает ядро (ADR-0099); здесь проверяется сам
    // порт, поэтому его отключаем и подставляем свой
    setSemanticSource(null)
    const plain = await call(fx.app, {
      url: `/knowledge/search?q=${encodeURIComponent('оповещение')}`,
      as: author,
    })
    expect(plain.statusCode).toBe(200)
    expect(plain.json().semantic).toBe(false)

    setSemanticSource({
      search: async () => [{ pageId: childId, blockId: 'step1', score: 0.83, text: null }],
    })
    const semantic = await call(fx.app, {
      url: `/knowledge/search?q=${encodeURIComponent('как поднять тревогу')}`,
      as: author,
    })
    expect(semantic.statusCode, semantic.body).toBe(200)
    expect(semantic.json().semantic).toBe(true)
    const hit = (semantic.json().items as Json[]).find((item) => item.source === 'semantic')
    expect(hit).toMatchObject({ pageId: childId, blockId: 'step1', score: 0.83 })
    expect(hit.snippet).toContain('Оповестить дежурного')

    // Посторонний выдачу источника не получает: права проверяются после него
    const denied = await call(fx.app, {
      url: `/knowledge/search?q=${encodeURIComponent('как поднять тревогу')}`,
      as: outsider,
    })
    expect(denied.statusCode).toBe(200)
    expect(denied.json().items).toEqual([])

    // Источник, который падает, выдачу не ломает
    setSemanticSource({
      search: async () => {
        throw new Error('модель недоступна')
      },
    })
    const degraded = await call(fx.app, {
      url: `/knowledge/search?q=${encodeURIComponent('как поднять тревогу')}`,
      as: author,
    })
    expect(degraded.statusCode).toBe(200)
    expect(degraded.json().semantic).toBe(false)
    setSemanticSource(null)
  })
})
