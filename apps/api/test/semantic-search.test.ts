import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeEmbeddings } from './fakes.js'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Поиск по смыслу (ADR-0099): движок считает векторы кусков текста, pgvector
 * ищет ближайшие, выдача сливается со словесной. Без модели функция выключена
 * и поиск работает как раньше. Права те же: чужое не находится.
 */
registerLifecycle()

const { indexEmbeddings, semanticSearch, similarObjects, chunkText } = await import(
  '../src/kernel/search/semantic.js'
)
const { resetConfigCache } = await import('../src/shared/config/index.js')
const { buildUserCtx } = await import('../src/kernel/context-builder.js')

/** Контекст пользователя без HTTP: сервис семантики зовём напрямую. */
async function userCtx(user: { id: string }) {
  return buildUserCtx(
    { sessionId: `test-${user.id}`, userId: user.id, onBehalfOf: null, mfaEnrolled: true },
    { id: 'test', ip: null, headers: {} } as never,
  )
}

const run = Date.now().toString(36)
let fx: TestContext
let embeddings: Awaited<ReturnType<typeof startFakeEmbeddings>>
let previousUrl: string | undefined
let previousToken: string | undefined

let counter = 0

/** Проект с описанием: его текст попадает в поиск — на нём и проверяем смысл. */
async function createNote(
  title: string,
  body: string,
  options: { as?: typeof fx.admin; spaceId?: string | null } = {},
): Promise<string> {
  counter += 1
  const response = await call(fx.app, {
    method: 'POST',
    url: '/projects',
    as: options.as ?? fx.admin,
    payload: {
      key: `SEM${counter}${run.toUpperCase().slice(-4)}`,
      name: title,
      description: body,
      ...(options.spaceId === undefined ? { spaceId: fx.spaceId } : {}),
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

beforeAll(async () => {
  fx = await setupFixture()
  embeddings = await startFakeEmbeddings()
  previousUrl = process.env.ENGINE_INTERNAL_URL
  previousToken = process.env.INTERNAL_SERVICE_TOKEN
  process.env.ENGINE_INTERNAL_URL = embeddings.url
  process.env.INTERNAL_SERVICE_TOKEN = 'test-token-for-embeddings-32ch'
  resetConfigCache()
})

afterAll(async () => {
  await embeddings.close()
  if (previousUrl === undefined) delete process.env.ENGINE_INTERNAL_URL
  else process.env.ENGINE_INTERNAL_URL = previousUrl
  if (previousToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN
  else process.env.INTERNAL_SERVICE_TOKEN = previousToken
  resetConfigCache()
})

describe('куски текста', () => {
  it('короткий текст — один кусок, длинный режется с нахлёстом по предложениям', () => {
    expect(chunkText('Короткая заметка')).toEqual(['Короткая заметка'])
    const long = `${'Паводок на реке Вахш угрожает посёлку. '.repeat(40)}`
    const chunks = chunkText(long)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000)
  })
})

describe('векторы объектов', () => {
  it('считаются один раз: неизменившийся текст модель заново не считает', async () => {
    const id = await createNote(
      `Паводок ${run}`,
      'Половодье на реке Вахш подтопило дорогу в посёлке; нужен насос и мешки с песком для берега.',
    )
    const first = await indexEmbeddings(id)
    expect(first).toBeGreaterThan(0)
    const before = embeddings.calls.length
    const again = await indexEmbeddings(id)
    expect(again).toBe(0)
    expect(embeddings.calls.length, 'второй раз движок не вызывается').toBe(before)
  })

  it('находят объект по смыслу и не показывают чужой', async () => {
    const mine = await createNote(
      `Сель ${run}`,
      'Сход селевого потока перекрыл горную дорогу; техника расчищает завал, жителей вывезли.',
    )
    await indexEmbeddings(mine)

    const ctx = await userCtx(fx.admin)
    const hits = await semanticSearch(ctx, 'селевой поток перекрыл дорогу', 10)
    expect(hits.map((hit) => hit.objectId)).toContain(mine)

    const strangerCtx = await userCtx(fx.users.stranger)
    const strangerHits = await semanticSearch(strangerCtx, 'селевой поток перекрыл дорогу', 10)
    expect(
      strangerHits.map((hit) => hit.objectId),
      'чужая тетрадь не видна',
    ).not.toContain(mine)
  })

  it('похожие объекты не включают сам объект', async () => {
    const first = await createNote(
      `Землетрясение ${run}`,
      'Подземные толчки магнитудой пять баллов ощущались в районе; разрушений нет, проверяют школы.',
    )
    const second = await createNote(
      `Толчки ${run}`,
      'Подземные толчки повторились ночью; комиссия проверяет школы и больницы района на трещины.',
    )
    await indexEmbeddings(first)
    await indexEmbeddings(second)

    const ctx = await userCtx(fx.admin)
    const similar = await similarObjects(ctx, first, 5)
    expect(similar.map((hit) => hit.objectId)).not.toContain(first)
    expect(similar.map((hit) => hit.objectId)).toContain(second)
  })
})

describe('без модели векторов', () => {
  it('поиск остаётся словесным, похожие отвечают «выключено»', async () => {
    const id = await createNote(
      `Ливень ${run}`,
      'Сильный ливень подтопил улицы города; коммунальные службы откачивают воду насосами.',
    )
    await indexEmbeddings(id)
    embeddings.disable()

    const ctx = await userCtx(fx.admin)
    expect(await semanticSearch(ctx, 'ливень подтопил улицы', 5)).toEqual([])

    const response = await call(fx.app, { url: `/objects/${id}/similar`, as: fx.admin })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().enabled).toBe(false)
    expect(response.json().items).toEqual([])

    const words = await call(fx.app, {
      url: `/search?q=${encodeURIComponent(`Ливень ${run}`)}`,
      as: fx.admin,
    })
    expect(words.statusCode, words.body).toBe(200)
    expect(words.json().semantic).toBe(false)
    embeddings.enable()
  })
})
