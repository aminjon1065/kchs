import type { Locale } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import type { Context } from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { directory } from '~/kernel/directory/port.js'
import { type InboxOpenAction, InboxService } from '~/kernel/inbox/service.js'
import type { ChannelAction } from '~/kernel/notifications/channels.js'
import { AppError } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import { TelegramLinks } from './links.js'

/**
 * Кнопки дел Входящих в Telegram (10-tasks-projects.md §8, ADR-0082): «Принять»,
 * «Отчитаться» (текстом), «Продлить» (дата и обоснование), «Принять отчёт»,
 * «Вернуть», «Согласовать продление». Нажатие ведёт в тот же
 * `InboxService.act`, что и кнопка Входящих, с контекстом привязанного
 * пользователя; действие с комментарием бот спрашивает ответным сообщением.
 */

/** Данные кнопки: `a:<элемент>:<действие>` — не длиннее 64 байт Bot API. */
const CALLBACK = /^a:([0-9a-f-]{36}):([a-z_]{1,24})$/i
/** Ожидание ответа на вопрос бота — 15 минут. */
const PENDING_TTL_SECONDS = 15 * 60

const pendingKey = (chatId: number) => `kchs:telegram:pending:${chatId}`

interface Pending {
  userId: string
  itemId: string
  key: string
  input: 'due_date' | null
}

/** Кнопки действий: по две в ряд, подписи — на языке получателя. */
export function actionKeyboard(
  actions: ReadonlyArray<Pick<ChannelAction, 'itemId' | 'key' | 'labelKey'>>,
  locale: Locale,
): InlineKeyboardButton[][] {
  const t = createTranslator(locale)
  const buttons = actions.map((action) => ({
    text: t(action.labelKey),
    callback_data: `a:${action.itemId}:${action.key}`,
  }))
  const rows: InlineKeyboardButton[][] = []
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2))
  return rows
}

/** «25.09.2026 причина» или «2026-09-25 причина» → дата и обоснование. */
export function parseDueAndReason(text: string): { date: string; reason: string } | null {
  const trimmed = text.trim()
  const russian = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s+(.+)$/su.exec(trimmed)
  const iso = /^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/su.exec(trimmed)
  const [year, month, day, reason] = russian
    ? [russian[3], russian[2], russian[1], russian[4]]
    : iso
      ? [iso[1], iso[2], iso[3], iso[4]]
      : []
  if (!year || !month || !day || !reason?.trim()) return null
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  return { date, reason: reason.trim() }
}

/** Привязанный к чату действующий сотрудник и его контекст; иначе — null. */
async function userOf(chatId: number) {
  const link = await TelegramLinks.byChat(chatId)
  if (!link) return null
  const ref = (await directory().refs([link.userId])).get(link.userId)
  if (!ref || (ref.status && ref.status !== 'active')) return null
  const ctx = await buildUserCtxFor(link.userId)
  return ctx ? { link, ctx } : null
}

export const TelegramActions = {
  /** Нажатие кнопки: действие без ввода выполняется сразу, с вводом — вопрос в ответ. */
  async press(update: Context, chatId: number, data: string): Promise<void> {
    const match = CALLBACK.exec(data)
    const user = match ? await userOf(chatId) : null
    if (!match || !user) {
      await update.answerCallbackQuery({
        text: createTranslator('ru')('telegram.notLinked'),
      })
      return
    }
    const t = createTranslator(user.ctx.locale)
    const [, itemId = '', key = ''] = match
    const action = await InboxService.actionOf(user.link.userId, itemId, key)
    if (!action) {
      await update.answerCallbackQuery({ text: t('telegram.actionGone') })
      return
    }
    if (action.requiresComment || action.input) {
      const pending: Pending = {
        userId: user.link.userId,
        itemId,
        key,
        input: action.input ?? null,
      }
      await redis().set(pendingKey(chatId), JSON.stringify(pending), 'EX', PENDING_TTL_SECONDS)
      await update.answerCallbackQuery()
      await update.reply(t(promptKey(action)), { reply_markup: { force_reply: true } })
      return
    }
    await update.answerCallbackQuery()
    await perform(update, user.ctx, action, {})
  },

  /**
   * Ответ на вопрос бота: текст отчёта, причина или «дата и обоснование».
   * `false` — вопроса не было, сообщение обрабатывают другие обработчики.
   */
  async reply(update: Context, chatId: number, text: string): Promise<boolean> {
    const raw = await redis().get(pendingKey(chatId))
    if (!raw) return false
    const pending = JSON.parse(raw) as Pending
    const user = await userOf(chatId)
    if (!user || user.link.userId !== pending.userId) {
      await redis().del(pendingKey(chatId))
      return false
    }
    const t = createTranslator(user.ctx.locale)
    if (text.trim() === '/cancel') {
      await redis().del(pendingKey(chatId))
      await update.reply(t('telegram.cancelled'))
      return true
    }
    let comment = text.trim()
    let payload: Record<string, unknown> = {}
    if (pending.input === 'due_date') {
      const parsed = parseDueAndReason(text)
      // Непонятная дата — вопрос остаётся, бот подсказывает формат
      if (!parsed) {
        await update.reply(t('telegram.badDueAndReason'))
        return true
      }
      comment = parsed.reason
      payload = { dueDate: parsed.date }
    }
    await redis().del(pendingKey(chatId))
    const action = await InboxService.actionOf(pending.userId, pending.itemId, pending.key)
    if (!action) {
      await update.reply(t('telegram.actionGone'))
      return true
    }
    await perform(update, user.ctx, action, { comment, payload })
    return true
  },
}

function promptKey(action: InboxOpenAction): string {
  if (action.input === 'due_date') return 'telegram.askDueAndReason'
  if (action.key === 'report') return 'telegram.askReport'
  return 'telegram.askComment'
}

/** Действие дела и ответ: «готово» и кнопки следующего шага по тому же объекту. */
async function perform(
  update: Context,
  ctx: NonNullable<Awaited<ReturnType<typeof buildUserCtxFor>>>,
  action: InboxOpenAction,
  input: { comment?: string; payload?: Record<string, unknown> },
): Promise<void> {
  const t = createTranslator(ctx.locale)
  try {
    await InboxService.act(ctx, action.itemId, {
      action: action.key,
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.payload && Object.keys(input.payload).length > 0 ? { payload: input.payload } : {}),
    })
  } catch (error) {
    if (!(error instanceof AppError)) {
      logger().warn({ err: error, itemId: action.itemId }, 'Telegram: действие не выполнено')
    }
    await update.reply(
      error instanceof AppError
        ? t('telegram.actionFailed', { reason: error.message })
        : t('telegram.actionError'),
    )
    return
  }
  const next = action.objectId ? await InboxService.openActions(ctx.userId, action.objectId) : []
  await update.reply(
    t('telegram.actionDone'),
    next.length > 0 ? { reply_markup: { inline_keyboard: actionKeyboard(next, ctx.locale) } } : {},
  )
}
