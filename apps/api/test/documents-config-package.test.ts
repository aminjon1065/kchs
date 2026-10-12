import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Стабильные ключи журналов и шаблонов и перенос справочников документооборота пакетом
 * конфигурации (ADR-0206, вопрос N42): ключ по названию, правка ключа в справочнике,
 * выгрузка без UUID, ссылки ключами, порядок применения и второй проход ссылок.
 */
registerLifecycle()

const { ensureStarterSet } = await import('../src/modules/documents/domain/starter-set.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext

interface Item {
  section: string
  key: string
  title: string
  updatedAt: string | null
  data: Record<string, unknown>
}

beforeAll(async () => {
  fx = await setupFixture()
  await ensureStarterSet(systemCtx('test', { initiatorId: fx.admin.id }))
})

async function exportPackage(sections: string[]) {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/config/export',
    as: fx.admin,
    payload: { sections },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { items: Item[]; [key: string]: unknown }
}

async function journals() {
  const response = await call(fx.app, { url: '/journals?includeInactive=true', as: fx.admin })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items as Array<{
    id: string
    key: string
    name: string
    typeIds: string[]
  }>
}

describe('ключ журнала (N42)', () => {
  it('стартовые журналы — со своими ключами', async () => {
    const keys = (await journals()).map((journal) => journal.key)
    expect(keys).toEqual(expect.arrayContaining(['incoming', 'outgoing', 'orders', 'appeals']))
  })

  it('без ключа — транслитерация названия, повтор — с суффиксом', async () => {
    const create = (name: string) =>
      call(fx.app, { method: 'POST', url: '/journals', as: fx.admin, payload: { name } })
    const first = await create('Журнал ЧС № 1')
    expect(first.statusCode, first.body).toBe(200)
    const second = await create('Журнал ЧС № 1')
    expect(second.statusCode, second.body).toBe(200)
    const byId = new Map((await journals()).map((journal) => [journal.id, journal.key]))
    expect(byId.get(first.json().id)).toBe('zhurnal_chs_1')
    expect(byId.get(second.json().id)).toBe('zhurnal_chs_1_2')
  })

  it('ключ правится в справочнике; занятый и неверный отклоняются', async () => {
    const [journal] = (await journals()).filter((item) => item.key === 'zhurnal_chs_1_2')
    const patch = (key: string) =>
      call(fx.app, {
        method: 'PATCH',
        url: `/journals/${journal?.id}`,
        as: fx.admin,
        payload: { key },
      })
    expect((await patch('incoming')).statusCode).toBe(409)
    expect((await patch('Плохой ключ')).statusCode).toBe(400)
    const ok = await patch('emergency_reports')
    expect(ok.statusCode, ok.body).toBe(200)
    const card = await call(fx.app, { url: `/journals/${journal?.id}`, as: fx.admin })
    expect(card.json().key).toBe('emergency_reports')
  })
})

describe('пакет конфигурации: журналы, типы, шаблоны (ADR-0206)', () => {
  it('разделы объявлены установкой', async () => {
    const response = await call(fx.app, { url: '/config/sections', as: fx.admin })
    const items = response.json().items as string[]
    expect(items).toEqual(
      expect.arrayContaining(['journals', 'documentTypes', 'documentTemplates']),
    )
  })

  it('выгрузка ссылается ключами, а не UUID; файл шаблона едет с хэшем', async () => {
    const pkg = await exportPackage(['journals', 'documentTypes', 'documentTemplates'])
    const all = await journals()
    const text = JSON.stringify(pkg)
    for (const journal of all) expect(text).not.toContain(journal.id)

    const letter = pkg.items.find(
      (item) => item.section === 'documentTypes' && item.key === 'outgoing_letter',
    )
    expect(letter?.data.numbering).toMatchObject({ journalKey: 'outgoing' })
    const template = pkg.items.find((item) => item.section === 'documentTemplates')
    expect(template?.data.typeKey).toBe('outgoing_letter')
    const file = template?.data.file as { sha256: string; content: string } | null
    expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(file?.content.length).toBeGreaterThan(100)
  })

  it('в том же контуре различий нет', async () => {
    const pkg = await exportPackage(['journals', 'documentTypes', 'documentTemplates'])
    const response = await call(fx.app, {
      method: 'POST',
      url: '/config/import/preview',
      as: fx.admin,
      payload: { package: pkg },
    })
    expect(response.statusCode, response.body).toBe(200)
    const counts = response.json().counts
    expect(counts.changed + counts.new + counts.conflict + counts.unsupported).toBe(0)
  })

  it('новые записи другого контура заводятся с местными ссылками, порядок файла не важен', async () => {
    const pkg = await exportPackage(['journals', 'documentTypes', 'documentTemplates'])
    const journal = pkg.items.find((item) => item.section === 'journals' && item.key === 'outgoing')
    const type = pkg.items.find(
      (item) => item.section === 'documentTypes' && item.key === 'outgoing_letter',
    )
    const template = pkg.items.find((item) => item.section === 'documentTemplates')
    if (!journal || !type || !template) throw new Error('в пакете нет стартовых записей')
    const sandbox: Item[] = [
      // Шаблон первым: применяется всё равно после типа
      {
        ...template,
        key: 'sandbox_letter',
        title: 'Бланк песочницы',
        data: { ...template.data, name: 'Бланк песочницы', typeKey: 'sandbox_letter' },
      },
      {
        ...type,
        key: 'sandbox_letter',
        title: 'Письмо песочницы',
        data: {
          ...type.data,
          name: { ru: 'Письмо песочницы' },
          numbering: { journalKey: 'sandbox_out', format: null },
        },
      },
      {
        ...journal,
        key: 'sandbox_out',
        title: 'Исходящие песочницы',
        // Журнал ссылается на тип из того же пакета — связь ставит второй проход
        data: { ...journal.data, name: 'Исходящие песочницы', typeKeys: ['sandbox_letter'] },
      },
    ]
    const body = { ...pkg, items: sandbox }
    const preview = await call(fx.app, {
      method: 'POST',
      url: '/config/import/preview',
      as: fx.admin,
      payload: { package: body },
    })
    expect(preview.json().counts.new).toBe(3)

    const applied = await call(fx.app, {
      method: 'POST',
      url: '/config/import',
      as: fx.admin,
      payload: { package: body },
    })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(
      (applied.json().applied as Array<{ section: string }>).map((entry) => entry.section),
    ).toEqual(['journals', 'documentTypes', 'documentTemplates'])

    const types = await call(fx.app, { url: '/document-types?includeInactive=true', as: fx.admin })
    const created = (
      types.json().items as Array<{ id: string; key: string; numbering: { journalId: string } }>
    ).find((item) => item.key === 'sandbox_letter')
    const newJournal = (await journals()).find((item) => item.key === 'sandbox_out')
    expect(created?.numbering.journalId).toBe(newJournal?.id)
    expect(newJournal?.typeIds).toEqual([created?.id])

    const templates = await call(fx.app, {
      url: '/document-templates?includeInactive=true',
      as: fx.admin,
    })
    const newTemplate = (
      templates.json().items as Array<{ key: string; type: { key: string } | null; file: unknown }>
    ).find((item) => item.key === 'sandbox_letter')
    expect(newTemplate?.type?.key).toBe('sandbox_letter')
    expect(newTemplate?.file).not.toBeNull()

    // Повторный предпросмотр того же пакета — совпадает
    const again = await call(fx.app, {
      method: 'POST',
      url: '/config/import/preview',
      as: fx.admin,
      payload: { package: body },
    })
    expect(again.json().counts.same).toBe(3)
  })
})
