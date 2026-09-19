import type { DocumentSignature, UserRef } from '@kchs/contracts'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import {
  documentSignatures,
  documentStepVersions,
  documents,
  documentVersions,
} from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'

/**
 * Простая электронная подпись (08-documents.md §9, ADR-0083): решение
 * «Подписать» шага маршрута фиксирует хэш замороженной версии, подписанта,
 * заместителя, сессию и подтверждение вторым фактором. Хэш версии считает
 * движок; подпись, поставленная раньше отчёта движка, получает хэш с ним.
 */
export const DocumentSignatures = {
  /** Версия, которую шаг видел при активации (заморозка), иначе — текущая. */
  async versionOfStep(
    executor: Executor,
    documentId: string,
    stepId: string,
  ): Promise<{ id: string; hash: string | null } | null> {
    const [frozen] = await executor
      .select({ id: documentVersions.id, hash: documentVersions.hash })
      .from(documentStepVersions)
      .innerJoin(documentVersions, eq(documentVersions.id, documentStepVersions.versionId))
      .where(eq(documentStepVersions.stepId, stepId))
      .limit(1)
    if (frozen) return frozen
    const [current] = await executor
      .select({ id: documentVersions.id, hash: documentVersions.hash })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
      .where(eq(documents.id, documentId))
      .limit(1)
    return current ?? null
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
    },
  ): Promise<{ id: string; versionId: string | null; hash: string | null }> {
    const version = await DocumentSignatures.versionOfStep(tx, input.documentId, input.stepId)
    const id = newId()
    await tx.insert(documentSignatures).values({
      id,
      documentId: input.documentId,
      versionId: version?.id ?? null,
      stepId: input.stepId,
      signerId: input.signerId,
      actorId: input.actorId !== input.signerId ? input.actorId : null,
      sessionId: ctx.kind === 'user' ? ctx.sessionId : null,
      hash: version?.hash ?? null,
      kind: input.kind,
      mfa: input.mfa,
    })
    return { id, versionId: version?.id ?? null, hash: version?.hash ?? null }
  },

  /** Отчёт движка о версии: подписи, поставленные до расчёта хэша, получают его. */
  async fillHash(executor: Executor, versionId: string, hash: string): Promise<void> {
    await executor
      .update(documentSignatures)
      .set({ hash })
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
        versionNumber: documentVersions.number,
        versionHash: documentVersions.hash,
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
    const ref = (id: string): UserRef =>
      refs.get(id) ?? { id, displayName: '—', avatarUrl: null, position: null, unitName: null }
    return rows.map((row) => ({
      id: row.id,
      versionId: row.versionId,
      versionNumber: row.versionNumber ?? null,
      signer: ref(row.signerId),
      actor: row.actorId ? ref(row.actorId) : null,
      signedAt: row.signedAt,
      hash: row.hash,
      kind: row.kind === 'qualified' ? 'qualified' : 'simple',
      mfa: row.mfa,
      state:
        !row.hash || !row.versionHash
          ? 'pending'
          : row.hash === row.versionHash
            ? 'valid'
            : 'mismatch',
      current: row.versionId !== null && row.versionId === row.currentVersionId,
    }))
  },
}
