import { createHash, X509Certificate } from 'node:crypto'
import {
  engineJobRef,
  type QesEngineReport,
  type QesEngineStart,
  type QesEngineStep,
  type QesFailureReason,
  type QesPageState,
  type QesSessionRecord,
  type QesSessionStartInput,
  type QesSessionState,
  type QualifiedCertificate,
  type QualifiedValidation,
  qualifiedValid,
} from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import { createTranslator } from '@kchs/i18n'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { authorize, requireCapability } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { engineJob } from '~/kernel/jobs/engine.js'
import { JobService } from '~/kernel/jobs/service.js'
import { ProcessService, ProcessView } from '~/kernel/process/index.js'
import { type QualifiedSignatureAuthority, qualifiedSignature } from '~/kernel/signature/port.js'
import { issueSigningTicket, verifySigningTicket } from '~/kernel/signature/ticket.js'
import {
  addStoredFileVersion,
  fileBuckets,
  fileStorageKey,
  fileVersionSource,
  registerGeneratedFile,
} from '~/modules/files/public.js'
import { config } from '~/shared/config/index.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import {
  documentQesSessions,
  documentSignatures,
  documents,
  documentVersions,
} from '../../schema.js'
import { DOCUMENTS_AUDIT } from '../audit-actions.js'
import { loadSubject } from '../render-queue.js'
import { DocumentSignatures } from './signatures.js'

/**
 * Квалифицированная электронная подпись документа (ADR-0205): PAdES-B-T на
 * подписанном экземпляре. Операции порта `kernel/signature` над версией документа:
 *
 * - `start` + `submitCertificate` — **prepare**: сеанс на шаг подписи, сертификат из
 *   агента УЦ, движок готовит PDF с полем подписи и штампом и считает хэш `ByteRange`
 *   (`dataToSign` — в состоянии сеанса); `signatureId` выдан сразу, на него ведёт QR;
 * - `submitCms` + `engineDone(attach)` — **attach**: CMS агента встраивается со штампом
 *   времени и проверяется; проверенная подпись становится решением шага маршрута
 *   (`ProcessService.act` с сеансом в `payload`) и записью `document_signatures`;
 * - `verify` — повторная проверка встроенной подписи (цепочка, отзыв, время).
 *
 * Подписантов несколько — подписи идут друг за другом: следующий подписывает экземпляр
 * с прошлыми КЭП (новая версия того же файла), прошлые подписи остаются верными.
 */

export const QES_JOB = engineJobRef('render:document.signature')

/** Сколько живёт сеанс и билет страницы подписания. */
export const QES_SESSION_TTL_MS = 30 * 60_000
const OPEN_STATES: readonly QesSessionState[] = [
  'awaiting_certificate',
  'preparing',
  'awaiting_signature',
  'verifying',
]
/** Решение шага записывается в той же транзакции, что и отчёт движка; снаружи не видно. */
const ATTACHED = 'attached'
const PDF_MIME = 'application/pdf'

type SessionRow = typeof documentQesSessions.$inferSelect

interface SessionSource {
  fileId: string
  versionId: string
  bucket: string
  storageKey: string
  /** Сеанс, чей экземпляр подписывается дальше; пусто — PDF-представление версии. */
  baseSessionId: string
  /** Подпись печатью организации (ADR-0218): `'true'` — колонка хранит строки. */
  seal?: string
}

interface SessionTarget {
  /** `new` — первый экземпляр с КЭП (новый файл), `version` — новая версия того же файла. */
  mode: 'new' | 'version'
  fileId: string
  versionId: string
  spaceId: string
  name: string
  bucket: string
  preparedKey: string
  signedKey: string
}

interface PreparedInfo {
  digest: string
  reservedStart: number
  reservedEnd: number
}

function expired(row: Pick<SessionRow, 'state' | 'expiresAt'>, now = Date.now()): boolean {
  return OPEN_STATES.includes(row.state as QesSessionState) && Date.parse(row.expiresAt) < now
}

/** Состояние для показа: открытый сеанс после срока — «не удался, истёк». */
function shownState(row: SessionRow): { state: QesSessionState; reason: QesFailureReason | null } {
  if (expired(row)) return { state: 'failed', reason: 'expired' }
  const state = row.state === ATTACHED ? 'verifying' : (row.state as QesSessionState)
  return { state, reason: (row.reason as QesFailureReason | null) ?? null }
}

function signingUrl(row: SessionRow): string {
  const ticket = issueSigningTicket({
    sessionId: row.id,
    userId: row.actorId,
    expiresAt: Date.parse(row.expiresAt),
  })
  return `${config().KCHS_BASE_URL}/api/v1/qes/sessions/${row.id}/page?t=${encodeURIComponent(ticket)}`
}

function present(row: SessionRow, viewerId: string): QesSessionRecord {
  const { state, reason } = shownState(row)
  const open = OPEN_STATES.includes(state)
  return {
    id: row.id,
    documentId: row.documentId,
    stepId: row.stepId,
    state,
    reason,
    error: state === 'failed' ? (row.error ?? null) : null,
    signingUrl: open && viewerId === row.actorId ? signingUrl(row) : null,
    signatureId: state === 'signed' ? row.signatureId : null,
    certificate: (row.certificate as QualifiedCertificate | null) ?? null,
    expiresAt: row.expiresAt,
  }
}

/**
 * Состояние для страницы подписания. Агенту УЦ — хэш `ByteRange`; ключу устройства (УЦ
 * Комитета, ADR-0218) — подписываемые атрибуты CMS над этим хэшем и сертификатом.
 */
async function pageState(row: SessionRow): Promise<QesPageState> {
  const { state, reason } = shownState(row)
  const prepared = row.prepared as PreparedInfo | null
  const waiting = state === 'awaiting_signature' && prepared !== null
  const found = waiting ? await qualifiedSignature().authority() : null
  const device =
    found?.kind === 'device' && found.device && row.certificateDer ? found.device : null
  const digest = prepared ? Buffer.from(prepared.digest, 'hex') : null
  return {
    state,
    reason,
    dataToSign:
      waiting && digest
        ? (device
            ? device.signedAttributes(Buffer.from(row.certificateDer as string, 'base64'), digest)
            : digest
          ).toString('base64')
        : null,
    mode: waiting ? (device ? 'signed-attributes' : 'cms-detached') : null,
    digestAlgorithm: 'sha256',
    certificate: (row.certificate as QualifiedCertificate | null) ?? null,
  }
}

async function lockSession(tx: Executor, id: string): Promise<SessionRow | null> {
  const [row] = await tx
    .select()
    .from(documentQesSessions)
    .where(eq(documentQesSessions.id, id))
    .limit(1)
    .for('update')
  return row ?? null
}

async function documentObject(tx: Executor, documentId: string) {
  const subject = await loadSubject(tx, documentId)
  return {
    id: documentId,
    type: 'document' as const,
    spaceId: subject?.spaceId ?? null,
    title: subject?.title ?? null,
  }
}

/** Новое состояние сеанса — запись, событие, а итог (подписан или нет) — и аудит. */
async function transition(
  tx: Tx,
  ctx: Ctx,
  row: SessionRow,
  patch: Partial<typeof documentQesSessions.$inferInsert> & { state: string },
): Promise<SessionRow> {
  const [updated] = await tx
    .update(documentQesSessions)
    .set({ ...patch, updatedAt: sql`now()` as never })
    .where(eq(documentQesSessions.id, row.id))
    .returning()
  if (!updated) throw errors.notFound('Сеанс подписания')
  if (patch.state === ATTACHED) return updated
  const object = await documentObject(tx, row.documentId)
  await publishEvent(tx, ctx, {
    type: 'document.qualified_signing',
    object,
    payload: {
      sessionId: row.id,
      stepId: row.stepId,
      signatureId: row.signatureId,
      state: patch.state,
      reason: patch.reason ?? null,
    },
  })
  if (patch.state === 'signed' || patch.state === 'failed') {
    const certificate = updated.certificate as QualifiedCertificate | null
    await audit(
      ctx,
      {
        action: DOCUMENTS_AUDIT.qualifiedSigningFinished,
        actorId: row.actorId,
        objectId: row.documentId,
        objectType: 'document',
        severity: patch.state === 'signed' ? 'info' : 'notice',
        details: {
          sessionId: row.id,
          signatureId: row.signatureId,
          state: patch.state,
          reason: patch.reason ?? null,
          certificate: certificate
            ? {
                owner: certificate.owner,
                serial: certificate.serial,
                fingerprint: certificate.fingerprint,
              }
            : null,
        },
      },
      tx,
    )
  }
  return updated
}

async function fail(
  tx: Tx,
  ctx: Ctx,
  row: SessionRow,
  reason: QesFailureReason,
  error: string | null,
): Promise<SessionRow> {
  return transition(tx, ctx, row, {
    state: 'failed',
    reason,
    error: error?.slice(0, 4000) ?? null,
    cms: null,
  })
}

async function scheduleStep(tx: Tx, ctx: Ctx, row: SessionRow, step: QesEngineStep) {
  await JobService.schedule(tx, ctx, {
    ...engineJob('render:document.signature', { sessionId: row.id, step }),
    objectId: row.documentId,
    // Повторная проверка — каждый раз новая; подготовка и встраивание — одна на сеанс
    idempotencyKey:
      step === 'verify'
        ? `document.signature:${row.id}:verify:${Date.now()}`
        : `document.signature:${row.id}:${step}`,
    callbackScope: `signature-session:${row.id}`,
    options: { attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
  })
}

/** Сеанс открыт и не истёк (истёкший показывается неудавшимся, см. `shownState`). */
function assertOpen(row: SessionRow, state: QesSessionState): void {
  if (expired(row)) {
    throw errors.conflict('Срок сеанса подписания истёк — начните подписание заново', {
      reason: 'expired',
    })
  }
  if (row.state !== state) {
    throw errors.conflict('Сеанс подписания уже на другом шаге', {
      reason: 'state',
      state: row.state,
    })
  }
}

// ─── Сертификат ─────────────────────────────────────────────────────────────

function nameField(dn: string, key: string): string | null {
  for (const line of dn.split('\n')) {
    const index = line.indexOf('=')
    if (index > 0 && line.slice(0, index).trim() === key) return line.slice(index + 1).trim()
  }
  return null
}

/** Сведения о сертификате из DER; проверка срока и того, что это не сертификат УЦ. */
export function certificateInfo(der: Buffer, now = new Date()): QualifiedCertificate {
  let cert: X509Certificate
  try {
    cert = new X509Certificate(der)
  } catch {
    throw errors.validation('Сертификат не разбирается', [
      { path: 'certificate', message: 'Ожидается сертификат X.509 (DER в base64)' },
    ])
  }
  if (cert.ca) {
    throw errors.validation('Выбран сертификат УЦ, а не подписанта', [
      { path: 'certificate', message: 'Сертификат УЦ' },
    ])
  }
  const notBefore = new Date(cert.validFrom)
  const notAfter = new Date(cert.validTo)
  if (now < notBefore || now > notAfter) {
    throw errors.validation('Сертификат не действует сейчас', [
      { path: 'certificate', message: `Срок: ${cert.validFrom} — ${cert.validTo}` },
    ])
  }
  const subject = cert.subject
  return {
    owner: (nameField(subject, 'CN') ?? subject.split('\n')[0] ?? '—').slice(0, 500),
    organization: nameField(subject, 'O')?.slice(0, 500) ?? null,
    subject: subject.replace(/\n/g, ', ').slice(0, 2000),
    issuer: cert.issuer.replace(/\n/g, ', ').slice(0, 2000),
    serial: cert.serialNumber.toLowerCase().replace(/^0+(?=.)/, ''),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fingerprint: createHash('sha256').update(der).digest('hex'),
  }
}

// ─── Штамп ───────────────────────────────────────────────────────────────────

/** Отметка об электронной подписи (ориентир — ГОСТ Р 7.0.97): строки штампа КЭП. */
async function stampLines(row: SessionRow): Promise<string[]> {
  const actor = await buildUserCtxFor(row.actorId)
  const locale = actor?.locale ?? 'ru'
  const timezone = actor?.timezone ?? config().TZ
  const t = createTranslator(locale)
  const certificate = row.certificate as QualifiedCertificate | null
  const refs = await directory().refs([row.signerId, row.actorId])
  const person = (id: string) => {
    const ref = refs.get(id)
    return ref ? (ref.position ? `${ref.displayName}, ${ref.position}` : ref.displayName) : '—'
  }
  const signer =
    row.actorId !== row.signerId
      ? t('documents.qualified.stamp.onBehalf', {
          actor: person(row.actorId),
          name: refs.get(row.signerId)?.displayName ?? '—',
        })
      : person(row.signerId)
  const [doc] = await db()
    .select({ regNumber: documents.regNumber, regDate: documents.regDate })
    .from(documents)
    .where(eq(documents.id, row.documentId))
    .limit(1)
  return [
    t('documents.qualified.stamp.title'),
    t('documents.qualified.stamp.kind'),
    ...(certificate
      ? [
          t('documents.qualified.stamp.certificate', { serial: certificate.serial.toUpperCase() }),
          t('documents.qualified.stamp.owner', { owner: certificate.owner }),
          t('documents.qualified.stamp.validity', {
            from: formatDate(certificate.notBefore, { locale, timezone }),
            to: formatDate(certificate.notAfter, { locale, timezone }),
          }),
        ]
      : []),
    t('documents.qualified.stamp.signer', { signer }),
    ...(doc?.regNumber
      ? [
          t('documents.print.esign.number', {
            number: doc.regNumber,
            date: doc.regDate ? formatDate(doc.regDate, { locale, timezone: 'UTC' }) : '',
          }),
        ]
      : []),
    formatDateTime(new Date().toISOString(), { locale, timezone }),
  ].map((line) => line.slice(0, 200))
}

// ─── Сеанс ───────────────────────────────────────────────────────────────────

async function authority(): Promise<QualifiedSignatureAuthority> {
  const found = await qualifiedSignature().authority()
  if (!found) {
    throw errors.conflict(
      'Квалифицированная подпись не настроена: создайте УЦ Комитета в консоли администрирования',
      { reason: 'qualified_signature' },
    )
  }
  return found
}

/** Последний подписанный сеанс версии — его экземпляр подписывает следующий. */
async function lastSigned(executor: Executor, versionId: string, except?: string) {
  const [row] = await executor
    .select()
    .from(documentQesSessions)
    .where(
      and(
        eq(documentQesSessions.versionId, versionId),
        eq(documentQesSessions.state, 'signed'),
        except ? ne(documentQesSessions.id, except) : undefined,
      ),
    )
    .orderBy(desc(documentQesSessions.updatedAt))
    .limit(1)
  return row ?? null
}

/** PDF-представление версии: закреплённая версия файла (ADR-0197). */
async function versionPdf(executor: Executor, versionId: string) {
  const [version] = await executor
    .select({
      pdfFileId: documentVersions.pdfFileId,
      fileVersions: documentVersions.fileVersions,
    })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId))
    .limit(1)
  if (!version?.pdfFileId) return null
  return fileVersionSource(version.pdfFileId, version.fileVersions[version.pdfFileId])
}

/**
 * Сертификат с устройства (УЦ Комитета, ADR-0218) — того, кто подписывает: выпущен этим УЦ,
 * действует и выдан ему самому; для печати — сертификат печати у её держателя (N121).
 */
async function assertDeviceCertificate(row: SessionRow, der: Buffer): Promise<void> {
  const found = await qualifiedSignature().authority()
  if (found?.kind !== 'device' || !found.device) return
  const owner = await found.device.owner(der)
  const seal = (row.source as unknown as SessionSource).seal === 'true'
  if (
    !owner ||
    !owner.active ||
    owner.userId !== row.actorId ||
    owner.purpose !== (seal ? 'seal' : 'person')
  ) {
    throw errors.conflict(
      seal
        ? 'На этом устройстве нет действующего ключа печати организации'
        : 'Сертификат не ваш или отозван: создайте ключ подписи в профиле',
      { reason: 'certificate_owner' },
    )
  }
}

/** CMS из подписи браузера; подпись чужим ключом или не тех атрибутов — отказ. */
async function deviceCms(row: SessionRow, signatureBase64: string): Promise<string> {
  const found = await qualifiedSignature().authority()
  const prepared = row.prepared as PreparedInfo | null
  if (found?.kind !== 'device' || !found.device || !prepared || !row.certificateDer) {
    throw errors.conflict('Подпись устройства здесь не ждут', { reason: 'mode' })
  }
  try {
    const cms = await found.device.assemble(
      Buffer.from(row.certificateDer, 'base64'),
      Buffer.from(prepared.digest, 'hex'),
      Buffer.from(signatureBase64, 'base64'),
    )
    return cms.toString('base64')
  } catch (error) {
    throw errors.validation('Подпись не сходится с ключом устройства', [
      {
        path: 'signature',
        message: error instanceof Error ? error.message : 'подпись не сходится',
      },
    ])
  }
}

export const QualifiedSignatures = {
  /**
   * «Подписать КЭП» в карточке: сеанс на шаг квалифицированной подписи того, кто
   * подписывает (или за кого — при замещении). Прежний открытый сеанс того же шага
   * закрывается; пока другой участник подписывает ту же версию — ждать.
   */
  async start(
    ctx: UserCtx,
    documentId: string,
    input: QesSessionStartInput,
  ): Promise<QesSessionRecord> {
    await authorize(ctx, 'view', documentId)
    const found = await authority()
    // Печать организации (ADR-0218): ставит держатель печати её ключом на своём устройстве
    const seal = input.seal === true
    if (seal) {
      requireCapability(ctx, 'documents.seal')
      if (found.kind !== 'device') {
        throw errors.conflict('Печать организации ставится ключом УЦ Комитета', { reason: 'seal' })
      }
    }
    const onBehalfOf = input.onBehalfOf ?? null
    const running = await ProcessService.running(db(), documentId)
    let mine = false
    for (const instance of running) {
      const view = await ProcessView.get(ctx, instance.instanceId)
      mine ||= view.myActions.some(
        (item) =>
          item.stepId === input.stepId &&
          item.qualified &&
          item.actions.includes('sign') &&
          (item.onBehalfOf?.id ?? null) === onBehalfOf,
      )
    }
    if (!mine) {
      throw errors.conflict('Нет вашего шага квалифицированной подписи по этому документу', {
        reason: 'no_step',
      })
    }
    const version = await DocumentSignatures.versionOfStep(db(), documentId, input.stepId)
    if (!version)
      throw errors.conflict('У документа нет версии для подписи', { reason: 'no_version' })
    const subject = await loadSubject(db(), documentId)
    if (!subject) throw errors.notFound('Документ')

    const row = await db().transaction(async (tx) => {
      // Одна версия — одна подпись за раз: следующий подписывает экземпляр предыдущего
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`qes:${version.id}`}))`)
      const open = await tx
        .select()
        .from(documentQesSessions)
        .where(
          and(
            eq(documentQesSessions.versionId, version.id),
            inArray(documentQesSessions.state, [...OPEN_STATES, ATTACHED]),
          ),
        )
        .for('update')
      for (const other of open) {
        if (expired(other)) {
          await fail(tx, ctx, other, 'expired', 'Срок сеанса подписания истёк')
        } else if (other.stepId === input.stepId && other.actorId === ctx.userId) {
          if (other.state === 'verifying' || other.state === ATTACHED) {
            throw errors.conflict('Подпись уже проверяется — дождитесь результата', {
              reason: 'verifying',
            })
          }
          await fail(tx, ctx, other, 'superseded', 'Начато новое подписание')
        } else {
          throw errors.conflict(
            'Документ сейчас подписывает другой участник — повторите через несколько минут',
            { reason: 'busy' },
          )
        }
      }

      const base = await lastSigned(tx, version.id)
      const baseTarget = base?.target as SessionTarget | undefined
      let source: SessionSource
      let target: SessionTarget
      if (base && baseTarget) {
        source = {
          fileId: baseTarget.fileId,
          versionId: baseTarget.versionId,
          bucket: baseTarget.bucket,
          storageKey: baseTarget.signedKey,
          baseSessionId: base.id,
        }
        const versionId = newId()
        target = {
          ...baseTarget,
          mode: 'version',
          versionId,
          preparedKey: fileStorageKey(
            subject.spaceId,
            baseTarget.fileId,
            versionId,
            'prepared.pdf',
          ),
          signedKey: fileStorageKey(subject.spaceId, baseTarget.fileId, versionId, baseTarget.name),
        }
      } else {
        const pdf = await versionPdf(tx, version.id)
        if (!pdf) {
          throw errors.conflict('PDF-представление версии ещё не готово — подпишите чуть позже', {
            reason: 'no_pdf',
          })
        }
        source = {
          fileId: pdf.fileId,
          versionId: pdf.versionId,
          bucket: pdf.bucket,
          storageKey: pdf.storageKey,
          baseSessionId: '',
        }
        const fileId = newId()
        const versionId = newId()
        const t = createTranslator(ctx.locale)
        const name = `${pdf.name.replace(/\.pdf$/i, '')} — ${t('documents.qualified.fileSuffix')}.pdf`
        target = {
          mode: 'new',
          fileId,
          versionId,
          spaceId: subject.spaceId,
          name,
          bucket: fileBuckets.files(),
          preparedKey: fileStorageKey(subject.spaceId, fileId, versionId, 'prepared.pdf'),
          signedKey: fileStorageKey(subject.spaceId, fileId, versionId, name),
        }
      }

      const id = newId()
      const [created] = await tx
        .insert(documentQesSessions)
        .values({
          id,
          documentId,
          versionId: version.id,
          stepId: input.stepId,
          signatureId: newId(),
          signerId: onBehalfOf ?? ctx.userId,
          actorId: ctx.userId,
          webSessionId: ctx.sessionId,
          state: 'awaiting_certificate',
          source: { ...source, ...(seal ? { seal: 'true' } : {}) },
          target: { ...target },
          expiresAt: new Date(Date.now() + QES_SESSION_TTL_MS).toISOString(),
        })
        .returning()
      if (!created) throw errors.internal('Сеанс подписания не записан')
      await publishEvent(tx, ctx, {
        type: 'document.qualified_signing',
        object: {
          id: documentId,
          type: 'document',
          spaceId: subject.spaceId,
          title: subject.title,
        },
        payload: {
          sessionId: id,
          stepId: input.stepId,
          signatureId: created.signatureId,
          state: 'awaiting_certificate',
          reason: null,
        },
      })
      await audit(
        ctx,
        {
          action: DOCUMENTS_AUDIT.qualifiedSigningStarted,
          objectId: documentId,
          objectType: 'document',
          details: { sessionId: id, stepId: input.stepId, onBehalfOf },
        },
        tx,
      )
      return created
    })
    return present(row, ctx.userId)
  },

  async get(ctx: UserCtx, documentId: string, sessionId: string): Promise<QesSessionRecord> {
    await authorize(ctx, 'view', documentId)
    const [row] = await db()
      .select()
      .from(documentQesSessions)
      .where(
        and(eq(documentQesSessions.id, sessionId), eq(documentQesSessions.documentId, documentId)),
      )
      .limit(1)
    if (!row) throw errors.notFound('Сеанс подписания')
    return present(row, ctx.userId)
  },

  // ─── Страница подписания (билет) ──────────────────────────────────────────

  /** Сеанс страницы: билет этого сеанса и его подписанта; иначе — «не найден». */
  async byTicket(sessionId: string, ticket: unknown): Promise<SessionRow> {
    const claims = verifySigningTicket(ticket, sessionId)
    if (!claims) throw errors.notFound('Сеанс подписания')
    const [row] = await db()
      .select()
      .from(documentQesSessions)
      .where(eq(documentQesSessions.id, sessionId))
      .limit(1)
    if (!row || row.actorId !== claims.userId) throw errors.notFound('Сеанс подписания')
    return row
  },

  async pageState(sessionId: string, ticket: unknown): Promise<QesPageState> {
    return await pageState(await QualifiedSignatures.byTicket(sessionId, ticket))
  },

  /** Агент вернул сертификат: проверка срока, сведения, подготовка PDF движком. */
  async submitCertificate(
    sessionId: string,
    ticket: unknown,
    certificateBase64: string,
  ): Promise<QesPageState> {
    const session = await QualifiedSignatures.byTicket(sessionId, ticket)
    const der = Buffer.from(certificateBase64, 'base64')
    const info = certificateInfo(der)
    await assertDeviceCertificate(session, der)
    const ctx = systemCtx('documents.qes.certificate')
    const row = await db().transaction(async (tx) => {
      const locked = await lockSession(tx, sessionId)
      if (!locked) throw errors.notFound('Сеанс подписания')
      assertOpen(locked, 'awaiting_certificate')
      const actorCtx = { ...ctx, initiatorId: locked.actorId }
      const next = await transition(tx, actorCtx, locked, {
        state: 'preparing',
        certificate: info,
        certificateDer: der.toString('base64'),
      })
      await scheduleStep(tx, actorCtx, next, 'prepare')
      return next
    })
    return await pageState(row)
  },

  /**
   * Результат страницы: CMS агента или подпись ключом устройства над подписываемыми
   * атрибутами — из неё CMS собирает поставщик (ADR-0218); дальше встраивание и проверка
   * движком.
   */
  async submitResult(
    sessionId: string,
    ticket: unknown,
    input: { cms?: string | undefined; signature?: string | undefined },
  ): Promise<QesPageState> {
    const session = await QualifiedSignatures.byTicket(sessionId, ticket)
    const cmsBase64 = input.cms ?? (await deviceCms(session, input.signature ?? ''))
    const ctx = systemCtx('documents.qes.result')
    const row = await db().transaction(async (tx) => {
      const locked = await lockSession(tx, sessionId)
      if (!locked) throw errors.notFound('Сеанс подписания')
      assertOpen(locked, 'awaiting_signature')
      const actorCtx = { ...ctx, initiatorId: locked.actorId }
      const next = await transition(tx, actorCtx, locked, { state: 'verifying', cms: cmsBase64 })
      await scheduleStep(tx, actorCtx, next, 'attach')
      return next
    })
    return await pageState(row)
  },

  // ─── Повторная проверка (verify) ──────────────────────────────────────────

  async verify(ctx: UserCtx, documentId: string, signatureId: string): Promise<void> {
    await authorize(ctx, 'view', documentId)
    await authority()
    await db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(documentQesSessions)
        .where(
          and(
            eq(documentQesSessions.signatureId, signatureId),
            eq(documentQesSessions.documentId, documentId),
            eq(documentQesSessions.state, 'signed'),
          ),
        )
        .limit(1)
      if (!row) throw errors.notFound('Квалифицированная подпись')
      await scheduleStep(tx, ctx, row, 'verify')
    })
  },

  // ─── Движок (токен задания, ADR-0176) ─────────────────────────────────────

  async engineStart(sessionId: string, step: QesEngineStep): Promise<QesEngineStart> {
    const [row] = await db()
      .select()
      .from(documentQesSessions)
      .where(eq(documentQesSessions.id, sessionId))
      .limit(1)
    if (!row) return { status: 'skip', reason: 'сеанса нет' }
    const found = await qualifiedSignature().authority()
    if (!found) return { status: 'skip', reason: 'удостоверяющий центр отключён' }
    const source = row.source as unknown as SessionSource
    const target = row.target as unknown as SessionTarget
    const fieldName = `kchs-${row.signatureId}`
    if (step === 'prepare') {
      if (row.state !== 'preparing' || expired(row)) return { status: 'skip', reason: row.state }
      return {
        status: 'prepare',
        source: { bucket: source.bucket, storageKey: source.storageKey },
        target: { bucket: target.bucket, storageKey: target.preparedKey },
        fieldName,
        stampLines: await stampLines(row),
        url: `${config().KCHS_BASE_URL}/api/v1/verify/${row.signatureId}`,
      }
    }
    if (step === 'attach') {
      const prepared = row.prepared as PreparedInfo | null
      const certificate = row.certificate as QualifiedCertificate | null
      if (row.state !== 'verifying' || !prepared || !certificate || !row.cms) {
        return { status: 'skip', reason: row.state }
      }
      return {
        status: 'attach',
        prepared: { bucket: target.bucket, storageKey: target.preparedKey },
        target: { bucket: target.bucket, storageKey: target.signedKey },
        fieldName,
        cms: row.cms,
        digest: prepared.digest,
        reservedStart: prepared.reservedStart,
        reservedEnd: prepared.reservedEnd,
        certificateSha256: certificate.fingerprint,
        timestamp: found.timestamp,
        policy: found.policy,
      }
    }
    if (row.state !== 'signed') return { status: 'skip', reason: row.state }
    return {
      status: 'verify',
      file: { bucket: target.bucket, storageKey: target.signedKey },
      fieldName,
      policy: found.policy,
    }
  },

  async engineDone(sessionId: string, report: QesEngineReport): Promise<{ stale: boolean }> {
    if (report.step === 'verify') return QualifiedSignatures.applyCheck(sessionId, report)
    if (report.step === 'prepare') return QualifiedSignatures.applyPrepared(sessionId, report)
    const outcome = await QualifiedSignatures.applyAttached(sessionId, report).catch(
      async (error: unknown) => {
        // Шаг закрылся, пока движок встраивал подпись: решение не записать
        if (!(error instanceof AppError)) throw error
        await db().transaction(async (tx) => {
          const row = await lockSession(tx, sessionId)
          if (row && (row.state === 'verifying' || row.state === ATTACHED)) {
            await fail(tx, systemCtx('documents.qes.attach'), row, 'step_closed', error.message)
          }
        })
        return { stale: false }
      },
    )
    return outcome
  },

  async applyPrepared(sessionId: string, report: QesEngineReport): Promise<{ stale: boolean }> {
    return db().transaction(async (tx) => {
      const row = await lockSession(tx, sessionId)
      if (row?.state !== 'preparing') return { stale: true }
      const ctx = systemCtx('documents.qes.prepare', { initiatorId: row.actorId })
      if (
        report.status !== 'ready' ||
        !report.digest ||
        report.reservedStart == null ||
        report.reservedEnd == null
      ) {
        await fail(tx, ctx, row, report.reason ?? 'engine_failed', report.error ?? null)
        return { stale: false }
      }
      await transition(tx, ctx, row, {
        state: 'awaiting_signature',
        prepared: {
          digest: report.digest,
          reservedStart: report.reservedStart,
          reservedEnd: report.reservedEnd,
          size: report.size ?? null,
          sha256: report.sha256 ?? null,
        },
      })
      return { stale: false }
    })
  },

  /**
   * Движок встроил и проверил подпись: экземпляр становится файлом документа, а
   * подпись — решением шага (через движок процессов) и записью `document_signatures`.
   * Всё в одной транзакции: либо подпись записана целиком, либо её нет.
   */
  async applyAttached(sessionId: string, report: QesEngineReport): Promise<{ stale: boolean }> {
    return db().transaction(async (tx) => {
      const row = await lockSession(tx, sessionId)
      if (row?.state !== 'verifying') return { stale: true }
      const sys = systemCtx('documents.qes.attach', { initiatorId: row.actorId })
      const certificate = row.certificate as QualifiedCertificate | null
      const validation = (report.validation ?? null) as QualifiedValidation | null
      if (report.status !== 'ready' || !qualifiedValid(validation)) {
        await fail(
          tx,
          sys,
          row,
          report.reason ?? 'invalid',
          report.error ?? validation?.problem ?? null,
        )
        return { stale: false }
      }
      if (!certificate || report.certificate?.fingerprint !== certificate.fingerprint) {
        await fail(
          tx,
          sys,
          row,
          'certificate_mismatch',
          'Подпись сделана не выбранным сертификатом',
        )
        return { stale: false }
      }
      // Кто-то подписал версию раньше: этот экземпляр не содержит его подписи
      const source = row.source as unknown as SessionSource
      const latest = await lastSigned(tx, row.versionId, row.id)
      if ((latest?.id ?? '') !== source.baseSessionId) {
        await fail(tx, sys, row, 'concurrent', 'Пока шла подпись, версию подписал другой участник')
        return { stale: false }
      }

      const target = row.target as unknown as SessionTarget
      if (target.mode === 'new') {
        await registerGeneratedFile(tx, sys, {
          fileId: target.fileId,
          versionId: target.versionId,
          spaceId: target.spaceId,
          name: target.name,
          mime: PDF_MIME,
          size: report.size ?? 0,
          storageKey: target.signedKey,
          checksum: report.sha256 ?? null,
          attachToObjectId: row.documentId,
        })
      } else {
        await addStoredFileVersion(tx, sys, {
          fileId: target.fileId,
          versionId: target.versionId,
          spaceId: target.spaceId,
          storageKey: target.signedKey,
          size: report.size ?? 0,
          mime: PDF_MIME,
          checksum: report.sha256 ?? null,
        })
      }
      await tx
        .update(documentVersions)
        .set({ signedCopyFileId: target.fileId })
        .where(eq(documentVersions.id, row.versionId))
      const attached = await transition(tx, sys, row, {
        state: ATTACHED,
        validation: validation as unknown as Record<string, unknown>,
        cms: null,
      })

      // Решение шага — тем, кто подписывал своим ключом, от имени подписанта при замещении
      const actor = await buildUserCtxFor(row.actorId)
      if (!actor) throw errors.conflict('Подписавший сотрудник не найден', { reason: 'actor' })
      await ProcessService.act(
        tx,
        {
          ...actor,
          sessionId: row.webSessionId ?? actor.sessionId,
          onBehalfOf: row.signerId !== row.actorId ? row.signerId : null,
          requestId: `qes_${row.id}`,
        },
        { stepId: row.stepId, action: 'sign', payload: { qualifiedSessionId: row.id } },
      )
      await transition(tx, sys, attached, { state: 'signed' })
      return { stale: false }
    })
  },

  async applyCheck(sessionId: string, report: QesEngineReport): Promise<{ stale: boolean }> {
    return db().transaction(async (tx) => {
      const row = await lockSession(tx, sessionId)
      if (row?.state !== 'signed' || report.status !== 'ready' || !report.validation) {
        return { stale: true }
      }
      await tx
        .update(documentSignatures)
        .set({ validation: report.validation as unknown as Record<string, unknown> })
        .where(eq(documentSignatures.id, row.signatureId))
      await publishEvent(tx, systemCtx('documents.qes.verify'), {
        type: 'document.signature_checked',
        object: await documentObject(tx, row.documentId),
        payload: { signatureId: row.signatureId, valid: qualifiedValid(report.validation) },
      })
      return { stale: false }
    })
  },

  /** Окончательный сбой задания движка: открытый сеанс не висит «в работе». */
  async failByJob(sessionId: string, step: string, message: string): Promise<void> {
    await db().transaction(async (tx) => {
      const row = await lockSession(tx, sessionId)
      const waiting = step === 'prepare' ? 'preparing' : step === 'attach' ? 'verifying' : null
      if (!row || row.state !== waiting) return
      await fail(tx, systemCtx('documents.qes.job'), row, 'engine_failed', message)
    })
    logger().warn({ sessionId, step }, 'задание квалифицированной подписи не выполнено')
  },

  /**
   * Решение «Подписать» шага с КЭП (`onDecision` поставщика документов): только по
   * сеансу, подпись которого движок уже встроил и проверил в этой же транзакции.
   */
  async consume(
    tx: Tx,
    input: { sessionId: unknown; stepId: string; signerId: string; actorId: string },
  ): Promise<SessionRow> {
    if (typeof input.sessionId !== 'string') {
      throw errors.conflict('Этот шаг подписывается квалифицированной подписью', {
        reason: 'qualified_signature_required',
      })
    }
    const row = await lockSession(tx, input.sessionId)
    if (
      row?.state !== ATTACHED ||
      row.stepId !== input.stepId ||
      row.signerId !== input.signerId ||
      row.actorId !== input.actorId
    ) {
      throw errors.conflict('Квалифицированная подпись не проверена', {
        reason: 'qualified_signature_required',
      })
    }
    return row
  },
}

/** Причина сбоя задания по нагрузке — для подписчика закрытых заданий. */
export function qesJobPayload(payload: unknown): { sessionId: string; step: string } | null {
  const value = payload as { sessionId?: unknown; step?: unknown } | null
  return typeof value?.sessionId === 'string' && typeof value.step === 'string'
    ? { sessionId: value.sessionId, step: value.step }
    : null
}
