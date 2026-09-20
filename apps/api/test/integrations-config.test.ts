import { inArray } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Объект `integration` и пакет конфигурации (P5-E06, ADR-0097).
 * Главная проверка — секреты не покидают установку: ни в ответе, ни в событии,
 * ни в аудите, ни в переносимом пакете (17-security.md §4).
 */
registerLifecycle()

const { auditLog, outbox } = await import('../src/shared/db/schema/index.js')

const SECRET = 'S3cret-значение-которого-никто-не-должен-увидеть'

let fx: TestContext
let integrationId = ''

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/integrations',
    as: fx.admin,
    payload: {
      key: 'external-api',
      kind: 'http',
      name: 'Внешний сервис',
      config: { url: 'https://example.org/api' },
      secrets: { token: SECRET },
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  integrationId = created.json().id
})

describe('интеграции', () => {
  it('в списке есть встроенные службы установки только для чтения', async () => {
    const response = await call(fx.app, { url: '/integrations', as: fx.admin })
    expect(response.statusCode).toBe(200)
    const items = response.json().items as Array<{ key: string; source: string }>
    const smtp = items.find((item) => item.key === 'smtp')
    const telegram = items.find((item) => item.key === 'telegram')
    expect(smtp?.source).toBe('env')
    expect(telegram?.source).toBe('env')
    expect(items.some((item) => item.key === 'external-api' && item.source === 'object')).toBe(true)
  })

  it('секреты не возвращаются наружу — только имена', async () => {
    const card = await call(fx.app, { url: `/integrations/${integrationId}`, as: fx.admin })
    expect(card.statusCode).toBe(200)
    expect(card.body).not.toContain(SECRET)
    expect(card.json().secretKeys).toEqual(['token'])

    const list = await call(fx.app, { url: '/integrations', as: fx.admin })
    expect(list.body).not.toContain(SECRET)
  })

  it('секреты не попадают ни в события, ни в аудит', async () => {
    const events = await db()
      .select({ event: outbox.event })
      .from(outbox)
      .where(inArray(outbox.type, ['integration.created', 'integration.updated']))
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain(SECRET)

    const entries = await db()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(inArray(auditLog.action, ['integration.created', 'integration.updated']))
    expect(entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })

  it('обновление секрета не раскрывает ни старое, ни новое значение', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: `/integrations/${integrationId}`,
      as: fx.admin,
      payload: { secrets: { token: 'новое-значение-секрета' } },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.body).not.toContain('новое-значение-секрета')
    expect(response.json().secretKeys).toEqual(['token'])
  })

  it('сотрудник без способности `automation.manage` список не видит', async () => {
    const response = await call(fx.app, { url: '/integrations', as: fx.users.member })
    expect(response.statusCode).toBe(403)
  })

  it('проверка соединения записывает статус и не раскрывает секрет', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: `/integrations/${integrationId}/check`,
      as: fx.admin,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.body).not.toContain(SECRET)
    expect(typeof response.json().ok).toBe('boolean')
  })

  it('встроенная служба проверяется отдельным маршрутом, неизвестная — 404', async () => {
    const smtp = await call(fx.app, {
      method: 'POST',
      url: '/integrations/builtin/smtp/check',
      as: fx.admin,
    })
    expect(smtp.statusCode, smtp.body).toBe(200)

    const unknown = await call(fx.app, {
      method: 'POST',
      url: '/integrations/builtin/unknown/check',
      as: fx.admin,
    })
    expect(unknown.statusCode).toBe(404)
  })
})

describe('пакет конфигурации', () => {
  async function exportPackage(sections: string[]) {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/config/export',
      as: fx.admin,
      payload: { sections },
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json()
  }

  async function preview(pkg: unknown) {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/config/import/preview',
      as: fx.admin,
      payload: { package: pkg },
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json()
  }

  it('перечисляет разделы, которые установка умеет переносить', async () => {
    const response = await call(fx.app, { url: '/config/sections', as: fx.admin })
    expect(response.statusCode).toBe(200)
    const items = response.json().items as string[]
    expect(items).toContain('integrations')
    expect(items).toContain('webhooks')
    expect(items).toContain('processDefinitions')
  })

  it('выгружает записи по стабильным ключам и без секретов', async () => {
    const pkg = await exportPackage(['integrations'])
    expect(pkg.version).toBe(1)
    const item = (pkg.items as Array<{ key: string; data: Record<string, unknown> }>).find(
      (entry) => entry.key === 'external-api',
    )
    expect(item, 'интеграция попала в пакет').toBeDefined()
    // Ключ, а не UUID
    expect(JSON.stringify(pkg)).not.toContain(integrationId)
    expect(JSON.stringify(pkg)).not.toContain(SECRET)
    expect(item?.data.requiredSecrets).toEqual(['token'])
    // Встроенные службы окружения в пакет не едут
    expect((pkg.items as Array<{ key: string }>).some((entry) => entry.key === 'smtp')).toBe(false)
  })

  it('предпросмотр в том же контуре не находит различий', async () => {
    const pkg = await exportPackage(['integrations'])
    const diff = await preview(pkg)
    expect(diff.counts.changed).toBe(0)
    expect(diff.counts.new).toBe(0)
    expect(diff.entries.every((entry: { status: string }) => entry.status === 'same')).toBe(true)
  })

  it('различие показывается до применения и применяется по выбору', async () => {
    const pkg = await exportPackage(['integrations'])
    const changed = {
      ...pkg,
      items: (pkg.items as Array<Record<string, unknown>>).map((item) => ({
        ...item,
        data: { ...(item.data as Record<string, unknown>), description: 'из другого контура' },
      })),
      // Пакет выгружен позже локальной правки — конфликта нет
      exportedAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const diff = await preview(changed)
    expect(diff.counts.changed).toBe(1)
    expect(diff.entries[0].changedFields).toContain('description')

    const applied = await call(fx.app, {
      method: 'POST',
      url: '/config/import',
      as: fx.admin,
      payload: { package: changed, only: ['integrations:external-api'] },
    })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(applied.json().applied).toEqual([
      { section: 'integrations', key: 'external-api', action: 'updated' },
    ])

    const card = await call(fx.app, { url: `/integrations/${integrationId}`, as: fx.admin })
    expect(card.json().description).toBe('из другого контура')
    // Секрет пережил импорт: пакет его не вёз и не стирал
    expect(card.json().secretKeys).toEqual(['token'])
  })

  it('запись, изменённая здесь после выгрузки, помечается конфликтом', async () => {
    const pkg = await exportPackage(['integrations'])
    const stale = {
      ...pkg,
      // Пакет «старый»: локальная правка новее
      exportedAt: new Date(Date.now() - 3_600_000).toISOString(),
      items: (pkg.items as Array<Record<string, unknown>>).map((item) => ({
        ...item,
        data: { ...(item.data as Record<string, unknown>), description: 'старое описание' },
      })),
    }
    const diff = await preview(stale)
    expect(diff.counts.conflict).toBe(1)

    const skipped = await call(fx.app, {
      method: 'POST',
      url: '/config/import',
      as: fx.admin,
      payload: { package: stale },
    })
    expect(skipped.statusCode, skipped.body).toBe(200)
    expect(skipped.json().applied).toEqual([])
    expect(skipped.json().skipped[0].reason).toBe('conflict')

    const forced = await call(fx.app, {
      method: 'POST',
      url: '/config/import',
      as: fx.admin,
      payload: { package: stale, overwriteConflicts: true },
    })
    expect(forced.statusCode, forced.body).toBe(200)
    expect(forced.json().applied).toHaveLength(1)
  })

  it('новая запись заводится выключенной: секретов в пакете нет', async () => {
    const pkg = await exportPackage(['integrations'])
    const fresh = {
      ...pkg,
      items: [
        {
          section: 'integrations',
          key: 'from-other-stand',
          title: 'Из другого контура',
          updatedAt: null,
          data: {
            name: 'Из другого контура',
            kind: 'http',
            config: { url: 'https://example.org' },
          },
        },
      ],
    }
    const diff = await preview(fresh)
    expect(diff.counts.new).toBe(1)

    const applied = await call(fx.app, {
      method: 'POST',
      url: '/config/import',
      as: fx.admin,
      payload: { package: fresh },
    })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(applied.json().applied[0].action).toBe('created')

    const list = await call(fx.app, { url: '/integrations', as: fx.admin })
    const created = (list.json().items as Array<{ key: string; enabled: boolean }>).find(
      (item) => item.key === 'from-other-stand',
    )
    expect(created?.enabled).toBe(false)
  })

  it('пакет доступен только администратору системы', async () => {
    for (const as of [fx.users.member, fx.users.stranger]) {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/config/export',
        as,
        payload: { sections: ['integrations'] },
      })
      expect(response.statusCode).toBe(403)
    }
  })
})
