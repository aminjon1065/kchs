import type { InboxItem } from '@kchs/contracts'
import type { Subscriber } from '~/kernel/events/types.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { AlertService } from './alert-service.js'
import { resolvePeople } from './recipients.js'

/**
 * Доставка срабатываний (ADR-0104): подписчик события `alert.fired` шлёт
 * уведомление, открывает дело во Входящих и письмо — по каналам правила.
 * Сам алерт ничего не рассылает: доставка — потребитель события, как и
 * правила автоматизации, которые ловят тот же домен.
 */

const DISMISS: InboxItem['actions'] = [
  {
    key: 'dismiss',
    labelKey: 'inbox.actions.dismissAlert',
    variant: 'primary',
    requiresComment: false,
  },
]

interface AlertFiredPayload {
  alertId?: string
  eventId?: string
  message?: string
  groupLabel?: string
}

export const alertSubscribers: Subscriber[] = [
  {
    name: 'alerts-deliver',
    types: ['alert.fired'],
    handle: async (event) => {
      const object = event.object
      const payload = (event.payload ?? {}) as AlertFiredPayload
      if (!object || !payload.alertId) return
      const row = await AlertService.load(db(), payload.alertId)
      if (!row) return
      const definition = AlertService.definitionOf(row)
      const recipients = await resolvePeople(definition.recipients, {
        spaceId: row.spaceId || null,
        authorId: row.ownerId,
      })
      const people = recipients.length > 0 ? recipients : row.ownerId ? [row.ownerId] : []
      if (people.length === 0) return
      const params = { title: row.title, message: payload.message ?? '' }

      if (definition.channels.notify || definition.channels.email) {
        await NotificationService.notify({
          userIds: people,
          category: 'data',
          titleKey: 'notifications.alert.fired',
          params,
          objectId: object.id,
          url: `/o/${object.id}`,
          aggregateKey: `alert:${row.id}`,
          ...(definition.channels.email
            ? { channels: definition.channels.notify ? ['app', 'email'] : ['email'] }
            : {}),
        })
      }
      if (definition.channels.inbox) {
        const ctx = systemCtx('alerts.deliver')
        await db().transaction(async (tx) => {
          for (const userId of people) {
            await InboxService.open(tx, ctx, {
              userId,
              kind: 'alert',
              objectId: object.id,
              titleKey: 'inbox.tpl.alertFired',
              params,
              payload: { alertId: row.id, eventId: payload.eventId ?? null },
              priority: 'high',
              dedupeKey: `alert:${payload.eventId ?? row.id}`,
              actions: DISMISS,
            })
          }
        })
      }
    },
  },
]
