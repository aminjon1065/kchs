import type { DocumentRecord, UserRef } from '@kchs/contracts'
import type { ProcessInstanceView, ProcessStepView } from '@kchs/process'
import { eq } from 'drizzle-orm'
import { ProcessView } from '~/kernel/process/index.js'
import { db } from '~/shared/db/client.js'
import { documentSignatures, processInstances } from '~/shared/db/schema/index.js'
import { DocumentService } from '../../document-service.js'
import { stepVersions } from '../../routes/provider.js'
import { DocumentSignatures } from '../../routes/signatures.js'
import { html, multiline, type SafeHtml } from '../html.js'
import type { PrintContext, PrintFormDefinition, PrintSubject } from '../registry.js'
import { dateOnly, dateTime, fileNameOf, footerOf, person } from './common.js'

/** Шаги, где люди принимают решения, — строки листа согласования. */
const DECISION_STEPS = new Set(['approval', 'sign', 'register', 'acknowledge', 'return'])
/** Назначенные, чьё решение не требовалось, в лист не попадают. */
const SKIPPED = new Set(['cancelled', 'waiting'])

/** Шапка листа: организация, заголовок, вид, номер и тема документа. */
function header(pc: PrintContext, doc: DocumentRecord, title: string): SafeHtml {
  const typeName = doc.type.name[pc.locale] ?? doc.type.name.ru
  const number = doc.regNumber
    ? pc.t('documents.print.sheets.numbered', {
        number: doc.regNumber,
        date: dateOnly(doc.regDate, pc),
      })
    : pc.t('documents.print.sheets.draft')
  return html`
    <div class="org">${pc.org}</div>
    <h1>${title}</h1>
    <p class="subtitle">${typeName} · ${number}</p>
    <p><strong>${pc.t('documents.fields.subject')}:</strong> ${doc.subject || '—'}</p>
  `
}

/** Кто решил: сам участник или заместитель за него. */
function who(pc: PrintContext, user: UserRef, actor: UserRef | null): string {
  return actor && actor.id !== user.id
    ? pc.t('documents.print.sheets.onBehalf', { actor: person(actor), name: person(user) })
    : person(user)
}

/** Комментарий назначенного на шаге: последнее его действие с текстом. */
function commentOf(step: ProcessStepView, userId: string): string | null {
  const own = step.actions.filter(
    (action) =>
      action.comment &&
      (action.onBehalfOf?.id === userId || (!action.onBehalfOf && action.actor?.id === userId)),
  )
  return own.at(-1)?.comment ?? null
}

async function routesOf(pc: PrintContext, documentId: string): Promise<ProcessInstanceView[]> {
  const summaries = await ProcessView.listForObject(pc.ctx, documentId)
  const views: ProcessInstanceView[] = []
  for (const summary of [...summaries].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    views.push(await ProcessView.get(pc.ctx, summary.id))
  }
  return views
}

function stepName(pc: PrintContext, step: ProcessStepView): string {
  const own = step.name ? (step.name[pc.locale] ?? step.name.ru) : ''
  return own || pc.t(`processes.types.${step.type}`)
}

/**
 * Лист согласования (08-documents.md §4, §5): по каждому маршруту документа —
 * этапы по кругам, участники и их решения с датой, комментарием и версией,
 * которую они видели (замороженная версия шага, ADR-0083).
 */
export const approvalSheet: PrintFormDefinition = {
  key: 'approval_sheet',
  labelKey: 'documents.print.forms.approval_sheet',
  subjectType: 'document',
  typeListed: false,
  unavailable: async (subject: PrintSubject) => {
    const [route] = await db()
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(eq(processInstances.objectId, subject.id))
      .limit(1)
    return route ? null : 'documents.print.reasons.noRoute'
  },
  build: async (pc, subject) => {
    const doc = await DocumentService.get(pc.ctx, subject.id)
    const routes = await routesOf(pc, subject.id)
    const versions = await stepVersions(db(), subject.id)
    const { t } = pc
    const title = t('documents.print.sheets.approvalTitle')
    const sections = routes.map((route) => {
      const name = route.name[pc.locale] ?? route.name.ru
      const rows: SafeHtml[] = []
      let index = 0
      for (const step of route.steps) {
        if (!DECISION_STEPS.has(step.type)) continue
        const version = versions.get(step.id)?.number
        for (const assignee of step.assignees) {
          if (SKIPPED.has(assignee.state)) continue
          index += 1
          const comment = commentOf(step, assignee.user.id)
          rows.push(html`<tr>
            <td class="num">${index}</td>
            <td>${stepName(pc, step)}${
              step.round > 1
                ? html`<br /><span class="muted">${t('documents.print.sheets.round', { round: step.round })}</span>`
                : ''
            }</td>
            <td>${who(pc, assignee.user, assignee.actor)}</td>
            <td>${t(`processes.entries.${assignee.state}`)}</td>
            <td>${assignee.decidedAt ? dateTime(assignee.decidedAt, pc) : '—'}</td>
            <td class="num">${version ?? '—'}</td>
            <td>${comment ? multiline(comment) : ''}</td>
          </tr>`)
        }
      }
      const state = route.outcome
        ? t(`processes.outcomes.${route.outcome}`)
        : t(`processes.status.${route.status}`)
      return html`
        <p class="section">${t('documents.print.sheets.route', {
          name,
          date: dateTime(route.startedAt, pc),
          state,
        })}</p>
        <table class="grid">
          <thead><tr>
            <th class="num">№</th>
            <th>${t('documents.print.sheets.step')}</th>
            <th>${t('documents.print.sheets.participant')}</th>
            <th>${t('documents.print.sheets.decision')}</th>
            <th>${t('documents.print.sheets.date')}</th>
            <th class="num">${t('documents.print.sheets.version')}</th>
            <th>${t('documents.print.sheets.comment')}</th>
          </tr></thead>
          <tbody>${
            rows.length > 0
              ? rows
              : html`<tr><td colspan="7" class="muted">${t('documents.print.sheets.noDecisions')}</td></tr>`
          }</tbody>
        </table>
      `
    })
    return {
      kind: 'html',
      title,
      orientation: 'landscape',
      body: html`${header(pc, doc, title)}${
        sections.length > 0
          ? sections
          : html`<p class="muted">${t('documents.print.sheets.noRoutes')}</p>`
      }`,
      footer: footerOf(pc),
      fileName: fileNameOf(title, doc.regNumber ?? doc.subject),
    }
  },
}

/**
 * Лист подписи (08-documents.md §9): простая ЭП — подписант, за кого,
 * время, подписанная версия и её хэш SHA-256, подтверждение кодом, проверка
 * хэша с текущим файлом версии (ADR-0083).
 */
export const signatureSheet: PrintFormDefinition = {
  key: 'signature_sheet',
  labelKey: 'documents.print.forms.signature_sheet',
  subjectType: 'document',
  typeListed: false,
  unavailable: async (subject: PrintSubject) => {
    const [signature] = await db()
      .select({ id: documentSignatures.id })
      .from(documentSignatures)
      .where(eq(documentSignatures.documentId, subject.id))
      .limit(1)
    return signature ? null : 'documents.print.reasons.noSignatures'
  },
  build: async (pc, subject) => {
    const doc = await DocumentService.get(pc.ctx, subject.id)
    const signatures = await DocumentSignatures.list(pc.ctx, subject.id)
    const { t } = pc
    const title = t('documents.print.sheets.signatureTitle')
    const rows = signatures.map(
      (signature, index) => html`<tr>
        <td class="num">${index + 1}</td>
        <td>${who(pc, signature.signer, signature.actor)}</td>
        <td>${dateTime(signature.signedAt, pc)}</td>
        <td class="num">${signature.versionNumber ?? '—'}</td>
        <td class="mono">${signature.hash ?? t('documents.signatures.state.pending')}</td>
        <td>${signature.mfa ? t('documents.print.sheets.mfaYes') : t('documents.print.sheets.mfaNo')}</td>
        <td>${t(`documents.signatures.state.${signature.state}`)}</td>
      </tr>`,
    )
    return {
      kind: 'html',
      title,
      orientation: 'landscape',
      body: html`${header(pc, doc, title)}
        <table class="grid">
          <thead><tr>
            <th class="num">№</th>
            <th>${t('documents.print.sheets.signer')}</th>
            <th>${t('documents.print.sheets.signedAt')}</th>
            <th class="num">${t('documents.print.sheets.version')}</th>
            <th>${t('documents.print.sheets.hash')}</th>
            <th>${t('documents.print.sheets.mfa')}</th>
            <th>${t('documents.print.sheets.check')}</th>
          </tr></thead>
          <tbody>${
            rows.length > 0
              ? rows
              : html`<tr><td colspan="7" class="muted">${t('documents.print.sheets.noSignatures')}</td></tr>`
          }</tbody>
        </table>
        <p class="muted">${t('documents.print.sheets.signatureNote')}</p>`,
      footer: footerOf(pc),
      fileName: fileNameOf(title, doc.regNumber ?? doc.subject),
    }
  },
}
