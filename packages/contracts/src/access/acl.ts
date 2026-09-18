import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { Level } from './levels.js'
import { Principal, PrincipalRef } from './principals.js'

/** Режим доступа объекта: наследует от предков или только явные записи. */
export const AccessMode = z.enum(['inherit', 'restricted'])
export type AccessMode = z.infer<typeof AccessMode>

export const AclEntry = z.object({
  id: Uuid,
  objectId: Uuid,
  principal: PrincipalRef,
  level: Level,
  grantedBy: Uuid.nullable(),
  grantedAt: Timestamp,
  expiresAt: Timestamp.nullable(),
  note: z.string().nullable(),
})
export type AclEntry = z.infer<typeof AclEntry>

export const AclGrantInput = z.object({
  principal: Principal,
  level: Level,
  expiresAt: Timestamp.nullable().optional(),
  note: z.string().max(500).optional(),
  message: z.string().max(2000).optional(),
})
export type AclGrantInput = z.infer<typeof AclGrantInput>

/** Источник права — для «Кто имеет доступ» и «Объяснить доступ». */
export const REASON_KINDS = [
  'system_role',
  'owner',
  'explicit',
  'inherited',
  'space_role',
  'type_policy',
  'share_link',
  'delegation',
  'attribute_cap',
  'denied',
] as const
export const ReasonKind = z.enum(REASON_KINDS)
export type ReasonKind = z.infer<typeof ReasonKind>

export const AccessReason = z.object({
  kind: ReasonKind,
  level: Level,
  /** Ключ i18n для человеческого объяснения, например `access.reason.inherited`. */
  messageKey: z.string(),
  /** Параметры для подстановки в объяснение. */
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  sourceObjectId: Uuid.nullable().optional(),
  principal: Principal.nullable().optional(),
})
export type AccessReason = z.infer<typeof AccessReason>

export const Decision = z.object({
  allowed: z.boolean(),
  level: Level,
  reasons: z.array(AccessReason),
})
export type Decision = z.infer<typeof Decision>

/** Эффективные права пользователя на объект — вкладка «Кто имеет доступ». */
export const EffectiveAccess = z.object({
  principal: PrincipalRef,
  level: Level,
  reasons: z.array(AccessReason),
})
export type EffectiveAccess = z.infer<typeof EffectiveAccess>

export const ShareLink = z.object({
  id: Uuid,
  objectId: Uuid,
  token: z.string(),
  url: z.string(),
  level: Level,
  hasPassword: z.boolean(),
  expiresAt: Timestamp.nullable(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  includeAttachments: z.boolean(),
  createdBy: Uuid,
  createdAt: Timestamp,
})
export type ShareLink = z.infer<typeof ShareLink>

export const ShareLinkInput = z.object({
  level: z.literal('view').default('view'),
  password: z.string().min(4).max(128).nullable().optional(),
  expiresAt: Timestamp.nullable().optional(),
  maxUses: z.number().int().min(1).max(100000).nullable().optional(),
  includeAttachments: z.boolean().default(false),
})
export type ShareLinkInput = z.infer<typeof ShareLinkInput>

/** Открытие объекта по гостевой ссылке: без пароля или с паролем. */
export const ShareLinkOpenInput = z.object({
  password: z.string().min(1).max(128).optional(),
})
export type ShareLinkOpenInput = z.infer<typeof ShareLinkOpenInput>

export const ShareLinkOpenResult = z.object({
  /** Ссылка защищена паролем, а он не предъявлен или не подошёл. */
  requiresPassword: z.boolean(),
  /** Токен доступа для заголовка `x-kchs-share-token`; `null`, пока нужен пароль. */
  accessToken: z.string().nullable(),
  objectId: Uuid.nullable(),
  expiresAt: Timestamp.nullable(),
  includeAttachments: z.boolean(),
  /** Подпись водяного знака для предпросмотра. */
  watermark: z.string().nullable(),
})
export type ShareLinkOpenResult = z.infer<typeof ShareLinkOpenResult>
