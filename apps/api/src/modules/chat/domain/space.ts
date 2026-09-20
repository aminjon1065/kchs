import { SpaceService } from '~/kernel/spaces/service.js'
import type { Executor } from '~/shared/db/client.js'

/** Ключ системного пространства личных бесед и групп (ADR-0090). */
export const CHATS_SPACE_KEY = 'chats'

/**
 * Личные беседы и группы живут в системном пространстве без участников: роль
 * в пространстве доступа не даёт, видимость — только по правам самой беседы
 * (участие). Каналы, наоборот, живут в пространстве команды или подразделения:
 * открытый канал виден его участникам наследованием. Так же устроены встречи
 * (ADR-0089) и документооборот (ADR-0080).
 */
export async function chatsSpaceId(tx: Executor): Promise<string> {
  return SpaceService.ensureSystem(tx, {
    key: CHATS_SPACE_KEY,
    name: 'Чаты',
    description: 'Личные беседы и группы',
  })
}
