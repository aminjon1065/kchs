import { createHash, type KeyObject } from 'node:crypto'
import type { PkiIssuer, PkiRotateInput, PkiStatus } from '@kchs/contracts'
import { and, count, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm'
import { audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { BrandingService } from '~/kernel/settings/branding.js'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { decryptSecret, encryptSecret } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { pkiAuthorities, pkiCertificates, pkiRetiredAuthorities } from '../schema.js'
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
  /** Имя в адресах `/pki/<path>.crt|.crl` (у выпускающего, ADR-0224). */
  path: string
}

/** Выпускающий — текущий или прежний (ADR-0224): у каждого свой список отзыва. */
interface IssuerRow {
  fingerprint: string
  path: string
  certificate: string
  keyEnc: Buffer
  notAfter: string
  current: boolean
  retiredAt: string | null
  reason: 'planned' | 'compromise' | null
  revokedAt: string | null
}

const cache = new Map<AuthorityKind, LoadedAuthority>()
const issuerCache = new Map<string, LoadedAuthority>()
const crlCache = new Map<string, { der: Buffer; until: number }>()
const CRL_CACHE_MS = 10 * 60_000
/** Политика штампов времени УЦ: частный OID-узел 2.25 из UUID установки (RFC 4122 § 4.2). */
const TSA_POLICY = '2.25.311622381948061227045327946513358061401'

const YEAR = 365 * 86_400_000
const MONTH = 30 * 86_400_000
/**
 * За сколько месяцев до конца срока ключ попадает в предупреждение (ADR-0224): выпускающий
 * и корень — за 24 (столько живёт сертификат сотрудника), служба штампов — за 6.
 */
const EXPIRY_WARNING_MONTHS: Record<AuthorityKind, number> = { root: 24, issuing: 24, tsa: 6 }

export function fingerprintOf(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex')
}

/** База адресов, вшитых в сертификаты: публичный адрес установки (через шлюз DMZ). */
export function pkiBaseUrl(): string {
  return `${(config().KCHS_PKI_PUBLIC_URL ?? config().KCHS_BASE_URL).replace(/\/+$/, '')}/api/v1/pki`
}

function loaded(
  kind: AuthorityKind,
  row: { certificate: string; keyEnc: Buffer; fingerprint: string; path: string },
): LoadedAuthority {
  const certificateDer = A.fromPem(row.certificate)
  const parsed = A.parseCertificate(certificateDer)
  return {
    kind,
    certificateDer,
    publicKeyDer: parsed.publicKeyDer,
    name: parsed.subject,
    key: A.privateKey(Buffer.from(decryptSecret(row.keyEnc), 'base64')),
    fingerprint: row.fingerprint,
    path: row.path,
  }
}

async function loadAuthority(kind: AuthorityKind): Promise<LoadedAuthority | null> {
  const [row] = await db().select().from(pkiAuthorities).where(eq(pkiAuthorities.kind, kind))
  if (!row) return null
  const cached = cache.get(kind)
  if (cached && cached.fingerprint === row.fingerprint) return cached
  const result = loaded(kind, row)
  cache.set(kind, result)
  return result
}

/** Выпускающие: текущий первым, затем прежние — новые раньше старых. */
async function issuerRows(): Promise<IssuerRow[]> {
  const [current] = await db()
    .select()
    .from(pkiAuthorities)
    .where(eq(pkiAuthorities.kind, 'issuing'))
  const retired = await db()
    .select()
    .from(pkiRetiredAuthorities)
    .where(eq(pkiRetiredAuthorities.kind, 'issuing'))
    .orderBy(sql`${pkiRetiredAuthorities.retiredAt} DESC`)
  return [
    ...(current
      ? [{ ...current, current: true, retiredAt: null, reason: null, revokedAt: null }]
      : []),
    ...retired.map((row) => ({
      ...row,
      current: false,
      reason: row.reason as 'planned' | 'compromise',
    })),
  ]
}

async function loadIssuer(row: IssuerRow): Promise<LoadedAuthority> {
  const cached = issuerCache.get(row.fingerprint)
  if (cached) return cached
  const result = loaded('issuing', row)
  issuerCache.set(row.fingerprint, result)
  return result
}

/** Выпускающий по имени в адресах (`issuing`, `issuers/<начало отпечатка>`). */
async function issuerByPath(path: string): Promise<{ row: IssuerRow; authority: LoadedAuthority }> {
  const row = (await issuerRows()).find((item) => item.path === path)
  if (!row) throw errors.notFound('Выпускающий УЦ')
  return { row, authority: await loadIssuer(row) }
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

function forgetAll(): void {
  cache.clear()
  issuerCache.clear()
  crlCache.clear()
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
    const tsa = rows.find((row) => row.kind === 'tsa')
    const [active] = await db()
      .select({ value: count() })
      .from(pkiCertificates)
      .where(and(isNull(pkiCertificates.revokedAt), gt(pkiCertificates.expiresAt, sql`now()`)))
    const issuers: PkiIssuer[] = (await issuerRows()).map((row) => ({
      fingerprint: row.fingerprint,
      path: row.path,
      notAfter: row.notAfter,
      current: row.current,
      retiredAt: row.retiredAt,
      reason: row.reason,
      revokedAt: row.revokedAt,
    }))
    // Предупреждение администратору: пора сменить ключ (консоль и «Здоровье системы»)
    const expiring = rows.flatMap((row) => {
      const kind = row.kind as AuthorityKind
      const warnFrom = Date.parse(row.notAfter) - EXPIRY_WARNING_MONTHS[kind] * MONTH
      return Date.now() >= warnFrom ? [{ kind, notAfter: row.notAfter }] : []
    })
    return {
      initialized: Boolean(root && issuing),
      rootFingerprint: root?.fingerprint ?? null,
      rootSubject: root ? subjectText(A.fromPem(root.certificate)) : null,
      rootNotAfter: root?.notAfter ?? null,
      issuingNotAfter: issuing?.notAfter ?? null,
      active: active?.value ?? 0,
      issuers,
      tsaNotAfter: tsa?.notAfter ?? null,
      expiring,
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
    forgetAll()
    return PkiAuthority.status()
  },

  /**
   * Цепочка для CMS и проверки: выпускающий сертификата и корневой (DER). Сертификат,
   * выпущенный прежним выпускающим (ADR-0224), идёт со своим выпускающим.
   */
  async chain(certificateDer?: Buffer): Promise<{ issuing: Buffer; root: Buffer }> {
    const [current, root] = await Promise.all([required('issuing'), required('root')])
    if (!certificateDer) return { issuing: current.certificateDer, root: root.certificateDer }
    const [row] = await db()
      .select({ issuer: pkiCertificates.issuerFingerprint })
      .from(pkiCertificates)
      .where(eq(pkiCertificates.fingerprint, fingerprintOf(certificateDer)))
      .limit(1)
    const issuer = (await issuerRows()).find((item) => item.fingerprint === row?.issuer)
    const issuing = issuer ? await loadIssuer(issuer) : current
    return { issuing: issuing.certificateDer, root: root.certificateDer }
  },

  /** Текущий выпускающий: отпечаток и имя в адресах — их вшивают в сертификат. */
  async currentIssuer(): Promise<{ fingerprint: string; path: string }> {
    const issuing = await required('issuing')
    return { fingerprint: issuing.fingerprint, path: issuing.path }
  },

  /** Выпустить сертификат текущим выпускающим. */
  async issue(input: Omit<A.IssueInput, 'issuer'>): Promise<Buffer> {
    const issuing = await required('issuing')
    return A.issueCertificate({ ...input, issuer: asIssuer(issuing) })
  },

  /** Сертификат выпускающего по имени в адресах — текущего или прежнего. */
  async issuerCertificate(path: string): Promise<Buffer> {
    return (await issuerByPath(path)).authority.certificateDer
  },

  /** Списки отзыва всех выпускающих и корня — в политику проверки подписи (PAdES-B-LT). */
  async allCrls(): Promise<Buffer[]> {
    const rows = await issuerRows()
    return [
      ...(await Promise.all(rows.map((row) => PkiAuthority.crl(row.path)))),
      await PkiAuthority.crl('root'),
    ]
  },

  /**
   * Список отзыва издателя: выпускающего — отозванные сертификаты сотрудников и печати,
   * корневого — пустой (выпускающий не отзывается без смены УЦ). Кэш — 10 минут или до
   * ближайшего отзыва; номер списка растёт с каждым новым списком.
   */
  async crl(path: 'root' | string): Promise<Buffer> {
    const cached = crlCache.get(path)
    if (cached && cached.until > Date.now()) return cached.der
    let authority: LoadedAuthority
    let revoked: Array<{ serial: string; revokedAt: string | null }>
    let number: number
    if (path === 'root') {
      authority = await required('root')
      // Корень отзывает выпускающего, ключ которого скомпрометирован (ADR-0224)
      revoked = (await issuerRows())
        .filter((row) => row.revokedAt !== null)
        .map((row) => ({
          serial: A.parseCertificate(A.fromPem(row.certificate)).serial.toString('hex'),
          revokedAt: row.revokedAt,
        }))
      const [counter] = await db()
        .update(pkiAuthorities)
        .set({ crlNumber: sql`${pkiAuthorities.crlNumber} + 1` })
        .where(eq(pkiAuthorities.kind, 'root'))
        .returning({ number: pkiAuthorities.crlNumber })
      number = counter?.number ?? 1
    } else {
      const issuer = await issuerByPath(path)
      authority = issuer.authority
      revoked = await db()
        .select({ serial: pkiCertificates.serial, revokedAt: pkiCertificates.revokedAt })
        .from(pkiCertificates)
        .where(
          and(
            isNotNull(pkiCertificates.revokedAt),
            eq(pkiCertificates.issuerFingerprint, issuer.row.fingerprint),
          ),
        )
      const [counter] = issuer.row.current
        ? await db()
            .update(pkiAuthorities)
            .set({ crlNumber: sql`${pkiAuthorities.crlNumber} + 1` })
            .where(eq(pkiAuthorities.kind, 'issuing'))
            .returning({ number: pkiAuthorities.crlNumber })
        : await db()
            .update(pkiRetiredAuthorities)
            .set({ crlNumber: sql`${pkiRetiredAuthorities.crlNumber} + 1` })
            .where(eq(pkiRetiredAuthorities.fingerprint, issuer.row.fingerprint))
            .returning({ number: pkiRetiredAuthorities.crlNumber })
      number = counter?.number ?? 1
    }
    const now = new Date()
    const der = A.buildCrl({
      issuer: asIssuer(authority),
      thisUpdate: now,
      nextUpdate: new Date(now.getTime() + (path === 'root' ? 30 : 7) * 86_400_000),
      number,
      revoked: revoked.map((row) => ({
        serial: Buffer.from(row.serial, 'hex'),
        revokedAt: new Date(row.revokedAt as string),
      })),
    })
    crlCache.set(path, { der, until: Date.now() + CRL_CACHE_MS })
    return der
  },

  /** Отзыв сертификата: списки отзыва выпускающих строятся заново. */
  forgetCrl(): void {
    for (const key of crlCache.keys()) if (key !== 'root') crlCache.delete(key)
  },

  async ocsp(requestDer: Buffer): Promise<Buffer> {
    // Ответ подписывает тот выпускающий, о чьих сертификатах спрашивают (ADR-0224)
    const asked = A.ocspIssuerKeyHash(requestDer)
    let issuing = await required('issuing')
    if (asked) {
      for (const row of await issuerRows()) {
        const candidate = await loadIssuer(row)
        if (A.issuerKeyHash(candidate.publicKeyDer, asked.algorithm)?.equals(asked.hash)) {
          issuing = candidate
          break
        }
      }
    }
    const rows = await db()
      .select({
        serial: pkiCertificates.serial,
        revokedAt: pkiCertificates.revokedAt,
      })
      .from(pkiCertificates)
      .where(eq(pkiCertificates.issuerFingerprint, issuing.fingerprint))
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

  /**
   * Смена ключа выпускающего (ADR-0224): новый выпускающий от того же корня и новая служба
   * штампов времени под ним. Прежние уходят в `pki_retired_authorities` с ключами: прежний
   * выпускающий подписывает свой список отзыва дальше, его сертификаты и подписи остаются
   * проверяемыми. При компрометации корень отзывает прежнего выпускающего, а сертификаты
   * сотрудников перевыпускаются при следующем подписании (`PkiCertificates.owner`).
   */
  async rotate(ctx: Ctx, input: PkiRotateInput): Promise<PkiStatus> {
    const [root, issuing, tsa] = await Promise.all([
      required('root'),
      required('issuing'),
      required('tsa'),
    ])
    const [issuingRow] = await db()
      .select()
      .from(pkiAuthorities)
      .where(eq(pkiAuthorities.kind, 'issuing'))
    const [tsaRow] = await db().select().from(pkiAuthorities).where(eq(pkiAuthorities.kind, 'tsa'))
    const [rootRow] = await db()
      .select({ notAfter: pkiAuthorities.notAfter })
      .from(pkiAuthorities)
      .where(eq(pkiAuthorities.kind, 'root'))
    if (!issuingRow || !tsaRow || !rootRow) throw errors.conflict('УЦ Комитета не создан')
    // Выпускающий не переживает корень: его сертификат действует не дольше корневого
    const rootNotAfter = Date.parse(rootRow.notAfter)
    const organization = (await BrandingService.current()).name
    const now = new Date()
    const base = pkiBaseUrl()
    const org = [
      { type: A.OID.organization, value: organization },
      { type: A.OID.country, value: 'TJ' },
    ]
    const issuingPair = A.generateRsa(3072)
    const issuingSubject = [{ type: A.OID.commonName, value: `УЦ — ${organization}` }, ...org]
    const issuingNotAfter = new Date(Math.min(now.getTime() + 10 * YEAR, rootNotAfter))
    const issuingDer = A.issueCertificate({
      subject: issuingSubject,
      issuer: asIssuer(root),
      publicKeyDer: issuingPair.publicKeyDer,
      serial: A.newSerial(),
      notBefore: now,
      notAfter: issuingNotAfter,
      extensions: [
        A.ext.basicConstraints(true, 0),
        A.ext.keyUsage(A.KeyUsage.keyCertSign | A.KeyUsage.cRLSign),
        A.ext.crlDistribution(`${base}/root.crl`),
        A.ext.authorityInfo({ caIssuers: `${base}/root.crt` }),
      ],
    })
    const issuingFingerprint = fingerprintOf(issuingDer)
    const path = `issuers/${issuingFingerprint.slice(0, 16)}`
    const tsaPair = A.generateRsa(2048)
    const tsaNotAfter = new Date(Math.min(now.getTime() + 5 * YEAR, issuingNotAfter.getTime()))
    const tsaDer = A.issueCertificate({
      subject: [
        { type: A.OID.commonName, value: `Служба штампов времени — ${organization}` },
        ...org,
      ],
      issuer: {
        name: A.buildName(issuingSubject),
        key: A.privateKey(issuingPair.privateKeyDer),
        publicKeyDer: issuingPair.publicKeyDer,
      },
      publicKeyDer: tsaPair.publicKeyDer,
      serial: A.newSerial(),
      notBefore: now,
      notAfter: tsaNotAfter,
      extensions: [
        A.ext.basicConstraints(false),
        A.ext.keyUsage(A.KeyUsage.digitalSignature | A.KeyUsage.nonRepudiation),
        A.ext.extKeyUsage([A.OID.timeStamping], true),
        A.ext.crlDistribution(`${base}/${path}.crl`),
        A.ext.authorityInfo({ ocsp: `${base}/ocsp`, caIssuers: `${base}/${path}.crt` }),
      ],
    })
    const retiredAt = now.toISOString()
    const compromise = input.mode === 'compromise'
    await db().transaction(async (tx) => {
      // Две смены разом: вторая увидит другой отпечаток текущего и ничего не сделает
      const [locked] = await tx
        .select({ fingerprint: pkiAuthorities.fingerprint })
        .from(pkiAuthorities)
        .where(eq(pkiAuthorities.kind, 'issuing'))
        .for('update')
      if (locked?.fingerprint !== issuing.fingerprint) {
        throw errors.conflict('Ключ выпускающего уже сменили — обновите страницу')
      }
      await tx.insert(pkiRetiredAuthorities).values([
        {
          id: newId(),
          kind: 'issuing',
          certificate: issuingRow.certificate,
          keyEnc: issuingRow.keyEnc,
          fingerprint: issuingRow.fingerprint,
          notAfter: issuingRow.notAfter,
          crlNumber: issuingRow.crlNumber,
          path: issuingRow.path,
          reason: input.mode,
          retiredAt,
          revokedAt: compromise ? retiredAt : null,
          retiredBy: ctx.kind === 'user' ? ctx.userId : null,
        },
        {
          id: newId(),
          kind: 'tsa',
          certificate: tsaRow.certificate,
          keyEnc: tsaRow.keyEnc,
          fingerprint: tsaRow.fingerprint,
          notAfter: tsaRow.notAfter,
          crlNumber: tsaRow.crlNumber,
          path: `tsa/${tsaRow.fingerprint.slice(0, 16)}`,
          reason: input.mode,
          retiredAt,
          revokedAt: null,
          retiredBy: ctx.kind === 'user' ? ctx.userId : null,
        },
      ])
      await tx
        .update(pkiAuthorities)
        .set({
          certificate: A.pem('CERTIFICATE', issuingDer),
          keyEnc: encryptSecret(issuingPair.privateKeyDer.toString('base64')),
          fingerprint: issuingFingerprint,
          notAfter: issuingNotAfter.toISOString(),
          crlNumber: 0,
          path,
        })
        .where(eq(pkiAuthorities.kind, 'issuing'))
      await tx
        .update(pkiAuthorities)
        .set({
          certificate: A.pem('CERTIFICATE', tsaDer),
          keyEnc: encryptSecret(tsaPair.privateKeyDer.toString('base64')),
          fingerprint: fingerprintOf(tsaDer),
          notAfter: tsaNotAfter.toISOString(),
          crlNumber: 0,
        })
        .where(eq(pkiAuthorities.kind, 'tsa'))
      const payload = {
        mode: input.mode,
        previousFingerprint: issuing.fingerprint,
        issuingFingerprint,
      }
      await publishEvent(tx, ctx, { type: 'pki.rotated', payload })
      await audit(
        ctx,
        {
          action: PKI_AUDIT.rotated,
          severity: compromise ? 'critical' : 'warning',
          details: { ...payload, reason: input.reason, tsaFingerprint: tsa.fingerprint },
        },
        tx,
      )
    })
    forgetAll()
    return PkiAuthority.status()
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
