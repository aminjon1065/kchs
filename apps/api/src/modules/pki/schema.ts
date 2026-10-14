import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from '../../kernel/directory/schema.js'
import { bytea, createdAt, tsCol } from '../../shared/db/columns.js'

/**
 * Ключи и сертификаты УЦ Комитета (ADR-0218): корневой, выпускающий, службы штампов
 * времени. Закрытый ключ — PKCS#8 шифром мастер-ключа (ADR-0143, `kchs secrets rotate`);
 * движок его не получает (ADR-0176). Сертификат — PEM, открытые данные.
 */
export const pkiAuthorities = pgTable('pki_authorities', {
  /** `root` | `issuing` | `tsa`. */
  kind: text('kind').primaryKey(),
  certificate: text('certificate').notNull(),
  keyEnc: bytea('key_enc').notNull(),
  fingerprint: text('fingerprint').notNull(),
  notAfter: tsCol('not_after').notNull(),
  /** Номер очередного списка отзыва этого издателя (CRLNumber растёт монотонно). */
  crlNumber: integer('crl_number').notNull().default(0),
  createdAt: createdAt(),
})

/**
 * Сертификаты сотрудников и печати организации. Ключ — на устройстве сотрудника
 * (WebCrypto, неизвлекаемый): здесь только сертификат и его судьба. Владелец сверяется
 * при подписании по `user_id` (у печати — держатель на своём устройстве).
 */
export const pkiCertificates = pgTable(
  'pki_certificates',
  {
    id: uuid('id').primaryKey(),
    serial: text('serial').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** `person` | `seal`. */
    purpose: text('purpose').notNull(),
    subject: text('subject').notNull(),
    deviceLabel: text('device_label').notNull(),
    certificate: text('certificate').notNull(),
    fingerprint: text('fingerprint').notNull(),
    issuedAt: tsCol('issued_at').notNull(),
    expiresAt: tsCol('expires_at').notNull(),
    revokedAt: tsCol('revoked_at'),
    revocationReason: text('revocation_reason'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('pki_certificates_serial_idx').on(t.serial),
    uniqueIndex('pki_certificates_fingerprint_idx').on(t.fingerprint),
    index('pki_certificates_user_idx').on(t.userId, t.issuedAt.desc()),
    index('pki_certificates_revoked_idx').on(t.revokedAt).where(sql`${t.revokedAt} IS NOT NULL`),
  ],
)
