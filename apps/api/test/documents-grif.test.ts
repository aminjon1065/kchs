import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
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
 * Грифы и допуски (08-documents.md §13, 04-verification.md фаза 3 №4, ADR-0080):
 * документ с грифом «конфиденциально» не виден пользователю без допуска — даже
 * с явной записью ACL и участием — ни в карточке, ни в списках (модуля и ядра),
 * ни в поиске, ни через связи, вложения, комнату realtime, системный датасет,
 * недавние; уведомления и Входящие — без содержания. Администратор системы видит
 * такой документ только в режиме администратора с обоснованием — всё в аудит.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { indexObject } = await import('../src/kernel/search/index-service.js')
const { canJoin } = await import('../src/kernel/realtime/gateway.js')
const { buildUserCtx } = await import('../src/kernel/context-builder.js')
const { usersWithAccess } = await import('../src/kernel/access/acl-service.js')
const { InboxService } = await import('../src/kernel/inbox/service.js')

const run = Date.now().toString(36)
let fx: TestContext
let registrar: TestUser
let auditor: TestUser
let cleared: TestUser
const types = new Map<string, string>()
let ministry = ''
let secretId = ''
let scanId = ''
const subject = `Совершенно особая тема ${run}`

/** Контекст сокета — как у шлюза realtime: сессия с её режимом администратора. */
async function userCtx(user: TestUser) {
  const [session] = await db().execute<{
    id: string
    until: string | null
    reason: string | null
  }>(
    sql`SELECT id, admin_mode_until AS until, admin_mode_reason AS reason FROM sessions
         WHERE user_id = ${user.id} AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  )
  return buildUserCtx(
    {
      sessionId: session?.id ?? `test-${user.id}`,
      userId: user.id,
      onBehalfOf: null,
      mfaEnrolled: true,
      adminMode:
        session?.until && new Date(session.until).getTime() > Date.now()
          ? { reason: session.reason ?? '', until: new Date(session.until).toISOString() }
          : null,
    },
    { id: 'test', ip: null, headers: {} } as never,
  )
}

const get = (as: TestUser, url: string) => call(fx.app, { url, as })

async function searchIds(as: TestUser, q: string): Promise<string[]> {
  const response = await call(fx.app, { url: `/search?q=${encodeURIComponent(q)}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().hits as Array<{ objectId: string }>).map((hit) => hit.objectId)
}

/** Поиск асинхронен: ждём, пока документ найдёт тот, кому он виден. */
async function waitIndexed(as: TestUser, q: string, id: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await searchIds(as, q)).includes(id)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`поиск не нашёл ${id}`)
}

const setClearance = (user: TestUser, clearance: string, as: TestUser = fx.admin) =>
  call(fx.app, {
    method: 'PUT',
    url: `/users/${user.id}/clearance`,
    as,
    payload: { clearance, reason: 'Допуск по приказу о режиме секретности' },
  })

async function auditRows(action: string, objectId: string) {
  return db().execute<{ actor_id: string | null; details: Record<string, unknown> }>(
    sql`SELECT actor_id, details FROM audit_log WHERE action = ${action} AND object_id = ${objectId}
         ORDER BY id`,
  )
}

/** Подписчики ядра и модуля документов по неопубликованным событиям — как воркер. */
async function drainOutbox(): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'kernel-notifications')) {
    const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
    registerKernelSubscribers()
  }
  if (!listSubscribers().some((subscriber) => subscriber.name === 'documents-notifications')) {
    const { registerDocumentsBackground } = await import('../src/modules/documents/module.js')
    registerDocumentsBackground()
  }
  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 2000`,
  )
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (!matchesType(subscriber.types, event.type)) continue
      // Поиск и комнаты в этом прогоне проверяются явно — подписчики ядра не нужны
      if (subscriber.name === 'kernel-search' || subscriber.name === 'kernel-collab') continue
      await subscriber.handle(event as never)
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, 'registrar_grif', ['employee', 'registrar'])
  auditor = await createUser(fx.app, 'auditor_grif', ['employee', 'security_auditor'])
  cleared = await createUser(fx.app, 'cleared_grif', ['employee'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  for (const item of (await get(fx.admin, '/document-types')).json().items as Array<{
    id: string
    key: string
  }>) {
    types.set(item.key, item.id)
  }
  ministry = (await get(registrar, '/correspondents?q=Минфин')).json().items[0].id

  // Делопроизводитель и исполнитель с допуском к конфиденциальному
  expect((await setClearance(registrar, 'confidential')).statusCode).toBe(200)
  expect((await setClearance(cleared, 'confidential')).statusCode).toBe(200)

  // Конфиденциальное входящее: ответственный — сотрудник БЕЗ допуска (участник), контролёр — с допуском
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as: registrar,
    payload: {
      typeId: types.get('incoming_letter'),
      subject,
      confidentiality: 'confidential',
      correspondentId: ministry,
      receivedDate: '2026-09-18',
      responsibleId: fx.users.member.id,
      controllerId: cleared.id,
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  secretId = created.json().id
  const doc = (await get(registrar, `/documents/${secretId}`)).json()
  const scan = await uploadFile(fx.app, registrar, {
    spaceId: doc.spaceId,
    name: `скан-конфиденциальный-${run}.pdf`,
    mime: 'application/pdf',
    content: '%PDF-1.4 конфиденциально',
    attachToObjectId: secretId,
  })
  scanId = scan.id
  const version = await call(fx.app, {
    method: 'POST',
    url: `/documents/${secretId}/versions`,
    as: registrar,
    payload: { mainFileId: scanId },
  })
  expect(version.statusCode, version.body).toBe(200)
  const registered = await call(fx.app, {
    method: 'POST',
    url: `/documents/${secretId}/register`,
    as: registrar,
    payload: {},
  })
  expect(registered.statusCode, registered.body).toBe(200)

  // Явная запись ACL сотруднику без допуска — гриф всё равно сильнее. Выдаёт
  // владелец-делопроизводитель: администратор вне режима документа не видит
  const shared = await call(fx.app, {
    method: 'POST',
    url: `/objects/${secretId}/access`,
    as: registrar,
    payload: { grants: [{ principal: { type: 'user', id: fx.users.member.id }, level: 'view' }] },
  })
  expect(shared.statusCode, shared.body).toBe(200)
})

describe('документ выше допуска не виден даже при ACL и участии', () => {
  it('карточка, реестр, версии, вложение — 404; попытка — в аудит', async () => {
    for (const url of [
      `/documents/${secretId}`,
      `/objects/${secretId}`,
      `/documents/${secretId}/versions`,
      `/objects/${secretId}/activity`,
      `/objects/${secretId}/discussion`,
      `/files/${scanId}`,
      `/files/${scanId}/download`,
    ]) {
      expect((await get(fx.users.member, url)).statusCode, url).toBe(404)
    }
    // С допуском — видно
    expect((await get(cleared, `/documents/${secretId}`)).statusCode).toBe(200)
    expect((await get(registrar, `/files/${scanId}`)).statusCode).toBe(200)

    const denied = await auditRows('document.confidential_access', secretId)
    const outcomes = denied
      .filter((row) => row.actor_id === fx.users.member.id)
      .map((row) => row.details.outcome)
    expect(outcomes).toContain('denied')
  })

  it('списки модуля и ядра, пакетная выборка, «Мои» — без документа', async () => {
    for (const url of [
      `/objects?type=document&limit=200`,
      `/objects?limit=200&q=${encodeURIComponent(subject)}`,
      `/objects?types=document,file&limit=200`,
    ]) {
      const list = await get(fx.users.member, url)
      expect(list.statusCode, list.body).toBe(200)
      const ids = list.json().items.map((item: { id: string }) => item.id)
      expect(ids, url).not.toContain(secretId)
      expect(ids, url).not.toContain(scanId)
    }
    const listed = await get(cleared, `/objects?type=document&limit=200`)
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(secretId)

    const batch = await call(fx.app, {
      method: 'POST',
      url: '/objects/batch-get',
      as: fx.users.member,
      payload: { ids: [secretId, scanId] },
    })
    for (const item of batch.json().items as Array<{ accessible: boolean; title: string }>) {
      expect(item.accessible).toBe(false)
      expect(item.title).toBe('')
    }
    const summary = await get(fx.users.member, '/documents/summary')
    expect(summary.json().mine).toBe(0)
  })

  it('поиск: ни документ, ни его скан не находятся без допуска', async () => {
    await indexObject(secretId)
    await indexObject(scanId)
    await waitIndexed(cleared, subject, secretId)
    expect(await searchIds(fx.users.member, subject)).not.toContain(secretId)
    await waitIndexed(registrar, `скан-конфиденциальный-${run}`, scanId)
    expect(await searchIds(fx.users.member, `скан-конфиденциальный-${run}`)).not.toContain(scanId)
    // Администратор вне режима администратора тоже не находит
    expect(await searchIds(fx.admin, subject)).not.toContain(secretId)
  })

  it('связь из доступного объекта — «нет доступа» без названия; комната realtime закрыта', async () => {
    const hub = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Хаб грифа ${run}`, spaceId: fx.spaceId },
    })
    const hubId = hub.json().id as string
    // Связь ставит тот, кто видит документ, — делопроизводитель с правом на хаб
    expect(
      (
        await call(fx.app, {
          method: 'POST',
          url: `/objects/${hubId}/access`,
          as: fx.admin,
          payload: { grants: [{ principal: { type: 'user', id: registrar.id }, level: 'edit' }] },
        })
      ).statusCode,
    ).toBe(200)
    const linked0 = await call(fx.app, {
      method: 'POST',
      url: `/objects/${hubId}/links`,
      as: registrar,
      payload: { targetId: secretId, kind: 'related' },
    })
    expect(linked0.statusCode, linked0.body).toBe(200)
    // Хаб в пространстве, где сотрудник — участник: связь ему видна, документ — нет
    const links = await get(fx.users.member, `/objects/${hubId}/links`)
    expect(links.statusCode, links.body).toBe(200)
    const linked = (
      links.json().links as Array<{ object: { id: string; accessible: boolean; title: string } }>
    ).find((link) => link.object.id === secretId)
    expect(linked?.object).toMatchObject({ accessible: false, title: '' })

    expect(await canJoin(await userCtx(fx.users.member), `object:${secretId}`)).toBe(false)
    expect(await canJoin(await userCtx(cleared), `object:${secretId}`)).toBe(true)
  })

  it('системный датасет, получатели уведомлений, гостевая ссылка', async () => {
    const query = (as: TestUser) =>
      call(fx.app, {
        method: 'POST',
        url: '/queries/run',
        as,
        payload: { spec: { version: 1, source: { kind: 'system', name: 'documents' }, steps: [] } },
      })
    const idsOf = (response: Awaited<ReturnType<typeof query>>) => {
      const body = response.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
      const column = body.fields.findIndex((field) => field.name === 'id')
      return body.rows.map((row) => row[column])
    }
    const forMember = await query(fx.users.member)
    expect(forMember.statusCode, forMember.body).toBe(200)
    expect(idsOf(forMember)).not.toContain(secretId)
    expect(idsOf(await query(cleared))).toContain(secretId)
    expect(idsOf(await query(fx.admin))).not.toContain(secretId)

    const recipients = await usersWithAccess(secretId)
    expect(recipients).not.toContain(fx.users.member.id)
    expect(recipients).toContain(cleared.id)

    const link = await call(fx.app, {
      method: 'POST',
      url: `/objects/${secretId}/share-links`,
      as: registrar,
      payload: {},
    })
    expect(link.statusCode).toBe(422)
  })

  it('уведомления и Входящие по конфиденциальному — только «Документ № …»', async () => {
    await drainOutbox()
    const notifications = await get(cleared, '/notifications')
    expect(notifications.statusCode, notifications.body).toBe(200)
    const items = notifications.json().items as Array<{
      title: string
      object: { id: string; title: string } | null
    }>
    const about = items.filter((item) => item.object?.id === secretId)
    expect(about.length).toBeGreaterThan(0)
    for (const item of about) {
      expect(item.title).not.toContain(subject)
      expect(item.title).toMatch(/Документ № ВХ-/)
      expect(item.object?.title).not.toContain(subject)
    }

    await db().transaction((tx) =>
      InboxService.open(tx, systemCtx('test'), {
        userId: cleared.id,
        kind: 'resolve',
        objectId: secretId,
        titleKey: 'inbox.tpl.resolveDocument',
        params: { title: subject },
      }),
    )
    const inbox = await get(cleared, '/inbox?state=open')
    const item = (
      inbox.json().items as Array<{ title: string; object: { id: string } | null }>
    ).find((entry) => entry.object?.id === secretId)
    expect(item?.title).not.toContain(subject)
  })
})

describe('допуск и гриф меняются — доступ пересчитывается', () => {
  it('допуск выдаёт только администратор системы; с допуском документ виден', async () => {
    expect((await setClearance(fx.users.member, 'secret', registrar)).statusCode).toBe(403)
    expect((await setClearance(fx.users.member, 'confidential')).statusCode).toBe(200)
    expect((await get(fx.users.member, `/documents/${secretId}`)).statusCode).toBe(200)
    expect((await setClearance(fx.users.member, 'internal')).statusCode).toBe(200)
    expect((await get(fx.users.member, `/documents/${secretId}`)).statusCode).toBe(404)

    const changes = await auditRows('user.clearance_changed', fx.users.member.id)
    expect(changes.length).toBeGreaterThanOrEqual(2)

    const users = await get(fx.admin, `/users?q=${fx.users.member.login}`)
    expect(users.json().items[0].clearance).toBe('internal')
    const asEmployee = await get(fx.users.member, `/users?q=${fx.users.member.login}`)
    expect(asEmployee.json().items[0].clearance).toBeUndefined()
  })

  it('гриф поднят — документ пропадает из недавних, карточки и комнаты', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: registrar,
      payload: {
        typeId: types.get('memo'),
        subject: `Сначала служебное ${run}`,
        responsibleId: fx.users.member.id,
      },
    })
    const id = created.json().id as string
    expect((await get(fx.users.member, `/objects/${id}`)).statusCode).toBe(200)
    const recentBefore = await get(fx.users.member, '/me/recent')
    expect(recentBefore.json().items.map((item: { id: string }) => item.id)).toContain(id)

    const raised = await call(fx.app, {
      method: 'PATCH',
      url: `/documents/${id}`,
      as: registrar,
      payload: { confidentiality: 'confidential' },
    })
    expect(raised.statusCode, raised.body).toBe(200)
    expect(raised.json().confidentiality).toBe('confidential')

    expect((await get(fx.users.member, `/documents/${id}`)).statusCode).toBe(404)
    const recentAfter = await get(fx.users.member, '/me/recent')
    expect(recentAfter.json().items.map((item: { id: string }) => item.id)).not.toContain(id)
    expect(await canJoin(await userCtx(fx.users.member), `object:${id}`)).toBe(false)
    const audited = await auditRows('document.confidentiality_changed', id)
    expect(audited).toHaveLength(1)
  })
})

describe('администратор системы и аудитор', () => {
  it('аудитор без допуска конфиденциального не видит', async () => {
    expect((await get(auditor, `/documents/${secretId}`)).statusCode).toBe(404)
  })

  it('администратор — только в режиме администратора с обоснованием; всё в аудит', async () => {
    expect((await get(fx.admin, `/documents/${secretId}`)).statusCode).toBe(404)
    const listBefore = await get(fx.admin, `/objects?type=document&limit=200`)
    expect(listBefore.json().items.map((item: { id: string }) => item.id)).not.toContain(secretId)

    const notAdmin = await call(fx.app, {
      method: 'POST',
      url: '/me/admin-mode',
      as: registrar,
      payload: { reason: 'Проверка обращения гражданина' },
    })
    expect(notAdmin.statusCode).toBe(403)
    const noReason = await call(fx.app, {
      method: 'POST',
      url: '/me/admin-mode',
      as: fx.admin,
      payload: { reason: 'надо' },
    })
    expect(noReason.statusCode).toBe(400)

    const entered = await call(fx.app, {
      method: 'POST',
      url: '/me/admin-mode',
      as: fx.admin,
      payload: { reason: 'Служебная проверка по запросу прокуратуры №15', minutes: 15 },
    })
    expect(entered.statusCode, entered.body).toBe(200)
    const me = await get(fx.admin, '/me')
    expect(me.json().adminMode?.reason).toContain('прокуратуры')

    expect((await get(fx.admin, `/documents/${secretId}`)).statusCode).toBe(200)
    const listed = await get(fx.admin, `/objects?type=document&limit=200`)
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(secretId)
    expect(await canJoin(await userCtx(fx.admin), `object:${secretId}`)).toBe(true)

    const exited = await call(fx.app, { method: 'DELETE', url: '/me/admin-mode', as: fx.admin })
    expect(exited.statusCode).toBe(200)
    expect((await get(fx.admin, `/documents/${secretId}`)).statusCode).toBe(404)
    expect(await canJoin(await userCtx(fx.admin), `object:${secretId}`)).toBe(false)

    const [entry] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM audit_log
           WHERE action = 'admin.mode_entered' AND actor_id = ${fx.admin.id}`,
    )
    expect(entry?.total).toBe(1)
    const access = (await auditRows('document.confidential_access', secretId)).filter(
      (row) => row.actor_id === fx.admin.id,
    )
    expect(access.map((row) => row.details.outcome)).toEqual(
      expect.arrayContaining(['denied', 'admin_mode']),
    )
    const [actions] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM audit_log
           WHERE action = 'admin.mode_action' AND actor_id = ${fx.admin.id}
             AND object_id = ${secretId}`,
    )
    expect(actions?.total).toBeGreaterThanOrEqual(1)
    const [exit] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM audit_log
           WHERE action = 'admin.mode_exited' AND actor_id = ${fx.admin.id}`,
    )
    expect(exit?.total).toBe(1)
  })
})
