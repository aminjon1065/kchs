import { SpaceService } from '~/kernel/spaces/service.js'
import type { Executor } from '~/shared/db/client.js'

/** Ключ системного пространства документооборота (ADR-0080). */
export const DOCUMENTS_SPACE_KEY = 'documents'

/**
 * Документы, журналы, типы и корреспонденты живут в системном пространстве без
 * участников: роль в пространстве доступа не даёт, видимость — только по
 * правам самих объектов. Здесь же папка «Вложения» со сканами и версиями.
 */
export async function documentsSpaceId(tx: Executor): Promise<string> {
  return SpaceService.ensureSystem(tx, {
    key: DOCUMENTS_SPACE_KEY,
    name: 'Документооборот',
    description: 'Документы, журналы регистрации, типы документов и корреспонденты',
  })
}
