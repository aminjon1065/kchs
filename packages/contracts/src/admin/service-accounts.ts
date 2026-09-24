import { z } from 'zod'
import { SpaceRole } from '../access/levels.js'
import { UserStatus } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'

// Служебная учётная запись (ADR-0130): от её имени работают правила
// автоматизации, формы и интеграции. Войти ею нельзя никаким способом,
// уведомлений и дел она не получает, назначения и пикеры людей её не выбирают.
// Права — роли (кроме администратора системы), подразделение, пространства
// и выданный на объекты доступ, как у сотрудника.

/** Роли служебной записи в пространстве: администратором она не бывает. */
export const SERVICE_ACCOUNT_SPACE_ROLES = ['viewer', 'member', 'editor'] as const

export const ServiceAccountSpace = z.object({
  spaceId: Uuid,
  /**
   * Роль в пространстве: правилу, которое пишет в объекты, нужна правка.
   * Администратором пространства служебная запись не бывает.
   */
  role: z.enum(SERVICE_ACCOUNT_SPACE_ROLES).default('editor'),
})
export type ServiceAccountSpace = z.infer<typeof ServiceAccountSpace>

const Name = z.string().trim().min(1).max(200)
const Description = z.string().trim().max(1000)
const RoleKeys = z.array(z.string().min(1).max(64)).max(20)

export const ServiceAccountCreateInput = z.object({
  name: Name,
  description: Description.nullable().default(null),
  roleKeys: RoleKeys.default([]),
  unitId: Uuid.nullable().default(null),
  spaces: z.array(ServiceAccountSpace).max(50).default([]),
})
export type ServiceAccountCreateInput = z.infer<typeof ServiceAccountCreateInput>

/** Правка: только переданные поля; `spaces` заменяет набор пространств целиком. */
export const ServiceAccountPatchInput = z
  .object({
    name: Name,
    description: Description.nullable(),
    roleKeys: RoleKeys,
    unitId: Uuid.nullable(),
    spaces: z.array(ServiceAccountSpace).max(50),
    status: z.enum(['active', 'blocked']),
  })
  .partial()
export type ServiceAccountPatchInput = z.infer<typeof ServiceAccountPatchInput>

export const ServiceAccount = z.object({
  id: Uuid,
  /** Технический логин `svc-…`: по нему запись видна в аудите; входа по нему нет. */
  login: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: UserStatus,
  roles: z.array(z.string()),
  unit: z.object({ id: Uuid, name: z.string() }).nullable(),
  spaces: z.array(z.object({ spaceId: Uuid, title: z.string(), role: SpaceRole })),
  createdAt: Timestamp,
})
export type ServiceAccount = z.infer<typeof ServiceAccount>
