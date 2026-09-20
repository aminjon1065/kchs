import type { PageTemplate } from '@kchs/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import type { SystemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
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
  { title: 'Обучение', template: 'instruction' },
  { title: 'Часто задаваемые вопросы', template: 'faq' },
]

/** Заводит недостающие разделы пространства; возвращает, сколько создано. */
export async function ensureDefaultSections(ctx: SystemCtx, spaceId: string): Promise<number> {
  let created = 0
  for (const section of DEFAULT_SECTIONS) {
    const [exists] = await db()
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.type, 'page'),
          eq(objects.spaceId, spaceId),
          isNull(objects.parentId),
          isNull(objects.deletedAt),
          eq(objects.title, section.title),
        ),
      )
      .limit(1)
    if (exists) continue
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
