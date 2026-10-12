import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Квалифицированная электронная подпись (ADR-0205): PAdES-B-T на подписанном
 * экземпляре. Ключ подписанта не покидает рабочего места: страница подписания
 * передаёт агенту удостоверяющего центра (УЦ) хэш `ByteRange`, агент возвращает
 * CMS, движок встраивает её в PDF, ставит штамп времени и проверяет цепочку и отзыв.
 */

/** Сертификат подписанта — то, что видно в карточке, листе подписи и на странице проверки. */
export const QualifiedCertificate = z.object({
  /** Владелец — CN субъекта (ФИО или название организации). */
  owner: z.string().max(500),
  /** Организация субъекта (O), если указана. */
  organization: z.string().max(500).nullable(),
  /** Субъект целиком, как его показывает человеку библиотека. */
  subject: z.string().max(2000),
  issuer: z.string().max(2000),
  /** Серийный номер — шестнадцатеричный, без разделителей. */
  serial: z.string().max(128),
  notBefore: Timestamp,
  notAfter: Timestamp,
  /** SHA-256 сертификата (DER), шестнадцатеричный. */
  fingerprint: z.string().length(64),
})
export type QualifiedCertificate = z.infer<typeof QualifiedCertificate>

/** Состояние отзыва сертификата на момент проверки. */
export const QUALIFIED_REVOCATION = ['good', 'revoked', 'unknown'] as const
export const QualifiedRevocation = z.enum(QUALIFIED_REVOCATION)
export type QualifiedRevocation = z.infer<typeof QualifiedRevocation>

/**
 * Итог проверки подписи PAdES движком: целостность байтов, математика подписи,
 * доверенная цепочка до корня УЦ, отзыв и штамп времени.
 */
export const QualifiedValidation = z.object({
  /** Подписанные байты не изменены. */
  intact: z.boolean(),
  /** Подпись математически верна. */
  valid: z.boolean(),
  /** Цепочка сертификата доходит до доверенного корня и сертификат не отозван. */
  trusted: z.boolean(),
  revocation: QualifiedRevocation,
  /** Время из штампа TSA; `null` — штампа нет или он не прошёл проверку. */
  timestampAt: Timestamp.nullable(),
  /** Что покрывает подпись: весь файл или ревизию (после неё — следующие подписи). */
  coverage: z.string().max(64),
  /** Изменения после подписи: `none`, `form_filling`, `annotations`, `other`. */
  modification: z.string().max(64),
  /** Почему подпись не прошла — первой строкой для человека. */
  problem: z.string().max(1000).nullable(),
  checkedAt: Timestamp,
})
export type QualifiedValidation = z.infer<typeof QualifiedValidation>

/** Подпись прошла проверку целиком: байты, математика, цепочка, не отозвана. */
export function qualifiedValid(value: QualifiedValidation | null | undefined): boolean {
  return Boolean(value?.intact && value.valid && value.trusted && value.revocation !== 'revoked')
}

/**
 * Сеанс подписания:
 * `awaiting_certificate` — страница ждёт сертификат от агента;
 * `preparing` — движок готовит PDF с полем подписи и считает хэш;
 * `awaiting_signature` — хэш готов, агент подписывает;
 * `verifying` — CMS получена, движок встраивает и проверяет;
 * `signed` — подпись встроена, решение шага записано; `failed` — нет (причина в `error`).
 */
export const QES_SESSION_STATES = [
  'awaiting_certificate',
  'preparing',
  'awaiting_signature',
  'verifying',
  'signed',
  'failed',
] as const
export const QesSessionState = z.enum(QES_SESSION_STATES)
export type QesSessionState = z.infer<typeof QesSessionState>

/** Что подписывает агент: CMS (CAdES) detached над хэшем SHA-256 `ByteRange`. */
export const QES_SIGNING_MODES = ['cms-detached'] as const
export const QesSigningMode = z.enum(QES_SIGNING_MODES)
export type QesSigningMode = z.infer<typeof QesSigningMode>

/** Почему сеанс не дошёл до подписи — код для перевода и тестов. */
export const QES_FAILURE_REASONS = [
  'expired',
  'superseded',
  'certificate_invalid',
  'malformed',
  'digest_mismatch',
  'certificate_mismatch',
  'untrusted',
  'revoked',
  'invalid',
  'timestamp_failed',
  'concurrent',
  'step_closed',
  'engine_failed',
] as const
export const QesFailureReason = z.enum(QES_FAILURE_REASONS)
export type QesFailureReason = z.infer<typeof QesFailureReason>

/** «Подписать КЭП» в карточке: шаг подписи и, если заместитель, — за кого. */
export const QesSessionStartInput = z.object({
  stepId: Uuid,
  onBehalfOf: Uuid.nullable().optional(),
})
export type QesSessionStartInput = z.infer<typeof QesSessionStartInput>

/** Сеанс подписания в карточке документа. */
export const QesSessionRecord = z.object({
  id: Uuid,
  documentId: Uuid,
  stepId: Uuid,
  state: QesSessionState,
  reason: QesFailureReason.nullable(),
  error: z.string().nullable(),
  /** Страница подписания — только тому, кто подписывает, и только пока сеанс открыт. */
  signingUrl: z.string().nullable(),
  /** Подпись, записанная по сеансу (`signed`). */
  signatureId: Uuid.nullable(),
  certificate: QualifiedCertificate.nullable(),
  expiresAt: Timestamp,
})
export type QesSessionRecord = z.infer<typeof QesSessionRecord>

const Base64 = z
  .string()
  .min(1)
  .max(96 * 1024)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Ожидается base64')

/** Билет страницы подписания в адресе: подписанный api, открывает только свой сеанс. */
export const QesTicketQuery = z.object({ t: z.string().min(1).max(1024) })
export type QesTicketQuery = z.infer<typeof QesTicketQuery>

/** Повторная проверка квалифицированной подписи поставлена движку. */
export const QesVerifyQueued = z.object({ queued: z.literal(true) })
export type QesVerifyQueued = z.infer<typeof QesVerifyQueued>

/** Страница подписания → api: сертификат, выбранный в агенте (DER в base64). */
export const QesCertificateInput = z.object({ certificate: Base64 })
export type QesCertificateInput = z.infer<typeof QesCertificateInput>

/** Страница подписания → api: CMS от агента (DER в base64). */
export const QesResultInput = z.object({ cms: Base64 })
export type QesResultInput = z.infer<typeof QesResultInput>

/** Состояние сеанса для страницы подписания: что делать дальше. */
export const QesPageState = z.object({
  state: QesSessionState,
  reason: QesFailureReason.nullable(),
  /** Хэш `ByteRange` (SHA-256, base64) — агент подписывает его, когда `awaiting_signature`. */
  dataToSign: z.string().nullable(),
  mode: QesSigningMode.nullable(),
  digestAlgorithm: z.literal('sha256'),
  certificate: QualifiedCertificate.nullable(),
})
export type QesPageState = z.infer<typeof QesPageState>

// ─── Движок (ADR-0176, ADR-0190) ─────────────────────────────────────────────

const StoredObject = z.object({ bucket: z.string().min(1), storageKey: z.string().min(1) })

export const QES_ENGINE_STEPS = ['prepare', 'attach', 'verify'] as const
export const QesEngineStep = z.enum(QES_ENGINE_STEPS)
export type QesEngineStep = z.infer<typeof QesEngineStep>

/** Политика проверки: доверенные корни УЦ, строгость отзыва, походы за OCSP и CRL. */
export const QesValidationPolicy = z.object({
  trustRootsPem: z.array(z.string().min(1)).min(1).max(50),
  /** `hard-fail` — без ответа OCSP или CRL подпись не доверенная. */
  revocation: z.enum(['hard-fail', 'soft-fail']),
  /** Ходить за OCSP и CRL по адресам из сертификата (только после проверки цепочки). */
  fetchRevocation: z.boolean(),
})
export type QesValidationPolicy = z.infer<typeof QesValidationPolicy>

/** Начало шага движка: api отвечает, что делать, по состоянию сеанса на этот момент. */
export const QesEngineStartInput = z.object({ step: QesEngineStep })
export type QesEngineStartInput = z.infer<typeof QesEngineStartInput>

export const QesEngineStart = z.discriminatedUnion('status', [
  z.object({ status: z.literal('skip'), reason: z.string() }),
  z.object({
    status: z.literal('prepare'),
    /** PDF, к которому добавляется поле подписи: представление версии или экземпляр с прошлыми КЭП. */
    source: StoredObject,
    /** Куда положить подготовленный PDF (с пустым полем подписи). */
    target: StoredObject,
    fieldName: z.string().min(1).max(64),
    /** Строки штампа (отметка об ЭП, ГОСТ Р 7.0.97) и адрес QR-кода — страница проверки. */
    stampLines: z.array(z.string().max(200)).max(12),
    url: z.string().max(500),
  }),
  z.object({
    status: z.literal('attach'),
    prepared: StoredObject,
    target: StoredObject,
    fieldName: z.string().min(1).max(64),
    cms: z.string().min(1),
    /** Хэш `ByteRange` (hex) и границы места под CMS — из отчёта подготовки. */
    digest: z.string().length(64),
    reservedStart: z.number().int().nonnegative(),
    reservedEnd: z.number().int().nonnegative(),
    /** Сертификат, выбранный в агенте: CMS должна быть подписана им. */
    certificateSha256: z.string().length(64),
    /** Сервер штампов времени (RFC 3161); `null` — подпись без штампа (PAdES-B-B). */
    timestamp: z
      .object({
        url: z.string().min(1),
        username: z.string().nullable(),
        password: z.string().nullable(),
      })
      .nullable(),
    policy: QesValidationPolicy,
  }),
  z.object({
    status: z.literal('verify'),
    file: StoredObject,
    fieldName: z.string().min(1).max(64),
    policy: QesValidationPolicy,
  }),
])
export type QesEngineStart = z.infer<typeof QesEngineStart>

/** Итог шага движка. Поля — по шагу: подготовка, встраивание, проверка. */
export const QesEngineReport = z.object({
  step: QesEngineStep,
  /** `ready` — шаг сделан; `invalid` — подпись не принята (`reason`); `failed` — сбой. */
  status: z.enum(['ready', 'invalid', 'failed']),
  reason: QesFailureReason.nullable().optional(),
  error: z.string().max(4000).nullable().optional(),
  /** Подготовка: хэш `ByteRange` (hex) и место под CMS. */
  digest: z.string().length(64).nullable().optional(),
  reservedStart: z.number().int().nonnegative().nullable().optional(),
  reservedEnd: z.number().int().nonnegative().nullable().optional(),
  /** Размер и SHA-256 файла, положенного под выданный ключ. */
  size: z.number().int().nonnegative().nullable().optional(),
  sha256: z.string().length(64).nullable().optional(),
  certificate: QualifiedCertificate.nullable().optional(),
  validation: QualifiedValidation.nullable().optional(),
})
export type QesEngineReport = z.infer<typeof QesEngineReport>
