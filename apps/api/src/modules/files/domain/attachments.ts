import { and, eq, isNull, sql } from 'drizzle-orm'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'

/** Признак системной папки «Вложения» в `objects.meta.system`. */
export const ATTACHMENTS_FOLDER = 'attachments'

/**
 * Системная папка «Вложения» пространства (09-files.md §1): файлы, загруженные
 * как вложения, лежат в ней, а не в корне пространства. Папка закрыта
 * (`restricted`) и без владельца — её содержимое видно не по роли в
 * пространстве, а через объекты, к которым файлы прикреплены (ядро выводит
 * доступ из связи `attachment`), и тем, кто файл загрузил.
 */
export const AttachmentsFolder = {
  async find(spaceId: string, executor: Executor = db()): Promise<string | null> {
    const [row] = await executor
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.spaceId, spaceId),
          eq(objects.type, 'folder'),
          isNull(objects.deletedAt),
          sql`${objects.meta}->>'system' = ${ATTACHMENTS_FOLDER}`,
        ),
      )
      .limit(1)
    return row?.id ?? null
  },

  async ensure(tx: Executor, ctx: Ctx, spaceId: string): Promise<string> {
    // Одновременные первые вложения в пространстве не создают две папки
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`attachments:${spaceId}`}))`)
    const existing = await AttachmentsFolder.find(spaceId, tx)
    if (existing) return existing
    const folder = await ObjectService.create(tx, ctx, {
      type: 'folder',
      spaceId,
      parentId: null,
      title: 'Вложения',
      icon: 'paperclip',
      ownerId: null,
      accessMode: 'restricted',
      meta: { system: ATTACHMENTS_FOLDER },
    })
    return folder.id
  },
}
