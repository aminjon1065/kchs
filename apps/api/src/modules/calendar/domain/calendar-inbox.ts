import type { InboxItem, Locale } from '@kchs/contracts'
import { InboxService } from '~/kernel/inbox/service.js'
import { UserService } from '~/modules/identity/public.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { formatWhen } from './format.js'

/** Кнопки приглашения: да, возможно, нет — из Входящих и из Telegram одним путём. */
export const INVITE_ACTIONS: InboxItem['actions'] = [
  {
    key: 'accepted',
    labelKey: 'inbox.actions.acceptInvite',
    variant: 'primary',
    requiresComment: false,
  },
  {
    key: 'tentative',
    labelKey: 'inbox.actions.tentative',
    variant: 'secondary',
    requiresComment: false,
  },
  {
    key: 'declined',
    labelKey: 'inbox.actions.decline',
    variant: 'danger',
    requiresComment: false,
  },
]

export interface InviteTarget {
  id: string
  startsAt: number
  allDay: boolean
  startDate: string | null
}

const dedupeKey = (eventId: string) => `event:${eventId}:invite`

/**
 * Приглашения во Входящих (12-calendar-notifications-home.md §3): участнику —
 * «ответить на приглашение» со сроком до начала встречи. Закрывает элемент сам
 * ответ (из Входящих, карточки события или Telegram), отмена события или
 * исключение из участников.
 */
export const CalendarInbox = {
  async invite(tx: Executor, ctx: Ctx, event: InviteTarget, userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      const profile = await UserService.profile(userId)
      await InboxService.open(tx, ctx, {
        userId,
        kind: 'respond_invite',
        objectId: event.id,
        titleKey: 'inbox.tpl.respondInvite',
        params: {
          when: formatWhen(event, (profile?.locale as Locale | undefined) ?? 'ru', {
            timezone: profile?.timezone ?? 'Asia/Dushanbe',
          }),
        },
        dueAt: new Date(event.startsAt).toISOString(),
        priority: 'normal',
        dedupeKey: dedupeKey(event.id),
        actions: INVITE_ACTIONS,
      })
    }
  },

  /** Закрыть приглашения события: у одного участника или у всех. */
  async close(
    tx: Executor,
    ctx: Ctx,
    eventId: string,
    userId?: string,
    outcome: 'resolved' | 'dismissed' = 'resolved',
  ): Promise<void> {
    await InboxService.resolve(
      tx,
      ctx,
      { objectId: eventId, kind: 'respond_invite', ...(userId ? { userId } : {}) },
      outcome,
    )
  },

  /** Время встречи изменилось — открытые приглашения переоткрываются с новым сроком. */
  async reopen(tx: Executor, ctx: Ctx, event: InviteTarget, userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      await InboxService.resolve(
        tx,
        ctx,
        { objectId: event.id, kind: 'respond_invite', userId },
        'dismissed',
      )
    }
    await CalendarInbox.invite(tx, ctx, event, userIds)
  },
}
