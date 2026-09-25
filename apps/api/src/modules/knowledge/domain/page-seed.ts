import type { Locale, PageBlock, PageTemplate } from '@kchs/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import type { SystemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { GUIDE_SECTION } from './page-guide.js'
import type { GuidePage } from './page-guide-kit.js'
import { GUIDES } from './page-guides.js'
import { PageService } from './page-service.js'

/**
 * Разделы базы знаний по умолчанию (13-search-knowledge-ai.md §2, ADR-0095):
 * четыре корневые страницы пространства «Общее». Раздел — обычная страница с
 * вложенными: дерево остаётся однородным, и у раздела есть своё вступление,
 * владелец и срок пересмотра. Загрузка идемпотентна — раздел с таким названием
 * второй раз не заводится.
 */
export const DEFAULT_SECTIONS: ReadonlyArray<{ title: string; template: PageTemplate }> = [
  { title: 'Регламенты и инструкции', template: 'regulation' },
  { title: 'Справочники', template: 'reference' },
  { title: GUIDE_SECTION, template: 'instruction' },
  { title: 'Часто задаваемые вопросы', template: 'faq' },
]

/** Страница пространства по названию и месту в дереве; null — нет такой. */
async function findPage(
  spaceId: string,
  title: string,
  parentId: string | null,
): Promise<string | null> {
  const [row] = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.type, 'page'),
        eq(objects.spaceId, spaceId),
        parentId === null ? isNull(objects.parentId) : eq(objects.parentId, parentId),
        isNull(objects.deletedAt),
        eq(objects.title, title),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/** Заводит недостающие разделы пространства; возвращает, сколько создано. */
export async function ensureDefaultSections(ctx: SystemCtx, spaceId: string): Promise<number> {
  let created = 0
  for (const section of DEFAULT_SECTIONS) {
    if (await findPage(spaceId, section.title, null)) continue
    await db().transaction((tx) =>
      PageService.create(
        tx,
        ctx,
        { title: section.title, spaceId, template: section.template },
        'ru',
      ),
    )
    created += 1
  }
  return created
}

/**
 * Публикация сидовой страницы: снимает версию и строит чанки поиска. Требует
 * контекста пользователя (`manage`), поэтому берётся владелец страницы. Если
 * опубликовать не удалось (нет владельца, недоступен сервер совместной правки),
 * страница остаётся черновиком — сид из-за этого не падает.
 */
async function publishPage(ownerId: string | null, pageId: string): Promise<boolean> {
  if (!ownerId) return false
  const ctx = await buildUserCtxFor(ownerId)
  if (!ctx) return false
  try {
    await PageService.publish(ctx, pageId, { note: 'Первая редакция' })
    return true
  } catch (error) {
    logger().child({ module: 'seed' }).warn({ err: error, pageId }, 'страница не опубликована')
    return false
  }
}

/** Создаёт страницу с готовыми блоками и публикует её; возвращает её id. */
async function createGuidePage(
  ctx: SystemCtx,
  spaceId: string,
  parentId: string | null,
  guide: GuidePage,
  locale: Locale,
): Promise<string> {
  const id = await db().transaction((tx) =>
    PageService.create(
      tx,
      ctx,
      {
        title: guide.title,
        spaceId,
        parentId,
        template: 'blank',
        blocks: guide.blocks as PageBlock[],
      },
      locale,
    ),
  )
  await publishPage(ctx.initiatorId, id)
  return id
}

/**
 * Краткое руководство пользователя в базе знаний (P5-E07): на каждом языке
 * интерфейса — корневая страница внутри раздела «Обучение» и вложенные в неё
 * разделы по работе (N88). Идемпотентно: страница с таким названием на своём месте
 * второй раз не заводится, уже написанный текст не перезаписывается. Возвращает
 * корни по языкам — их открывает пункт «Справка».
 */
export async function ensureUserGuide(
  ctx: SystemCtx,
  spaceId: string,
): Promise<{ created: number; roots: Partial<Record<Locale, string>> }> {
  const sectionId = await findPage(spaceId, GUIDE_SECTION, null)
  if (!sectionId) return { created: 0, roots: {} }

  let created = 0
  const roots: Partial<Record<Locale, string>> = {}
  for (const guide of GUIDES) {
    let rootId = await findPage(spaceId, guide.root.title, sectionId)
    if (!rootId) {
      rootId = await createGuidePage(ctx, spaceId, sectionId, guide.root, guide.locale)
      created += 1
    }
    roots[guide.locale] = rootId
    for (const child of guide.pages) {
      if (await findPage(spaceId, child.title, rootId)) continue
      await createGuidePage(ctx, spaceId, rootId, child, guide.locale)
      created += 1
    }
  }
  return { created, roots }
}
