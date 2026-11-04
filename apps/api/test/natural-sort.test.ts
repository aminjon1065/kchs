import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Человеческий порядок списков (ADR-0229): база создана с C.UTF-8, и строки шли по
 * байтам — «Ёров» перед «Абдуллоевым», буквы Ғ, Қ, Ӯ, Ҷ после «Я», «№ 10» перед «№ 2».
 * Списки сортируют коллацией `kchs_natural` (ICU, таджикский, числа по значению).
 */
registerLifecycle()

const { UserService } = await import('../src/kernel/directory/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
const run = Date.now().toString(36)

/** Фамилии в ожидаемом порядке: Ғ после Г, Ё рядом с Е, Қ после К, Ӯ после У, Ҷ после Ч. */
const SURNAMES = [
  'Абдуллоев',
  'Гулов',
  'Ғафуров',
  'Ёров',
  'Ершов',
  'Кадыров',
  'Қодиров',
  'Убайдуллоев',
  'Ӯлмасов',
  'Чориев',
  'Ҷураев',
  'Яхёев',
]

beforeAll(async () => {
  fx = await setupFixture()
  const ctx = systemCtx('test')
  // Создаются вразнобой: порядок выдачи не должен зависеть от порядка вставки
  for (const lastName of [...SURNAMES].reverse()) {
    const login = `sort_${run}_${SURNAMES.indexOf(lastName)}`
    const { id } = await db().transaction((tx) =>
      UserService.create(tx, ctx, {
        login,
        email: `${login}@test.local`,
        lastName,
        firstName: run,
        roleKeys: ['employee'],
        password: 'Sort!Password-2026-x',
        mustChangePassword: false,
        locale: 'ru',
        timezone: 'Asia/Dushanbe',
        unitId: null,
      }),
    )
    const joined = await call(fx.app, {
      method: 'POST',
      url: `/spaces/${fx.spaceId}/members`,
      as: fx.admin,
      payload: { userId: id, role: 'viewer' },
    })
    expect(joined.statusCode, joined.body).toBe(200)
  }
})

const surnames = (names: string[]) =>
  names.filter((name) => name.endsWith(` ${run}`)).map((name) => name.split(' ')[0])

describe('человеческий порядок (ADR-0229)', () => {
  it('люди: участники пространства и поиск для пикеров — по алфавиту с таджикскими буквами', async () => {
    const members = await call(fx.app, { url: `/spaces/${fx.spaceId}/members`, as: fx.admin })
    expect(members.statusCode, members.body).toBe(200)
    const listed = members.json().items as Array<{ displayName: string }>
    expect(surnames(listed.map((member) => member.displayName))).toEqual(SURNAMES)

    const found = await call(fx.app, {
      url: `/principals/search?q=${run}&types=user&limit=50`,
      as: fx.admin,
    })
    expect(found.statusCode, found.body).toBe(200)
    const refs = found.json().items as Array<{ title: string }>
    expect(surnames(refs.map((ref) => ref.title))).toEqual(SURNAMES)
  })

  it('названия с номерами в списке объектов — числа по значению', async () => {
    const titles = ['№ 100', '№ 12/10', '№ 2', '№ 12/3', '№ 10', '№ 1']
    for (const name of titles) {
      const created = await call(fx.app, {
        method: 'POST',
        url: '/folders',
        as: fx.admin,
        payload: { name: `${name} ${run}`, spaceId: fx.spaceId },
      })
      expect(created.statusCode, created.body).toBe(200)
    }
    const listed = await call(fx.app, {
      url: `/objects?type=folder&q=${run}&sort=title&limit=50`,
      as: fx.admin,
    })
    expect(listed.statusCode, listed.body).toBe(200)
    const order = (listed.json().items as Array<{ title: string }>).map((item) =>
      item.title.replace(` ${run}`, ''),
    )
    expect(order).toEqual(['№ 1', '№ 2', '№ 10', '№ 12/3', '№ 12/10', '№ 100'])
  })
})
