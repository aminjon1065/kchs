import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeAi, startFakeAi } from './fakes.js'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
} from './helpers.js'

/**
 * Модуль ИИ и «Спросить данные» v1 (P1-E09 S02–S03, ADR-0061): провайдер —
 * поддельный сервер (Anthropic Messages API и OpenAI-совместимый), настоящая
 * модель не вызывается. Проверяются схема для модели без скрытых полей и
 * строк, исполнение с политиками, понятные ошибки, лимиты и аудит.
 */
registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/env.js')

let fx: TestContext
let ai: FakeAi
let datasetId: string
const run = Date.now().toString(36)

const BY_DISTRICT = {
  answerable: true,
  reason: '',
  title: 'Обращения по районам',
  explanation: 'Количество обращений по районам',
  conditions: [],
  groups: [{ field: 'district', bucket: null }],
  measures: [{ agg: 'count', field: null }],
  sort: { by: 'count', dir: 'desc' },
  limit: null,
  chart: 'bar',
}

function configure(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetConfigCache()
}

const ask = (question: string, as = fx.users.member) =>
  call(fx.app, { method: 'POST', url: `/datasets/${datasetId}/ask`, as, payload: { question } })

/** Строки результата: значения по именам столбцов. */
function records(result: { fields: Array<{ name: string }>; rows: unknown[][] }) {
  const names = result.fields.map((item) => item.name)
  return result.rows.map((row) => Object.fromEntries(names.map((name, i) => [name, row[i]])))
}

beforeAll(async () => {
  fx = await setupFixture()
  ai = await startFakeAi()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Обращения ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Номер' }, type: 'identifier', semantic: 'identifier' },
        {
          key: 'district',
          label: { ru: 'Район' },
          type: 'select',
          semantic: 'category',
          options: [
            { value: 'khatlon', label: { ru: 'Хатлон' } },
            { value: 'sughd', label: { ru: 'Согд' } },
            { value: 'gbao', label: { ru: 'ГБАО' } },
          ],
        },
        { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
        { key: 'phone', label: { ru: 'Телефон заявителя' }, type: 'text' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        { code: 'A-1', district: 'khatlon', amount: 10, day: '2026-03-01', phone: '+992900000001' },
        { code: 'A-2', district: 'khatlon', amount: 20, day: '2026-03-02', phone: '+992900000002' },
        { code: 'A-3', district: 'sughd', amount: 30, day: '2026-04-03', phone: '+992900000003' },
        { code: 'A-4', district: 'gbao', amount: 40, day: '2026-04-04', phone: '+992900000004' },
      ].map((values) => ({ values })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)

  // Читатель видит только Хатлон и не видит телефон
  const rowPolicy = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/policies/rows`,
    as: fx.admin,
    payload: {
      principal: { type: 'user', id: fx.users.viewer.id },
      filter: { field: 'district', op: 'eq', value: 'khatlon' },
    },
  })
  expect(rowPolicy.statusCode, rowPolicy.body).toBe(200)
  const columnPolicy = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/policies/columns`,
    as: fx.admin,
    payload: {
      principal: { type: 'user', id: fx.users.viewer.id },
      mode: 'hide',
      fields: ['phone'],
    },
  })
  expect(columnPolicy.statusCode, columnPolicy.body).toBe(200)
})

afterAll(async () => {
  configure({
    AI_PROVIDER: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_BASE_URL: undefined,
    OPENAI_COMPAT_URL: undefined,
    AI_MODEL: undefined,
    AI_DAILY_REQUESTS: undefined,
  })
  await ai?.close()
})

describe('ИИ без провайдера', () => {
  it('функции скрыты, API отвечает понятной ошибкой', async () => {
    configure({ AI_PROVIDER: undefined })
    const status = await call(fx.app, { url: '/ai/status', as: fx.users.member })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ enabled: false, provider: null, model: null })

    const response = await ask('Сколько обращений по районам?')
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ data: { reason: 'ai_not_configured' } })
    expect(ai.calls).toHaveLength(0)
  })
})

describe('«Спросить данные» через Anthropic', () => {
  beforeAll(() => {
    configure({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key-not-real',
      ANTHROPIC_BASE_URL: ai.url,
      AI_MODEL: undefined,
    })
  })

  it('вопрос на русском → проверенный план, запрос и результат', async () => {
    const status = await call(fx.app, { url: '/ai/status', as: fx.users.member })
    expect(status.json()).toMatchObject({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })

    // Владелец видит все строки: у датасета есть политика строк только для читателя
    ai.reply(BY_DISTRICT)
    const response = await ask('Сколько обращений по районам?', fx.admin)
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body.plan).toEqual({
      filter: null,
      groups: [{ field: 'district' }],
      measures: [{ agg: 'count' }],
      sort: { field: 'count', dir: 'desc' },
      limit: null,
    })
    expect(body.chart).toBe('bar')
    expect(body.title).toBe('Обращения по районам')
    expect(body.spec.source).toEqual({ kind: 'dataset', id: datasetId })
    expect(body.spec.steps.map((step: { type: string }) => step.type)).toEqual([
      'aggregate',
      'sort',
    ])
    expect(records(body.result)).toEqual([
      { district: 'khatlon', count: 2 },
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
    ])

    // Модели ушли инструкция, схема и вопрос — без строк данных
    const request = ai.calls.at(-1)
    expect(request?.path).toBe('/v1/messages')
    expect(request?.headers['x-api-key']).toBe('test-key-not-real')
    expect(request?.body.model).toBe('claude-sonnet-5')
    expect(request?.body.output_config).toMatchObject({ format: { type: 'json_schema' } })
    const prompt = JSON.stringify(request?.body.messages)
    expect(prompt).toContain('Сколько обращений по районам?')
    expect(prompt).toContain('khatlon')
    expect(prompt).toContain('Телефон заявителя')
    expect(prompt).not.toContain('+99290000000')
    expect(prompt).not.toContain('A-1')

    // Аудит: вопрос, исход и токены, без строк результата
    const [entry] = await db().execute<{ details: Record<string, unknown> }>(
      sql`SELECT details FROM audit_log WHERE action = 'ai.request' AND actor_id = ${fx.admin.id}
           ORDER BY id DESC LIMIT 1`,
    )
    expect(entry?.details).toMatchObject({
      feature: 'ask_data',
      provider: 'anthropic',
      outcome: 'ok',
      question: 'Сколько обращений по районам?',
      inputTokens: 1200,
      outputTokens: 150,
    })
    expect(JSON.stringify(entry?.details)).not.toContain('+99290000000')
  })

  it('читателю — только видимые поля в схеме и его строки в результате', async () => {
    ai.reply(BY_DISTRICT)
    const response = await ask('Сколько обращений по районам?', fx.users.viewer)
    expect(response.statusCode, response.body).toBe(200)
    expect(records(response.json().result)).toEqual([{ district: 'khatlon', count: 2 }])
    const prompt = JSON.stringify(ai.calls.at(-1)?.body.messages)
    expect(prompt).not.toContain('phone')
    expect(prompt).not.toContain('Телефон заявителя')

    // План со скрытым полем не выполняется и не выдаёт, что поле существует
    const before = await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM query_runs`,
    )
    ai.reply({
      ...BY_DISTRICT,
      conditions: [{ field: 'phone', op: 'contains', value: '+992', values: null, relative: null }],
    })
    const hidden = await ask('Обращения с номерами +992', fx.users.viewer)
    expect(hidden.statusCode).toBe(422)
    expect(hidden.json()).toMatchObject({
      data: { reason: 'ai_invalid', issues: ['conditions.0: нет поля «phone»'] },
    })
    const after = await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM query_runs`,
    )
    expect(after[0]?.count).toBe(before[0]?.count)
  })

  it('ошибки модели — понятное сообщение, ничего не выполняется', async () => {
    ai.reply({ ...BY_DISTRICT, answerable: false, reason: 'В датасете нет сведений о погоде' })
    const unanswerable = await ask('Какая завтра погода?')
    expect(unanswerable.statusCode).toBe(422)
    expect(unanswerable.json()).toMatchObject({
      detail: 'В датасете нет сведений о погоде',
      data: { reason: 'ai_unanswerable' },
    })

    ai.reply('это не JSON')
    const garbage = await ask('Сколько обращений?')
    expect(garbage.statusCode).toBe(422)
    expect(garbage.json()).toMatchObject({ data: { reason: 'ai_invalid' } })

    // Компилятор отвергает сравнение «больше» для списка — ответ модели не годится
    ai.reply({
      ...BY_DISTRICT,
      conditions: [{ field: 'district', op: 'gt', value: 'khatlon', values: null, relative: null }],
    })
    const rejected = await ask('Районы после Хатлона')
    expect(rejected.statusCode).toBe(422)
    expect(rejected.json().data.reason).toBe('ai_invalid')
    expect(rejected.json().data.issues[0]).toContain('gt')

    ai.fail(401)
    const provider = await ask('Сколько обращений?')
    expect(provider.statusCode).toBe(424)
    expect(provider.json()).toMatchObject({ data: { reason: 'ai_provider' } })
    // Ключ провайдера не уходит клиенту
    expect(provider.body).not.toContain('test-key-not-real')

    const outcomes = await db().execute<{ outcome: string }>(
      sql`SELECT details->>'outcome' AS outcome FROM audit_log
           WHERE action = 'ai.request' AND actor_id = ${fx.users.member.id} ORDER BY id DESC LIMIT 4`,
    )
    expect(outcomes.map((row) => row.outcome)).toEqual([
      'provider_error',
      'rejected',
      'invalid_output',
      'rejected',
    ])
  })

  it('суточный лимит запросов на пользователя', async () => {
    for (const key of await redis().keys('kchs:ai:usage:*')) await redis().del(key)
    configure({ AI_DAILY_REQUESTS: '1' })
    ai.reply(BY_DISTRICT)
    expect((await ask('Сколько обращений по районам?')).statusCode).toBe(200)
    const limited = await ask('Сколько обращений по районам?')
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ data: { reason: 'ai_limit' } })
    const status = await call(fx.app, { url: '/ai/status', as: fx.users.member })
    expect(status.json().limits).toMatchObject({
      requestsPerDay: 1,
      requestsUsed: 1,
      tokensUsed: 1350,
    })
    configure({ AI_DAILY_REQUESTS: undefined })
  })

  it('без способности ai.use ИИ недоступен', async () => {
    const plain = await createUser(fx.app, `no_ai_${run}`, [])
    const status = await call(fx.app, { url: '/ai/status', as: plain })
    expect(status.json().enabled).toBe(false)
    expect((await ask('Сколько обращений?', plain)).statusCode).toBe(403)
  })
})

describe('«Спросить данные» через OpenAI-совместимый сервер', () => {
  it('свой сервер модели отвечает по той же схеме', async () => {
    configure({
      AI_PROVIDER: 'openai-compat',
      OPENAI_COMPAT_URL: `${ai.url}/v1`,
      AI_MODEL: 'local-model',
    })
    ai.reply(BY_DISTRICT)
    const response = await ask('Сколько обращений по районам?')
    expect(response.statusCode, response.body).toBe(200)
    const request = ai.calls.at(-1)
    expect(request?.path).toBe('/v1/chat/completions')
    expect(request?.body.model).toBe('local-model')
    expect(request?.body.response_format).toMatchObject({ type: 'json_schema' })
  })
})
