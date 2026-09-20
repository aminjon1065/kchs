import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Формы сбора данных (P5-E03, ADR-0103): форма — объект реестра над датасетом,
 * назначенный сдаёт сводку строкой датасета с `_import_id` отправки,
 * ответственный принимает или возвращает, контроль сдачи — матрица.
 */
registerLifecycle()

const run = Date.now().toString(36)
let fx: TestContext
let datasetId = ''
let formId = ''

/** Период, который уже закрыт: вчерашний день в поясе установки. */
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

const definition = (patch: Record<string, unknown> = {}) => ({
  datasetId,
  fields: [
    { key: 'people', required: true, hint: null },
    { key: 'note', required: false, hint: null },
  ],
  auto: { unit: 'unit_name', period: 'period', author: 'author', submittedAt: 'submitted_at' },
  schedule: {
    periodicity: 'daily',
    time: '08:00',
    dueWorkingDays: 1,
    startsOn: null,
    dueOn: null,
  },
  assignments: [{ kind: 'unit', id: fx.unitId }],
  review: { enabled: true, reviewers: [`user:${fx.admin.id}`] },
  escalation: { enabled: true, afterWorkingDays: 1 },
  ...patch,
})

beforeAll(async () => {
  fx = await setupFixture()
  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Сводка по происшествиям ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'people', label: { ru: 'Людей' }, type: 'integer', semantic: 'measure' },
        { key: 'note', label: { ru: 'Примечание' }, type: 'text', semantic: 'dimension' },
        { key: 'unit_name', label: { ru: 'Подразделение' }, type: 'text' },
        { key: 'period', label: { ru: 'Период' }, type: 'date', semantic: 'time' },
        { key: 'author', label: { ru: 'Автор' }, type: 'text' },
        { key: 'submitted_at', label: { ru: 'Отправлено' }, type: 'datetime' },
      ],
    },
  })
  expect(dataset.statusCode, dataset.body).toBe(200)
  datasetId = dataset.json().id as string

  const created = await call(fx.app, {
    method: 'POST',
    url: '/forms',
    as: fx.admin,
    payload: { name: `Суточная сводка ${run}`, spaceId: fx.spaceId, definition: definition() },
  })
  expect(created.statusCode, created.body).toBe(200)
  formId = created.json().id as string
})

describe('форма сбора данных', () => {
  it('назначенный видит форму политикой типа, посторонний — нет', async () => {
    const member = await call(fx.app, {
      method: 'GET',
      url: `/forms/${formId}`,
      as: fx.users.member,
    })
    expect(member.statusCode, member.body).toBe(200)
    expect(member.json().canSubmit).toBe(true)
    expect(member.json().canManage).toBe(false)

    const stranger = await call(fx.app, {
      method: 'GET',
      url: `/forms/${formId}`,
      as: fx.users.stranger,
    })
    expect([403, 404]).toContain(stranger.statusCode)
  })

  it('сдача пишет строку датасета с авто-полями и помечает её отправкой', async () => {
    const opened = await call(fx.app, {
      method: 'POST',
      url: `/forms/${formId}/submissions`,
      as: fx.users.member,
      payload: { periodKey: yesterday, subject: { kind: 'unit', id: fx.unitId } },
    })
    expect(opened.statusCode, opened.body).toBe(200)
    const submissionId = opened.json().id as string
    expect(opened.json().status).toBe('draft')
    expect(opened.json().canSubmit).toBe(true)

    const draft = await call(fx.app, {
      method: 'PUT',
      url: `/forms/submissions/${submissionId}`,
      as: fx.users.member,
      payload: { values: { people: 3 } },
    })
    expect(draft.statusCode, draft.body).toBe(200)
    expect(draft.json().values.people).toBe(3)

    const submitted = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/submit`,
      as: fx.users.member,
      payload: { values: { people: 7, note: 'без происшествий' } },
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().status).toBe('submitted')
    const rowId = submitted.json().rowId as string
    expect(rowId).toBeTruthy()

    const row = await call(fx.app, {
      method: 'GET',
      url: `/datasets/${datasetId}/rows/${rowId}`,
      as: fx.admin,
    })
    expect(row.statusCode, row.body).toBe(200)
    expect(row.json().values.people).toBe(7)
    // Авто-поля заполняются сами: подразделение, период и автор
    expect(row.json().values.period).toBe(yesterday)
    expect(row.json().values.unit_name).toBeTruthy()
    expect(row.json().values.author).toBeTruthy()
  })

  it('обязательное поле без значения не сдаётся', async () => {
    const opened = await call(fx.app, {
      method: 'POST',
      url: `/forms/${formId}/submissions`,
      as: fx.users.member,
      payload: { periodKey: yesterday, subject: { kind: 'unit', id: fx.unitId } },
    })
    const submissionId = opened.json().id as string
    const bad = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/submit`,
      as: fx.users.member,
      payload: { values: { note: 'нет числа' } },
    })
    // Сводка за период уже сдана: повторная сдача закрыта
    expect([400, 409]).toContain(bad.statusCode)
  })

  it('возврат с комментарием открывает сдачу заново, приёмка закрывает период', async () => {
    const control = await call(fx.app, {
      method: 'GET',
      url: `/forms/${formId}/control?periods=4`,
      as: fx.admin,
    })
    expect(control.statusCode, control.body).toBe(200)
    const cell = (
      control.json().rows[0].cells as Array<{
        periodKey: string
        state: string
        submissionId: string | null
      }>
    ).find((item) => item.periodKey === yesterday)
    expect(cell?.state).toBe('submitted')
    const submissionId = cell?.submissionId as string

    const noRights = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/review`,
      as: fx.users.member,
      payload: { decision: 'accept' },
    })
    expect(noRights.statusCode).toBe(403)

    const returned = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/review`,
      as: fx.admin,
      payload: { decision: 'return', comment: 'уточните число пострадавших' },
    })
    expect(returned.statusCode, returned.body).toBe(200)
    expect(returned.json().status).toBe('returned')

    const again = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/submit`,
      as: fx.users.member,
      payload: { values: { people: 9, note: 'уточнено' } },
    })
    expect(again.statusCode, again.body).toBe(200)
    // Повторная сдача правит ту же строку датасета
    expect(again.json().rowId).toBe(returned.json().rowId)

    const accepted = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/review`,
      as: fx.admin,
      payload: { decision: 'accept' },
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().status).toBe('accepted')

    const after = await call(fx.app, {
      method: 'GET',
      url: `/forms/${formId}/control?periods=4`,
      as: fx.admin,
    })
    const state = (after.json().rows[0].cells as Array<{ periodKey: string; state: string }>).find(
      (item) => item.periodKey === yesterday,
    )?.state
    expect(state).toBe('accepted')
    expect(after.json().totals.accepted).toBe(1)
  })

  it('сдавать за чужое подразделение нельзя', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: `/forms/${formId}/submissions`,
      as: fx.users.viewer,
      payload: { periodKey: yesterday, subject: { kind: 'unit', id: fx.unitId } },
    })
    expect([403, 404]).toContain(response.statusCode)
  })

  it('схема формы — подмножество полей датасета', async () => {
    const schema = await call(fx.app, {
      method: 'GET',
      url: `/forms/${formId}/schema`,
      as: fx.users.member,
    })
    expect(schema.statusCode, schema.body).toBe(200)
    expect((schema.json().fields as Array<{ key: string }>).map((item) => item.key)).toEqual([
      'people',
      'note',
    ])

    const bad = await call(fx.app, {
      method: 'POST',
      url: '/forms',
      as: fx.admin,
      payload: {
        name: `Плохая форма ${run}`,
        spaceId: fx.spaceId,
        definition: definition({ fields: [{ key: 'unknown_field', required: false, hint: null }] }),
      },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('включение формы без назначений отклоняется', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/forms',
      as: fx.admin,
      payload: {
        name: `Без назначений ${run}`,
        spaceId: fx.spaceId,
        definition: definition({ assignments: [] }),
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const response = await call(fx.app, {
      method: 'POST',
      url: `/forms/${created.json().id}/enabled`,
      as: fx.admin,
      payload: { enabled: true },
    })
    expect(response.statusCode).toBe(400)
  })
})
