import {
  PROTOCOL_DEFAULT_DUE_WORKING_DAYS,
  PROTOCOL_PRINT_FORM,
  type ProtocolBlock,
  type ProtocolRecord,
  richBodyText,
  type UserRef,
} from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import { directory } from '~/kernel/directory/port.js'
import {
  DocumentsPrint,
  type PrintContext,
  type PrintFormDefinition,
} from '~/modules/documents/public.js'
import { MeetingService } from './meeting-service.js'
import { ProtocolService } from './protocol-service.js'

type SafeHtml = ReturnType<typeof DocumentsPrint.html>
const { html, multiline } = DocumentsPrint

function person(ref: UserRef | null | undefined): string {
  if (!ref) return '—'
  return ref.position ? `${ref.displayName}, ${ref.position}` : ref.displayName
}

/** Имя файла без символов, недопустимых в именах файлов и заголовках. */
function fileNameOf(...parts: string[]): string {
  const name = [...parts.join(' ')]
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
  return `${name || 'protocol'}.pdf`
}

/** Текст блока с переносами строк; пустой — ничего. */
function body(block: ProtocolBlock): SafeHtml | string {
  const text = richBodyText(block.body)
  return text ? html`<p>${multiline(text)}</p>` : ''
}

/** Срок поручения: у созданного — срок задачи, у предложения — дата блока или «10 рабочих дней». */
function dueOf(pc: PrintContext, block: ProtocolBlock, protocol: ProtocolRecord): string {
  if (block.kind !== 'instruction') return ''
  const created = protocol.instructions.find((item) => item.blockId === block.id)
  if (created?.dueAt)
    return formatDateTime(created.dueAt, { locale: pc.locale, timezone: pc.timezone })
  if (block.dueAt) return formatDate(block.dueAt, { locale: pc.locale, timezone: 'UTC' })
  return pc.t('meetings.protocol.print.defaultDue', { days: PROTOCOL_DEFAULT_DUE_WORKING_DAYS })
}

/**
 * Печатная форма протокола (N32, ADR-0137): повестка, ход заседания по
 * блокам, таблица поручений и строки подписи председателя и секретаря. При
 * регистрации протокола документом этот PDF становится первой версией —
 * подписывают его. Данные читаются правами того, кто заказал печать.
 */
export const protocolPrintForm: PrintFormDefinition = {
  key: PROTOCOL_PRINT_FORM,
  labelKey: 'documents.print.forms.meeting_protocol',
  subjectType: 'protocol',
  build: async (pc, subject) => {
    const { t } = pc
    const protocol = await ProtocolService.get(pc.ctx, subject.id)
    const meeting = await MeetingService.get(pc.ctx, protocol.meetingId)
    const secretary = meeting.participants.find((item) => item.role === 'secretary')?.user ?? null
    const people = new Set<string>()
    for (const block of protocol.blocks) {
      if (block.kind === 'agenda_item' && block.speakerId) people.add(block.speakerId)
      if (block.kind === 'instruction') {
        if (block.assigneeId) people.add(block.assigneeId)
        if (block.controllerId) people.add(block.controllerId)
      }
    }
    const refs = await directory().refs([...people])
    const ref = (id: string | null) => (id ? (refs.get(id) ?? null) : null)
    const held = meeting.startedAt ?? meeting.startsAt ?? meeting.createdAt
    const present = meeting.participants
      .filter((item) => item.role !== 'guest')
      .map((item) => item.user.displayName)
      .join(', ')

    const agenda = protocol.blocks.filter((block) => block.kind === 'agenda_item')
    const instructions = protocol.blocks.filter((block) => block.kind === 'instruction')
    let question = 0
    const proceedings = protocol.blocks.map((block) => {
      switch (block.kind) {
        case 'agenda_item': {
          question += 1
          const speaker = ref(block.speakerId)
          return html`<p><strong>${question}. ${t('meetings.protocol.print.heard')}:</strong> ${
            block.title || '—'
          }${
            speaker
              ? html` <span class="muted">(${t('meetings.protocol.print.speaker', { name: person(speaker) })})</span>`
              : ''
          }</p>${body(block)}`
        }
        case 'decision':
          return html`<p><strong>${t('meetings.protocol.print.decided')}:</strong> ${block.title}</p>${body(block)}`
        case 'instruction':
          return html`<p><strong>${t('meetings.protocol.kinds.instruction')}:</strong> ${block.title}</p>${body(block)}<p class="muted small">${t('meetings.protocol.assignee')}: ${person(ref(block.assigneeId))}; ${t('meetings.protocol.controller')}: ${person(ref(block.controllerId))}; ${t('meetings.protocol.due')}: ${dueOf(pc, block, protocol)}</p>`
        default:
          return html`<p><em>${block.title}</em></p>${body(block)}`
      }
    })

    const title = t('meetings.protocol.print.title')
    return {
      kind: 'html',
      title,
      body: html`
        <div class="org">${pc.org}</div>
        <h1>${title}</h1>
        <p class="subtitle">${meeting.title}</p>
        <table class="card">
          <tr><th>${t('meetings.protocol.print.held')}</th><td>${formatDateTime(held, { locale: pc.locale, timezone: pc.timezone })}</td></tr>
          <tr><th>${t('meetings.protocol.print.chairman')}</th><td>${person(meeting.organizer)}</td></tr>
          <tr><th>${t('meetings.role.secretary')}</th><td>${person(secretary)}</td></tr>
          <tr><th>${t('meetings.protocol.print.present')}</th><td>${present || '—'}</td></tr>
        </table>
        ${
          protocol.summary
            ? html`<p class="section">${t('meetings.protocol.summary')}</p><p>${multiline(protocol.summary)}</p>`
            : ''
        }
        <p class="section">${t('meetings.protocol.print.agenda')}</p>
        ${
          agenda.length > 0
            ? html`<ol>${agenda.map((block) => html`<li>${block.title || '—'}</li>`)}</ol>`
            : html`<p class="muted">—</p>`
        }
        <p class="section">${t('meetings.protocol.print.proceedings')}</p>
        ${proceedings.length > 0 ? proceedings : html`<p class="muted">—</p>`}
        ${
          instructions.length > 0
            ? html`<p class="section">${t('meetings.protocol.instructions')}</p>
          <table class="grid">
            <thead><tr>
              <th class="num">№</th>
              <th>${t('meetings.protocol.kinds.instruction')}</th>
              <th>${t('meetings.protocol.assignee')}</th>
              <th>${t('meetings.protocol.controller')}</th>
              <th>${t('meetings.protocol.due')}</th>
            </tr></thead>
            <tbody>${instructions.map(
              (block, index) => html`<tr>
                <td class="num">${index + 1}</td>
                <td>${block.title || richBodyText(block.body).split('\n')[0] || '—'}</td>
                <td>${block.kind === 'instruction' ? person(ref(block.assigneeId)) : ''}</td>
                <td>${block.kind === 'instruction' ? person(ref(block.controllerId)) : ''}</td>
                <td>${dueOf(pc, block, protocol)}</td>
              </tr>`,
            )}</tbody>
          </table>`
            : ''
        }
        <div class="signatures">
          <div class="signature">${t('meetings.protocol.print.chairman')}: ${person(meeting.organizer)}</div>
          <div class="signature">${t('meetings.role.secretary')}: ${person(secretary)}</div>
        </div>
      `,
      footer: t('documents.print.footer', {
        org: pc.org,
        name: pc.ctx.displayName,
        date: formatDateTime(pc.now, { locale: pc.locale, timezone: pc.timezone }),
      }),
      fileName: fileNameOf(title, meeting.title),
    }
  },
}
