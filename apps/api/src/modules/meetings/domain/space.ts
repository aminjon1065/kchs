import { SpaceService } from '~/kernel/spaces/service.js'
import type { Executor } from '~/shared/db/client.js'

/** Ключ системного пространства встреч (ADR-0089). */
export const MEETINGS_SPACE_KEY = 'meetings'

/**
 * Встречи живут в системном пространстве без участников: роль в пространстве
 * доступа не даёт, видимость — только по правам самой встречи (участие,
 * организатор, явная запись ACL). Так же устроен документооборот (ADR-0080).
 */
export async function meetingsSpaceId(tx: Executor): Promise<string> {
  return SpaceService.ensureSystem(tx, {
    key: MEETINGS_SPACE_KEY,
    name: 'Встречи',
    description: 'Встречи, звонки, записи и протоколы',
  })
}
