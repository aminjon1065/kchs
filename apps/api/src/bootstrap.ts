import type { Capability, LangText } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { ensureSearchIndex } from './kernel/search/index-service.js'
import { registerAllObjectTypes, upgradeModuleStorage } from './modules/index.js'
import { db } from './shared/db/client.js'
import { roleCapabilities, roles } from './shared/db/schema/index.js'
import { newId } from './shared/ids.js'
import { logger } from './shared/logger/index.js'

/** Системные роли и их способности (03-access-model.md §Способности). */
const SYSTEM_ROLES: Array<{
  key: string
  name: LangText
  description: string
  capabilities: Capability[]
}> = [
  {
    key: 'system_admin',
    name: { ru: 'Администратор системы', tg: 'Маъмури система', en: 'System administrator' },
    description: 'Полный доступ с аудитом всех действий',
    capabilities: [
      'spaces.create',
      'users.manage',
      'org.manage',
      'groups.manage',
      'roles.manage',
      'documents.register',
      'documents.journals.manage',
      'data.sources.manage',
      'data.export',
      'data.sql',
      'gis.basemaps.manage',
      'automation.manage',
      'admin.audit.read',
      'admin.system',
      'admin.impersonate',
      'ai.use',
      'meetings.record',
      'api_tokens.create',
      'share_links.create',
    ],
  },
  {
    key: 'security_auditor',
    name: { ru: 'Аудитор безопасности', tg: 'Аудитори амният', en: 'Security auditor' },
    description: 'Чтение всего и аудита без изменений',
    capabilities: ['admin.audit.read'],
  },
  {
    key: 'org_admin',
    name: { ru: 'Администратор оргструктуры', tg: 'Маъмури сохтор', en: 'Org administrator' },
    description: 'Пользователи, подразделения, должности',
    capabilities: ['users.manage', 'org.manage', 'groups.manage', 'spaces.create'],
  },
  {
    key: 'registrar',
    name: { ru: 'Делопроизводитель', tg: 'Коргузор', en: 'Registrar' },
    description: 'Регистрация документов и ведение журналов',
    capabilities: ['documents.register', 'documents.journals.manage', 'share_links.create'],
  },
  {
    key: 'data_steward',
    name: { ru: 'Ответственный за данные', tg: 'Масъули маълумот', en: 'Data steward' },
    description: 'Источники данных, качество, экспорт',
    capabilities: ['data.sources.manage', 'data.export', 'data.sql', 'spaces.create', 'ai.use'],
  },
  {
    key: 'gis_admin',
    name: { ru: 'Администратор ГИС', tg: 'Маъмури ГИС', en: 'GIS administrator' },
    description: 'Базовые карты, слои, пространственные данные',
    capabilities: ['gis.basemaps.manage', 'data.export', 'data.sql', 'spaces.create'],
  },
  {
    key: 'employee',
    name: { ru: 'Сотрудник', tg: 'Корманд', en: 'Employee' },
    description: 'Роль по умолчанию',
    capabilities: ['share_links.create', 'ai.use'],
  },
]

/**
 * Идемпотентная инициализация платформы при старте:
 * типы объектов, системные роли, поисковый индекс.
 */
export async function bootstrapPlatform(): Promise<{ roles: number; searchIndex: boolean }> {
  const log = logger().child({ module: 'bootstrap' })

  registerAllObjectTypes()

  for (const role of SYSTEM_ROLES) {
    const [existing] = await db()
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, role.key))
      .limit(1)
    const roleId = existing?.id ?? newId()

    if (!existing) {
      await db().insert(roles).values({
        id: roleId,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: true,
      })
    }

    await db().delete(roleCapabilities).where(eq(roleCapabilities.roleId, roleId))
    if (role.capabilities.length > 0) {
      await db()
        .insert(roleCapabilities)
        .values(role.capabilities.map((capability) => ({ roleId, capability })))
        .onConflictDoNothing()
    }
  }

  await upgradeModuleStorage()

  const searchIndex = await ensureSearchIndex()
    .then(() => true)
    .catch((error) => {
      log.warn({ err: error }, 'поисковый индекс недоступен, продолжаю без него')
      return false
    })

  log.info({ roles: SYSTEM_ROLES.length }, 'платформа инициализирована')
  return { roles: SYSTEM_ROLES.length, searchIndex }
}
