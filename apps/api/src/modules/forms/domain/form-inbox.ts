import type { FormSubject, InboxItem } from '@kchs/contracts'
import { InboxService } from '~/kernel/inbox/service.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import type { FormRow } from './form-service.js'
import { subjectNames, submittersOf } from './subject-names.js'

/**
 * Дела Входящих формы (12-calendar-notifications-home.md §3, ADR-0103):
 * назначенному — «Сдать сводку», ответственному — «Принять сводку».
 * Ключ дедупликации содержит отправку: у одной формы дел столько, сколько
 * открытых периодов.
 */

const FILL: InboxItem['actions'] = [
  {
    key: 'fill',
    labelKey: 'inbox.actions.fillForm',
    variant: 'primary',
    requiresComment: false,
    /** Заполнение — экран формы: Входящие открывают объект. */
    openObject: true,
  },
]

const REVIEW: InboxItem['actions'] = [
  {
    key: 'accept',
    labelKey: 'inbox.actions.acceptForm',
    variant: 'primary',
    requiresComment: false,
  },
  { key: 'return', labelKey: 'inbox.actions.return', variant: 'secondary', requiresComment: true },
]

interface SubmissionLike {
  id: string
  periodKey: string
  dueAt: string | null
}

export const FormInbox = {
  /** Назначенному: заполнить и сдать сводку за период. */
  async submit(
    tx: Executor,
    ctx: Ctx,
    form: FormRow,
    submission: SubmissionLike,
    subject: FormSubject,
  ): Promise<void> {
    for (const userId of await submittersOf(subject)) {
      await InboxService.open(tx, ctx, {
        userId,
        kind: 'submit_form',
        objectId: form.id,
        titleKey: 'inbox.tpl.submitForm',
        params: { title: form.title, period: submission.periodKey },
        payload: { submissionId: submission.id, periodKey: submission.periodKey },
        dueAt: submission.dueAt,
        priority: 'normal',
        dedupeKey: `form:${submission.id}:submit`,
        actions: FILL,
      })
    }
  },

  /** Ответственным: принять сводку или вернуть с комментарием. */
  async review(
    tx: Executor,
    ctx: Ctx,
    form: FormRow,
    submission: SubmissionLike,
    subject: FormSubject,
  ): Promise<void> {
    const names = await subjectNames([subject])
    for (const userId of form.reviewers) {
      await InboxService.open(tx, ctx, {
        userId,
        kind: 'review_form',
        objectId: form.id,
        titleKey: 'inbox.tpl.reviewForm',
        params: {
          title: form.title,
          period: submission.periodKey,
          subject: names.get(`${subject.kind}:${subject.id}`) ?? '',
        },
        payload: { submissionId: submission.id, periodKey: submission.periodKey },
        dueAt: submission.dueAt,
        priority: 'normal',
        dedupeKey: `form:${submission.id}:review`,
        actions: REVIEW,
      })
    }
  },

  async closeSubmit(tx: Executor, ctx: Ctx, submissionId: string): Promise<void> {
    await InboxService.resolve(tx, ctx, { dedupeKey: `form:${submissionId}:submit` }, 'resolved')
  },

  async closeReview(tx: Executor, ctx: Ctx, submissionId: string): Promise<void> {
    await InboxService.resolve(tx, ctx, { dedupeKey: `form:${submissionId}:review` }, 'resolved')
  },
}
