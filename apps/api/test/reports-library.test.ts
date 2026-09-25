import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Библиотека отчётов (ADR-0164): встроенные шаблоны и отчёты-шаблоны, версии с возвратом
 * через документ Yjs, картинки и файлы блоков, размер страницы в плане движка, группы, роли
 * и внешние адреса рассылки с учётом грифа.
 */
registerLifecycle()

const { startCollab, stopCollab, CollabService } = await import('../src/kernel/collab/server.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { ReportSchedules } = await import('../src/modules/reports/domain/schedule-service.js')
const { ReportRuns } = await import('../src/modules/reports/domain/run-service.js')
const { REPORT_DOC } = await import('@kchs/contracts')
const { buildUserCtxFor } = await import('../src/kernel/access/explain.js')

let fx: TestContext
let analyst: TestUser
const run = Date.now().toString(36)
// Однопиксельный PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

async function createReport(body: Record<string, unknown>): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/reports',
    as: fx.admin,
    payload: { spaceId: fx.spaceId, ...body },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

beforeAll(async () => {
  fx = await setupFixture()
  await fx.app.listen({ port: 0, host: '127.0.0.1' })
  startCollab(fx.app.server, { resolveSession: (token) => AuthService.resolveSession(token) })
  analyst = await createUser(fx.app, `rep_lib_${run}`, ['employee', 'data_steward'])
})

afterAll(async () => {
  await stopCollab()
})

describe('шаблоны отчётов', () => {
  it('встроенные шаблоны КЧС и отчёт, отмеченный шаблоном, — в библиотеке', async () => {
    const list = await call(fx.app, { url: '/reports/templates', as: fx.admin })
    expect(list.statusCode, list.body).toBe(200)
    const items = list.json().items as Array<{
      id: string
      source: string
      blocks: unknown[]
      params: unknown
      settings: { toc: boolean }
    }>
    const builtin = items.filter((item) => item.source === 'builtin').map((item) => item.id)
    expect(builtin).toEqual([
      'builtin:daily-summary',
      'builtin:flood-season',
      'builtin:instructions-control',
    ])
    const flood = items.find((item) => item.id === 'builtin:flood-season')
    expect(flood?.settings.toc).toBe(true)

    // Отчёт из шаблона — те же блоки, параметры и печать
    const reportId = await createReport({
      name: `Паводок ${run}`,
      blocks: flood?.blocks,
      params: flood?.params,
      settings: flood?.settings,
    })
    const record = (await call(fx.app, { url: `/reports/${reportId}`, as: fx.admin })).json()
    expect(record.blocks).toHaveLength(flood?.blocks.length ?? 0)
    expect(record.template).toBe(false)

    const marked = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/template`,
      as: fx.admin,
      payload: { template: true },
    })
    expect(marked.statusCode, marked.body).toBe(200)
    expect(marked.json().template).toBe(true)
    const withOwn = (await call(fx.app, { url: '/reports/templates', as: fx.admin })).json()
      .items as Array<{ id: string; source: string }>
    expect(withOwn).toContainEqual(expect.objectContaining({ id: reportId, source: 'report' }))
    // Посторонний не видит чужой отчёт-шаблон
    const foreign = (
      await call(fx.app, { url: '/reports/templates', as: fx.users.stranger })
    ).json().items as Array<{ id: string }>
    expect(foreign.map((item) => item.id)).not.toContain(reportId)
    // Снять отметку может только управляющий
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/template`,
      as: fx.users.stranger,
      payload: { template: false },
    })
    expect([403, 404]).toContain(denied.statusCode)
  })
})

describe('версии отчёта', () => {
  it('версия вручную, возврат через документ, версия при формировании — только если менялся', async () => {
    const reportId = await createReport({
      name: `Версии ${run}`,
      blocks: [
        { id: 'a1', kind: 'text' },
        { id: 'a2', kind: 'metrics', title: 'Показатели' },
      ],
      settings: { pageSize: 'A3', orientation: 'landscape', formats: ['pdf'] },
    })
    const saved = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/versions`,
      as: fx.admin,
      payload: { label: 'Перед совещанием' },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().number).toBe(1)

    // Соавтор удаляет блоки — правка через документ Yjs, как в редакторе
    const ctx = await buildUserCtxFor(fx.admin.id)
    if (!ctx) throw new Error('нет контекста администратора')
    await CollabService.change(ctx, { id: reportId, type: 'report' }, (doc) => {
      const order = doc.getArray<string>(REPORT_DOC.order)
      order.delete(0, order.length)
    })
    const emptied = (await call(fx.app, { url: `/reports/${reportId}`, as: fx.admin })).json()
    expect(emptied.blocks).toHaveLength(0)

    const versions = (
      await call(fx.app, { url: `/reports/${reportId}/versions`, as: fx.admin })
    ).json().items as Array<{ id: string; number: number; reason: string; label: string | null }>
    expect(versions[0]).toMatchObject({ number: 1, reason: 'manual', label: 'Перед совещанием' })

    const restored = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/versions/${versions[0]?.id}/restore`,
      as: fx.admin,
    })
    expect(restored.statusCode, restored.body).toBe(200)
    expect(restored.json().blocks.map((block: { id: string }) => block.id)).toEqual(['a1', 'a2'])
    expect(restored.json().settings).toMatchObject({ pageSize: 'A3', orientation: 'landscape' })
    const after = (
      await call(fx.app, { url: `/reports/${reportId}/versions`, as: fx.admin })
    ).json().items as Array<{ number: number; reason: string; blocks: number }>
    // Состояние до возврата (без блоков) — версией «Перед возвратом»
    expect(after[0]).toMatchObject({ number: 2, reason: 'restore', blocks: 0 })

    // «Сформировать»: шаблон изменился с последней версии — версия «При формировании»
    const started = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/runs`,
      as: fx.admin,
      payload: {},
    })
    expect(started.statusCode, started.body).toBe(200)
    const runs = (await call(fx.app, { url: `/reports/${reportId}/versions`, as: fx.admin })).json()
      .items as Array<{ number: number; reason: string }>
    expect(runs[0]).toMatchObject({ number: 3, reason: 'run' })

    // План движка несёт размер страницы
    const plan = await ReportRuns.engineStart(started.json().id)
    expect(plan).toMatchObject({ status: 'render', pageSize: 'A3', orientation: 'landscape' })

    // Читающий не возвращает версии
    const viewer = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/versions/${versions[0]?.id}/restore`,
      as: fx.users.stranger,
    })
    expect([403, 404]).toContain(viewer.statusCode)
  })
})

describe('блоки «Изображение» и «Файлы»', () => {
  it('картинка — data URL тому, кто видит файл; не картинка — 400; файлы — названия', async () => {
    const image = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `схема-${run}.png`,
      content: PNG,
      mime: 'image/png',
    })
    const text = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `справка-${run}.txt`,
      content: 'справка',
    })
    const reportId = await createReport({
      name: `Картинки ${run}`,
      blocks: [
        { id: 'i1', kind: 'image', fileId: image.id, title: 'Схема' },
        { id: 'f1', kind: 'file', fileIds: [text.id, image.id] },
      ],
    })
    const record = (await call(fx.app, { url: `/reports/${reportId}`, as: fx.admin })).json()
    expect(record.blocks.map((block: { kind: string }) => block.kind)).toEqual(['image', 'file'])

    const png = await call(fx.app, {
      url: `/reports/${reportId}/images/${image.id}`,
      as: fx.admin,
    })
    expect(png.statusCode, png.body).toBe(200)
    expect(png.json().dataUrl).toMatch(/^data:image\/png;base64,/)
    const notImage = await call(fx.app, {
      url: `/reports/${reportId}/images/${text.id}`,
      as: fx.admin,
    })
    expect(notImage.statusCode).toBe(400)

    const files = await call(fx.app, {
      url: `/reports/${reportId}/files?ids=${text.id},${image.id},не-идентификатор`,
      as: fx.admin,
    })
    expect(files.statusCode, files.body).toBe(200)
    expect(files.json().items.map((item: { name: string }) => item.name)).toEqual([
      `справка-${run}.txt`,
      `схема-${run}.png`,
    ])
  })
})

describe('рассылка: группы, роли, внешние адреса', () => {
  it('роль разворачивается на момент рассылки; внешним адресам — запуск автора; гриф — пропуск', async () => {
    const reportId = await createReport({ name: `Рассылка ${run}`, blocks: [] })
    // Аналитик должен видеть отчёт, иначе его запуск пропускается
    const shared = await call(fx.app, {
      method: 'POST',
      url: `/objects/${reportId}/access`,
      as: fx.admin,
      payload: { grants: [{ principal: { type: 'user', id: analyst.id }, level: 'view' }] },
    })
    expect(shared.statusCode, shared.body).toBe(200)

    const empty = await call(fx.app, {
      method: 'PUT',
      url: `/reports/${reportId}/schedule`,
      as: fx.admin,
      payload: {
        frequency: 'daily',
        time: '07:00',
        timezone: 'Asia/Dushanbe',
        channels: ['email'],
        formats: ['pdf'],
      },
    })
    expect(empty.statusCode).toBe(400)

    const set = await call(fx.app, {
      method: 'PUT',
      url: `/reports/${reportId}/schedule`,
      as: fx.admin,
      payload: {
        frequency: 'daily',
        time: '07:00',
        timezone: 'Asia/Dushanbe',
        roles: ['data_steward'],
        emails: ['Minfin@Example.TJ', 'minfin@example.tj'],
        channels: ['email'],
        formats: ['pdf'],
      },
    })
    expect(set.statusCode, set.body).toBe(200)
    expect(set.json()).toMatchObject({
      recipients: [],
      roles: ['data_steward'],
      emails: ['minfin@example.tj'],
      externalBlocked: false,
    })
    expect(set.json().expandedCount).toBeGreaterThanOrEqual(1)

    const fired = await ReportSchedules.fire(reportId, { force: true })
    expect(fired.runs).toBeGreaterThanOrEqual(2)
    const rows = await db().execute<{ run_as: string; status: string; external_emails: string[] }>(
      sql`SELECT run_as, status, external_emails FROM report_runs WHERE report_id = ${reportId} AND trigger = 'schedule'`,
    )
    const external = rows.find((row) => row.external_emails.length > 0)
    expect(external).toMatchObject({
      run_as: fx.admin.id,
      status: 'queued',
      external_emails: ['minfin@example.tj'],
    })
    expect(rows.find((row) => row.run_as === analyst.id)?.status).toBe('queued')

    // Гриф «Конфиденциально»: внешним адресам — пропуск с причиной
    await db().execute(
      sql`UPDATE objects SET confidentiality = 'confidential' WHERE id = ${reportId}`,
    )
    // Отчёт с грифом администратор без допуска уже не видит — состояние читаем сервисом
    const blocked = await ReportSchedules.get(reportId)
    expect(blocked?.externalBlocked).toBe(true)
    await db().execute(sql`DELETE FROM report_runs WHERE report_id = ${reportId}`)
    await ReportSchedules.fire(reportId, { force: true })
    const [skipped] = await db().execute<{ status: string; error: string }>(
      sql`SELECT status, error FROM report_runs WHERE report_id = ${reportId} AND cardinality(external_emails) > 0`,
    )
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.error).toContain('Конфиденциально')
  })
})
