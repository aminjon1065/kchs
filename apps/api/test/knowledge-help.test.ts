import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Справка (вопрос N88): пункт открывает страницу базы знаний на языке сотрудника, без
 * неё — русскую; страницу выбирает администратор; сотруднику, которому страница не
 * видна, пункта нет; сид не перебивает выбор администратора.
 */
registerLifecycle()

const { objects, users } = await import('../src/shared/db/schema/index.js')
const { KnowledgeSeed } = await import('../src/modules/knowledge/public.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

async function createPage(title: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/pages',
    as: fx.admin,
    payload: { title, spaceId: fx.spaceId, template: 'blank' },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

const help = async (as: TestUser) => {
  const response = await call(fx.app, { url: '/knowledge/help', as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().page as { id: string; title: string } | null
}

const choose = (payload: Record<string, string | null>, as: TestUser = fx.admin) =>
  call(fx.app, { method: 'PUT', url: '/knowledge/help/pages', as, payload })

describe('справка', () => {
  it('страница по языку, без перевода — русская; посторонний пункта не видит', async () => {
    const ru = await createPage(`Справка ${run}`)
    const tg = await createPage(`Маълумотнома ${run}`)

    expect((await choose({ ru }, fx.users.member)).statusCode).toBe(403)
    const saved = await choose({ ru, tg, en: null })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toEqual({ ru, tg, en: null })

    expect(await help(fx.users.member)).toEqual({ id: ru, title: `Справка ${run}` })
    await db().update(users).set({ locale: 'tg' }).where(eq(users.id, fx.users.member.id))
    expect((await help(fx.users.member))?.id).toBe(tg)
    await db().update(users).set({ locale: 'en' }).where(eq(users.id, fx.users.member.id))
    expect((await help(fx.users.member))?.id).toBe(ru)
    await db().update(users).set({ locale: 'ru' }).where(eq(users.id, fx.users.member.id))

    // Страница в чужом пространстве: пункта нет, а не ошибка при открытии
    expect(await help(fx.users.stranger)).toBeNull()
  })

  it('справкой выбирают только живую страницу базы знаний', async () => {
    const file = await createPage(`Удаляемая ${run}`)
    await db()
      .update(objects)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(objects.id, file))
    const deleted = await choose({ ru: file })
    expect(deleted.statusCode).toBe(400)
    const unknown = await choose({ ru: '01a0d714-896b-7997-b2e7-6d8e9c941735' })
    expect(unknown.statusCode).toBe(400)
  })

  it('сид предлагает корни руководства только языкам без выбора', async () => {
    const current = (await call(fx.app, { url: '/knowledge/help/pages', as: fx.admin })).json()
    const root = await createPage(`How to ${run}`)
    const other = await createPage(`Другой корень ${run}`)
    const set = await db().transaction((tx) =>
      KnowledgeSeed.ensureHelp(tx, systemCtx('test'), { ru: other, en: root }),
    )
    expect(set).toBe(1)
    const after = (await call(fx.app, { url: '/knowledge/help/pages', as: fx.admin })).json()
    expect(after).toEqual({ ...current, en: root })

    const newcomer = await createUser(fx.app, `help_${run}`)
    expect(await help(newcomer)).toBeNull()
  })
})
