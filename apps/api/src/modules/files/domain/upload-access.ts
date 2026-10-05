import { eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { objects } from '~/kernel/objects/schema.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'

/** Куда ложится загружаемый файл: пространство, папка, новая версия или вложение. */
export interface UploadTarget {
  spaceId: string
  folderId?: string | null | undefined
  fileId?: string | null | undefined
  attachToObjectId?: string | null | undefined
}

/**
 * Право загрузить файл в цель. Проверяется при открытии сессии, при докачке и при
 * завершении (ADR-0123, ADR-0177): возобновляемая сессия живёт долго, и право,
 * отозванное после её открытия, не должно дать создать файл.
 */
export async function authorizeUploadTarget(ctx: UserCtx, target: UploadTarget): Promise<void> {
  const { attachToObjectId, fileId, folderId, spaceId } = target
  if (attachToObjectId && !fileId && !folderId) {
    // Вложение меняет объект, к которому прикрепляется: нужен уровень edit на
    // нём, а файл ляжет в системную папку «Вложения» его пространства
    await authorize(ctx, 'edit', attachToObjectId)
    const [row] = await db()
      .select({ spaceId: objects.spaceId })
      .from(objects)
      .where(eq(objects.id, attachToObjectId))
      .limit(1)
    if (row?.spaceId !== spaceId) {
      throw errors.validation('Вложение загружается в пространство объекта', [
        { path: 'spaceId', message: 'mismatch' },
      ])
    }
    return
  }
  // Загрузка в пространство требует права на создание в нём или в папке
  await authorize(ctx, fileId ? 'upload_version' : 'create_child', fileId ?? folderId ?? spaceId)
  if (attachToObjectId) await authorize(ctx, 'edit', attachToObjectId)
}
