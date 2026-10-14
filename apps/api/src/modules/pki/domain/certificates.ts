import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  PkiAdminCertificateQuery,
  PkiCertificateList,
  PkiCertificateRecord,
  PkiChallenge,
  PkiEnrollInput,
  PkiPurpose,
} from '@kchs/contracts'
import { and, desc, eq, gt, ilike, isNotNull, isNull, lte, or, type SQL, sql } from 'drizzle-orm'
import { requireCapability } from '~/kernel/access/authorize.js'
import { audit } from '~/kernel/audit/service.js'
import { UserService } from '~/kernel/directory/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { confirmSecondFactor } from '~/kernel/second-factor/port.js'
import { BrandingService } from '~/kernel/settings/branding.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { signingKeys } from '~/shared/crypto/secrets.js'
import { db, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { pkiCertificates } from '../schema.js'
import * as A from './asn1.js'
import { PKI_AUDIT } from './audit-actions.js'
import { fingerprintOf, PkiAuthority, pkiBaseUrl, subjectText } from './authority.js'

/** Причина отзыва прежнего сертификата при перевыпуске (ADR-0224). */
const REISSUED_REASON = 'Перевыпущен после смены ключа УЦ'

/**
 * Сертификаты сотрудников и печати (ADR-0218). Ключ создаёт браузер (WebCrypto, RSA 2048,
 * неизвлекаемый) — сюда приходят только открытый ключ и подпись вызова им: доказательство,
 * что ключ у того, кто просит. Выпуск — после второго фактора, субъект — из справочника
 * людей, а не из запроса: сотрудник не может назваться другим.
 */

const CHALLENGE_PURPOSE = 'kchs:pki-enroll:v1'
const CHALLENGE_TTL_MS = 10 * 60_000
/** Срок сертификата сотрудника: два года — потом новый ключ на устройстве. */
const VALIDITY_MS = 2 * 365 * 86_400_000

type Row = typeof pkiCertificates.$inferSelect

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url')
}

function challengeFor(userId: string, purpose: PkiPurpose): PkiChallenge {
  const [key] = signingKeys(CHALLENGE_PURPOSE)
  if (!key) throw new Error('KCHS_MASTER_KEY не задан: вызов подписать нечем')
  const expiresAt = Date.now() + CHALLENGE_TTL_MS
  const payload = Buffer.from(
    JSON.stringify({ u: userId, p: purpose, n: randomBytes(16).toString('hex'), e: expiresAt }),
  ).toString('base64url')
  return {
    challenge: `${payload}.${sign(key, payload)}`,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

function challengeValid(challenge: string, userId: string, purpose: PkiPurpose): boolean {
  const [payload, signature, ...rest] = challenge.split('.')
  if (!payload || !signature || rest.length > 0) return false
  const provided = Buffer.from(signature, 'base64url')
  const signed = signingKeys(CHALLENGE_PURPOSE).some((key) => {
    const expected = Buffer.from(sign(key, payload), 'base64url')
    return expected.length === provided.length && timingSafeEqual(expected, provided)
  })
  if (!signed) return false
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: unknown
      p?: unknown
      e?: unknown
    }
    return claims.u === userId && claims.p === purpose && Number(claims.e) > Date.now()
  } catch {
    return false
  }
}

function state(row: Row, now = Date.now()): PkiCertificateRecord['state'] {
  if (row.revokedAt) return 'revoked'
  return Date.parse(row.expiresAt) <= now ? 'expired' : 'active'
}

function present(row: Row, userName: string | null): PkiCertificateRecord {
  return {
    id: row.id,
    serial: row.serial,
    purpose: row.purpose as PkiPurpose,
    userId: row.userId,
    userName,
    subject: row.subject,
    deviceLabel: row.deviceLabel,
    fingerprint: row.fingerprint,
    state: state(row),
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
    certificate: A.fromPem(row.certificate).toString('base64'),
  }
}

async function listWhere(where: SQL | undefined): Promise<PkiCertificateList> {
  const rows = await db()
    .select()
    .from(pkiCertificates)
    .where(where)
    .orderBy(desc(pkiCertificates.issuedAt))
    .limit(500)
  // Имена владельцев — через справочник ядра: таблицы людей модулю не читать (ADR-0178)
  const people = await UserService.refs([...new Set(rows.map((row) => row.userId))])
  return {
    items: rows.map((row) => present(row, people.get(row.userId)?.displayName ?? null)),
  }
}

async function revokeRow(tx: Tx, ctx: Ctx, row: Row, reason: string | null): Promise<Row> {
  if (row.revokedAt) return row
  const [updated] = await tx
    .update(pkiCertificates)
    .set({
      revokedAt: sql`now()`,
      revocationReason: reason,
      revokedBy: ctx.kind === 'user' ? ctx.userId : null,
    })
    .where(and(eq(pkiCertificates.id, row.id), isNull(pkiCertificates.revokedAt)))
    .returning()
  if (!updated) return row
  await publishEvent(tx, ctx, {
    type: 'pki.certificate_revoked',
    payload: { certificateId: row.id, userId: row.userId, serial: row.serial, reason },
  })
  await audit(
    ctx,
    {
      action: PKI_AUDIT.certificateRevoked,
      objectId: row.userId,
      objectType: 'user',
      severity: 'warning',
      details: { certificateId: row.id, serial: row.serial, purpose: row.purpose, reason },
    },
    tx,
  )
  return updated
}

/** Расширения сертификата сотрудника и печати: адреса — того выпускающего, кто выпустил. */
function personExtensions(issuerPath: string) {
  const base = pkiBaseUrl()
  return [
    A.ext.basicConstraints(false),
    A.ext.keyUsage(A.KeyUsage.digitalSignature | A.KeyUsage.nonRepudiation),
    A.ext.extKeyUsage([A.OID.documentSigning, A.OID.emailProtection]),
    A.ext.crlDistribution(`${base}/${issuerPath}.crl`),
    A.ext.authorityInfo({ ocsp: `${base}/ocsp`, caIssuers: `${base}/${issuerPath}.crt` }),
  ]
}

/** Действующий преемник перевыпущенного сертификата. */
async function successor(row: Row): Promise<Row | null> {
  if (!row.replacedBy) return null
  const [next] = await db()
    .select()
    .from(pkiCertificates)
    .where(eq(pkiCertificates.id, row.replacedBy))
    .limit(1)
  return next && state(next) === 'active' ? next : null
}

/**
 * Перевыпуск при следующем подписании (ADR-0224): выпускающий сертификата отозван корнем
 * после компрометации, а сам сертификат действует — тот же ключ устройства и субъект
 * получают сертификат текущего выпускающего на оставшийся срок. Прежний отзывается с
 * пометкой о замене. Владение ключом подтверждает сама подпись: CMS собирается из подписи
 * устройства и проверяется по ключу нового сертификата.
 */
async function reissueIfCompromised(row: Row): Promise<Row | null> {
  if (state(row) !== 'active' || !row.issuerFingerprint) return null
  const status = await PkiAuthority.status()
  const issuer = status.issuers.find((item) => item.fingerprint === row.issuerFingerprint)
  if (!issuer?.revokedAt) return null
  const old = A.parseCertificate(A.fromPem(row.certificate))
  const current = await PkiAuthority.currentIssuer()
  const now = new Date()
  const serial = A.newSerial()
  const der = await PkiAuthority.issue({
    subject: old.subject,
    publicKeyDer: old.publicKeyDer,
    serial,
    notBefore: now,
    notAfter: new Date(row.expiresAt),
    extensions: personExtensions(current.path),
  })
  const id = newId()
  const ctx = systemCtx('pki.reissue')
  const inserted = await db().transaction(async (tx) => {
    // Две подписи разом: перевыпускает первая, вторая берёт её преемника
    const [locked] = await tx
      .select({ replacedBy: pkiCertificates.replacedBy })
      .from(pkiCertificates)
      .where(eq(pkiCertificates.id, row.id))
      .for('update')
    if (locked?.replacedBy) return null
    const [created] = await tx
      .insert(pkiCertificates)
      .values({
        id,
        serial: serial.toString('hex'),
        userId: row.userId,
        purpose: row.purpose,
        subject: subjectText(der),
        deviceLabel: row.deviceLabel,
        certificate: A.pem('CERTIFICATE', der),
        fingerprint: fingerprintOf(der),
        issuedAt: now.toISOString(),
        expiresAt: row.expiresAt,
        issuerFingerprint: current.fingerprint,
      })
      .returning()
    await tx
      .update(pkiCertificates)
      .set({
        revokedAt: now.toISOString(),
        revocationReason: REISSUED_REASON,
        replacedBy: id,
      })
      .where(eq(pkiCertificates.id, row.id))
    await publishEvent(tx, ctx, {
      type: 'pki.certificate_issued',
      payload: {
        certificateId: id,
        userId: row.userId,
        purpose: row.purpose as PkiPurpose,
        serial: serial.toString('hex'),
      },
    })
    await audit(
      ctx,
      {
        action: PKI_AUDIT.reissued,
        objectId: row.userId,
        objectType: 'user',
        severity: 'notice',
        details: { certificateId: id, previous: row.id, purpose: row.purpose },
      },
      tx,
    )
    return created as Row
  })
  PkiAuthority.forgetCrl()
  if (inserted) return inserted
  const [refreshed] = await db()
    .select()
    .from(pkiCertificates)
    .where(eq(pkiCertificates.id, row.id))
    .limit(1)
  return refreshed ? successor(refreshed) : null
}

export const PkiCertificates = {
  async challenge(ctx: UserCtx, purpose: PkiPurpose): Promise<PkiChallenge> {
    if (purpose === 'seal') requireCapability(ctx, 'documents.seal')
    // Без УЦ выпуск не начинается: ключ на устройстве не создаётся впустую
    await PkiAuthority.required('issuing')
    return challengeFor(ctx.userId, purpose)
  },

  async enroll(ctx: UserCtx, input: PkiEnrollInput): Promise<PkiCertificateRecord> {
    if (input.purpose === 'seal') requireCapability(ctx, 'documents.seal')
    const publicKeyDer = Buffer.from(input.publicKey, 'base64')
    let proofValid = false
    try {
      proofValid =
        challengeValid(input.challenge, ctx.userId, input.purpose) &&
        A.verifySha256(
          publicKeyDer,
          Buffer.from(input.challenge, 'utf8'),
          Buffer.from(input.proof, 'base64'),
        )
    } catch (error) {
      throw errors.validation('Ключ устройства не подходит', [
        {
          path: 'publicKey',
          message: error instanceof Error ? error.message : 'ключ не разбирается',
        },
      ])
    }
    if (!proofValid) {
      await audit(ctx, {
        action: PKI_AUDIT.enrollmentRejected,
        objectId: ctx.userId,
        objectType: 'user',
        severity: 'warning',
        details: { reason: 'proof', purpose: input.purpose },
      })
      throw errors.validation('Подпись вызова не сходится с ключом или вызов устарел', [
        { path: 'proof', message: 'Создайте ключ заново' },
      ])
    }
    // Выпуск подписи — как сама подпись: подтверждение вторым фактором
    await confirmSecondFactor(ctx.userId, input.code)
    const [person] = [...(await UserService.refs([ctx.userId])).values()]
    if (!person) throw errors.notFound('Сотрудник')
    const organization = (await BrandingService.current()).name
    const subject =
      input.purpose === 'seal'
        ? [
            { type: A.OID.commonName, value: organization },
            { type: A.OID.title, value: 'Печать организации' },
            { type: A.OID.organization, value: organization },
            { type: A.OID.country, value: 'TJ' },
          ]
        : [
            { type: A.OID.commonName, value: person.displayName },
            ...(person.position ? [{ type: A.OID.title, value: person.position }] : []),
            { type: A.OID.organization, value: organization },
            { type: A.OID.country, value: 'TJ' },
            // Владелец ключа — сотрудник платформы (N121): сверка при подписании по нему
            { type: A.OID.userId, value: ctx.userId },
          ]
    const now = new Date()
    const serial = A.newSerial()
    const issuer = await PkiAuthority.currentIssuer()
    const der = await PkiAuthority.issue({
      subject,
      publicKeyDer,
      serial,
      notBefore: now,
      notAfter: new Date(now.getTime() + VALIDITY_MS),
      extensions: personExtensions(issuer.path),
    })
    const id = newId()
    const row = await db().transaction(async (tx) => {
      const [inserted] = await tx
        .insert(pkiCertificates)
        .values({
          id,
          serial: serial.toString('hex'),
          userId: ctx.userId,
          purpose: input.purpose,
          subject: subjectText(der),
          deviceLabel: input.deviceLabel,
          certificate: A.pem('CERTIFICATE', der),
          fingerprint: fingerprintOf(der),
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + VALIDITY_MS).toISOString(),
          issuerFingerprint: issuer.fingerprint,
        })
        .returning()
      await publishEvent(tx, ctx, {
        type: 'pki.certificate_issued',
        payload: {
          certificateId: id,
          userId: ctx.userId,
          purpose: input.purpose,
          serial: serial.toString('hex'),
        },
      })
      await audit(
        ctx,
        {
          action: PKI_AUDIT.certificateIssued,
          objectId: ctx.userId,
          objectType: 'user',
          severity: 'notice',
          details: { certificateId: id, purpose: input.purpose, device: input.deviceLabel },
        },
        tx,
      )
      return inserted as Row
    })
    return present(row, person.displayName)
  },

  async mine(ctx: UserCtx): Promise<PkiCertificateList> {
    return listWhere(eq(pkiCertificates.userId, ctx.userId))
  },

  /** Отзыв своего сертификата («ключ утерян», «устройство сменилось»). */
  async revokeMine(ctx: UserCtx, id: string, reason: string | null): Promise<PkiCertificateRecord> {
    const result = await db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(pkiCertificates)
        .where(and(eq(pkiCertificates.id, id), eq(pkiCertificates.userId, ctx.userId)))
        .for('update')
      if (!row) throw errors.notFound('Сертификат')
      return revokeRow(tx, ctx, row, reason ?? 'отозван владельцем')
    })
    PkiAuthority.forgetCrl()
    return present(result, null)
  },

  async list(ctx: UserCtx, query: PkiAdminCertificateQuery): Promise<PkiCertificateList> {
    requireCapability(ctx, 'users.manage')
    const conditions: SQL[] = []
    if (query.state === 'revoked') conditions.push(isNotNull(pkiCertificates.revokedAt))
    if (query.state === 'active') {
      conditions.push(isNull(pkiCertificates.revokedAt), gt(pkiCertificates.expiresAt, sql`now()`))
    }
    if (query.state === 'expired') {
      conditions.push(isNull(pkiCertificates.revokedAt), lte(pkiCertificates.expiresAt, sql`now()`))
    }
    if (query.q) {
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`
      // В субъекте сертификата сотрудника — его ФИО; у печати — устройство держателя
      const match = or(
        ilike(pkiCertificates.subject, pattern),
        ilike(pkiCertificates.deviceLabel, pattern),
        ilike(pkiCertificates.serial, pattern),
      )
      if (match) conditions.push(match)
    }
    return listWhere(conditions.length > 0 ? and(...conditions) : undefined)
  },

  async revoke(ctx: UserCtx, id: string, reason: string | null): Promise<PkiCertificateRecord> {
    requireCapability(ctx, 'users.manage')
    const result = await db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(pkiCertificates)
        .where(eq(pkiCertificates.id, id))
        .for('update')
      if (!row) throw errors.notFound('Сертификат')
      return revokeRow(tx, ctx, row, reason ?? 'отозван администратором')
    })
    PkiAuthority.forgetCrl()
    return present(result, null)
  },

  /** Все сертификаты сотрудника — при блокировке учётной записи. */
  async revokeAllOf(ctx: Ctx, userId: string, reason: string): Promise<number> {
    const revoked = await db().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(pkiCertificates)
        .where(and(eq(pkiCertificates.userId, userId), isNull(pkiCertificates.revokedAt)))
        .for('update')
      for (const row of rows) await revokeRow(tx, ctx, row, reason)
      return rows.length
    })
    if (revoked > 0) PkiAuthority.forgetCrl()
    return revoked
  },

  /**
   * Владелец сертификата для подписания (N121): выпущен ли он УЦ Комитета, кому, для чего
   * и действует ли. Печать подписывает её держатель, пока у него есть способность.
   */
  async owner(
    certificateDer: Buffer,
  ): Promise<{ userId: string; purpose: PkiPurpose; active: boolean; current?: Buffer } | null> {
    const [found] = await db()
      .select()
      .from(pkiCertificates)
      .where(eq(pkiCertificates.fingerprint, fingerprintOf(certificateDer)))
      .limit(1)
    if (!found) return null
    // Перевыпущенный после компрометации выпускающего (ADR-0224): подпись — преемником
    const row = (await successor(found)) ?? (await reissueIfCompromised(found)) ?? found
    return {
      userId: row.userId,
      purpose: row.purpose as PkiPurpose,
      active: state(row) === 'active',
      ...(row.id !== found.id ? { current: A.fromPem(row.certificate) } : {}),
    }
  },
}
