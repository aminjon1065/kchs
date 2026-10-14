import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * УЦ Комитета (ADR-0218): собственный удостоверяющий центр платформы. Ключи сотрудников
 * создаются в браузере (WebCrypto, неизвлекаемые) и не покидают устройства; платформа
 * выпускает сертификат по открытому ключу и доказательству владения им, после второго
 * фактора.
 */

const Base64 = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'ожидается base64')

/** Назначение сертификата: подпись сотрудника или печать организации. */
export const PKI_PURPOSES = ['person', 'seal'] as const
export const PkiPurpose = z.enum(PKI_PURPOSES)
export type PkiPurpose = z.infer<typeof PkiPurpose>

export const PKI_CERTIFICATE_STATES = ['active', 'revoked', 'expired'] as const
export const PkiCertificateState = z.enum(PKI_CERTIFICATE_STATES)
export type PkiCertificateState = z.infer<typeof PkiCertificateState>

/** Состояние УЦ: создан ли он и до какой поры действуют его сертификаты. */
/** Смена ключа выпускающего (ADR-0224): плановая или после компрометации прежнего. */
export const PKI_ROTATION_MODES = ['planned', 'compromise'] as const
export const PkiRotationMode = z.enum(PKI_ROTATION_MODES)
export type PkiRotationMode = z.infer<typeof PkiRotationMode>

export const PkiRotateInput = z.object({
  mode: PkiRotationMode,
  reason: z.string().trim().min(3).max(500),
})
export type PkiRotateInput = z.infer<typeof PkiRotateInput>

/** Выпускающий УЦ: текущий или прежний — его список отзыва публикуется дальше. */
export const PkiIssuer = z.object({
  fingerprint: z.string(),
  /** Адреса `/pki/<path>.crt` и `/pki/<path>.crl`. */
  path: z.string(),
  notAfter: Timestamp,
  current: z.boolean(),
  retiredAt: Timestamp.nullable(),
  reason: PkiRotationMode.nullable(),
  /** Отозван корнем — после компрометации. */
  revokedAt: Timestamp.nullable(),
})
export type PkiIssuer = z.infer<typeof PkiIssuer>

/** Срок ключа УЦ подходит к концу: пора сменить (`kchs pki rotate`, ADR-0224). */
export const PkiExpiry = z.object({
  kind: z.enum(['root', 'issuing', 'tsa']),
  notAfter: Timestamp,
})
export type PkiExpiry = z.infer<typeof PkiExpiry>

export const PkiStatus = z.object({
  initialized: z.boolean(),
  /** SHA-256 корневого сертификата — сверяют при установке доверия. */
  rootFingerprint: z.string().nullable(),
  rootSubject: z.string().nullable(),
  rootNotAfter: Timestamp.nullable(),
  issuingNotAfter: Timestamp.nullable(),
  /** Действующих сертификатов сотрудников и печати. */
  active: z.number().int().nonnegative(),
  /** Выпускающие: текущий первым, затем прежние (ADR-0224). */
  issuers: z.array(PkiIssuer),
  tsaNotAfter: Timestamp.nullable(),
  /** Ключи, срок которых подходит к концу, — предупреждение администратору. */
  expiring: z.array(PkiExpiry),
})
export type PkiStatus = z.infer<typeof PkiStatus>

export const PkiChallengeInput = z.object({ purpose: PkiPurpose.default('person') })
export type PkiChallengeInput = z.infer<typeof PkiChallengeInput>

/** Вызов для доказательства владения ключом: устройство подписывает его своим ключом. */
export const PkiChallenge = z.object({ challenge: z.string().min(16), expiresAt: Timestamp })
export type PkiChallenge = z.infer<typeof PkiChallenge>

/**
 * Выпуск сертификата: открытый ключ устройства (SubjectPublicKeyInfo, DER в base64),
 * подпись вызова этим ключом (RSASSA-PKCS1-v1_5, SHA-256) и код второго фактора.
 */
export const PkiEnrollInput = z.object({
  publicKey: Base64,
  challenge: z.string().min(16).max(1024),
  proof: Base64,
  deviceLabel: z.string().trim().min(1).max(120),
  purpose: PkiPurpose.default('person'),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
})
export type PkiEnrollInput = z.infer<typeof PkiEnrollInput>

export const PkiCertificateRecord = z.object({
  id: Uuid,
  serial: z.string(),
  purpose: PkiPurpose,
  /** Владелец — сотрудник (у печати — кто её держит на своём устройстве). */
  userId: Uuid,
  userName: z.string().nullable(),
  subject: z.string(),
  deviceLabel: z.string(),
  fingerprint: z.string(),
  state: PkiCertificateState,
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  revocationReason: z.string().nullable(),
  /** Сертификат (DER в base64) — устройство хранит его рядом с ключом. */
  certificate: z.string(),
})
export type PkiCertificateRecord = z.infer<typeof PkiCertificateRecord>

export const PkiCertificateList = z.object({ items: z.array(PkiCertificateRecord) })
export type PkiCertificateList = z.infer<typeof PkiCertificateList>

export const PkiAdminCertificateQuery = z.object({
  state: PkiCertificateState.optional(),
  q: z.string().trim().max(200).optional(),
})
export type PkiAdminCertificateQuery = z.infer<typeof PkiAdminCertificateQuery>

export const PkiRevokeInput = z.object({ reason: z.string().trim().max(500).optional() })
export type PkiRevokeInput = z.infer<typeof PkiRevokeInput>
