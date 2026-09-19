import { fileBriefs, fileBuckets } from '~/modules/files/public.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { DocumentService } from '../../document-service.js'
import { DocumentTypeService } from '../../type-service.js'
import { DocumentVersionService } from '../../version-service.js'
import { html, overlayPage } from '../html.js'
import type { PrintFormDefinition } from '../registry.js'
import { dateOnly, fileNameOf } from './common.js'

type StampSource =
  | { ok: false; reason: string }
  | {
      ok: true
      row: NonNullable<Awaited<ReturnType<typeof DocumentService.load>>>
      pdfFileId: string
    }

/** PDF-представление текущей версии зарегистрированного документа или причина, почему его нет. */
async function stampSource(documentId: string): Promise<StampSource> {
  const row = await DocumentService.load(db(), documentId)
  if (!row?.regNumber) return { ok: false, reason: 'documents.print.reasons.notRegistered' }
  const version = await DocumentVersionService.record(db(), row.currentVersionId)
  if (!version) return { ok: false, reason: 'documents.print.reasons.noVersion' }
  if (version.pdfStatus === 'pending') {
    return { ok: false, reason: 'documents.print.reasons.pdfPending' }
  }
  if (version.pdfStatus !== 'ready' || !version.pdfFile) {
    return { ok: false, reason: 'documents.print.reasons.noPdf' }
  }
  return { ok: true, row, pdfFileId: version.pdfFile.id }
}

/** Синие «чернила» штампа — как у резинового штампа канцелярии. */
const STAMP_CSS = `
.stamp { position: absolute; right: 14mm; bottom: 12mm; min-width: 52mm; max-width: 82mm;
  border: 1.2pt solid #1d3f8f; border-radius: 1.5mm; color: #1d3f8f; background: rgba(255, 255, 255, 0.88);
  padding: 2mm 3.5mm; font-size: 9.5pt; line-height: 1.35; text-align: center; }
.stamp .org { font-weight: bold; font-size: 8pt; text-transform: uppercase; margin-bottom: 1mm; }
.stamp .number { font-size: 11pt; font-weight: bold; }
`

/**
 * Штамп регистрации (08-documents.md §5, ГОСТ Р 7.0.97 п. 5.27 — правый нижний
 * угол первого листа): организация, «Вх. № …», дата. Накладывается на копию
 * PDF-представления текущей версии — отдельный файл, прикреплённый к
 * документу; сама версия (её PDF и хэш) не меняется.
 */
export const registrationStamp: PrintFormDefinition = {
  key: 'registration_stamp',
  labelKey: 'documents.print.forms.registration_stamp',
  subjectType: 'document',
  unavailable: async (subject) => {
    const source = await stampSource(subject.id)
    return source.ok ? null : source.reason
  },
  build: async (pc, subject) => {
    const source = await stampSource(subject.id)
    if (!source.ok) throw errors.conflict(pc.t(source.reason))
    const { row, pdfFileId } = source
    const type = await DocumentTypeService.load(db(), row.typeId)
    const brief = (await fileBriefs([pdfFileId])).get(pdfFileId)
    if (!brief) throw errors.notFound('PDF-представление')
    const label = pc.t(`documents.print.stamp.${type?.direction ?? 'internal'}`)
    const body = html`<div class="stamp">
      <div class="org">${pc.org}</div>
      <div>${label} <span class="number">${row.regNumber}</span></div>
      <div>${dateOnly(row.regDate, pc)}</div>
    </div>`
    return {
      kind: 'overlay',
      source: {
        bucket: fileBuckets.files(),
        storageKey: brief.storageKey,
        name: brief.name,
        mime: brief.mime,
      },
      html: overlayPage({ lang: pc.locale, css: STAMP_CSS, body }),
      pages: 'first',
      fileName: fileNameOf(row.regNumber, pc.t('documents.print.stamp.suffix')),
    }
  },
}
