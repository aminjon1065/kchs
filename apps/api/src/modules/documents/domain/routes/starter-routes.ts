import type { ProcessDefinitionInput } from '@kchs/process'
import { eq } from 'drizzle-orm'
import { ProcessDefinitions } from '~/kernel/process/index.js'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { documentTypes } from '~/shared/db/schema/index.js'
import { DocumentTypeService } from '../type-service.js'

/**
 * Просрочка шага — руководителю не ответившего и автору (08-documents.md §4):
 * тем, кто документ не видит, ядро пишет без содержания (ADR-0083).
 */
const ESCALATION: ProcessDefinitionInput['timers'] = [
  {
    step: '*',
    onOverdue: [
      { action: 'notify', to: 'manager(step.assignee)' },
      { action: 'notify', to: 'author' },
    ],
  },
]

const returnToAuthor = (next: string, reapproval: 'full' | 'rejecters_only') => ({
  type: 'return' as const,
  name: { ru: 'Доработка автором', tg: 'Такмил аз ҷониби муаллиф', en: 'Revision by the author' },
  to: 'author',
  reapproval,
  next,
})

/**
 * Исходящее письмо (сценарий B, 08-documents.md §4): параллельно юрист и
 * профильный отдел (выбирает инициатор), затем заместитель руководителя
 * (руководитель руководителя подразделения автора), подпись руководителя из
 * карточки с кодом второго фактора, регистрация канцелярией. После замечаний —
 * повторно согласуют только не одобрившие.
 */
const OUTGOING: ProcessDefinitionInput = {
  version: 1,
  key: 'document_outgoing',
  objectType: 'document',
  name: {
    ru: 'Исходящее: согласование, подпись, регистрация',
    tg: 'Содиротӣ: мувофиқа, имзо, бақайдгирӣ',
    en: 'Outgoing: approval, signature, registration',
  },
  description: {
    ru: 'Юрист и профильный отдел параллельно, затем заместитель руководителя; подпись с подтверждением; регистрация в канцелярии',
    en: 'Legal and subject-matter unit in parallel, then the deputy head; confirmed signature; registration by the registry office',
  },
  start: 'review',
  steps: {
    review: {
      type: 'approval',
      name: {
        ru: 'Согласование: юрист и профильный отдел',
        tg: 'Мувофиқа: ҳуқуқшинос ва шӯъбаи соҳавӣ',
        en: 'Approval: legal and subject-matter unit',
      },
      mode: 'parallel',
      quorum: 'all',
      assignees: ['chosen_by_initiator'],
      dueWorkingDays: 3,
      onReject: 'return_to_author',
      allowAddApprover: true,
      next: 'deputy',
    },
    deputy: {
      type: 'approval',
      name: {
        ru: 'Согласование заместителя руководителя',
        tg: 'Мувофиқаи муовини роҳбар',
        en: 'Deputy head approval',
      },
      mode: 'sequential',
      assignees: ['manager(unit_head(author.unit))'],
      dueWorkingDays: 2,
      onReject: 'return_to_author',
      next: 'sign',
    },
    sign: {
      type: 'sign',
      name: { ru: 'Подпись руководителя', tg: 'Имзои роҳбар', en: 'Head signature' },
      assignees: ['field:signer'],
      dueWorkingDays: 2,
      requireMfa: true,
      onReject: 'return_to_author',
      next: 'register',
    },
    register: {
      type: 'register',
      name: {
        ru: 'Регистрация исходящего',
        tg: 'Бақайдгирии содиротӣ',
        en: 'Outgoing registration',
      },
      assignees: ['role:registrar'],
      dueWorkingDays: 1,
      next: 'end',
    },
    return_to_author: returnToAuthor('review', 'rejecters_only'),
    end: { type: 'end', outcome: 'completed' },
  },
  timers: ESCALATION,
}

/** Приказ и распоряжение: согласование, подпись с кодом, регистрация по подписи. */
const ORDER: ProcessDefinitionInput = {
  version: 1,
  key: 'document_order',
  objectType: 'document',
  name: {
    ru: 'Приказ: согласование, подпись, регистрация',
    tg: 'Фармоиш: мувофиқа, имзо, бақайдгирӣ',
    en: 'Order: approval, signature, registration',
  },
  description: {
    ru: 'Согласующих выбирает инициатор; подпись руководителя из карточки; номер — сразу после подписи',
    en: 'Approvers are chosen by the initiator; the signer comes from the card; numbered on signing',
  },
  start: 'review',
  steps: {
    review: {
      type: 'approval',
      name: { ru: 'Согласование проекта', tg: 'Мувофиқаи лоиҳа', en: 'Draft approval' },
      mode: 'parallel',
      quorum: 'all',
      assignees: ['chosen_by_initiator'],
      dueWorkingDays: 3,
      onReject: 'return_to_author',
      allowAddApprover: true,
      next: 'sign',
    },
    sign: {
      type: 'sign',
      name: { ru: 'Подпись руководителя', tg: 'Имзои роҳбар', en: 'Head signature' },
      assignees: ['field:signer'],
      dueWorkingDays: 2,
      requireMfa: true,
      onReject: 'return_to_author',
      next: 'register',
    },
    register: {
      type: 'register',
      name: { ru: 'Регистрация', tg: 'Бақайдгирӣ', en: 'Registration' },
      next: 'end',
    },
    return_to_author: returnToAuthor('review', 'full'),
    end: { type: 'end', outcome: 'completed' },
  },
  timers: ESCALATION,
}

/** Служебная записка: подпись руководителя подразделения автора и регистрация. */
const MEMO: ProcessDefinitionInput = {
  version: 1,
  key: 'document_memo',
  objectType: 'document',
  name: {
    ru: 'Служебная записка: подпись руководителя подразделения',
    tg: 'Мактуби хизматӣ: имзои роҳбари воҳид',
    en: 'Memo: signature of the unit head',
  },
  start: 'sign',
  steps: {
    sign: {
      type: 'sign',
      name: {
        ru: 'Подпись руководителя подразделения',
        tg: 'Имзои роҳбари воҳид',
        en: 'Unit head signature',
      },
      assignees: ['unit_head(author.unit)'],
      dueWorkingDays: 2,
      onReject: 'return_to_author',
      next: 'register',
    },
    register: {
      type: 'register',
      name: { ru: 'Регистрация', tg: 'Бақайдгирӣ', en: 'Registration' },
      next: 'end',
    },
    return_to_author: returnToAuthor('sign', 'full'),
    end: { type: 'end', outcome: 'completed' },
  },
  timers: ESCALATION,
}

export const STARTER_ROUTES: readonly ProcessDefinitionInput[] = [OUTGOING, ORDER, MEMO]

/** Маршрут по умолчанию стартовых типов (ключ типа → ключ маршрута). */
const TYPE_ROUTES: Record<string, string> = {
  outgoing_letter: 'document_outgoing',
  order: 'document_order',
  directive: 'document_order',
  memo: 'document_memo',
  report_memo: 'document_memo',
}

/**
 * Стартовые маршруты (`kchs init`, `db:seed`) — идемпотентно: маршрут с тем же
 * ключом, изменённый администратором, не трогается; тип получает маршрут по
 * умолчанию, только если его ещё не выбрали.
 */
export async function ensureStarterRoutes(ctx: Ctx): Promise<number> {
  let created = 0
  for (const definition of STARTER_ROUTES) {
    if (await db().transaction((tx) => ProcessDefinitions.ensure(tx, ctx, definition))) {
      created += 1
    }
  }
  for (const [typeKey, routeKey] of Object.entries(TYPE_ROUTES)) {
    const [type] = await db()
      .select({ id: documentTypes.id, defaultRouteKey: documentTypes.defaultRouteKey })
      .from(documentTypes)
      .where(eq(documentTypes.key, typeKey))
      .limit(1)
    if (!type || type.defaultRouteKey) continue
    await db().transaction((tx) =>
      DocumentTypeService.update(tx, ctx, type.id, { defaultRouteKey: routeKey }),
    )
  }
  return created
}
