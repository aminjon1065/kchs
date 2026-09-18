import { z } from 'zod'
import { UserRef, UserStatus } from '../auth/session.js'
import { LangText, Timestamp, Uuid } from '../common/primitives.js'

export const ORG_UNIT_KINDS = ['committee', 'department', 'division', 'regional', 'sector'] as const
export const OrgUnitKind = z.enum(ORG_UNIT_KINDS)
export type OrgUnitKind = z.infer<typeof OrgUnitKind>

export const OrgUnit = z.object({
  id: Uuid,
  parentId: Uuid.nullable(),
  code: z.string(),
  name: LangText,
  kind: OrgUnitKind,
  head: UserRef.nullable(),
  territoryId: Uuid.nullable(),
  sort: z.number().int(),
  isActive: z.boolean(),
  employeeCount: z.number().int().default(0),
  childCount: z.number().int().default(0),
  spaceId: Uuid.nullable(),
})
export type OrgUnit = z.infer<typeof OrgUnit>

export const OrgUnitInput = z.object({
  parentId: Uuid.nullable().optional(),
  code: z.string().min(1).max(64),
  name: LangText,
  kind: OrgUnitKind.default('department'),
  headUserId: Uuid.nullable().optional(),
  /** Территория ответственности: её получают сотрудники подразделения и его потомков (ADR-0057). */
  territoryId: Uuid.nullable().optional(),
  sort: z.number().int().default(0),
  isActive: z.boolean().default(true),
  createSpace: z.boolean().default(true),
})
export type OrgUnitInput = z.infer<typeof OrgUnitInput>

/**
 * Правка подразделения: только переданные поля. Не `OrgUnitInput.partial()` —
 * значения по умолчанию сбрасывали бы вид, порядок и активность при любой правке.
 */
export const OrgUnitPatch = z
  .object({
    parentId: Uuid.nullable(),
    code: z.string().min(1).max(64),
    name: LangText,
    kind: OrgUnitKind,
    headUserId: Uuid.nullable(),
    territoryId: Uuid.nullable(),
    sort: z.number().int(),
    isActive: z.boolean(),
  })
  .partial()
export type OrgUnitPatch = z.infer<typeof OrgUnitPatch>

export const Position = z.object({
  id: Uuid,
  name: LangText,
  rank: z.number().int(),
  unitId: Uuid.nullable(),
})
export type Position = z.infer<typeof Position>

export const Employment = z.object({
  id: Uuid,
  userId: Uuid,
  unitId: Uuid,
  unitName: z.string(),
  positionId: Uuid.nullable(),
  positionName: z.string().nullable(),
  isPrimary: z.boolean(),
  startsAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
})
export type Employment = z.infer<typeof Employment>

export const Group = z.object({
  id: Uuid,
  name: z.string(),
  kind: z.enum(['static', 'system']),
  spaceId: Uuid.nullable(),
  description: z.string().nullable(),
  memberCount: z.number().int(),
})
export type Group = z.infer<typeof Group>

export const AdminUser = z.object({
  id: Uuid,
  login: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  displayName: z.string(),
  status: UserStatus,
  avatarUrl: z.string().nullable(),
  mfaEnabled: z.boolean(),
  lastSeenAt: Timestamp.nullable(),
  createdAt: Timestamp,
  units: z.array(z.object({ id: Uuid, name: z.string(), isPrimary: z.boolean() })).default([]),
  positions: z.array(z.object({ id: Uuid, name: z.string() })).default([]),
  roles: z.array(z.string()).default([]),
})
export type AdminUser = z.infer<typeof AdminUser>

export const AdminUserCreateInput = z.object({
  login: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'логин: латиница, цифры, . _ -'),
  email: z.email().nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  lastName: z.string().min(1).max(100),
  firstName: z.string().min(1).max(100),
  middleName: z.string().max(100).nullable().optional(),
  unitId: Uuid.nullable().optional(),
  positionId: Uuid.nullable().optional(),
  roleKeys: z.array(z.string()).default(['employee']),
  password: z.string().min(12).max(200).optional(),
  mustChangePassword: z.boolean().default(true),
  locale: z.enum(['ru', 'tg', 'en']).default('ru'),
  timezone: z.string().default('Asia/Dushanbe'),
})
export type AdminUserCreateInput = z.infer<typeof AdminUserCreateInput>

export const AdminUserPatchInput = z.object({
  email: z.email().nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  lastName: z.string().min(1).max(100).optional(),
  firstName: z.string().min(1).max(100).optional(),
  middleName: z.string().max(100).nullable().optional(),
  status: UserStatus.optional(),
  roleKeys: z.array(z.string()).optional(),
  unitId: Uuid.nullable().optional(),
  positionId: Uuid.nullable().optional(),
})
export type AdminUserPatchInput = z.infer<typeof AdminUserPatchInput>

export const DelegationInput = z.object({
  toUserId: Uuid,
  scope: z.enum(['all', 'approvals', 'instructions', 'documents', 'meetings']).default('all'),
  startsAt: Timestamp,
  endsAt: Timestamp,
  note: z.string().max(500).nullable().optional(),
})
export type DelegationInput = z.infer<typeof DelegationInput>

export const HealthComponent = z.object({
  name: z.string(),
  status: z.enum(['ok', 'degraded', 'down']),
  detail: z.string().nullable(),
  latencyMs: z.number().nullable(),
})

export const HealthReport = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  uptimeSeconds: z.number().int(),
  components: z.array(HealthComponent),
  outbox: z.object({ pending: z.number().int(), oldestSeconds: z.number().int().nullable() }),
  jobs: z.object({ queued: z.number().int(), running: z.number().int(), failed: z.number().int() }),
})
export type HealthReport = z.infer<typeof HealthReport>
