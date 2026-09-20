import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeAi, startFakeAi } from './fakes.js'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Ассистент в контекстной панели (ADR-0100): модель просит инструмент, сервер
 * выполняет его правами спрашивающего и возвращает результат модели. Чужие
 * объекты ассистент не видит, объекты не создаёт — только предлагает, а
 * переписка у каждого своя.
 */
registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/index.js')
const { indexObject } = await import('../src/kernel/search/index-service.js')

const run = Date.now().toString(36)
let fx: TestContext
let ai: FakeAi
let projectId = ''
let secretId = ''

function configure(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetConfigCache()
}

const ask = (question: string, as = fx.admin, objectId: string | null = null) =>
  call(fx.app, {
    method: 'POST',
    url: '/assistant/ask',
    as,
    payload: { question, objectId },
  })

beforeAll(async () => {
  fx = await setupFixture()
  ai = await startFakeAi()

  const project = await call(fx.app, {
    method: 'POST',
    url: '/projects',
    as: fx.admin,
    payload: {
      key: `ASSIST${run.toUpperCase().slice(-4)}`,
      name: `Паводок ${run}`,
      description: 'Половодье на реке Вахш: подтоплены дороги, нужен насос и мешки с песком.',
      spaceId: fx.spaceId,
    },
  })
  expect(project.statusCode, project.body).toBe(200)
  projectId = project.json().id as string

  // Закрытое пространство: у сотрудника доступа к нему нет
  const closed = await call(fx.app, {
    method: 'POST',
    url: '/spaces',
    as: fx.admin,
    payload: { key: `closed-${run}`, name: `Закрытое ${run}`, kind: 'team' },
  })
  expect(closed.statusCode, closed.body).toBe(200)

  const secret = await call(fx.app, {
    method: 'POST',
    url: '/projects',
    as: fx.admin,
    payload: {
      key: `SECRET${run.toUpperCase().slice(-4)}`,
      name: `Чужой проект ${run}`,
      description: 'Секретные работы постороннего сотрудника.',
      spaceId: closed.json().id as string,
    },
  })
  expect(secret.statusCode, secret.body).toBe(200)
  secretId = secret.json().id as string

  configure({
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'test-key-not-real',
    ANTHROPIC_BASE_URL: ai.url,
  })

  // Индекс наполняет подписчик воркера; в тесте индексируем сами, чтобы
  // проверять ассистента, а не очередь
  await indexObject(projectId)
  await indexObject(secretId)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = await call(fx.app, {
      url: `/search?q=${encodeURIComponent(`Паводок ${run}`)}`,
      as: fx.admin,
    })
    const hits = (found.json().hits as Array<{ objectId: string }>) ?? []
    if (hits.some((hit) => hit.objectId === projectId)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

afterAll(async () => {
  configure({ AI_PROVIDER: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined })
  await ai.close()
})

describe('ассистент', () => {
  it('идёт инструментом поиска и отвечает со ссылкой на найденное', async () => {
    ai.reply(
      { action: 'tool', tool: 'search', query: `Паводок ${run}`, objectId: '', reason: 'ищу' },
      { action: 'answer', text: 'Нашёл проект по паводку.', citations: [projectId], proposals: [] },
    )

    const response = await ask('Что у нас по паводку?')
    expect(response.statusCode, response.body).toBe(200)
    const message = response.json()
    expect(message.text).toContain('паводку')
    expect(message.steps).toHaveLength(1)
    expect(message.steps[0]).toMatchObject({ tool: 'search' })
    expect(message.citations.map((item: { objectId: string }) => item.objectId)).toContain(
      projectId,
    )
  })

  it('чужой объект не показывает даже по прямому указанию', async () => {
    ai.reply(
      { action: 'tool', tool: 'get_object', query: '', objectId: secretId, reason: 'смотрю' },
      { action: 'answer', text: 'Такой объект мне недоступен.', citations: [], proposals: [] },
    )

    const response = await ask('Покажи карточку чужого проекта', fx.users.member)
    expect(response.statusCode, response.body).toBe(200)
    const message = response.json()
    expect(message.steps[0]).toMatchObject({ found: 0 })
    expect(message.citations).toEqual([])
    expect(JSON.stringify(message)).not.toContain('Секретные работы')
  })

  it('поручение приходит предложением, а не созданным объектом', async () => {
    ai.reply({
      action: 'answer',
      text: 'Предлагаю поручение.',
      citations: [],
      proposals: [
        {
          kind: 'task',
          title: `Проверить насосы ${run}`,
          description: 'По итогам разговора',
          sourceId: null,
        },
      ],
    })

    const response = await ask('Оформи поручение проверить насосы', fx.admin, projectId)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().proposals[0]).toMatchObject({ kind: 'task' })

    const tasks = await call(fx.app, {
      url: `/tasks?q=${encodeURIComponent(`Проверить насосы ${run}`)}`,
      as: fx.admin,
    })
    expect(tasks.statusCode, tasks.body).toBe(200)
    expect(tasks.json().items, 'ассистент ничего не создал').toHaveLength(0)
  })

  it('диалог хранится у каждого свой и стирается владельцем', async () => {
    const mine = await call(fx.app, {
      url: `/assistant/thread?objectId=${projectId}`,
      as: fx.admin,
    })
    expect(mine.statusCode, mine.body).toBe(200)
    expect(mine.json().messages.length).toBeGreaterThan(0)

    const foreign = await call(fx.app, {
      url: `/assistant/thread?objectId=${projectId}`,
      as: fx.users.member,
    })
    expect(foreign.statusCode, foreign.body).toBe(200)
    expect(foreign.json().messages, 'чужая переписка не видна').toHaveLength(0)

    const cleared = await call(fx.app, {
      method: 'DELETE',
      url: `/assistant/threads/${mine.json().id}`,
      as: fx.users.member,
    })
    expect(cleared.statusCode, 'стереть чужой диалог нельзя').toBe(404)

    const own = await call(fx.app, {
      method: 'DELETE',
      url: `/assistant/threads/${mine.json().id}`,
      as: fx.admin,
    })
    expect(own.statusCode, own.body).toBe(200)
  })

  it('без провайдера ассистент отвечает «ИИ не настроен»', async () => {
    configure({ AI_PROVIDER: undefined })
    const response = await ask('Что нового?')
    expect(response.statusCode).toBe(503)
    configure({ AI_PROVIDER: 'anthropic' })
  })
})

describe('вопрос к данным', () => {
  it('ассистент спрашивает датасет и отвечает по выборке', async () => {
    const dataset = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Обращения ${run}`,
        spaceId: fx.spaceId,
        fields: [
          { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
          { key: 'people', label: { ru: 'Людей' }, type: 'integer', semantic: 'measure' },
        ],
      },
    })
    expect(dataset.statusCode, dataset.body).toBe(200)
    const datasetId = dataset.json().id as string
    const rows = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: {
        rows: [
          { values: { district: 'Хатлон', people: 12 } },
          { values: { district: 'Согд', people: 7 } },
        ],
      },
    })
    expect(rows.statusCode, rows.body).toBe(200)

    ai.reply(
      {
        action: 'tool',
        tool: 'ask_data',
        query: 'людей по районам',
        objectId: datasetId,
        reason: 'считаю',
      },
      // Ответ «спросить данные»: план, запрос и подпись
      {
        plan: {
          datasetId,
          groupBy: [{ field: 'district' }],
          measures: [{ alias: 'n', agg: 'sum', field: 'people' }],
        },
        chart: 'bar',
        title: 'Людей по районам',
        explanation: 'Сумма людей по районам',
      },
      { action: 'answer', text: 'Больше всего людей в Хатлоне.', citations: [], proposals: [] },
    )

    const response = await ask('Сколько людей по районам?', fx.admin, datasetId)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().steps[0]).toMatchObject({ tool: 'ask_data' })
    expect(response.json().text).toContain('Хатлон')
  })
})

describe('перевод', () => {
  it('возвращает перевод и язык оригинала, без провайдера — 503', async () => {
    ai.reply({ text: 'Flood in Khatlon', from: 'ru' })
    const response = await call(fx.app, {
      method: 'POST',
      url: '/ai/translate',
      as: fx.admin,
      payload: { text: 'Паводок в Хатлоне', to: 'en' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ text: 'Flood in Khatlon', from: 'ru' })

    configure({ AI_PROVIDER: undefined })
    const off = await call(fx.app, {
      method: 'POST',
      url: '/ai/translate',
      as: fx.admin,
      payload: { text: 'Паводок', to: 'tg' },
    })
    expect(off.statusCode).toBe(503)
    configure({ AI_PROVIDER: 'anthropic' })
  })
})
