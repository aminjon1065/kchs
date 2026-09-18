import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { UsersImportParsed, UsersImportStatus } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
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
 * Импорт пользователей из Excel (P0-E04 S04, ADR-0041). Тест играет роль движка:
 * передаёт разобранные строки внутренним маршрутом; проверку и создание
 * выполняет настоящий воркер (BullMQ).
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { startWorkers, stopWorkers, listJobHandlers } = await import('../src/kernel/jobs/runner.js')
const { registerIdentityBackground } = await import('../src/modules/identity/module.js')
const { resetConfigCache } = await import('../src/shared/config/env.js')
const { auditLog, employments, userRoles, roles, users } = await import(
  '../src/shared/db/schema/index.js'
)

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
const run = Date.now().toString(36)
let fx: TestContext
let previousSubscribers: Subscriber[] = []

beforeAll(async () => {
  fx = await setupFixture()
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()
  if (!listJobHandlers().some((h) => h.name === 'identity.users-import')) {
    registerIdentityBackground()
  }
  startWorkers()
  bus.startConsumers({ blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 })
  bus.startDispatcher()
})

afterAll(async () => {
  bus.stopDispatcher()
  await bus.stopConsumers()
  await stopWorkers()
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

type Values = Partial<Record<keyof UsersImportParsed['rows'][number]['values'], string | null>>

function parsed(rows: Values[], extra: Partial<UsersImportParsed> = {}): UsersImportParsed {
  return {
    rows: rows.map((values, index) => ({ row: index + 2, values })),
    columns: { login: 'Логин', lastName: 'Фамилия', firstName: 'Имя' },
    warnings: [],
    fileError: null,
    totalRows: rows.length,
    ...extra,
  }
}

/** Файл импорта — в личном пространстве загрузившего, как в интерфейсе. */
async function xlsxFile(as: TestUser = fx.admin): Promise<string> {
  const me = await call(fx.app, { url: '/me', as })
  const file = await uploadFile(fx.app, as, {
    spaceId: me.json().personalSpaceId as string,
    name: `Сотрудники ${run}.xlsx`,
    content: 'PK — содержимое разбирает движок, здесь его роль играет тест',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  return file.id
}

async function startImport(fileId: string, mode: 'check' | 'apply', as: TestUser = fx.admin) {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/admin/users/import',
    as,
    payload: { fileId, mode },
  })
  expect(response.statusCode, response.body).toBe(202)
  return response.json().importId as string
}

function engineSends(importId: string, body: UsersImportParsed, serviceToken = token) {
  return call(fx.app, {
    method: 'POST',
    url: `/internal/users-import/${importId}/parsed`,
    payload: body,
    headers: { 'x-kchs-service-token': serviceToken },
  })
}

async function finished(
  importId: string,
  as: TestUser = fx.admin,
  timeoutMs = 60_000,
): Promise<UsersImportStatus> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await call(fx.app, { url: `/admin/users/import/${importId}`, as })
    expect(response.statusCode, response.body).toBe(200)
    const status = response.json() as UsersImportStatus
    if (status.state === 'succeeded' || status.state === 'failed') return status
    if (Date.now() > deadline) throw new Error(`импорт не завершился: ${status.state}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function runImport(rows: Values[], mode: 'check' | 'apply', as: TestUser = fx.admin) {
  const importId = await startImport(await xlsxFile(as), mode, as)
  const accepted = await engineSends(importId, parsed(rows))
  expect(accepted.statusCode, accepted.body).toBe(200)
  return { importId, status: await finished(importId, as) }
}

const person = (login: string, extra: Values = {}): Values => ({
  login,
  lastName: 'Каримова',
  firstName: 'Зарина',
  ...extra,
})

async function userByLogin(login: string) {
  const [row] = await db()
    .select()
    .from(users)
    .where(sql`lower(${users.login}) = ${login.toLowerCase()}`)
    .limit(1)
  return row
}

describe('импорт пользователей: проверка', () => {
  it('задание движка ставится с файлом и режимом; строки проверяются без записи', async () => {
    const fileId = await xlsxFile()
    const importId = await startImport(fileId, 'check')

    const [job] = await db().execute<{
      queue: string
      name: string
      payload: Record<string, string>
    }>(sql`SELECT queue, name, payload FROM jobs WHERE id = ${importId}`)
    expect(job?.queue).toBe('imports')
    expect(job?.name).toBe('users.parse')
    expect(job?.payload).toMatchObject({ mode: 'check', fileId })
    expect(job?.payload.storageKey).toBeTruthy()

    const rows: Values[] = [
      person(`ok.${run}`, { email: `ok.${run}@kchs.tj`, unit: 'TEST', roles: 'Сотрудник' }),
      person('bad login!'),
      { login: `nolast.${run}`, firstName: 'Имя' },
      person(`ok.${run}`),
      person(`role.${run}`, { roles: 'employee, волшебник' }),
      person(`unit.${run}`, { unit: 'НЕТ-ТАКОГО' }),
      person(`mail.${run}`, { email: 'x@' }),
      person(`lang.${run}`, { locale: 'fr' }),
      person(`tz.${run}`, { timezone: 'Mars/Base' }),
      person(`pos.${run}`, { position: 'Специалист' }),
      person(`dupmail.${run}`, { email: `ok.${run}@kchs.tj` }),
      person(fx.users.member.login.toUpperCase()),
      person(`long.${run}`, { lastName: 'Я'.repeat(101), phone: '9'.repeat(33) }),
    ]
    const accepted = await engineSends(importId, parsed(rows))
    expect(accepted.statusCode, accepted.body).toBe(200)
    const status = await finished(importId)

    expect(status.state).toBe('succeeded')
    const report = status.report
    expect(report?.mode).toBe('check')
    const byRow = new Map(report?.rows.map((row) => [row.row, row]))
    const codes = (row: number) => byRow.get(row)?.issues.map((i) => `${i.field}:${i.code}`)

    expect(byRow.get(2)?.status).toBe('ready')
    expect(codes(3)).toEqual(['login:invalid_login'])
    expect(codes(4)).toEqual(['lastName:required'])
    expect(codes(5)).toEqual(['login:duplicate_login'])
    expect(byRow.get(5)?.issues[0]?.params).toEqual({ row: 2 })
    expect(codes(6)).toEqual(['roles:unknown_role'])
    expect(codes(7)).toEqual(['unit:unknown_unit'])
    expect(codes(8)).toEqual(['email:invalid_email'])
    expect(codes(9)).toEqual(['locale:invalid_locale'])
    expect(codes(10)).toEqual(['timezone:invalid_timezone'])
    expect(codes(11)).toEqual(['position:position_without_unit'])
    expect(codes(12)).toEqual(['email:duplicate_email'])
    expect(byRow.get(13)?.status).toBe('exists')
    expect(byRow.get(13)?.userId).toBe(fx.users.member.id)
    expect(codes(14)).toEqual(['lastName:too_long', 'phone:too_long'])
    expect(report?.counts).toEqual({ ready: 1, created: 0, exists: 1, error: 11 })

    // Проверка ничего не пишет
    expect(await userByLogin(`ok.${run}`)).toBeUndefined()
    expect(status.credentialsAvailable).toBe(false)
  })

  it('ошибка файла от движка — отчёт без строк, импорт завершён', async () => {
    const importId = await startImport(await xlsxFile(), 'check')
    await engineSends(
      importId,
      parsed([], {
        fileError: { code: 'missing_columns', field: null, params: { columns: 'Фамилия' } },
        warnings: [{ code: 'unknown_column', field: null, params: { column: 'Табельный №' } }],
      }),
    )
    const status = await finished(importId)
    expect(status.state).toBe('succeeded')
    expect(status.report?.fileError?.code).toBe('missing_columns')
    expect(status.report?.warnings[0]?.params).toEqual({ column: 'Табельный №' })
    expect(status.report?.rows).toEqual([])
  })

  it('отчёт выгружается в CSV на языке администратора', async () => {
    const { importId } = await runImport([person(`csv.${run}`), person('плохой логин')], 'check')
    const csv = await call(fx.app, {
      url: `/admin/users/import/${importId}/report.csv`,
      as: fx.admin,
    })
    expect(csv.statusCode).toBe(200)
    expect(String(csv.headers['content-type'])).toContain('text/csv')
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n')
    expect(lines[0]).toBe('Строка,Логин,ФИО,Статус,Замечания')
    expect(lines[1]).toContain(`csv.${run}`)
    expect(lines[2]).toContain('Логин: ')
  })
})

describe('импорт пользователей: создание', () => {
  it('создаёт годные строки, пароли выдаются один раз, повтор не создаёт дублей', async () => {
    const rows: Values[] = [
      person(`new1.${run}`, {
        email: `new1.${run}@kchs.tj`,
        phone: '992935001122',
        unit: 'Тестовое подразделение',
        roles: 'employee, data_steward',
        locale: 'Таджикский',
      }),
      person(`new2.${run}`, { middleName: 'Алиевна' }),
      person(`new3.${run}`, { timezone: 'Asia/Dushanbe' }),
      person('не логин'),
    ]
    const first = await runImport(rows, 'apply')
    expect(first.status.state).toBe('succeeded')
    expect(first.status.report?.counts).toEqual({ ready: 0, created: 3, exists: 0, error: 1 })
    expect(first.status.credentialsAvailable).toBe(true)
    expect(first.status.report?.credentialsExpireAt).toBeTruthy()

    const created = await userByLogin(`new1.${run}`)
    expect(created?.mustChangePassword).toBe(true)
    expect(created?.locale).toBe('tg')
    expect(created?.phone).toBe('992935001122')
    const assigned = await db()
      .select({ key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, created?.id ?? ''))
    expect(assigned.map((r) => r.key).sort()).toEqual(['data_steward', 'employee'])
    const [employment] = await db()
      .select({ unitId: employments.unitId })
      .from(employments)
      .where(eq(employments.userId, created?.id ?? ''))
    expect(employment?.unitId).toBe(fx.unitId)

    // Пароли — только инициатору и один раз
    const foreign = await call(fx.app, {
      url: `/admin/users/import/${first.importId}/credentials.csv`,
      as: fx.users.member,
    })
    expect(foreign.statusCode).toBe(403)
    const download = await call(fx.app, {
      url: `/admin/users/import/${first.importId}/credentials.csv`,
      as: fx.admin,
    })
    expect(download.statusCode).toBe(200)
    expect(String(download.headers['cache-control'])).toContain('no-store')
    const lines = download.body.replace(/^﻿/, '').trim().split('\r\n')
    expect(lines[0]).toBe('Логин,ФИО,Временный пароль')
    expect(lines).toHaveLength(4)
    const [login, , password] = (lines[1] ?? '').split(',')
    expect(login).toBe(`new1.${run}`)

    const signIn = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login, password },
    })
    expect(signIn.statusCode).toBe(200)
    expect(signIn.json().status).toBe('password_change_required')

    const again = await call(fx.app, {
      url: `/admin/users/import/${first.importId}/credentials.csv`,
      as: fx.admin,
    })
    expect(again.statusCode).toBe(404)
    const status = await finished(first.importId)
    expect(status.credentialsAvailable).toBe(false)

    const trail = await db()
      .select({ action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      // Журнал аудита не очищается между прогонами (только INSERT) — фильтр по импорту
      .where(
        sql`${auditLog.action} in ('users.imported', 'users.import_credentials_downloaded')
            AND ${auditLog.details}->>'importId' = ${first.importId}`,
      )
    expect(trail.map((row) => row.action).sort()).toEqual([
      'users.import_credentials_downloaded',
      'users.imported',
    ])
    expect(JSON.stringify(trail)).not.toContain(password ?? '---')

    // Повтор того же файла: всё уже есть, ничего не создаётся
    const second = await runImport(rows, 'apply')
    expect(second.status.report?.counts).toEqual({ ready: 0, created: 0, exists: 3, error: 1 })
    expect(second.status.credentialsAvailable).toBe(false)
    const [total] = await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM users WHERE login LIKE ${`new_.${run}`}`,
    )
    expect(total?.count).toBe(3)
  })

  it('500 строк импортируются с отчётом за разумное время', { timeout: 180_000 }, async () => {
    const rows: Values[] = Array.from({ length: 500 }, (_, i) =>
      i % 50 === 49
        ? person(`bulk${i}.${run}`, { email: 'не почта' })
        : person(`bulk${i}.${run}`, { email: `bulk${i}.${run}@kchs.tj`, unit: 'TEST' }),
    )
    const started = Date.now()
    const importId = await startImport(await xlsxFile(), 'apply')
    expect((await engineSends(importId, parsed(rows))).statusCode).toBe(200)
    const status = await finished(importId, fx.admin, 170_000)
    const seconds = (Date.now() - started) / 1000

    expect(status.state).toBe('succeeded')
    expect(status.report?.counts).toEqual({ ready: 0, created: 490, exists: 0, error: 10 })
    expect(status.report?.rows.filter((r) => r.status === 'error').map((r) => r.row)).toEqual(
      Array.from({ length: 10 }, (_, k) => 51 + k * 50),
    )
    expect(seconds).toBeLessThan(150)
  })
})

describe('импорт пользователей: права и границы', () => {
  it('без права users.manage импорт недоступен', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/admin/users/import',
      as: fx.users.member,
      payload: { fileId: await xlsxFile(), mode: 'check' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('администратор оргструктуры не назначает роли сверх базовой', async () => {
    const orgAdmin = await createUser(fx.app, `orgadmin.${run}`, ['org_admin'])
    const { status } = await runImport(
      [person(`plain.${run}`), person(`steward.${run}`, { roles: 'data_steward' })],
      'check',
      orgAdmin,
    )
    const [plain, steward] = status.report?.rows ?? []
    expect(plain?.status).toBe('ready')
    expect(steward?.issues.map((i) => i.code)).toEqual(['role_forbidden'])

    // Чужой импорт не виден: только инициатору и администратору системы
    const foreign = await call(fx.app, {
      url: `/admin/users/import/${status.importId}`,
      as: (await createUser(fx.app, `orgadmin2.${run}`, ['org_admin'])) as TestUser,
    })
    expect(foreign.statusCode).toBe(404)
    const bySystemAdmin = await call(fx.app, {
      url: `/admin/users/import/${status.importId}`,
      as: fx.admin,
    })
    expect(bySystemAdmin.statusCode).toBe(200)
  })

  it('файл не XLSX отклоняется, внутренний маршрут требует сервисный токен', async () => {
    const text = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `users-${run}.csv`,
      content: 'login,lastName',
      mime: 'text/csv',
    })
    const refused = await call(fx.app, {
      method: 'POST',
      url: '/admin/users/import',
      as: fx.admin,
      payload: { fileId: text.id, mode: 'check' },
    })
    expect(refused.statusCode).toBe(400)

    const importId = await startImport(await xlsxFile(), 'check')
    expect((await engineSends(importId, parsed([]), 'wrong-token-0000000')).statusCode).toBe(401)
    const unknown = await engineSends('00000000-0000-4000-8000-000000000000', parsed([]))
    expect(unknown.statusCode).toBe(404)

    // Повтор вызова движком возвращает то же задание проверки
    const first = await engineSends(importId, parsed([person(`twice.${run}`)]))
    const second = await engineSends(importId, parsed([person(`twice.${run}`)]))
    expect(second.json().applyJobId).toBe(first.json().applyJobId)
  })

  it('без доступа к файлу импорт не начинается', async () => {
    const orgAdmin = await createUser(fx.app, `orgadmin3.${run}`, ['org_admin'])
    const response = await call(fx.app, {
      method: 'POST',
      url: '/admin/users/import',
      as: orgAdmin,
      payload: { fileId: await xlsxFile(fx.admin), mode: 'check' },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('шаблон импорта', () => {
  let engine: Server
  let received: { token?: string; body?: Record<string, unknown> } = {}
  let reply = { status: 200, body: Buffer.from('PK шаблон') }
  const previousUrl = process.env.ENGINE_INTERNAL_URL

  beforeAll(async () => {
    engine = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received = {
          token: String(request.headers['x-kchs-service-token'] ?? ''),
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        }
        response.statusCode = reply.status
        response.end(reply.body)
      })
    })
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve))
    process.env.ENGINE_INTERNAL_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`
    resetConfigCache()
  })

  afterAll(async () => {
    process.env.ENGINE_INTERNAL_URL = previousUrl
    resetConfigCache()
    await new Promise((resolve) => engine.close(resolve))
  })

  it('движок собирает XLSX со справочниками организации', async () => {
    const response = await call(fx.app, { url: '/admin/users/import/template.xlsx', as: fx.admin })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['content-type'])).toContain('spreadsheetml')
    expect(String(response.headers['content-disposition'])).toContain('kchs-users-import.xlsx')
    expect(response.body.startsWith('PK')).toBe(true)
    expect(received.token).toBe(token)
    const body = received.body as {
      roles: Array<{ key: string }>
      units: Array<{ code: string; name: string }>
    }
    expect(body.roles.map((r) => r.key)).toContain('employee')
    expect(body.units).toContainEqual(expect.objectContaining({ code: 'TEST' }))

    const member = await call(fx.app, {
      url: '/admin/users/import/template.xlsx',
      as: fx.users.member,
    })
    expect(member.statusCode).toBe(403)
  })

  it('сбой движка — 424, а не пустой файл', async () => {
    reply = { status: 500, body: Buffer.from('boom') }
    const response = await call(fx.app, { url: '/admin/users/import/template.xlsx', as: fx.admin })
    expect(response.statusCode).toBe(424)
    reply = { status: 200, body: Buffer.from('PK') }
  })
})
