import type { DocumentSignature, OverlayImage } from '@kchs/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import QRCode from 'qrcode'
import { FacsimileService } from '~/kernel/directory/facsimile.js'
import { directory } from '~/kernel/directory/port.js'
import { fileBuckets, fileVersionBriefs } from '~/modules/files/public.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { documentSignatures, documentVersions } from '../../../schema.js'
import { DocumentService } from '../../document-service.js'
import { DocumentSignatures } from '../../routes/signatures.js'
import { shortNameOf } from '../../template-context.js'
import { DocumentVersionService } from '../../version-service.js'
import { html, overlayPage, SafeHtml } from '../html.js'
import type { PrintContext, PrintFormDefinition } from '../registry.js'
import { dateOnly, dateTime, fileNameOf, person } from './common.js'

/** Маркер места подписи в бланке: шаблон DOCX ставит его невидимым (ADR-0198). */
export const SIGN_MARKER = '[[SIGN]]'
/** Ширина факсимиле на листе и предел его высоты, мм. */
const FACSIMILE_WIDTH_MM = 40
const FACSIMILE_MAX_HEIGHT_MM = 20

/** Адрес страницы проверки подписи — его кодирует QR штампа. */
export function verifyUrl(signatureId: string): string {
  return `${config().KCHS_BASE_URL.replace(/\/+$/, '')}/api/v1/verify/${signatureId}`
}

type StampSource =
  | { ok: false; reason: string }
  | {
      ok: true
      row: NonNullable<Awaited<ReturnType<typeof DocumentService.load>>>
      versionId: string
      pdf: { storageKey: string; name: string }
    }

/** PDF-представление текущей версии, у которой есть подписи, — или причина, почему его нет. */
async function stampSource(documentId: string, versionId?: string): Promise<StampSource> {
  const row = await DocumentService.load(db(), documentId)
  if (!row?.currentVersionId) return { ok: false, reason: 'documents.print.reasons.noVersion' }
  if (versionId && versionId !== row.currentVersionId) {
    return { ok: false, reason: 'documents.print.reasons.versionChanged' }
  }
  const [signed] = await db()
    .select({ id: documentSignatures.id })
    .from(documentSignatures)
    .where(
      and(
        eq(documentSignatures.documentId, documentId),
        eq(documentSignatures.versionId, row.currentVersionId),
      ),
    )
    .limit(1)
  if (!signed) return { ok: false, reason: 'documents.print.reasons.noSignatures' }
  const version = await DocumentVersionService.record(db(), row.currentVersionId)
  if (!version) return { ok: false, reason: 'documents.print.reasons.noVersion' }
  if (version.pdfStatus === 'pending') {
    return { ok: false, reason: 'documents.print.reasons.pdfPending' }
  }
  if (version.pdfStatus !== 'ready' || !version.pdfFile?.versionId) {
    return { ok: false, reason: 'documents.print.reasons.noPdf' }
  }
  const pinned = (await fileVersionBriefs([version.pdfFile.versionId])).get(
    version.pdfFile.versionId,
  )
  if (!pinned) return { ok: false, reason: 'documents.print.reasons.noPdf' }
  return {
    ok: true,
    row,
    versionId: row.currentVersionId,
    pdf: { storageKey: pinned.storageKey, name: pinned.name },
  }
}

/** Синие «чернила» штампа электронной подписи, левый нижний угол последнего листа. */
const STAMP_CSS = `
.esign { position: absolute; left: 12mm; bottom: 10mm; width: 96mm; display: flex; gap: 3mm;
  align-items: flex-start; border: 1pt solid #1d3f8f; border-radius: 1.5mm; color: #1d3f8f;
  background: rgba(255, 255, 255, 0.9); padding: 2mm 2.5mm; font-size: 7.5pt; line-height: 1.3; }
.esign .qr { width: 22mm; height: 22mm; flex: none; }
.esign .qr svg { width: 22mm; height: 22mm; display: block; }
.esign .title { font-weight: bold; text-transform: uppercase; font-size: 7pt; margin-bottom: 0.8mm; }
.esign .who { font-weight: bold; }
.esign .row { margin-top: 0.4mm; }
.esign .hash { font-family: 'DejaVu Sans Mono', monospace; font-size: 6.5pt; }
`

function signerLine(pc: PrintContext, signature: DocumentSignature): string {
  return signature.actor && signature.actor.id !== signature.signer.id
    ? pc.t('documents.print.esign.onBehalf', {
        actor: person(signature.actor),
        name: person(signature.signer),
      })
    : person(signature.signer)
}

/**
 * Факсимиле подписавших: подписал заместитель — его факсимиле, не подписанта
 * (ADR-0198 п. 3). Якоря — маркер бланка (у единственной подписи) и фамилия с
 * инициалами того, за кого подписано.
 */
async function facsimiles(signatures: DocumentSignature[]): Promise<OverlayImage[]> {
  const drawers = signatures.map((signature) => signature.actor?.id ?? signature.signer.id)
  const images = await FacsimileService.imagesFor(drawers)
  const result: OverlayImage[] = []
  for (const [index, signature] of signatures.entries()) {
    const image = images.get(drawers[index] ?? '')
    if (!image) continue
    const profile = await directory().profile(signature.signer.id)
    const name = shortNameOf(signature.signer, profile)
    let widthMm = FACSIMILE_WIDTH_MM
    let heightMm = (widthMm * image.height) / image.width
    if (heightMm > FACSIMILE_MAX_HEIGHT_MM) {
      heightMm = FACSIMILE_MAX_HEIGHT_MM
      widthMm = (heightMm * image.width) / image.height
    }
    const manual = signature.placement?.source === 'manual' ? signature.placement : null
    result.push({
      id: signature.id,
      dataUri: image.dataUri,
      widthMm: Math.round(widthMm * 10) / 10,
      heightMm: Math.round(heightMm * 10) / 10,
      anchors: [
        ...(signatures.length === 1 ? [{ text: SIGN_MARKER, mode: 'cover' as const }] : []),
        ...(name.trim().length >= 2 ? [{ text: name, mode: 'left' as const }] : []),
      ],
      manual: manual ? { page: manual.page, x: manual.x, y: manual.y } : null,
      // Над штампом, у левого края: если в тексте нет ни маркера, ни фамилии
      fallback: { x: 0.25 + 0.27 * (index % 2), y: 0.78 - 0.06 * Math.floor(index / 2) },
    })
  }
  return result
}

/**
 * Подписанный экземпляр (08-documents.md §9, ADR-0198): копия закреплённого
 * PDF-представления подписанной версии с факсимиле у фамилии и штампом
 * электронной подписи с QR-кодом на последнем листе. Версия, её PDF и хэши не
 * меняются; экземпляр — отдельный файл документа.
 */
export const signatureStamp: PrintFormDefinition = {
  key: 'signature_stamp',
  labelKey: 'documents.print.forms.signature_stamp',
  subjectType: 'document',
  typeListed: false,
  unavailable: async (subject) => {
    const source = await stampSource(subject.id)
    return source.ok ? null : source.reason
  },
  build: async (pc, subject, params) => {
    const source = await stampSource(subject.id, params.versionId)
    if (!source.ok) throw errors.conflict(pc.t(source.reason))
    const { row, versionId, pdf } = source
    const signatures = (await DocumentSignatures.list(pc.ctx, subject.id))
      .filter((signature) => signature.versionId === versionId)
      .sort((a, b) => (a.signedAt < b.signedAt ? -1 : 1))
    const last = signatures.at(-1)
    if (!last) throw errors.conflict(pc.t('documents.print.reasons.noSignatures'))
    const qr = await QRCode.toString(verifyUrl(last.id), {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#1d3f8f', light: '#ffffff00' },
    })
    const number = row.regNumber
      ? pc.t('documents.print.esign.number', {
          number: row.regNumber,
          date: dateOnly(row.regDate, pc),
        })
      : null
    const body = html`<div class="esign">
      <div class="qr">${new SafeHtml(qr)}</div>
      <div>
        <div class="title">${pc.t('documents.print.esign.title')}</div>
        <div>${pc.org}</div>
        ${number ? html`<div class="row">${number}</div>` : ''}
        ${signatures.map(
          (signature) => html`<div class="row">
            <span class="who">${signerLine(pc, signature)}</span><br>
            ${dateTime(signature.signedAt, pc)}${
              signature.mfa ? html` · ${pc.t('documents.print.esign.mfa')}` : ''
            }
          </div>`,
        )}
        <div class="row hash">${pc.t('documents.print.esign.id', { id: last.id })}<br>SHA-256 ${
          (last.hash ?? '').slice(0, 16) || pc.t('documents.signatures.state.pending')
        }</div>
      </div>
    </div>`
    return {
      kind: 'overlay',
      source: {
        bucket: fileBuckets.files(),
        storageKey: pdf.storageKey,
        name: pdf.name,
        mime: 'application/pdf',
      },
      html: overlayPage({ lang: pc.locale, css: STAMP_CSS, body }),
      pages: 'last',
      images: await facsimiles(signatures),
      fileName: fileNameOf(row.regNumber ?? subject.title, pc.t('documents.print.esign.suffix')),
    }
  },
  onReady: async (tx, _ctx, ready) => {
    const versionId = ready.params.versionId
    if (!versionId) return
    await tx
      .update(documentVersions)
      .set({ signedCopyFileId: ready.fileId })
      .where(
        and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, ready.subjectId)),
      )
    // Где встали факсимиле: выбранное человеком место не перезаписываем
    const ids = ready.placements.map((placement) => placement.id)
    const rows =
      ids.length > 0
        ? await tx
            .select({ id: documentSignatures.id, placement: documentSignatures.placement })
            .from(documentSignatures)
            .where(
              and(
                inArray(documentSignatures.id, ids),
                eq(documentSignatures.documentId, ready.subjectId),
              ),
            )
        : []
    for (const row of rows) {
      const placement = ready.placements.find((item) => item.id === row.id)
      if (!placement) continue
      const manual = (row.placement as { source?: string } | null)?.source === 'manual'
      await tx
        .update(documentSignatures)
        .set({
          facsimile: true,
          ...(manual
            ? {}
            : {
                placement: {
                  page: placement.page,
                  x: placement.x,
                  y: placement.y,
                  source: placement.source,
                },
              }),
        })
        .where(eq(documentSignatures.id, row.id))
    }
  },
}
