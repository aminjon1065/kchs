import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: УЦ Комитета (ADR-0218). Домен `pki` целиком принадлежит этому файлу
 * (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const PKI_EVENTS = {
  /** Созданы корневой и выпускающий сертификаты и сертификат службы штампов времени. */
  'pki.initialized': z.object({ rootFingerprint: z.string() }),
  /** Смена ключа выпускающего (ADR-0224): плановая или после компрометации. */
  'pki.rotated': z.object({
    mode: z.enum(['planned', 'compromise']),
    previousFingerprint: z.string(),
    issuingFingerprint: z.string(),
  }),
  /** Выпущен сертификат сотрудника или печати по ключу устройства. */
  'pki.certificate_issued': z.object({
    certificateId: Uuid,
    userId: Uuid,
    purpose: z.enum(['person', 'seal']),
    serial: z.string(),
  }),
  /** Сертификат отозван: самим сотрудником, администратором или при блокировке. */
  'pki.certificate_revoked': z.object({
    certificateId: Uuid,
    userId: Uuid,
    serial: z.string(),
    reason: z.string().nullable().default(null),
  }),
} as const satisfies Record<string, z.ZodType>
