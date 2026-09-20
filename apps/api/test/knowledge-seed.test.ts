import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Содержимое базы знаний из `db:seed` (P5-E07): разделы по умолчанию и краткое
 * руководство пользователя деревом страниц в разделе «Обучение». Проверяем то,
 * ради чего оно заведено: страницы действительно создаются, у них есть текст,
 * оглавление и владелец, они опубликованы, и повторный сид ничего не дублирует.
 */
registerLifecycle()

const { startCollab, stopCollab } = await import('../src/kernel/collab/server.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { KnowledgeSeed } = await import('../src/modules/knowledge/public.js')
const { GUIDE_PAGES, GUIDE_ROOT, GUIDE_SECTION } = await import(
  '../src/modules/knowledge/domain/page-guide.js'
)
const { systemCtx } = await import('../src/shared/context.js')

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

let fx: TestContext

/** Дерево страниц пространства — плоский список узлов с `parentId`. */
async function tree(spaceId = fx.spaceId): Promise<Json[]> {
  const response = await call(fx.app, { url: `/knowledge/tree?spaceId=${spaceId}`, as: fx.admin })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items as Json[]
}

const byTitle = (items: Json[], title: string): Json | undefined =>
  items.find((item) => item.title === title)

beforeAll(async () => {
  fx = await setupFixture()
  startCollab(fx.app.server, { resolveSession: (token) => AuthService.resolveSession(token) })
  const ctx = systemCtx('seed', { initiatorId: fx.admin.id })
  await KnowledgeSeed.ensureDefaultSections(ctx, fx.spaceId)
  await KnowledgeSeed.ensureUserGuide(ctx, fx.spaceId)
}, 180_000)

afterAll(async () => {
  await stopCollab()
})

describe('база знаний из сида', () => {
  it('заводит разделы по умолчанию и дерево руководства', async () => {
    const items = await tree()
    for (const section of ['Регламенты и инструкции', 'Справочники', GUIDE_SECTION]) {
      expect(byTitle(items, section), section).toMatchObject({ parentId: null })
    }

    // руководство вложено в раздел «Обучение», а не лежит в корне пространства
    const section = byTitle(items, GUIDE_SECTION) as Json
    const root = byTitle(items, GUIDE_ROOT.title) as Json
    expect(root).toMatchObject({ parentId: section.id, hasChildren: true })

    const children = items.filter((item) => item.parentId === root.id)
    expect(children).toHaveLength(GUIDE_PAGES.length)
    for (const guide of GUIDE_PAGES) {
      expect(byTitle(children, guide.title), guide.title).toBeDefined()
    }
  })

  it('у страниц есть текст, оглавление, владелец и версия', async () => {
    const root = byTitle(await tree(), GUIDE_ROOT.title) as Json
    const response = await call(fx.app, { url: `/pages/${root.id}`, as: fx.admin })
    expect(response.statusCode, response.body).toBe(200)
    const page = response.json() as Json

    expect(page.blocks).toHaveLength(GUIDE_ROOT.blocks.length)
    expect(page.blocks[0].kind).toBe('text')
    // подписи блоков дают оглавление страницы
    expect(page.outline.map((item: Json) => item.text)).toContain('Содержание')
    expect(page.owner?.id).toBe(fx.admin.id)
    expect(page.status).toBe('published')
    expect(page.versionNumber).toBe(1)
  })

  it('повторный сид ничего не дублирует', async () => {
    const before = await tree()
    const ctx = systemCtx('seed', { initiatorId: fx.admin.id })
    expect(await KnowledgeSeed.ensureDefaultSections(ctx, fx.spaceId)).toBe(0)
    expect(await KnowledgeSeed.ensureUserGuide(ctx, fx.spaceId)).toEqual({ created: 0 })
    expect(await tree()).toHaveLength(before.length)
  })

  it('без раздела «Обучение» руководство не заводится', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/spaces',
      as: fx.admin,
      payload: { key: `guide-${Date.now().toString(36)}`, name: 'Без обучения', kind: 'team' },
    })
    expect(created.statusCode, created.body).toBe(200)
    const spaceId = created.json().id as string
    const ctx = systemCtx('seed', { initiatorId: fx.admin.id })
    expect(await KnowledgeSeed.ensureUserGuide(ctx, spaceId)).toEqual({ created: 0 })
    expect(await tree(spaceId)).toHaveLength(0)
  })
})
