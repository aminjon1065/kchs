import type { FormSubject } from '@kchs/contracts'
import type { Subscriber } from '~/kernel/events/types.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { db } from '~/shared/db/client.js'
import { FormService } from './form-service.js'
import { submitterOf } from './subject-names.js'

/**
 * Уведомления по формам сбора данных (ADR-0103). Дела Входящих открывает сам
 * доменный код — подписчик добавляет к ним уведомления: напоминание о возврате
 * сводки автору, просрочку — руководителю, приёмку — сдавшему.
 */

interface FormEventPayload {
  submissionId?: string
  periodKey?: string
  subjectKind?: string
  subjectId?: string
  authorId?: string | null
  managerId?: string
  comment?: string
}

const subjectOf = (payload: FormEventPayload): FormSubject | null =>
  (payload.subjectKind === 'unit' || payload.subjectKind === 'user') && payload.subjectId
    ? { kind: payload.subjectKind, id: payload.subjectId }
    : null

export const formSubscribers: Subscriber[] = [
  {
    name: 'forms-notify',
    types: ['form.returned', 'form.accepted', 'form.overdue', 'form.escalated'],
    handle: async (event) => {
      const object = event.object
      if (!object) return
      const payload = (event.payload ?? {}) as FormEventPayload
      const form = await FormService.load(db(), object.id)
      if (!form) return
      const subject = subjectOf(payload)
      const params = { title: form.title, period: payload.periodKey ?? '' }
      const url = `/o/${object.id}`

      if (event.type === 'form.escalated' && payload.managerId) {
        await NotificationService.notify({
          userIds: [payload.managerId],
          category: 'data',
          titleKey: 'notifications.tpl.formEscalated',
          params,
          objectId: object.id,
          url,
        })
        return
      }

      const recipients = new Set<string>()
      if (payload.authorId) recipients.add(payload.authorId)
      if (subject) {
        const submitter = await submitterOf(subject)
        if (submitter) recipients.add(submitter)
      }
      if (recipients.size === 0) return
      const titleKey =
        event.type === 'form.returned'
          ? 'notifications.tpl.formReturned'
          : event.type === 'form.accepted'
            ? 'notifications.tpl.formAccepted'
            : 'notifications.tpl.formOverdue'
      await NotificationService.notify({
        userIds: [...recipients],
        category: 'data',
        titleKey,
        params,
        objectId: object.id,
        actorId: event.actor?.userId ?? null,
        url,
      })
    },
  },
]
