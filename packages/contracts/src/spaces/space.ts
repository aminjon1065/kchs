import { z } from 'zod'
import { SpaceRole } from '../access/levels.js'
import { Timestamp, Uuid } from '../common/primitives.js'

/** Вид пространства (02-platform-kernel.md §2). */
export const SPACE_KINDS = ['personal', 'unit', 'team', 'org'] as const
export const SpaceKind = z.enum(SPACE_KINDS)
export type SpaceKind = z.infer<typeof SpaceKind>

export const SpaceSettings = z.object({
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  modules: z.array(z.string()).optional(),
  defaultVisibility: z.enum(['space', 'private']).default('space'),
  /** Роль пространства → уровень доступа по умолчанию (переопределение). */
  roleLevels: z.record(z.string(), z.string()).optional(),
})
export type SpaceSettings = z.infer<typeof SpaceSettings>

export const Space = z.object({
  id: Uuid,
  key: z.string(),
  name: z.string(),
  kind: SpaceKind,
  unitId: Uuid.nullable(),
  ownerId: Uuid.nullable(),
  description: z.string().nullable(),
  settings: SpaceSettings,
  memberCount: z.number().int(),
  myRole: SpaceRole.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Space = z.infer<typeof Space>

export const SpaceCreateInput = z.object({
  key: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'ключ: строчные латинские буквы, цифры и дефис'),
  name: z.string().min(1).max(200),
  kind: z.enum(['team', 'unit', 'org']).default('team'),
  unitId: Uuid.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  settings: SpaceSettings.partial().optional(),
})
export type SpaceCreateInput = z.infer<typeof SpaceCreateInput>

export const SpaceMember = z.object({
  spaceId: Uuid,
  userId: Uuid,
  role: SpaceRole,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  position: z.string().nullable(),
  unitName: z.string().nullable(),
  addedAt: Timestamp,
})
export type SpaceMember = z.infer<typeof SpaceMember>
