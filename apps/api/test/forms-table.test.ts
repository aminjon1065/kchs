import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Табличные формы и ответственный за сдачу (N48, N49, ADR-0129): сводка за
 * период — таблица строк; сдача пишет строки датасета с `_import_id` отправки,
 * повторная сдача после возврата заменяет их, пустая таблица — «записей не
 * было». Дело «Сдать сводку» подразделения уходит ответственному, который
 * видит форму и сдаёт за подразделение, даже не состоя в нём.
 */
registerLifecycle()

const { FormJobs } = await import('../src/modules/forms/domain/form-jobs.js')

const run = Date.now().toString(36)
let fx: TestContext
let datasetId = ''
let formId = ''

/** Закрытые периоды ежедневной формы: вчера и позавчера в поясе установки. */
const day = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
const yesterday = day(1)
const beforeYesterday = day(2)

const definition = (patch: Record<string, unknown> = {}) => ({
  datasetId,
  layout: 'table',
  table: { minRows: 0, maxRows: 3 },
  fields: [
    { key: 'kind', required: true, hint: null },
    { key: 'injured', required: false, hint: null },
    { key: 'note', required: false, hint: null },
  ],
  auto: { unit: 'unit_name', period: 'period', author: 'author', submittedAt: null },
  schedule: { periodicity: 'daily', time: '08:00', dueWorkingDays: 1, startsOn: null, dueOn: null },
  assignments: [{ kind: 'unit', id: fx.unitId, responsibleId: fx.users.viewer.id }],
  review: { enabled: true, reviewers: [`user:${fx.admin.id}`] },
  escalation: { enabled: true, afterWorkingDays: 1 },
  ...patch,
})

/** Строки датасета, записанные отправкой: `_id`, пометка отправки и удаление. */
async function datasetRows() {
  const [dataset] = await db().execute<{ physical_table: string }>(
    sql`SELECT physical_table FROM datasets WHERE id = ${datasetId}`,
  )
  const table = dataset?.physical_table as string
  return db().execute<{ id: string; import_id: string | null; deleted: boolean }>(
    sql.raw(`SELECT _id::text AS id, _import_id::text AS import_id,
                    _deleted_at IS NOT NULL AS deleted
               FROM ds."${table}" ORDER BY _id`),
  )
}

async function openSubmission(periodKey: string) {
  const opened = await call(fx.app, {
    method: 'POST',
    url: `/forms/${formId}/submissions`,
    as: fx.users.viewer,
    payload: { periodKey, subject: { kind: 'unit', id: fx.unitId } },
  })
  expect(opened.statusCode, opened.body).toBe(200)
  return opened.json() as { id: string; rows: unknown[] | null; canSubmit: boolean }
}

beforeAll(async () => {
  fx = await setupFixture()
  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Происшествия за сутки ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
        { key: 'injured', label: { ru: 'Пострадавшие' }, type: 'integer', semantic: 'measure' },
        { key: 'note', label: { ru: 'Описание' }, type: 'text', semantic: 'text' },
        { key: 'unit_name', label: { ru: 'Подразделение' }, type: 'text' },
        { key: 'period', label: { ru: 'Сутки' }, type: 'date', semantic: 'time' },
        { key: 'author', label: { ru: 'Автор' }, type: 'text' },
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
  const enabled = await call(fx.app, {
    method: 'POST',
    url: `/forms/${formId}/enabled`,
    as: fx.admin,
    payload: { enabled: true },
  })
  expect(enabled.statusCode, enabled.body).toBe(200)
})

describe('ответственный за сдачу (N48)', () => {
  it('видит форму и сдаёт за подразделение, в котором не состоит', async () => {
    const response = await call(fx.app, {
      method: 'GET',
      url: `/forms/${formId}`,
      as: fx.users.viewer,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().canSubmit).toBe(true)
    expect(response.json().definition.assignments[0].responsibleId).toBe(fx.users.viewer.id)
  })

  it('получает дело «Сдать сводку» вместо сотрудников подразделения', async () => {
    await FormJobs.control()
    const items = await db().execute<{ user_id: string }>(
      sql`SELECT user_id FROM inbox_items
           WHERE kind = 'submit_form' AND object_id = ${formId} AND state = 'open'`,
    )
    const recipients = new Set(items.map((item) => item.user_id))
    expect(recipients.has(fx.users.viewer.id)).toBe(true)
    expect(recipients.has(fx.users.member.id)).toBe(false)
  })

  it('недействующий или назначенный сотруднику ответственный отклоняется', async () => {
    const stranger = await call(fx.app, {
      method: 'PUT',
      url: `/forms/${formId}`,
      as: fx.admin,
      payload: {
        definition: definition({
          assignments: [{ kind: 'user', id: fx.users.member.id, responsibleId: fx.admin.id }],
        }),
      },
    })
    expect(stranger.statusCode).toBe(400)
    const unknown = await call(fx.app, {
      method: 'PUT',
      url: `/forms/${formId}`,
      as: fx.admin,
      payload: {
        definition: definition({
          assignments: [
            { kind: 'unit', id: fx.unitId, responsibleId: '00000000-0000-4000-8000-000000000000' },
          ],
        }),
      },
    })
    expect(unknown.statusCode).toBe(400)
  })
})

describe('табличная сводка (N49)', () => {
  let submissionId = ''

  it('черновик хранит строки, сдача пишет их в датасет с пометкой отправки', async () => {
    const opened = await openSubmission(yesterday)
    submissionId = opened.id
    expect(opened.canSubmit).toBe(true)
    expect(opened.rows).toEqual([])

    const draft = await call(fx.app, {
      method: 'PUT',
      url: `/forms/submissions/${submissionId}`,
      as: fx.users.viewer,
      payload: { rows: [{ kind: 'Пожар' }] },
    })
    expect(draft.statusCode, draft.body).toBe(200)
    expect(draft.json().rows).toEqual([{ kind: 'Пожар' }])

    const submitted = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/submit`,
      as: fx.users.viewer,
      payload: {
        rows: [
          { kind: 'Пожар', injured: 2, note: 'жилой дом' },
          { kind: 'ДТП', injured: 1 },
        ],
      },
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().status).toBe('submitted')
    expect(submitted.json().rowIds).toHaveLength(2)
    expect(submitted.json().rowId).toBeNull()

    const rows = (await datasetRows()).filter((row) => !row.deleted)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.import_id === submissionId)).toBe(true)

    // Авто-поля — в каждой строке
    const row = await call(fx.app, {
      method: 'GET',
      url: `/datasets/${datasetId}/rows/${submitted.json().rowIds[0]}`,
      as: fx.admin,
    })
    expect(row.statusCode, row.body).toBe(200)
    expect(row.json().values.period).toBe(yesterday)
    expect(row.json().values.unit_name).toBeTruthy()
    expect(row.json().values.author).toBeTruthy()
  })

  it('матрица показывает число сданных строк', async () => {
    const control = await call(fx.app, {
      method: 'GET',
      url: `/forms/${formId}/control?periods=4`,
      as: fx.admin,
    })
    expect(control.statusCode, control.body).toBe(200)
    const cells = control.json().rows[0].cells as Array<{
      periodKey: string
      state: string
      rows: number | null
    }>
    expect(cells.find((cell) => cell.periodKey === yesterday)).toMatchObject({
      state: 'submitted',
      rows: 2,
    })
    // Несданный период — без числа строк
    expect(cells.find((cell) => cell.periodKey === beforeYesterday)?.rows).toBeNull()
  })

  it('повторная сдача после возврата заменяет строки прежней сдачи', async () => {
    const returned = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/review`,
      as: fx.admin,
      payload: { decision: 'return', comment: 'добавьте происшествие на реке' },
    })
    expect(returned.statusCode, returned.body).toBe(200)
    const previous = returned.json().rowIds as string[]

    const again = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/submit`,
      as: fx.users.viewer,
      payload: {
        rows: [
          { kind: 'Пожар', injured: 2 },
          { kind: 'ДТП', injured: 1 },
          { kind: 'Утопление', injured: 0 },
        ],
      },
    })
    expect(again.statusCode, again.body).toBe(200)
    const next = again.json().rowIds as string[]
    expect(next).toHaveLength(3)
    expect(next.some((id) => previous.includes(id))).toBe(false)

    const rows = await datasetRows()
    const live = rows.filter((row) => !row.deleted)
    expect(live).toHaveLength(3)
    // Прежние строки удалены мягко: история датасета их помнит
    expect(rows.filter((row) => previous.includes(row.id)).every((row) => row.deleted)).toBe(true)

    const [event] = await db().execute<{ payload: Record<string, unknown> }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'form.submitted' AND event->'payload'->>'submissionId' = ${submissionId}
           ORDER BY id DESC LIMIT 1`,
    )
    expect(event?.payload).toMatchObject({ rowCount: 3, resubmitted: true })
  })

  it('пустая таблица сдаётся как «записей не было»', async () => {
    const opened = await openSubmission(beforeYesterday)
    const submitted = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${opened.id}/submit`,
      as: fx.users.viewer,
      payload: { rows: [] },
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    expect(submitted.json().status).toBe('submitted')
    expect(submitted.json().rowIds).toEqual([])
  })

  it('лишние строки, пустая строка и незаполненное обязательное поле не сдаются', async () => {
    const opened = await openSubmission(day(3))
    const submit = (rows: unknown[]) =>
      call(fx.app, {
        method: 'POST',
        url: `/forms/submissions/${opened.id}/submit`,
        as: fx.users.viewer,
        payload: { rows },
      })
    const tooMany = await submit([{ kind: 'А' }, { kind: 'Б' }, { kind: 'В' }, { kind: 'Г' }])
    expect(tooMany.statusCode).toBe(400)
    const blank = await submit([{ kind: 'А' }, {}])
    expect(blank.statusCode).toBe(400)
    expect(blank.json().detail).toContain('Строка 2')
    const required = await submit([{ kind: 'А' }, { injured: 3 }])
    expect(required.statusCode).toBe(400)
    expect(required.json().detail).toContain('Строка 2')
    // Табличная форма не сдаётся одиночными значениями
    const single = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${opened.id}/submit`,
      as: fx.users.viewer,
      payload: { values: { kind: 'А' } },
    })
    expect(single.statusCode).toBe(400)
  })

  it('сотрудник подразделения по-прежнему сдаёт за него', async () => {
    const response = await call(fx.app, {
      method: 'GET',
      url: `/forms/${formId}`,
      as: fx.users.member,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().canSubmit).toBe(true)
  })
})
