import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Содержимое базы знаний из `db:seed` (P5-E07): разделы по умолчанию и краткое
 * руководство пользователя деревом страниц в разделе «Обучение» — на каждом языке
 * интерфейса своё дерево (N88). Проверяем то, ради чего оно заведено: страницы
 * действительно создаются, у них есть текст, оглавление и владелец, они
 * опубликованы, корни по языкам возвращаются для «Справки», и повторный сид ничего
 * не дублирует.
 */
registerLifecycle()

const { startCollab, stopCollab } = await import('../src/kernel/collab/server.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { KnowledgeSeed } = await import('../src/modules/knowledge/public.js')
const { GUIDE_SECTION } = await import('../src/modules/knowledge/domain/page-guide.js')
const { GUIDES } = await import('../src/modules/knowledge/domain/page-guides.js')
const { systemCtx } = await import('../src/shared/context.js')

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

let fx: TestContext
/** Итог первого сида: сколько страниц заведено и корни руководства по языкам. */
let firstRun: Awaited<ReturnType<typeof KnowledgeSeed.ensureUserGuide>>

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
  firstRun = await KnowledgeSeed.ensureUserGuide(ctx, fx.spaceId)
}, 300_000)

afterAll(async () => {
  await stopCollab()
})

describe('база знаний из сида', () => {
  it('заводит разделы по умолчанию и дерево руководства на каждом языке', async () => {
    const items = await tree()
    for (const section of ['Регламенты и инструкции', 'Справочники', GUIDE_SECTION]) {
      expect(byTitle(items, section), section).toMatchObject({ parentId: null })
    }

    // руководства вложены в раздел «Обучение», а не лежат в корне пространства:
    // три корня — русский, таджикский, английский
    const section = byTitle(items, GUIDE_SECTION) as Json
    expect(items.filter((item) => item.parentId === section.id)).toHaveLength(GUIDES.length)
    expect(GUIDES.map((guide) => guide.locale)).toEqual(['ru', 'tg', 'en'])

    for (const guide of GUIDES) {
      const root = byTitle(items, guide.root.title) as Json
      expect(root, guide.root.title).toMatchObject({ parentId: section.id, hasChildren: true })

      const children = items.filter((item) => item.parentId === root.id)
      expect(children).toHaveLength(guide.pages.length)
      for (const child of guide.pages) {
        expect(byTitle(children, child.title), `${guide.locale}: ${child.title}`).toBeDefined()
      }
    }
    const created = GUIDES.reduce((sum, guide) => sum + 1 + guide.pages.length, 0)
    expect(firstRun.created).toBe(created)
  })

  it('корни руководства по языкам — для пункта «Справка»', async () => {
    const items = await tree()
    expect(Object.keys(firstRun.roots).sort()).toEqual(['en', 'ru', 'tg'])
    for (const guide of GUIDES) {
      const root = byTitle(items, guide.root.title) as Json
      expect(firstRun.roots[guide.locale], guide.locale).toBe(root.id)
    }
  })

  it('у страниц есть текст, оглавление, владелец и версия', async () => {
    const items = await tree()
    for (const guide of GUIDES) {
      const root = byTitle(items, guide.root.title) as Json
      const response = await call(fx.app, { url: `/pages/${root.id}`, as: fx.admin })
      expect(response.statusCode, response.body).toBe(200)
      const page = response.json() as Json

      expect(page.blocks).toHaveLength(guide.root.blocks.length)
      expect(page.blocks[0].kind).toBe('text')
      // подписи блоков дают оглавление страницы: «Содержание», «Мундариҷа», «Contents»
      const contents = (guide.root.blocks[1] as Json).title as string
      expect(
        page.outline.map((item: Json) => item.text),
        guide.locale,
      ).toContain(contents)
      expect(page.owner?.id).toBe(fx.admin.id)
      expect(page.status).toBe('published')
      expect(page.versionNumber).toBe(1)
    }
  })

  it('повторный сид ничего не дублирует', async () => {
    const before = await tree()
    const ctx = systemCtx('seed', { initiatorId: fx.admin.id })
    expect(await KnowledgeSeed.ensureDefaultSections(ctx, fx.spaceId)).toBe(0)
    expect(await KnowledgeSeed.ensureUserGuide(ctx, fx.spaceId)).toEqual({
      created: 0,
      roots: firstRun.roots,
    })
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
    expect(await KnowledgeSeed.ensureUserGuide(ctx, spaceId)).toEqual({ created: 0, roots: {} })
    expect(await tree(spaceId)).toHaveLength(0)
  })
})
