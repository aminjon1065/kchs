import { TAGS_PER_OBJECT_MAX } from '@kchs/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/** Теги (02-platform-kernel.md §14): словарь пространства, назначение, поиск по тегу. */
registerLifecycle()

const { indexObject } = await import('../src/kernel/search/index-service.js')
const { outbox } = await import('../src/shared/db/schema/index.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

async function createFolder(name: string, as: TestUser = fx.admin): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as,
    payload: { name, spaceId: fx.spaceId },
  })
  expect(response.statusCode).toBe(200)
  return response.json().id as string
}

function addTag(objectId: string, name: string, as: TestUser = fx.admin, color?: string) {
  return call(fx.app, {
    method: 'POST',
    url: `/objects/${objectId}/tags`,
    as,
    payload: color ? { name, color } : { name },
  })
}

const names = (response: { json: () => { items: Array<{ name: string }> } }) =>
  response.json().items.map((tag) => tag.name)

describe('теги объекта', () => {
  it('назначение создаёт тег в словаре пространства; карточка объекта показывает теги', async () => {
    const folder = await createFolder(`Теги ${run}`)
    const added = await addTag(folder, `  паводок   ${run} `, fx.admin, 'chart-4')
    expect(added.statusCode).toBe(200)
    expect(added.json().items).toEqual([
      expect.objectContaining({ name: `паводок ${run}`, color: 'chart-4' }),
    ])

    const record = await call(fx.app, { url: `/objects/${folder}`, as: fx.users.viewer })
    expect(record.json().tags.map((tag: { name: string }) => tag.name)).toEqual([`паводок ${run}`])

    const suggestions = await call(fx.app, {
      url: `/tags?spaceId=${fx.spaceId}&q=${encodeURIComponent('ПАВОД')}`,
      as: fx.users.member,
    })
    expect(suggestions.statusCode).toBe(200)
    expect(names(suggestions)).toContain(`паводок ${run}`)
  })

  it('то же имя в другом регистре — тот же тег, повторное назначение ничего не меняет', async () => {
    const first = await createFolder(`Регистр А ${run}`)
    const second = await createFolder(`Регистр Б ${run}`)
    const a = await addTag(first, `Сель ${run}`)
    const b = await addTag(second, `СЕЛЬ ${run}`)
    expect(b.json().items[0].id).toBe(a.json().items[0].id)
    expect(b.json().items[0].name).toBe(`Сель ${run}`)

    const again = await addTag(first, `сель ${run}`)
    expect(again.json().items).toHaveLength(1)
  })

  it('одновременное назначение нового имени не падает на уникальности словаря', async () => {
    const folders = await Promise.all([1, 2, 3, 4].map((n) => createFolder(`Гонка ${n} ${run}`)))
    const results = await Promise.all(folders.map((id) => addTag(id, `Гонка ${run}`)))
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200])
    expect(new Set(results.map((r) => r.json().items[0].id)).size).toBe(1)
  })

  it('снятие тега публикует object.tagged с оставшимся набором', async () => {
    const folder = await createFolder(`Снятие ${run}`)
    await addTag(folder, `первый ${run}`)
    const both = await addTag(folder, `второй ${run}`)
    const first = both.json().items.find((tag: { name: string }) => tag.name === `первый ${run}`)

    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${folder}/tags/${first.id}`,
      as: fx.admin,
    })
    expect(removed.statusCode).toBe(200)
    expect(names(removed)).toEqual([`второй ${run}`])

    const [row] = await db()
      .select({ event: outbox.event })
      .from(outbox)
      .where(
        and(eq(outbox.type, 'object.tagged'), sql`${outbox.event}->'object'->>'id' = ${folder}`),
      )
      .orderBy(desc(outbox.id))
      .limit(1)
    const second = both.json().items.find((tag: { name: string }) => tag.name === `второй ${run}`)
    expect(row?.event.payload).toEqual({ tagIds: [second.id] })
  })

  it('имя проверяется: пустое и длиннее 60 символов отклоняются, цвет — только из палитры', async () => {
    const folder = await createFolder(`Проверка ${run}`)
    expect((await addTag(folder, '   ')).statusCode).toBe(400)
    expect((await addTag(folder, 'я'.repeat(61))).statusCode).toBe(400)
    expect((await addTag(folder, `цвет ${run}`, fx.admin, '#ff0000')).statusCode).toBe(400)
  })

  it(`у объекта не больше ${TAGS_PER_OBJECT_MAX} тегов`, async () => {
    const folder = await createFolder(`Лимит ${run}`)
    for (let i = 0; i < TAGS_PER_OBJECT_MAX; i++) {
      expect((await addTag(folder, `л${i} ${run}`)).statusCode).toBe(200)
    }
    const over = await addTag(folder, `лишний ${run}`)
    expect(over.statusCode).toBe(400)
  })
})

describe('теги и доступ', () => {
  it('читатель пространства видит теги, но не может их менять', async () => {
    const folder = await createFolder(`Доступ ${run}`)
    const tagged = await addTag(folder, `служебный ${run}`)
    const tagId = tagged.json().items[0].id

    expect((await addTag(folder, `чужой ${run}`, fx.users.viewer)).statusCode).toBe(403)
    const removal = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${folder}/tags/${tagId}`,
      as: fx.users.viewer,
    })
    expect(removal.statusCode).toBe(403)
    expect((await addTag(folder, `редактор ${run}`, fx.users.member)).statusCode).toBe(200)
  })

  it('посторонний не видит ни объект, ни словарь пространства', async () => {
    const folder = await createFolder(`Посторонний ${run}`)
    await addTag(folder, `закрытый ${run}`)

    expect((await addTag(folder, `взлом ${run}`, fx.users.stranger)).statusCode).toBe(404)
    const dictionary = await call(fx.app, {
      url: `/tags?spaceId=${fx.spaceId}`,
      as: fx.users.stranger,
    })
    expect(dictionary.statusCode).toBe(404)
  })
})

describe('поиск по тегу', () => {
  it('объект находится по имени тега, которого нет в названии', async () => {
    const folder = await createFolder(`Отчёт без ключевого слова ${run}`)
    const tag = `оползень${run}`
    await addTag(folder, tag)
    await indexObject(folder)

    const deadline = Date.now() + 10_000
    let hits: string[] = []
    while (Date.now() < deadline) {
      const response = await call(fx.app, { url: `/search?q=${tag}`, as: fx.admin })
      hits = response.json().hits.map((hit: { objectId: string }) => hit.objectId)
      if (hits.includes(folder)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(hits).toContain(folder)
  })
})
