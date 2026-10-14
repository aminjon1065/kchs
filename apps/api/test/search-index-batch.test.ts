import { Index } from 'meilisearch'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Индексация поиска пачкой (ADR-0222): документы пачки готовятся вместе и уходят в
 * Meilisearch одним вызовом, а не по объекту; полная переиндексация идёт курсором по
 * id — правки во время прохода не дают ни пропусков, ни повторов. Права в документе —
 * те же, что у поштучной индексации.
 */
registerLifecycle()

const { ObjectService } = await import('../src/kernel/objects/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { readPrincipalsFor } = await import('../src/kernel/access/acl-service.js')
const { ensureSearchIndex, indexObjects, reindexAll } = await import(
  '../src/kernel/search/index-service.js'
)
const { objects } = await import('../src/db-schema.js')
const { eq, sql } = await import('drizzle-orm')

let fx: TestContext
const ids: string[] = []
const COUNT = 60

beforeAll(async () => {
  fx = await setupFixture()
  await ensureSearchIndex()
  const ctx = systemCtx('test', { initiatorId: fx.admin.id })
  await db().transaction(async (tx) => {
    for (let i = 0; i < COUNT; i += 1) {
      const created = await ObjectService.create(tx, ctx, {
        type: 'folder',
        spaceId: fx.spaceId,
        title: `Папка индекса ${i}`,
      })
      ids.push(created.id)
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

type Doc = { id: string; aclPrincipals: string[]; title: string }

describe('индексация пачкой', () => {
  it('пачка уходит в Meilisearch одним вызовом; права — как у поштучной', async () => {
    const added = vi.spyOn(Index.prototype, 'addDocuments')
    const started = performance.now()
    await indexObjects(ids)
    const elapsed = performance.now() - started
    // biome-ignore lint/suspicious/noConsole: замеры времени нужны в журнале прогона
    console.info(
      `индексация ${COUNT} объектов: ${elapsed.toFixed(0)} мс, вызовов ${added.mock.calls.length}`,
    )
    expect(added).toHaveBeenCalledTimes(1)
    const documents = added.mock.calls.flatMap(([batch]) => batch as Doc[])
    expect(documents.map((doc) => doc.id).sort()).toEqual([...ids].sort())
    const sample = documents.find((doc) => doc.id === ids[7])
    expect(sample?.aclPrincipals.sort()).toEqual((await readPrincipalsFor(ids[7] ?? '')).sort())
    expect(sample?.title).toBe('Папка индекса 7')
  })

  it('удалённые объекты пачки уходят из индекса одним вызовом', async () => {
    const removedId = ids[3] ?? ''
    await db()
      .update(objects)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(objects.id, removedId))
    const added = vi.spyOn(Index.prototype, 'addDocuments')
    const removed = vi.spyOn(Index.prototype, 'deleteDocuments')
    const removedOne = vi.spyOn(Index.prototype, 'deleteDocument')
    await indexObjects(ids.slice(0, 10))
    const removedIds = [
      ...removed.mock.calls.flatMap(([batch]) => batch as string[]),
      ...removedOne.mock.calls.map(([id]) => id as string),
    ]
    expect(removedIds).toEqual([removedId])
    const addedIds = added.mock.calls.flatMap(([batch]) => (batch as Doc[]).map((doc) => doc.id))
    expect(addedIds).not.toContain(removedId)
    expect(addedIds).toHaveLength(9)
    await db().update(objects).set({ deletedAt: null }).where(eq(objects.id, removedId))
  })
})

describe('полная переиндексация', () => {
  it('правки во время прохода не дают ни пропусков, ни повторов', async () => {
    const seen: string[] = []
    let touched = false
    vi.spyOn(Index.prototype, 'addDocuments').mockImplementation((async (batch: Doc[]) => {
      for (const doc of batch) seen.push(doc.id)
      // После первой пачки правим все объекты: новые версии строк ложатся в конец кучи —
      // проход через OFFSET без ORDER BY перечитал бы одни и пропустил другие
      if (!touched) {
        touched = true
        await db().execute(sql`UPDATE objects SET title = title || '' WHERE deleted_at IS NULL`)
      }
      return { taskUid: 0 }
    }) as never)
    vi.spyOn(Index.prototype, 'deleteDocuments').mockImplementation((async (batch: string[]) => {
      for (const id of batch) seen.push(id)
      return { taskUid: 0 }
    }) as never)
    vi.spyOn(Index.prototype, 'deleteDocument').mockImplementation((async (id: string) => {
      seen.push(id)
      return { taskUid: 0 }
    }) as never)
    vi.spyOn(Index.prototype, 'updateSettings').mockResolvedValue({ taskUid: 0 } as never)

    await reindexAll(7)
    const all = await db().select({ id: objects.id }).from(objects)
    const unique = new Set(seen)
    expect(seen.length - unique.size, 'повторы').toBe(0)
    expect(
      all.filter((row) => !unique.has(row.id)),
      'пропуски',
    ).toEqual([])
    expect(unique.size).toBe(all.length)
  })
})
