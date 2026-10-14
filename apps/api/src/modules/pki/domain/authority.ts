import { createHash, type KeyObject } from 'node:crypto'
import type { PkiStatus } from '@kchs/contracts'
import { and, count, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm'
import { audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { BrandingService } from '~/kernel/settings/branding.js'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { decryptSecret, encryptSecret } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { pkiAuthorities, pkiCertificates } from '../schema.js'
import * as A from './asn1.js'
import { PKI_AUDIT } from './audit-actions.js'

/**
 * Хранилище УЦ Комитета (ADR-0218): корневой и выпускающий сертификаты, сертификат службы
 * штампов времени. Закрытые ключи — шифром мастер-ключа; в памяти процесса — расшифрованные,
 * пока отпечаток сертификата тот же. Порт `PkiKeyStore` — место, где позже встанет HSM
 * (PKCS#11): подписывать будет он, а не процесс.
 */

export type AuthorityKind = 'root' | 'issuing' | 'tsa'

export interface LoadedAuthority {
  kind: AuthorityKind
  certificateDer: Buffer
  publicKeyDer: Buffer
  name: ReturnType<typeof A.parseCertificate>['subject']
  key: KeyObject
  fingerprint: string
}

const cache = new Map<AuthorityKind, LoadedAuthority>()
const crlCache = new Map<'root' | 'issuing', { der: Buffer; until: number }>()
const CRL_CACHE_MS = 10 * 60_000
/** Политика штампов времени УЦ: частный OID-узел 2.25 из UUID установки (RFC 4122 § 4.2). */
const TSA_POLICY = '2.25.311622381948061227045327946513358061401'

const YEAR = 365 * 86_400_000

export function fingerprintOf(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex')
}

/** База адресов, вшитых в сертификаты: публичный адрес установки (через шлюз DMZ). */
export function pkiBaseUrl(): string {
  return `${(config().KCHS_PKI_PUBLIC_URL ?? config().KCHS_BASE_URL).replace(/\/+$/, '')}/api/v1/pki`
}

async function loadAuthority(kind: AuthorityKind): Promise<LoadedAuthority | null> {
  const [row] = await db().select().from(pkiAuthorities).where(eq(pkiAuthorities.kind, kind))
  if (!row) return null
  const cached = cache.get(kind)
  if (cached && cached.fingerprint === row.fingerprint) return cached
  const certificateDer = A.fromPem(row.certificate)
  const parsed = A.parseCertificate(certificateDer)
  const loaded: LoadedAuthority = {
    kind,
    certificateDer,
    publicKeyDer: parsed.publicKeyDer,
    name: parsed.subject,
    key: A.privateKey(Buffer.from(decryptSecret(row.keyEnc), 'base64')),
    fingerprint: row.fingerprint,
  }
  cache.set(kind, loaded)
  return loaded
}

async function required(kind: AuthorityKind): Promise<LoadedAuthority> {
  const found = await loadAuthority(kind)
  if (!found) {
    throw errors.conflict('УЦ Комитета не создан: администратор создаёт его в консоли', {
      reason: 'pki_not_initialized',
    })
  }
  return found
}

function asIssuer(authority: LoadedAuthority) {
  return { name: authority.name, key: authority.key, publicKeyDer: authority.publicKeyDer }
}

export const PkiAuthority = {
  load: loadAuthority,
  required,

  async status(): Promise<PkiStatus> {
    const rows = await db().select().from(pkiAuthorities)
    const root = rows.find((row) => row.kind === 'root')
    const issuing = rows.find((row) => row.kind === 'issuing')
    const [active] = await db()
      .select({ value: count() })
      .from(pkiCertificates)
      .where(and(isNull(pkiCertificates.revokedAt), gt(pkiCertificates.expiresAt, sql`now()`)))
    return {
      initialized: Boolean(root && issuing),
      rootFingerprint: root?.fingerprint ?? null,
      rootSubject: root ? subjectText(A.fromPem(root.certificate)) : null,
      rootNotAfter: root?.notAfter ?? null,
      issuingNotAfter: issuing?.notAfter ?? null,
      active: active?.value ?? 0,
    }
  },

  /**
   * Создать УЦ: корневой (RSA 3072, 20 лет), выпускающий (RSA 3072, 10 лет, только для
   * сотрудников) и службу штампов времени (RSA 2048, 5 лет). Повторный вызов ничего не
   * меняет: ключи УЦ не пересоздаются, иначе все выпущенные подписи станут недоверенными.
   */
  async initialize(ctx: Ctx): Promise<PkiStatus> {
    const existing = await loadAuthority('root')
    if (existing) return PkiAuthority.status()
    const organization = (await BrandingService.current()).name
    const now = new Date()
    const base = pkiBaseUrl()
    const org = [
      { type: A.OID.organization, value: organization },
      { type: A.OID.country, value: 'TJ' },
    ]
    const rootPair = A.generateRsa(3072)
    const rootSubject = [{ type: A.OID.commonName, value: `Корневой УЦ — ${organization}` }, ...org]
    const rootKey = A.privateKey(rootPair.privateKeyDer)
    const rootName = A.buildName(rootSubject)
    const rootDer = A.issueCertificate({
      subject: rootSubject,
      issuer: { name: rootName, key: rootKey, publicKeyDer: rootPair.publicKeyDer },
      publicKeyDer: rootPair.publicKeyDer,
      serial: A.newSerial(),
      notBefore: now,
      notAfter: new Date(now.getTime() + 20 * YEAR),
      extensions: [
        A.ext.basicConstraints(true),
        A.ext.keyUsage(A.KeyUsage.keyCertSign | A.KeyUsage.cRLSign),
      ],
    })
    const rootIssuer = { name: rootName, key: rootKey, publicKeyDer: rootPair.publicKeyDer }
    const issuingPair = A.generateRsa(3072)
    const issuingSubject = [{ type: A.OID.commonName, value: `УЦ — ${organization}` }, ...org]
    const issuingDer = A.issueCertificate({
      subject: issuingSubject,
      issuer: rootIssuer,
      publicKeyDer: issuingPair.publicKeyDer,
      serial: A.newSerial(),
      notBefore: now,
      notAfter: new Date(now.getTime() + 10 * YEAR),
      extensions: [
        A.ext.basicConstraints(true, 0),
        A.ext.keyUsage(A.KeyUsage.keyCertSign | A.KeyUsage.cRLSign),
        A.ext.crlDistribution(`${base}/root.crl`),
        A.ext.authorityInfo({ caIssuers: `${base}/root.crt` }),
      ],
    })
    const issuingIssuer = {
      name: A.buildName(issuingSubject),
      key: A.privateKey(issuingPair.privateKeyDer),
      publicKeyDer: issuingPair.publicKeyDer,
    }
    const tsaPair = A.generateRsa(2048)
    const tsaDer = A.issueCertificate({
      subject: [
        { type: A.OID.commonName, value: `Служба штампов времени — ${organization}` },
        ...org,
      ],
      issuer: issuingIssuer,
      publicKeyDer: tsaPair.publicKeyDer,
      serial: A.newSerial(),
      notBefore: now,
      notAfter: new Date(now.getTime() + 5 * YEAR),
      extensions: [
        A.ext.basicConstraints(false),
        A.ext.keyUsage(A.KeyUsage.digitalSignature | A.KeyUsage.nonRepudiation),
        A.ext.extKeyUsage([A.OID.timeStamping], true),
        A.ext.crlDistribution(`${base}/issuing.crl`),
        A.ext.authorityInfo({ ocsp: `${base}/ocsp`, caIssuers: `${base}/issuing.crt` }),
      ],
    })
    const rows = [
      { kind: 'root', der: rootDer, pair: rootPair, years: 20 },
      { kind: 'issuing', der: issuingDer, pair: issuingPair, years: 10 },
      { kind: 'tsa', der: tsaDer, pair: tsaPair, years: 5 },
    ] as const
    const rootFingerprint = fingerprintOf(rootDer)
    await db().transaction(async (tx) => {
      // Гонка двух администраторов: второй упрётся в ключ таблицы и ничего не создаст
      const inserted = await tx
        .insert(pkiAuthorities)
        .values(
          rows.map((row) => ({
            kind: row.kind,
            certificate: A.pem('CERTIFICATE', row.der),
            keyEnc: encryptSecret(row.pair.privateKeyDer.toString('base64')),
            fingerprint: fingerprintOf(row.der),
            notAfter: new Date(now.getTime() + row.years * YEAR).toISOString(),
          })),
        )
        .onConflictDoNothing()
        .returning({ kind: pkiAuthorities.kind })
      if (inserted.length === 0) return
      await publishEvent(tx, ctx, { type: 'pki.initialized', payload: { rootFingerprint } })
      await audit(
        ctx,
        {
          action: PKI_AUDIT.initialized,
          severity: 'warning',
          details: { rootFingerprint },
        },
        tx,
      )
    })
    cache.clear()
    crlCache.clear()
    return PkiAuthority.status()
  },

  /** Цепочка для CMS и проверки: выпускающий и корневой (DER). */
  async chain(): Promise<{ issuing: Buffer; root: Buffer }> {
    const [issuing, root] = await Promise.all([required('issuing'), required('root')])
    return { issuing: issuing.certificateDer, root: root.certificateDer }
  },

  async issue(input: Omit<A.IssueInput, 'issuer'>): Promise<Buffer> {
    const issuing = await required('issuing')
    return A.issueCertificate({ ...input, issuer: asIssuer(issuing) })
  },

  /**
   * Список отзыва издателя: выпускающего — отозванные сертификаты сотрудников и печати,
   * корневого — пустой (выпускающий не отзывается без смены УЦ). Кэш — 10 минут или до
   * ближайшего отзыва; номер списка растёт с каждым новым списком.
   */
  async crl(kind: 'root' | 'issuing'): Promise<Buffer> {
    const cached = crlCache.get(kind)
    if (cached && cached.until > Date.now()) return cached.der
    const authority = await required(kind)
    const revoked =
      kind === 'issuing'
        ? await db()
            .select({ serial: pkiCertificates.serial, revokedAt: pkiCertificates.revokedAt })
            .from(pkiCertificates)
            .where(isNotNull(pkiCertificates.revokedAt))
        : []
    const [counter] = await db()
      .update(pkiAuthorities)
      .set({ crlNumber: sql`${pkiAuthorities.crlNumber} + 1` })
      .where(eq(pkiAuthorities.kind, kind))
      .returning({ number: pkiAuthorities.crlNumber })
    const now = new Date()
    const der = A.buildCrl({
      issuer: asIssuer(authority),
      thisUpdate: now,
      nextUpdate: new Date(now.getTime() + (kind === 'root' ? 30 : 7) * 86_400_000),
      number: counter?.number ?? 1,
      revoked: revoked.map((row) => ({
        serial: Buffer.from(row.serial, 'hex'),
        revokedAt: new Date(row.revokedAt as string),
      })),
    })
    crlCache.set(kind, { der, until: Date.now() + CRL_CACHE_MS })
    return der
  },

  /** Отзыв сертификата: следующий список отзыва строится заново. */
  forgetCrl(): void {
    crlCache.delete('issuing')
  },

  async ocsp(requestDer: Buffer): Promise<Buffer> {
    const issuing = await required('issuing')
    const rows = await db()
      .select({
        serial: pkiCertificates.serial,
        revokedAt: pkiCertificates.revokedAt,
      })
      .from(pkiCertificates)
    const bySerial = new Map(rows.map((row) => [row.serial, row.revokedAt]))
    return A.ocspResponse({
      requestDer,
      issuer: { certificateDer: issuing.certificateDer, key: issuing.key },
      statusOf: (serial) => {
        if (!bySerial.has(serial)) return { status: 'unknown' }
        const revokedAt = bySerial.get(serial)
        return revokedAt ? { status: 'revoked', at: new Date(revokedAt) } : { status: 'good' }
      },
    })
  },

  async timestamp(requestDer: Buffer): Promise<Buffer> {
    const [tsa, issuing] = await Promise.all([required('tsa'), required('issuing')])
    return A.timestampResponse({
      requestDer,
      tsa: { certificateDer: tsa.certificateDer, key: tsa.key, chainDer: [issuing.certificateDer] },
      policy: TSA_POLICY,
      serial: A.newSerial(),
    })
  },
}

/** Имя субъекта сертификата строкой «CN=…, O=…» — для списков и аудита. */
export function subjectText(der: Buffer): string {
  const { subject } = A.parseCertificate(der)
  const names: Record<string, string> = {
    [A.OID.commonName]: 'CN',
    [A.OID.organization]: 'O',
    [A.OID.organizationalUnit]: 'OU',
    [A.OID.title]: 'T',
    [A.OID.country]: 'C',
    [A.OID.userId]: 'UID',
  }
  return subject
    .flatMap((rdn) =>
      rdn.map((item) => `${names[item.type] ?? item.type}=${item.value.toString()}`),
    )
    .join(', ')
}
