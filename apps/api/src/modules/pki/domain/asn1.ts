import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'
import { OCSPRequest } from '@peculiar/asn1-ocsp'
import { AsnConvert, AsnParser, OctetString } from '@peculiar/asn1-schema'
import { TimeStampReq } from '@peculiar/asn1-tsp'
import * as X from '@peculiar/asn1-x509'

/**
 * Криптографические структуры УЦ Комитета (ADR-0218): сертификаты и CRL — классами
 * `@peculiar/asn1-x509`, CMS, ответы OCSP и службы штампов времени — короткими функциями
 * DER (структуры фиксированные), разбор запросов — `@peculiar/asn1-ocsp` и `-tsp`. Подпись —
 * `node:crypto`, RSASSA-PKCS1-v1_5 с SHA-256: её проверяет любая программа чтения PDF.
 */

// ─── OID ─────────────────────────────────────────────────────────────────────

export const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha1: '1.3.14.3.2.26',
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  ocspBasic: '1.3.6.1.5.5.7.48.1.1',
  ocspNonce: '1.3.6.1.5.5.7.48.1.2',
  commonName: '2.5.4.3',
  country: '2.5.4.6',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  title: '2.5.4.12',
  userId: '0.9.2342.19200300.100.1.1',
  /** Подпись документов (RFC 9336) и защита почты — назначения сертификата сотрудника. */
  documentSigning: '1.3.6.1.5.5.7.3.36',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  timeStamping: '1.3.6.1.5.5.7.3.8',
} as const

// ─── DER ─────────────────────────────────────────────────────────────────────

function lengthOf(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), lengthOf(content.length), content])
}

const seq = (...parts: Buffer[]) => tlv(0x30, ...parts)
const set = (...parts: Buffer[]) => tlv(0x31, ...parts)
const octets = (value: Buffer) => tlv(0x04, value)
const nullValue = () => Buffer.from([0x05, 0x00])
/** Контекстный тег: `[n]` конструированный (EXPLICIT или IMPLICIT для SEQUENCE/SET). */
const context = (n: number, ...parts: Buffer[]) => tlv(0xa0 | n, ...parts)

/** INTEGER из байтов без знака (серийный номер, nonce) или числа. */
export function integer(value: Buffer | number): Buffer {
  let bytes = typeof value === 'number' ? Buffer.from([value]) : Buffer.from(value)
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] ?? 0) < 0x80) bytes = bytes.subarray(1)
  if ((bytes[0] ?? 0) >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return tlv(0x02, bytes)
}

export function oid(text: string): Buffer {
  const parts = text.split('.').map(Number)
  const first = parts[0] ?? 0
  const second = parts[1] ?? 0
  const body: number[] = [first * 40 + second]
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f]
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128)) {
      chunk.unshift((rest & 0x7f) | 0x80)
    }
    body.push(...chunk)
  }
  return tlv(0x06, Buffer.from(body))
}

/** GeneralizedTime с точностью до секунды, UTC. */
function generalizedTime(date: Date): Buffer {
  const text = `${date.toISOString().slice(0, 19).replace(/[-:T]/g, '')}Z`
  return tlv(0x18, Buffer.from(text, 'ascii'))
}

const algorithm = (id: string, withNull = true) => seq(oid(id), ...(withNull ? [nullValue()] : []))

function asBuffer(value: ArrayBuffer | ArrayBufferView): Buffer {
  return ArrayBuffer.isView(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : Buffer.from(value)
}

// ─── Ключи ───────────────────────────────────────────────────────────────────

export interface RsaKeyPair {
  /** Закрытый ключ PKCS#8 (DER) — хранится только шифром мастер-ключа. */
  privateKeyDer: Buffer
  /** Открытый ключ SubjectPublicKeyInfo (DER). */
  publicKeyDer: Buffer
}

export function generateRsa(bits: 2048 | 3072): RsaKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits })
  return {
    privateKeyDer: privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer,
    publicKeyDer: publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
  }
}

export function privateKey(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

export function signSha256(key: KeyObject, data: Buffer): Buffer {
  return sign('sha256', data, key)
}

/** Ключ RSA 2048–4096 из SubjectPublicKeyInfo; иначе — ошибка с понятной причиной. */
export function rsaPublicKey(spki: Buffer): KeyObject {
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (key.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 4096) {
    throw new Error('нужен ключ RSA от 2048 до 4096 бит')
  }
  return key
}

export function verifySha256(spki: Buffer, data: Buffer, signature: Buffer): boolean {
  return verify('sha256', data, rsaPublicKey(spki), signature)
}

/** Идентификатор ключа: SHA-1 битовой строки открытого ключа (RFC 5280, способ 1). */
export function keyIdentifier(spki: Buffer): Buffer {
  const info = AsnParser.parse(spki, X.SubjectPublicKeyInfo)
  return createHash('sha1').update(asBuffer(info.subjectPublicKey)).digest()
}

/** Положительный серийный номер в 16 байт. */
export function newSerial(): Buffer {
  const serial = randomBytes(16)
  serial[0] = ((serial[0] ?? 1) & 0x7f) | 0x01
  return serial
}

// ─── Имена и расширения ──────────────────────────────────────────────────────

export type NameEntry = { type: string; value: string }

export function buildName(entries: readonly NameEntry[]): X.Name {
  return new X.Name(
    entries.map(
      (entry) =>
        new X.RelativeDistinguishedName([
          new X.AttributeTypeAndValue({
            type: entry.type,
            value: new X.AttributeValue(
              entry.type === OID.country
                ? { printableString: entry.value }
                : { utf8String: entry.value },
            ),
          }),
        ]),
    ),
  )
}

function extension(id: string, critical: boolean, value: unknown): X.Extension {
  return new X.Extension({
    extnID: id,
    critical,
    extnValue: new OctetString(AsnConvert.serialize(value)),
  })
}

export const ext = {
  basicConstraints: (ca: boolean, pathLength?: number) =>
    extension(
      X.id_ce_basicConstraints,
      true,
      new X.BasicConstraints(
        ca
          ? { cA: true, ...(pathLength !== undefined ? { pathLenConstraint: pathLength } : {}) }
          : {},
      ),
    ),
  keyUsage: (flags: number) => extension(X.id_ce_keyUsage, true, new X.KeyUsage(flags)),
  extKeyUsage: (ids: readonly string[], critical = false) =>
    extension(X.id_ce_extKeyUsage, critical, new X.ExtendedKeyUsage([...ids])),
  subjectKeyId: (spki: Buffer) =>
    extension(X.id_ce_subjectKeyIdentifier, false, new X.SubjectKeyIdentifier(keyIdentifier(spki))),
  authorityKeyId: (issuerSpki: Buffer) =>
    extension(
      X.id_ce_authorityKeyIdentifier,
      false,
      new X.AuthorityKeyIdentifier({
        keyIdentifier: new X.KeyIdentifier(keyIdentifier(issuerSpki)),
      }),
    ),
  crlDistribution: (url: string) =>
    extension(
      X.id_ce_cRLDistributionPoints,
      false,
      new X.CRLDistributionPoints([
        new X.DistributionPoint({
          distributionPoint: new X.DistributionPointName({
            fullName: [new X.GeneralName({ uniformResourceIdentifier: url })],
          }),
        }),
      ]),
    ),
  authorityInfo: (urls: { ocsp?: string; caIssuers?: string }) =>
    extension(
      X.id_pe_authorityInfoAccess,
      false,
      new X.AuthorityInfoAccessSyntax([
        ...(urls.ocsp
          ? [
              new X.AccessDescription({
                accessMethod: X.id_ad_ocsp,
                accessLocation: new X.GeneralName({ uniformResourceIdentifier: urls.ocsp }),
              }),
            ]
          : []),
        ...(urls.caIssuers
          ? [
              new X.AccessDescription({
                accessMethod: X.id_ad_caIssuers,
                accessLocation: new X.GeneralName({ uniformResourceIdentifier: urls.caIssuers }),
              }),
            ]
          : []),
      ]),
    ),
}

export const KeyUsage = X.KeyUsageFlags

function signatureAlgorithm(): X.AlgorithmIdentifier {
  return new X.AlgorithmIdentifier({
    algorithm: OID.sha256WithRSA,
    parameters: new Uint8Array([0x05, 0x00]).buffer,
  })
}

// ─── Сертификаты и CRL ───────────────────────────────────────────────────────

export interface IssueInput {
  subject: readonly NameEntry[]
  /** Издатель: имя и ключ; для корневого — тот же, что у субъекта. */
  issuer: { name: X.Name; key: KeyObject; publicKeyDer: Buffer }
  publicKeyDer: Buffer
  serial: Buffer
  notBefore: Date
  notAfter: Date
  extensions: readonly X.Extension[]
}

export function issueCertificate(input: IssueInput): Buffer {
  const tbs = new X.TBSCertificate({
    version: X.Version.v3,
    serialNumber: new Uint8Array(input.serial).buffer,
    signature: signatureAlgorithm(),
    issuer: input.issuer.name,
    validity: new X.Validity({ notBefore: input.notBefore, notAfter: input.notAfter }),
    subject: buildName(input.subject),
    subjectPublicKeyInfo: AsnParser.parse(input.publicKeyDer, X.SubjectPublicKeyInfo),
    extensions: new X.Extensions([
      ...input.extensions,
      ext.subjectKeyId(input.publicKeyDer),
      ext.authorityKeyId(input.issuer.publicKeyDer),
    ]),
  })
  const tbsDer = asBuffer(AsnConvert.serialize(tbs))
  const certificate = new X.Certificate({
    tbsCertificate: tbs,
    signatureAlgorithm: signatureAlgorithm(),
    signatureValue: new Uint8Array(signSha256(input.issuer.key, tbsDer)).buffer,
  })
  return asBuffer(AsnConvert.serialize(certificate))
}

/** Разобранный сертификат: имя субъекта (для издательства), серийный номер, ключ. */
export function parseCertificate(der: Buffer) {
  const cert = AsnParser.parse(der, X.Certificate)
  const tbs = cert.tbsCertificate
  return {
    subject: tbs.subject,
    issuerDer: asBuffer(AsnConvert.serialize(tbs.issuer)),
    serial: asBuffer(tbs.serialNumber),
    publicKeyDer: asBuffer(AsnConvert.serialize(tbs.subjectPublicKeyInfo)),
  }
}

export interface RevokedEntry {
  serial: Buffer
  revokedAt: Date
}

export function buildCrl(input: {
  issuer: { name: X.Name; key: KeyObject; publicKeyDer: Buffer }
  thisUpdate: Date
  nextUpdate: Date
  number: number
  revoked: readonly RevokedEntry[]
}): Buffer {
  const tbs = new X.TBSCertList({
    version: X.Version.v2,
    signature: signatureAlgorithm(),
    issuer: input.issuer.name,
    thisUpdate: new X.Time(input.thisUpdate),
    nextUpdate: new X.Time(input.nextUpdate),
    ...(input.revoked.length > 0
      ? {
          revokedCertificates: input.revoked.map(
            (entry) =>
              new X.RevokedCertificate({
                userCertificate: new Uint8Array(entry.serial).buffer,
                revocationDate: new X.Time(entry.revokedAt),
              }),
          ),
        }
      : {}),
    crlExtensions: [
      ext.authorityKeyId(input.issuer.publicKeyDer),
      extension(X.id_ce_cRLNumber, false, new X.CRLNumber(input.number)),
    ],
  })
  const tbsDer = asBuffer(AsnConvert.serialize(tbs))
  const list = new X.CertificateList({
    tbsCertList: tbs,
    signatureAlgorithm: signatureAlgorithm(),
    signature: new Uint8Array(signSha256(input.issuer.key, tbsDer)).buffer,
  })
  return asBuffer(AsnConvert.serialize(list))
}

// ─── CMS: подписываемые атрибуты и сборка подписи ────────────────────────────

/** ESS signingCertificateV2: хэш сертификата подписанта и его издатель с номером. */
function signingCertificateV2(certDer: Buffer): Buffer {
  const cert = parseCertificate(certDer)
  const issuerSerial = seq(seq(context(4, cert.issuerDer)), integer(cert.serial))
  const essCertId = seq(octets(createHash('sha256').update(certDer).digest()), issuerSerial)
  return seq(seq(essCertId))
}

function attribute(type: string, value: Buffer): Buffer {
  return seq(oid(type), set(value))
}

/** Атрибуты по порядку DER (SET OF сортируется по кодировке). */
function sortedAttributes(attributes: Buffer[]): Buffer[] {
  return [...attributes].sort(Buffer.compare)
}

/**
 * Подписываемые атрибуты PAdES (ETSI EN 319 142-1, B-B): тип содержимого, хэш
 * `ByteRange` и сертификат подписанта; без времени подписи — его несёт словарь подписи.
 * Возвращается DER-кодировка `SET OF` — её подписывает ключ сотрудника.
 */
export function signedAttributes(certDer: Buffer, digest: Buffer, contentType = OID.data): Buffer {
  return set(...attributesFor(certDer, digest, contentType))
}

function attributesFor(certDer: Buffer, digest: Buffer, contentType: string): Buffer[] {
  return sortedAttributes([
    attribute(OID.contentType, oid(contentType)),
    attribute(OID.messageDigest, octets(digest)),
    attribute(OID.signingCertificateV2, signingCertificateV2(certDer)),
  ])
}

function signerInfo(certDer: Buffer, attributes: Buffer[], signature: Buffer): Buffer {
  const cert = parseCertificate(certDer)
  return seq(
    integer(1),
    seq(cert.issuerDer, integer(cert.serial)),
    algorithm(OID.sha256, false),
    // [0] IMPLICIT SET OF Attribute — те же байты, что подписаны, под другим тегом
    context(0, ...attributes),
    algorithm(OID.rsaEncryption),
    octets(signature),
  )
}

function signedData(input: {
  version: number
  contentType: string
  content: Buffer | null
  certificates: readonly Buffer[]
  signer: Buffer
}): Buffer {
  const encapsulated = seq(
    oid(input.contentType),
    ...(input.content ? [context(0, octets(input.content))] : []),
  )
  return seq(
    oid(OID.signedData),
    context(
      0,
      seq(
        integer(input.version),
        set(algorithm(OID.sha256, false)),
        encapsulated,
        context(0, ...input.certificates),
        set(input.signer),
      ),
    ),
  )
}

/**
 * CMS (отделённая подпись PAdES) из подписи браузера: подпись — RSASSA-PKCS1-v1_5 над
 * `signedAttributes(cert, digest)`. Подпись проверяется здесь же: чужой ключ или не те
 * атрибуты отклоняются до движка.
 */
export function assembleCms(input: {
  certificateDer: Buffer
  chainDer: readonly Buffer[]
  digest: Buffer
  signature: Buffer
}): Buffer {
  const attributes = attributesFor(input.certificateDer, input.digest, OID.data)
  const signed = set(...attributes)
  const { publicKeyDer } = parseCertificate(input.certificateDer)
  if (!verifySha256(publicKeyDer, signed, input.signature)) {
    throw new Error('подпись не сходится с сертификатом и подписываемыми атрибутами')
  }
  return signedData({
    version: 1,
    contentType: OID.data,
    content: null,
    certificates: [input.certificateDer, ...input.chainDer],
    signer: signerInfo(input.certificateDer, attributes, input.signature),
  })
}

// ─── Служба штампов времени (RFC 3161) ───────────────────────────────────────

function statusInfo(status: number): Buffer {
  return seq(integer(status))
}

/**
 * Ответ службы штампов времени: штамп над хэшем из запроса, подписанный ключом TSA;
 * сертификат TSA — в штампе, если запрос его просит. Плохой запрос — отказ со статусом 2.
 */
export function timestampResponse(input: {
  requestDer: Buffer
  tsa: { certificateDer: Buffer; key: KeyObject; chainDer: readonly Buffer[] }
  policy: string
  serial: Buffer
  now?: Date
}): Buffer {
  let request: TimeStampReq
  try {
    request = AsnParser.parse(input.requestDer, TimeStampReq)
  } catch {
    return seq(statusInfo(2))
  }
  const imprint = asBuffer(AsnConvert.serialize(request.messageImprint))
  const tstInfo = seq(
    integer(1),
    oid(input.policy),
    imprint,
    integer(input.serial),
    generalizedTime(input.now ?? new Date()),
    seq(integer(1)),
    ...(request.nonce ? [integer(asBuffer(request.nonce))] : []),
  )
  const attributes = sortedAttributes([
    attribute(OID.contentType, oid(OID.tstInfo)),
    attribute(OID.messageDigest, octets(createHash('sha256').update(tstInfo).digest())),
    attribute(OID.signingCertificateV2, signingCertificateV2(input.tsa.certificateDer)),
  ])
  const signature = signSha256(input.tsa.key, set(...attributes))
  const token = signedData({
    version: 3,
    contentType: OID.tstInfo,
    content: tstInfo,
    certificates: request.certReq ? [input.tsa.certificateDer, ...input.tsa.chainDer] : [],
    signer: signerInfo(input.tsa.certificateDer, attributes, signature),
  })
  return seq(statusInfo(0), token)
}

// ─── OCSP (RFC 6960) ─────────────────────────────────────────────────────────

export type OcspStatus =
  | { status: 'good' }
  | { status: 'revoked'; at: Date }
  | { status: 'unknown' }

/**
 * Ответ OCSP, подписанный самим выпускающим УЦ (ответчик — по хэшу ключа): состояние
 * каждого сертификата из запроса — по серийному номеру, если запрос про этого издателя.
 */
export function ocspResponse(input: {
  requestDer: Buffer
  issuer: { certificateDer: Buffer; key: KeyObject }
  statusOf: (serialHex: string) => OcspStatus
  now?: Date
}): Buffer {
  let request: OCSPRequest
  try {
    request = AsnParser.parse(input.requestDer, OCSPRequest)
  } catch {
    return seq(tlv(0x0a, Buffer.from([1])))
  }
  const now = input.now ?? new Date()
  const next = new Date(now.getTime() + 24 * 3_600_000)
  const issuer = parseCertificate(input.issuer.certificateDer)
  const keyHashes = {
    [OID.sha1]: keyIdentifier(issuer.publicKeyDer),
    [OID.sha256]: createHash('sha256')
      .update(
        asBuffer(AsnParser.parse(issuer.publicKeyDer, X.SubjectPublicKeyInfo).subjectPublicKey),
      )
      .digest(),
  } as Record<string, Buffer>
  const responses = request.tbsRequest.requestList.map((item) => {
    const certId = item.reqCert
    const expected = keyHashes[certId.hashAlgorithm.algorithm]
    const ours = expected?.equals(asBuffer(certId.issuerKeyHash.buffer)) ?? false
    const state: OcspStatus = ours
      ? input.statusOf(asBuffer(certId.serialNumber).toString('hex'))
      : { status: 'unknown' }
    const status =
      state.status === 'good'
        ? Buffer.from([0x80, 0x00])
        : state.status === 'revoked'
          ? tlv(0xa1, generalizedTime(state.at))
          : Buffer.from([0x82, 0x00])
    return seq(
      asBuffer(AsnConvert.serialize(certId)),
      status,
      generalizedTime(now),
      context(0, generalizedTime(next)),
    )
  })
  const nonce = request.tbsRequest.requestExtensions?.find((item) => item.extnID === OID.ocspNonce)
  const responseData = seq(
    context(2, octets(keyHashes[OID.sha1] as Buffer)),
    generalizedTime(now),
    seq(...responses),
    ...(nonce ? [context(1, seq(asBuffer(AsnConvert.serialize(nonce))))] : []),
  )
  const signature = signSha256(input.issuer.key, responseData)
  const basic = seq(
    responseData,
    algorithm(OID.sha256WithRSA),
    tlv(0x03, Buffer.from([0]), signature),
  )
  return seq(tlv(0x0a, Buffer.from([0])), context(0, seq(oid(OID.ocspBasic), octets(basic))))
}

/** PEM-обёртка сертификата или CRL. */
export function pem(label: 'CERTIFICATE' | 'X509 CRL', der: Buffer): string {
  const body = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

export function fromPem(text: string): Buffer {
  return Buffer.from(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
}
