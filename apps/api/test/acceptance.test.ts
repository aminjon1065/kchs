import { authenticator } from 'otplib'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Сценарии приёмки фазы 0 (04-delivery/04-verification.md §3).
 * Каждый тест повторяет пользовательский сценарий целиком через HTTP API.
 */
registerLifecycle()

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

const PASSWORD = 'Test!Password-2026-x'

async function drainOutbox(): Promise<number> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  // Подписчики ядра регистрируются композиционным корнем, а не приложением
  if (listSubscribers().length === 0) {
    const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
    registerKernelSubscribers()
  }
  const { sql } = await import('drizzle-orm')

  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 500`,
  )

  let delivered = 0
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (!matchesType(subscriber.types, event.type)) continue
      await subscriber.handle(event as never)
      delivered += 1
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
  return delivered
}

describe('сценарий 1: администратор заводит подразделение, пользователя и роль, вход с MFA', () => {
  it('подразделение и пользователь создаются через API администрирования', async () => {
    const unit = await call(fx.app, {
      method: 'POST',
      url: '/org/units',
      as: fx.admin,
      payload: {
        code: `ACC-${Date.now()}`,
        name: { ru: 'Отдел приёмки' },
        kind: 'department',
        createSpace: true,
      },
    })
    expect(unit.statusCode).toBe(200)

    const login = `acc${Date.now().toString().slice(-8)}`
    const created = await call(fx.app, {
      method: 'POST',
      url: '/users',
      as: fx.admin,
      payload: {
        login,
        email: `${login}@test.local`,
        lastName: 'Приёмкин',
        firstName: 'Пётр',
        unitId: unit.json().id,
        roleKeys: ['data_steward'],
        password: PASSWORD,
        mustChangePassword: false,
      },
    })
    expect(created.statusCode).toBe(200)

    const signIn = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login, password: PASSWORD },
    })
    expect(signIn.statusCode).toBe(200)
    expect(signIn.json().status).toBe('ok')

    const cookie = String(signIn.headers['set-cookie'])
      .split(';')
      .find((part) => part.includes('kchs_session='))
      ?.trim()

    const me = await call(fx.app, { url: '/me', headers: { cookie: cookie ?? '' } })
    expect(me.statusCode).toBe(200)
    expect(me.json().roles).toContain('data_steward')
    // Личное пространство создаётся вместе с пользователем
    expect(me.json().personalSpaceId).toBeTruthy()
  })

  it('MFA включается и требуется при следующем входе', async () => {
    const user = fx.users.viewer

    const setup = await call(fx.app, { method: 'POST', url: '/me/mfa/setup', as: user })
    expect(setup.statusCode).toBe(200)
    const secret = setup.json().secret as string
    expect(secret.length).toBeGreaterThan(10)

    const enable = await call(fx.app, {
      method: 'POST',
      url: '/me/mfa/enable',
      as: user,
      payload: { code: authenticator.generate(secret) },
    })
    expect(enable.statusCode).toBe(200)
    expect(enable.json().codes.length).toBeGreaterThan(0)

    const first = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: user.login, password: PASSWORD },
    })
    expect(first.json().status).toBe('mfa_required')

    const mfaCookie = String(first.headers['set-cookie'])
      .split(';')
      .find((part) => part.includes('kchs_mfa='))
      ?.trim()
    expect(mfaCookie).toBeTruthy()

    // Код включения уже использован (повтор отклоняется) — берём код следующего шага
    const nextCode = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret)
    const verify = await call(fx.app, {
      method: 'POST',
      url: '/auth/mfa/verify',
      headers: { cookie: mfaCookie ?? '' },
      payload: { challengeId: first.json().challengeId, code: nextCode },
    })
    expect(verify.statusCode).toBe(200)
    expect(verify.json().csrfToken).toBeTruthy()

    // Неверный код не пускает
    const wrong = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: user.login, password: PASSWORD },
    })
    const wrongCookie = String(wrong.headers['set-cookie'])
      .split(';')
      .find((part) => part.includes('kchs_mfa='))
      ?.trim()
    const bad = await call(fx.app, {
      method: 'POST',
      url: '/auth/mfa/verify',
      headers: { cookie: wrongCookie ?? '' },
      payload: { challengeId: wrong.json().challengeId, code: '000000' },
    })
    expect(bad.statusCode).toBeGreaterThanOrEqual(400)

    // Возвращаем пользователя в исходное состояние для других тестов:
    // коды TOTP текущего окна уже использованы — отключаем кодом восстановления
    const disable = await call(fx.app, {
      method: 'DELETE',
      url: '/me/mfa',
      as: user,
      payload: { code: enable.json().codes[0] },
    })
    expect(disable.json().ok).toBe(true)
  })
})

describe('сценарий 2: пространство проекта и приглашение коллеги редактором', () => {
  it('владелец создаёт пространство, участник получает edit', async () => {
    const space = await call(fx.app, {
      method: 'POST',
      url: '/spaces',
      as: fx.admin,
      payload: {
        key: `proj-${Date.now().toString().slice(-8)}`,
        name: 'Проект',
        kind: 'team',
        description: 'Приёмка фазы 0',
      },
    })
    expect(space.statusCode).toBe(200)
    const spaceId = space.json().id

    const invite = await call(fx.app, {
      method: 'POST',
      url: `/spaces/${spaceId}/members`,
      as: fx.admin,
      payload: { userId: fx.users.stranger.id, role: 'editor' },
    })
    expect(invite.statusCode).toBe(200)
    await redis().del(`kchs:principals:${fx.users.stranger.id}`)

    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.users.stranger,
      payload: { name: 'Материалы', spaceId },
    })
    expect(folder.statusCode).toBe(200)

    const card = await call(fx.app, {
      url: `/objects/${folder.json().id}`,
      as: fx.users.stranger,
    })
    expect(card.json().level).toBe('owner')

    const forOther = await call(fx.app, {
      url: `/objects/${folder.json().id}`,
      as: fx.users.member,
    })
    expect(forOther.statusCode).toBe(404)
  })
})

describe('сценарий 3: файл, обсуждение с упоминанием, уведомление и письмо', () => {
  it('упоминание доходит до уведомлений и попадает в дайджест', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Документы приёмки', spaceId: fx.spaceId },
    })
    const folderId = folder.json().id

    const message = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/discussion/messages`,
      as: fx.admin,
      payload: {
        body: { type: 'doc', content: [] },
        text: 'Коллега, посмотрите материалы',
        attachments: [],
        mentions: [fx.users.member.id, fx.users.stranger.id],
        mentionedObjectIds: [],
      },
    })
    expect(message.statusCode).toBe(200)

    await drainOutbox()

    // Посторонний упомянут, но папку не видит: уведомление раскрыло бы её название
    const { sql: rawSql } = await import('drizzle-orm')
    const leaked = await db().execute<{ count: number }>(
      rawSql`SELECT count(*)::int AS count FROM notifications
              WHERE user_id = ${fx.users.stranger.id} AND object_id = ${folderId}`,
    )
    expect(leaked[0]?.count).toBe(0)

    const list = await call(fx.app, { url: '/notifications', as: fx.users.member })
    expect(list.statusCode).toBe(200)
    const mention = list
      .json()
      .items.find((item: { category: string }) => item.category === 'mention')
    expect(mention).toBeTruthy()
    expect(mention.title).toContain('упомянул')

    // Канал e-mail выбран по умолчанию для категории mention
    const { sql } = await import('drizzle-orm')
    const rows = await db().execute<{ id: number; channels: string[]; emailed_at: string | null }>(
      sql`SELECT id, channels, emailed_at FROM notifications
           WHERE user_id = ${fx.users.member.id} AND category = 'mention'
           ORDER BY id DESC LIMIT 1`,
    )
    expect(rows[0]?.channels).toContain('email')

    // Доставка почтой: категория mention отправляется немедленно.
    // Без SMTP уведомление не теряется — остаётся в очереди дайджеста.
    const { deliverEmail, sendEmailDigest } = await import('../src/kernel/notifications/service.js')
    const { mailConfigured } = await import('../src/shared/mail/index.js')

    if (mailConfigured()) {
      expect(rows[0]?.emailed_at).not.toBeNull()
      // Повторная доставка того же уведомления ничего не отправляет
      expect(await deliverEmail([rows[0]!.id])).toBe(0)
    } else {
      expect(rows[0]?.emailed_at).toBeNull()
      // Без SMTP дайджест ничего не отправляет и пометку не ставит
      expect(await sendEmailDigest(0)).toBe(0)
      const after = await db().execute<{ emailed_at: string | null }>(
        sql`SELECT emailed_at FROM notifications WHERE id = ${rows[0]!.id}`,
      )
      expect(after[0]?.emailed_at).toBeNull()
    }
  })
})

describe('сценарий 4: разрыв наследования, гостевая ссылка с паролем, посторонний', () => {
  it('ссылка с паролем открывается только с паролем, посторонний получает 404', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Закрытая папка', spaceId: fx.spaceId },
    })
    const folderId = folder.json().id

    // До разрыва наследования редактор пространства видит папку
    expect(
      (await call(fx.app, { url: `/objects/${folderId}`, as: fx.users.member })).statusCode,
    ).toBe(200)

    const mode = await call(fx.app, {
      method: 'PUT',
      url: `/objects/${folderId}/access-mode`,
      as: fx.admin,
      payload: { mode: 'restricted' },
    })
    expect(mode.statusCode).toBe(200)

    // Права скопированы явно: кто видел — видит
    expect(
      (await call(fx.app, { url: `/objects/${folderId}`, as: fx.users.member })).statusCode,
    ).toBe(200)
    // Посторонний не видит
    expect(
      (await call(fx.app, { url: `/objects/${folderId}`, as: fx.users.stranger })).statusCode,
    ).toBe(404)

    const link = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/share-links`,
      as: fx.admin,
      payload: { level: 'view', password: 'guest-pass-2026', includeAttachments: true },
    })
    expect(link.statusCode).toBe(200)
    const token = link.json().token as string

    // Без пароля — только признак «нужен пароль», без раскрытия объекта
    const locked = await call(fx.app, { method: 'POST', url: `/share/${token}/open`, payload: {} })
    expect(locked.statusCode).toBe(200)
    expect(locked.json().requiresPassword).toBe(true)
    expect(locked.json().objectId).toBeNull()
    expect(locked.json().accessToken).toBeNull()

    const wrong = await call(fx.app, {
      method: 'POST',
      url: `/share/${token}/open`,
      payload: { password: 'нет' },
    })
    expect(wrong.statusCode).toBe(401)

    const opened = await call(fx.app, {
      method: 'POST',
      url: `/share/${token}/open`,
      payload: { password: 'guest-pass-2026' },
    })
    expect(opened.statusCode).toBe(200)
    expect(opened.json().objectId).toBe(folderId)
    expect(opened.json().watermark).toBeTruthy()

    const guestToken = opened.json().accessToken as string
    const guestView = await call(fx.app, {
      url: `/objects/${folderId}`,
      headers: { 'x-kchs-share-token': guestToken },
    })
    expect(guestView.statusCode).toBe(200)
    expect(guestView.json().level).toBe('view')

    // Гость не выходит за пределы объекта
    const other = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: { 'x-kchs-share-token': guestToken },
    })
    expect(other.statusCode).toBe(404)

    // Открытие записано в аудит
    const { sql } = await import('drizzle-orm')
    const audit = await db().execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM audit_log
           WHERE action = 'share_link.opened' AND object_id = ${folderId}`,
    )
    expect(Number(audit[0]?.count ?? 0)).toBeGreaterThan(0)

    // Отзыв ссылки закрывает доступ
    const revoke = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${folderId}/share-links/${link.json().id}`,
      as: fx.admin,
    })
    expect(revoke.statusCode).toBe(200)

    const afterRevoke = await call(fx.app, {
      url: `/objects/${folderId}`,
      headers: { 'x-kchs-share-token': guestToken },
    })
    expect(afterRevoke.statusCode).toBe(401)
  })
})

describe('сценарий 6: замещение и действия «от имени»', () => {
  it('заместитель видит делегированный элемент и действует от имени', async () => {
    const principal = fx.users.member
    const deputy = fx.users.stranger

    const delegation = await call(fx.app, {
      method: 'POST',
      url: '/me/delegations',
      as: principal,
      payload: {
        toUserId: deputy.id,
        scope: 'all',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        note: 'Отпуск',
      },
    })
    expect(delegation.statusCode).toBe(200)
    await redis().del(`kchs:principals:${deputy.id}`)

    // Элемент Входящих делегирующего дублируется заместителю
    const { InboxService } = await import('../src/kernel/inbox/service.js')
    const { systemCtx } = await import('../src/shared/context.js')
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'На ознакомление', spaceId: fx.spaceId },
    })
    await db().transaction((tx) =>
      InboxService.open(tx, systemCtx('test'), {
        userId: principal.id,
        kind: 'acknowledge',
        objectId: folder.json().id,
        titleKey: 'inbox.kind.acknowledge',
      }),
    )

    const deputyInbox = await call(fx.app, { url: '/inbox?scope=delegated', as: deputy })
    expect(deputyInbox.statusCode).toBe(200)
    expect(deputyInbox.json().items.length).toBeGreaterThan(0)
    expect(deputyInbox.json().items[0].onBehalfOf).toBeTruthy()

    // Действие «от имени»: заголовок принимается только в рамках замещения
    const acting = await call(fx.app, {
      url: '/me',
      as: deputy,
      headers: { 'x-kchs-on-behalf-of': principal.id },
    })
    expect(acting.statusCode).toBe(200)
    expect(acting.json().session.onBehalfOf).toBe(principal.id)
    expect(acting.json().actingFor.length).toBeGreaterThan(0)

    // Действие «от имени» в аудите: заместителю выдан manage на объекте
    const folderId = folder.json().id
    const grant = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: deputy.id }, level: 'manage' }],
      },
    })
    expect(grant.statusCode).toBe(200)
    await redis().del(`kchs:principals:${deputy.id}`)

    const link = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/share-links`,
      as: deputy,
      headers: { 'x-kchs-on-behalf-of': principal.id },
      payload: { level: 'view', includeAttachments: false },
    })
    expect(link.statusCode).toBe(200)

    // Чужое замещение не принимается
    const foreign = await call(fx.app, {
      url: '/me',
      as: fx.admin,
      headers: { 'x-kchs-on-behalf-of': principal.id },
    })
    expect(foreign.statusCode).toBe(403)

    // Аудит содержит обе стороны: кто сделал и от чьего имени
    const { sql } = await import('drizzle-orm')
    const rows = await db().execute<{ actor_id: string; on_behalf_of: string }>(
      sql`SELECT actor_id, on_behalf_of FROM audit_log
           WHERE action = 'share_link.created' AND object_id = ${folderId}
           ORDER BY occurred_at DESC LIMIT 1`,
    )
    expect(rows[0]?.actor_id).toBe(deputy.id)
    expect(rows[0]?.on_behalf_of).toBe(principal.id)
  })
})

describe('сценарий 7: устойчивость — событие не теряется, задание повторяется', () => {
  it('сбой подписчика не подтверждает обработку события', async () => {
    const { registerSubscriber, clearSubscribers, listSubscribers } = await import(
      '../src/kernel/events/bus.js'
    )
    const before = [...listSubscribers()]
    let calls = 0

    clearSubscribers()
    registerSubscriber({
      name: 'test-flaky',
      types: ['object.created'],
      handle: async () => {
        calls += 1
        if (calls === 1) throw new Error('сбой подписчика')
      },
    })

    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Устойчивость', spaceId: fx.spaceId },
    })
    expect(folder.statusCode).toBe(200)

    const { sql } = await import('drizzle-orm')
    const rows = await db().execute<{ id: number; event: { type: string; id: string } }>(
      sql`SELECT id, event FROM ops.outbox
           WHERE event->'object'->>'id' = ${folder.json().id} AND type = 'object.created'`,
    )
    expect(rows.length).toBe(1)
    const event = rows[0]!.event

    const subscriber = listSubscribers()[0]!
    await expect(subscriber.handle(event as never)).rejects.toThrow('сбой подписчика')

    // Повторная доставка проходит: обработчик идемпотентен, событие не потеряно
    await expect(subscriber.handle(event as never)).resolves.toBeUndefined()
    expect(calls).toBe(2)

    clearSubscribers()
    for (const item of before) registerSubscriber(item)
  })

  it('упавшее задание фиксирует ошибку и повторяется', async () => {
    const { JobService } = await import('../src/kernel/jobs/service.js')
    const { systemCtx } = await import('../src/shared/context.js')

    const id = await JobService.enqueue(systemCtx('test'), {
      queue: 'maintenance',
      name: 'test.echo',
      data: { value: 1 },
    })

    await JobService.start(id)
    await JobService.fail(id, new Error('воркер остановлен'))

    const failed = await JobService.get(id)
    expect(failed?.status).toBe('failed')
    expect(failed?.attempts).toBe(1)
    expect((failed?.error as { message?: string })?.message).toContain('воркер остановлен')

    // Повтор увеличивает счётчик попыток и возвращает задание в работу
    await JobService.start(id)
    const retried = await JobService.get(id)
    expect(retried?.status).toBe('running')
    expect(retried?.attempts).toBe(2)

    await JobService.finish(id, { ok: true })
    expect((await JobService.get(id))?.status).toBe('succeeded')
  })
})
