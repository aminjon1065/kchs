import type {
  DocumentManifest,
  DocumentSignature,
  QualifiedCertificate,
  QualifiedValidation,
  SignaturePlacement,
  SignaturePlacementInput,
  UserRef,
} from '@kchs/contracts'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { objects } from '~/kernel/objects/schema.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import {
  documentSignatures,
  documentStepVersions,
  documents,
  documentVersions,
} from '../../schema.js'
import { buildManifest, manifestHash } from './manifest.js'

interface StepVersion {
  id: string
  /** Хэш основного файла — до манифеста подпись брала его (ADR-0083). */
  hash: string | null
  manifest: DocumentManifest | null
  manifestHash: string | null
}

const versionColumns = {
  id: documentVersions.id,
  hash: documentVersions.hash,
  documentId: documentVersions.documentId,
  number: documentVersions.number,
  mainFileId: documentVersions.mainFileId,
  pdfFileId: documentVersions.pdfFileId,
  attachments: documentVersions.attachments,
  fileVersions: documentVersions.fileVersions,
  hashes: documentVersions.hashes,
  manifestHash: documentVersions.manifestHash,
}

function stepVersion(row: {
  id: string
  hash: string | null
  documentId: string
  number: number
  mainFileId: string | null
  pdfFileId: string | null
  attachments: string[]
  fileVersions: Record<string, string>
  hashes: Record<string, string>
  manifestHash: string | null
}): StepVersion {
  const manifest = row.manifestHash ? buildManifest(row) : null
  return {
    id: row.id,
    hash: row.hash,
    manifest,
    manifestHash: manifest ? manifestHash(manifest) : null,
  }
}

function parsePlacement(value: Record<string, unknown> | null): SignaturePlacement | null {
  if (!value) return null
  const { page, x, y, source } = value as Partial<SignaturePlacement>
  if (typeof page !== 'number' || typeof x !== 'number' || typeof y !== 'number') return null
  return {
    page,
    x,
    y,
    source: source === 'manual' || source === 'marker' || source === 'name' ? source : 'fallback',
  }
}

/**
 * Простая электронная подпись (08-documents.md §9, ADR-0083): решение
 * «Подписать» шага маршрута фиксирует хэш замороженной версии, подписанта,
 * заместителя, сессию и подтверждение вторым фактором. С ADR-0198 хэш — это
 * хэш манифеста версии (основной файл, приложения, PDF-представление), если
 * движок уже прислал хэши всех файлов; иначе — основного файла, как раньше.
 */
export const DocumentSignatures = {
  /** Версия, которую шаг видел при активации (заморозка), иначе — текущая. */
  async versionOfStep(
    executor: Executor,
    documentId: string,
    stepId: string,
  ): Promise<StepVersion | null> {
    const [frozen] = await executor
      .select(versionColumns)
      .from(documentStepVersions)
      .innerJoin(documentVersions, eq(documentVersions.id, documentStepVersions.versionId))
      .where(eq(documentStepVersions.stepId, stepId))
      .limit(1)
    if (frozen) return stepVersion(frozen)
    const [current] = await executor
      .select(versionColumns)
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
      .where(eq(documents.id, documentId))
      .limit(1)
    return current ? stepVersion(current) : null
  },

  async record(
    tx: Executor,
    ctx: Ctx,
    input: {
      documentId: string
      stepId: string
      signerId: string
      actorId: string
      mfa: boolean
      kind: 'simple' | 'qualified'
      /** КЭП (ADR-0205): идентификатор выдан сеансом заранее — на него ведёт QR штампа. */
      id?: string
      certificate?: QualifiedCertificate | null
      validation?: QualifiedValidation | null
      signedFileId?: string | null
    },
  ): Promise<{ id: string; versionId: string | null; hash: string | null }> {
    const version = await DocumentSignatures.versionOfStep(tx, input.documentId, input.stepId)
    const id = input.id ?? newId()
    const hash = version?.manifestHash ?? version?.hash ?? null
    await tx.insert(documentSignatures).values({
      id,
      documentId: input.documentId,
      versionId: version?.id ?? null,
      stepId: input.stepId,
      signerId: input.signerId,
      actorId: input.actorId !== input.signerId ? input.actorId : null,
      sessionId: ctx.kind === 'user' ? ctx.sessionId : null,
      hash,
      manifest: version?.manifestHash ? (version.manifest as Record<string, unknown> | null) : null,
      kind: input.kind,
      mfa: input.mfa,
      certificate: (input.certificate ?? null) as Record<string, unknown> | null,
      validation: (input.validation ?? null) as Record<string, unknown> | null,
      signedFileId: input.signedFileId ?? null,
    })
    return { id, versionId: version?.id ?? null, hash }
  },

  /**
   * Отчёт движка о версии: подписи, поставленные до расчёта хэшей, получают хэш
   * манифеста (или основного файла, если манифест неполон).
   */
  async fillHash(
    executor: Executor,
    versionId: string,
    value: { hash: string; manifest: DocumentManifest | null },
  ): Promise<void> {
    await executor
      .update(documentSignatures)
      .set({
        hash: value.hash,
        manifest: value.manifest as Record<string, unknown> | null,
      })
      .where(and(eq(documentSignatures.versionId, versionId), isNull(documentSignatures.hash)))
  },

  async list(ctx: UserCtx, documentId: string): Promise<DocumentSignature[]> {
    await authorize(ctx, 'view', documentId)
    const rows = await db()
      .select({
        id: documentSignatures.id,
        versionId: documentSignatures.versionId,
        signerId: documentSignatures.signerId,
        actorId: documentSignatures.actorId,
        signedAt: documentSignatures.signedAt,
        hash: documentSignatures.hash,
        kind: documentSignatures.kind,
        mfa: documentSignatures.mfa,
        manifest: documentSignatures.manifest,
        placement: documentSignatures.placement,
        facsimile: documentSignatures.facsimile,
        certificate: documentSignatures.certificate,
        validation: documentSignatures.validation,
        signedFileId: documentSignatures.signedFileId,
        versionNumber: documentVersions.number,
        versionHash: documentVersions.hash,
        versionManifestHash: documentVersions.manifestHash,
        currentVersionId: documents.currentVersionId,
      })
      .from(documentSignatures)
      .innerJoin(documents, eq(documents.id, documentSignatures.documentId))
      .leftJoin(documentVersions, eq(documentVersions.id, documentSignatures.versionId))
      .where(eq(documentSignatures.documentId, documentId))
      .orderBy(desc(documentSignatures.signedAt))
    const refs = await directory().refs([
      ...new Set(
        rows.flatMap((row) => [row.signerId, row.actorId]).filter((id): id is string => !!id),
      ),
    ])
    const manager = (await authorize(ctx, 'manage', documentId, { soft: true })).allowed
    const ref = (id: string): UserRef =>
      refs.get(id) ?? { id, displayName: '—', avatarUrl: null, position: null, unitName: null }
    return rows.map((row) => {
      // Подпись после ADR-0198 сверяется с манифестом версии, прежняя — с хэшем файла
      const expected = row.manifest ? row.versionManifestHash : row.versionHash
      return {
        id: row.id,
        versionId: row.versionId,
        versionNumber: row.versionNumber ?? null,
        signer: ref(row.signerId),
        actor: row.actorId ? ref(row.actorId) : null,
        signedAt: row.signedAt,
        hash: row.hash,
        kind: row.kind === 'qualified' ? 'qualified' : 'simple',
        mfa: row.mfa,
        state: !row.hash || !expected ? 'pending' : row.hash === expected ? 'valid' : 'mismatch',
        current: row.versionId !== null && row.versionId === row.currentVersionId,
        manifest: (row.manifest as DocumentManifest | null) ?? null,
        facsimile: row.facsimile,
        placement: parsePlacement(row.placement),
        canPlace:
          row.kind !== 'qualified' &&
          (manager ||
            ctx.userId === row.signerId ||
            (row.actorId !== null && ctx.userId === row.actorId)),
        certificate: (row.certificate as QualifiedCertificate | null) ?? null,
        validation: (row.validation as QualifiedValidation | null) ?? null,
        signedFileId: row.signedFileId,
      }
    })
  },

  /**
   * Место факсимиле, выбранное человеком (ADR-0198): подписант, заместитель или
   * управляющий документом; подписанный экземпляр строится заново (подписчик).
   */
  async place(
    tx: Tx,
    ctx: UserCtx,
    documentId: string,
    signatureId: string,
    input: SignaturePlacementInput,
  ): Promise<void> {
    await authorize(ctx, 'view', documentId)
    const [row] = await tx
      .select({
        id: documentSignatures.id,
        signerId: documentSignatures.signerId,
        actorId: documentSignatures.actorId,
        spaceId: objects.spaceId,
        title: objects.title,
      })
      .from(documentSignatures)
      .innerJoin(objects, eq(objects.id, documentSignatures.documentId))
      .where(
        and(eq(documentSignatures.id, signatureId), eq(documentSignatures.documentId, documentId)),
      )
      .limit(1)
      .for('update', { of: documentSignatures })
    if (!row) throw errors.notFound('Подпись')
    const own = ctx.userId === row.signerId || ctx.userId === row.actorId
    if (!own) await authorize(ctx, 'manage', documentId)
    await tx
      .update(documentSignatures)
      .set({ placement: { ...input, source: 'manual' } })
      .where(eq(documentSignatures.id, signatureId))
    await publishEvent(tx, ctx, {
      type: 'document.signature_placed',
      object: { id: documentId, type: 'document', spaceId: row.spaceId, title: row.title },
      payload: { signatureId, page: input.page, x: input.x, y: input.y },
    })
  },
}
