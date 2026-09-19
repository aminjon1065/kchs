import { z } from 'zod'
import { AdminModeState, Confidentiality } from '../access/confidentiality.js'
import { Capability } from '../access/principals.js'
import { Locale, Timestamp, Uuid } from '../common/primitives.js'

export const LoginInput = z.object({
  login: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
  rememberDevice: z.boolean().default(false),
})
export type LoginInput = z.infer<typeof LoginInput>

export const MfaChallenge = z.object({
  challengeId: z.string(),
  methods: z.array(z.enum(['totp', 'recovery_code'])),
  expiresAt: Timestamp,
})

export const LoginResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('mfa_required'), challenge: MfaChallenge }),
  z.object({ status: z.literal('password_change_required') }),
])
export type LoginResult = z.infer<typeof LoginResult>

export const MfaVerifyInput = z.object({
  challengeId: z.string(),
  code: z.string().min(6).max(24),
  trustDevice: z.boolean().default(false),
})
export type MfaVerifyInput = z.infer<typeof MfaVerifyInput>

export const UserStatus = z.enum(['active', 'invited', 'blocked', 'deactivated'])
export type UserStatus = z.infer<typeof UserStatus>

/** Компактное представление пользователя для чипов, пикеров и авторства. */
export const UserRef = z.object({
  id: Uuid,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  position: z.string().nullable(),
  unitName: z.string().nullable(),
  status: UserStatus.optional(),
})
export type UserRef = z.infer<typeof UserRef>

export const UserProfile = z.object({
  id: Uuid,
  login: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  displayName: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  middleName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  locale: Locale,
  timezone: z.string(),
  status: UserStatus,
  attributes: z.record(z.string(), z.unknown()).default({}),
})
export type UserProfile = z.infer<typeof UserProfile>

/** Замещение — активное делегирование, в котором участвует пользователь. */
export const DelegationScope = z.enum(['all', 'approvals', 'instructions', 'documents', 'meetings'])
export type DelegationScope = z.infer<typeof DelegationScope>

export const ActiveDelegation = z.object({
  id: Uuid,
  fromUser: UserRef,
  toUser: UserRef,
  scope: DelegationScope,
  startsAt: Timestamp,
  endsAt: Timestamp,
  note: z.string().nullable(),
})
export type ActiveDelegation = z.infer<typeof ActiveDelegation>

/** `/me` — всё, что нужно оболочке при старте. */
export const MeResponse = z.object({
  user: UserProfile,
  personalSpaceId: Uuid.nullable(),
  roles: z.array(z.string()),
  capabilities: z.array(Capability),
  units: z.array(z.object({ id: Uuid, name: z.string(), isPrimary: z.boolean() })),
  positions: z.array(z.object({ id: Uuid, name: z.string() })),
  /** Замещения, которые пользователь исполняет («Вы замещаете …»). */
  actingFor: z.array(ActiveDelegation),
  /** Замещения, которые пользователь выдал. */
  delegatedTo: z.array(ActiveDelegation),
  mfaEnabled: z.boolean(),
  /** Временный пароль не сменён: оболочка показывает только экран смены пароля. */
  mustChangePassword: z.boolean().default(false),
  /** Политика требует второй фактор для роли, а он не подключён: оболочка показывает только подключение MFA. */
  mfaEnrollmentRequired: z.boolean().default(false),
  preferences: z.record(z.string(), z.unknown()).default({}),
  /** Допуск к грифам (ADR-0080): документы строже него не видны. */
  clearance: Confidentiality.default('internal'),
  /** Режим администратора текущей сессии (ADR-0080); null — не включён. */
  adminMode: AdminModeState.nullable().default(null),
  session: z.object({
    id: Uuid,
    expiresAt: Timestamp,
    createdAt: Timestamp,
    /** Токен CSRF текущей сессии: нужен для изменяющих запросов. */
    csrfToken: z.string(),
    /** Кого пользователь замещает в этом запросе (режим «от имени»). */
    onBehalfOf: Uuid.nullable(),
  }),
})
export type MeResponse = z.infer<typeof MeResponse>

export const SessionInfo = z.object({
  id: Uuid,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  deviceName: z.string().nullable(),
  createdAt: Timestamp,
  lastActiveAt: Timestamp,
  expiresAt: Timestamp,
  current: z.boolean(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

export const PasswordChangeInput = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
  revokeOtherSessions: z.boolean().default(true),
})
export type PasswordChangeInput = z.infer<typeof PasswordChangeInput>

export const ProfileUpdateInput = z.object({
  displayName: z.string().min(1).max(200).optional(),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
  middleName: z.string().max(100).nullable().optional(),
  email: z.email().nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  locale: Locale.optional(),
  timezone: z.string().max(64).optional(),
})
export type ProfileUpdateInput = z.infer<typeof ProfileUpdateInput>

export const MfaSetupResponse = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrSvg: z.string(),
})
export type MfaSetupResponse = z.infer<typeof MfaSetupResponse>

export const MfaEnableInput = z.object({
  code: z.string().length(6),
})
export type MfaEnableInput = z.infer<typeof MfaEnableInput>

export const RecoveryCodesResponse = z.object({
  codes: z.array(z.string()),
})
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponse>

export const PasswordResetRequestInput = z.object({
  login: z.string().min(1).max(200),
})

export const PasswordResetConfirmInput = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(12).max(200),
})
