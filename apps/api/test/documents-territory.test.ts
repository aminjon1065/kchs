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
 * Вкладка «Документы» паспорта территории (ADR-0158): документ относится к территории
 * или вложенной единице по реквизиту «Территория», по полю-территории карточки типа или
 * по связи «о территории»; смотрящий видит только открытые ему документы.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { TerritoryService } = await import('../src/modules/gis/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const TERRITORIES = (await import('../src/seed/territories.json', { with: { type: 'json' } }))
  .default

const run = Date.now().toString(36)
let fx: TestContext
let registrar: TestUser
let clerk: TestUser
const territory = new Map<string, string>()
const created = new Map<string, string>()

interface Listed {
  items: Array<{ id: string; title: string; territoryId: string; via: string; status: string }>
  total: number
}

const listed = async (as: TestUser, code: string): Promise<Listed> => {
  const response = await call(fx.app, {
    url: `/documents/territory/${territory.get(code)}`,
    as,
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, `registrar_terr_${run}`, ['employee', 'registrar'])
  clerk = await createUser(fx.app, `clerk_terr_${run}`, ['employee'])
  await db().transaction((tx) => TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never))
  await TerritoryService.invalidate()
  for (const item of await TerritoryService.list()) territory.set(item.code, item.id)
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })

  // Тип с полем-территорией карточки — как «Район» донесения о ЧС в пакете
  const types = (await call(fx.app, { url: '/document-types', as: fx.admin })).json()
    .items as Array<{ id: string; key: string }>
  const typeId = types.find((type) => type.key === 'outgoing_letter')?.id as string
  const type = (await call(fx.app, { url: `/document-types/${typeId}`, as: fx.admin })).json()
  const patched = await call(fx.app, {
    method: 'PATCH',
    url: `/document-types/${typeId}`,
    as: fx.admin,
    payload: {
      cardSchema: {
        ...type.cardSchema,
        fields: [
          ...(type.cardSchema?.fields ?? []),
          { key: 'district', label: { ru: 'Район' }, type: 'territory', semantic: 'territory' },
        ],
      },
    },
  })
  expect(patched.statusCode, patched.body).toBe(200)

  const create = async (key: string, payload: Record<string, unknown>) => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: registrar,
      payload: { typeId, subject: `${key} ${run}`, ...payload },
    })
    expect(response.statusCode, response.body).toBe(200)
    created.set(key, response.json().id as string)
  }
  await create('Реквизит', { territoryId: territory.get('TJ-KT-10'), responsibleId: clerk.id })
  await create('Поле карточки', { fields: { district: territory.get('TJ-KT-13') } })
  await create('Связь', {})
  await create('Другая область', { territoryId: territory.get('TJ-SU-01') })
  const linked = await call(fx.app, {
    method: 'POST',
    url: `/objects/${created.get('Связь')}/links`,
    as: registrar,
    payload: { targetId: territory.get('TJ-KT-01'), kind: 'about_territory' },
  })
  expect(linked.statusCode, linked.body).toBe(200)
})

describe('документы территории (ADR-0158)', () => {
  it('реквизит, поле карточки и связь — с вложенными единицами области', async () => {
    const region = await listed(registrar, 'TJ-KT')
    const byId = new Map(region.items.map((item) => [item.id, item]))
    expect(byId.get(created.get('Реквизит') as string)).toMatchObject({
      via: 'card',
      territoryId: territory.get('TJ-KT-10'),
      status: 'draft',
    })
    expect(byId.get(created.get('Поле карточки') as string)).toMatchObject({
      via: 'field',
      territoryId: territory.get('TJ-KT-13'),
    })
    expect(byId.get(created.get('Связь') as string)).toMatchObject({
      via: 'link',
      territoryId: territory.get('TJ-KT-01'),
    })
    expect(byId.has(created.get('Другая область') as string)).toBe(false)
    expect(region.total).toBe(region.items.length)

    // Район — только свои документы
    const district = await listed(registrar, 'TJ-KT-10')
    expect(district.items.map((item) => item.id)).toEqual([created.get('Реквизит')])
  })

  it('права — по каждому документу: сотрудник видит только документ, где он ответственный', async () => {
    const region = await listed(clerk, 'TJ-KT')
    expect(region.items.map((item) => item.id)).toEqual([created.get('Реквизит')])
    expect(region.total).toBe(1)
  })

  it('неизвестная территория — 404', async () => {
    const response = await call(fx.app, {
      url: '/documents/territory/00000000-0000-7000-8000-000000000000',
      as: registrar,
    })
    expect(response.statusCode).toBe(404)
  })
})
