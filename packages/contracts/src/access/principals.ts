import { z } from 'zod'
import { LangText } from '../common/primitives.js'

/**
 * Принципалы — кто может получать права (03-access-model.md).
 * Хранятся в `acl_entries(principal_type, principal_id)`.
 */
export const PRINCIPAL_TYPES = [
  'user',
  'group',
  'unit',
  'position',
  'space_role',
  'role',
  'everyone',
  'link',
] as const
export const PrincipalType = z.enum(PRINCIPAL_TYPES)
export type PrincipalType = z.infer<typeof PrincipalType>

export const Principal = z.object({
  type: PrincipalType,
  /** `space_role` → `<spaceId>:<role>`; `everyone` → `*`; остальные — id/ключ. */
  id: z.string().min(1).max(128),
})
export type Principal = z.infer<typeof Principal>

export const EVERYONE: Principal = { type: 'everyone', id: '*' }

export function principalKey(p: Principal): string {
  return `${p.type}:${p.id}`
}

export function parsePrincipal(key: string): Principal {
  const idx = key.indexOf(':')
  if (idx < 0) throw new Error(`некорректный принципал: ${key}`)
  return { type: PrincipalType.parse(key.slice(0, idx)), id: key.slice(idx + 1) }
}

/** Отображаемый принципал — для диалога «Поделиться» и пикеров. */
export const PrincipalRef = Principal.extend({
  title: z.string(),
  subtitle: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
  icon: z.string().optional(),
  /** Пользователь — служебная учётная запись (ADR-0130): интерфейс её отмечает. */
  service: z.boolean().optional(),
})
export type PrincipalRef = z.infer<typeof PrincipalRef>

/** Системные роли (05-appendix/glossary.md). */
export const SYSTEM_ROLES = [
  'system_admin',
  'security_auditor',
  'org_admin',
  'registrar',
  'data_steward',
  'gis_admin',
  'employee',
] as const
export const SystemRoleKey = z.enum(SYSTEM_ROLES)
export type SystemRoleKey = z.infer<typeof SystemRoleKey>

/** Способности — глобальные разрешения действий (03-access-model.md §Способности). */
export const CAPABILITIES = [
  'spaces.create',
  'users.manage',
  'org.manage',
  'groups.manage',
  'roles.manage',
  'documents.register',
  'documents.journals.manage',
  /** Маршруты процессов: определения, публикация, переназначение и отмена (ADR-0079). */
  'processes.manage',
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
] as const
export const Capability = z.enum(CAPABILITIES)
export type Capability = z.infer<typeof Capability>

export const RoleInfo = z.object({
  id: z.string(),
  key: z.string(),
  name: LangText,
  isSystem: z.boolean(),
  capabilities: z.array(z.string()),
  /** Активных сотрудников с этой ролью (матрица ролей в консоли). */
  userCount: z.number().int().nonnegative(),
})
export type RoleInfo = z.infer<typeof RoleInfo>
