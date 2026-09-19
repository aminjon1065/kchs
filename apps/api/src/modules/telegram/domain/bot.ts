import { LOCALES, type Locale } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { Bot, type Context, GrammyError, InputFile } from 'grammy'
import type { Update } from 'grammy/types'
import type { ChannelDocument, ChannelMessage } from '~/kernel/notifications/channels.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { actionKeyboard, TelegramActions } from './actions.js'
import { TelegramLinks } from './links.js'

/** Предел текста сообщения Telegram — 4096 символов; уведомления короче, но с запасом. */
const MAX_TEXT = 3500
/** Предел подписи к файлу — 1024 символа. */
const MAX_CAPTION = 900

/** Бот настроен на установке: без токена привязка и канал скрыты. */
export function telegramConfigured(): boolean {
  return Boolean(config().TELEGRAM_BOT_TOKEN)
}

let current: { key: string; bot: Bot } | null = null

/**
 * Экземпляр бота с обработчиками команд. Адрес Bot API берётся из
 * конфигурации (тесты подставляют поддельный сервер); при смене токена или
 * адреса бот создаётся заново.
 */
export function telegramBot(): Bot {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_API_URL: apiRoot } = config()
  if (!token) throw errors.unavailable('Telegram-бот не настроен')
  const key = `${apiRoot}|${token}`
  if (current?.key === key) return current.bot
  // Тайм-аут запроса больше тайм-аута долгого опроса (30 с)
  const bot = new Bot(token, { client: { apiRoot, timeoutSeconds: 60 } })
  installHandlers(bot)
  current = { key, bot }
  return bot
}

/** Имя бота для ссылки `t.me/<имя>`; `null` — Telegram сейчас недоступен. */
export async function telegramBotUsername(): Promise<string | null> {
  const bot = telegramBot()
  if (!bot.isInited()) {
    try {
      await bot.init()
    } catch (error) {
      logger().warn({ err: safeError(error) }, 'Telegram: не удалось получить сведения о боте')
      return null
    }
  }
  return bot.botInfo.username
}

/** Обработка одного обновления — долгий опрос и тесты идут через неё. */
export async function handleTelegramUpdate(update: Update): Promise<void> {
  const bot = telegramBot()
  if (!bot.isInited()) await bot.init()
  await bot.handleUpdate(update)
}

export type SendOutcome = 'sent' | 'blocked' | 'failed'

/**
 * Уведомление в личный чат: текст на языке получателя, ссылка на вкладку
 * объекта и кнопки действий открытых дел получателя по объекту («Принять»,
 * «Отчитаться», «Продлить» — ADR-0082). Кнопка «Открыть» — только для HTTPS:
 * Telegram не принимает в кнопках адреса вроде `http://localhost`.
 */
export async function sendTelegramNotification(
  chatId: number,
  message: ChannelMessage,
): Promise<SendOutcome> {
  const t = createTranslator(message.locale)
  const text = `${message.text.slice(0, MAX_TEXT)}\n${message.url}`
  const keyboard = [
    ...actionKeyboard(message.actions ?? [], message.locale),
    ...(message.url.startsWith('https://')
      ? [[{ text: t('telegram.open'), url: message.url }]]
      : []),
  ]
  try {
    await telegramBot().api.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: true },
      ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    })
    return 'sent'
  } catch (error) {
    // 403: пользователь заблокировал бота или удалил чат — привязка больше не работает
    if (error instanceof GrammyError && error.error_code === 403) return 'blocked'
    logger().warn({ err: safeError(error) }, 'Telegram: уведомление не доставлено')
    return 'failed'
  }
}

/**
 * Файл в личный чат (отчёт по расписанию, ADR-0078): документ с подписью на
 * языке получателя и кнопкой «Открыть» для HTTPS-адресов.
 */
export async function sendTelegramDocument(
  chatId: number,
  document: ChannelDocument,
): Promise<SendOutcome> {
  const t = createTranslator(document.locale)
  try {
    await telegramBot().api.sendDocument(
      chatId,
      new InputFile(document.content, document.fileName),
      {
        caption: `${document.caption.slice(0, MAX_CAPTION)}\n${document.url}`,
        ...(document.url.startsWith('https://')
          ? {
              reply_markup: {
                inline_keyboard: [[{ text: t('telegram.open'), url: document.url }]],
              },
            }
          : {}),
      },
    )
    return 'sent'
  } catch (error) {
    if (error instanceof GrammyError && error.error_code === 403) return 'blocked'
    logger().warn({ err: safeError(error) }, 'Telegram: файл не доставлен')
    return 'failed'
  }
}

/** Короткое сообщение в чат (например, «уведомления отключены»); ошибки не важны. */
export async function sayToTelegramChat(
  chatId: number,
  locale: Locale,
  key: string,
): Promise<void> {
  try {
    await telegramBot().api.sendMessage(chatId, createTranslator(locale)(key))
  } catch (error) {
    logger().debug({ err: safeError(error) }, 'Telegram: сообщение не отправлено')
  }
}

/**
 * Ошибка для журнала без токена бота: адрес запроса к Bot API содержит его,
 * поэтому в журнал идут только тип, код и описание.
 */
export function safeError(error: unknown): Record<string, unknown> {
  const token = config().TELEGRAM_BOT_TOKEN
  const clean = (text: string) => (token ? text.replaceAll(token, '<token>') : text)
  if (error instanceof GrammyError) {
    return { name: error.name, code: error.error_code, description: clean(error.description) }
  }
  if (error instanceof Error) return { name: error.name, message: clean(error.message) }
  return { message: clean(String(error)) }
}

/** Язык ответа тем, кто ещё не привязан: по языку клиента Telegram, иначе русский. */
function localeOf(ctx: Context): Locale {
  const code = ctx.from?.language_code?.slice(0, 2)
  return (LOCALES as readonly string[]).includes(code ?? '') ? (code as Locale) : 'ru'
}

function installHandlers(bot: Bot): void {
  // Только личные чаты: уведомления персональные, в группе их увидели бы другие
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === 'private') await next()
  })

  bot.command('start', async (ctx) => {
    const t = createTranslator(localeOf(ctx))
    const token = ctx.match.trim()
    const chatId = ctx.chat.id
    if (!token) {
      const linked = await TelegramLinks.byChat(chatId)
      await ctx.reply(t(linked ? 'telegram.alreadyLinked' : 'telegram.welcome'))
      return
    }
    const result = await TelegramLinks.complete(token, {
      chatId,
      username: ctx.from?.username ?? null,
    })
    if (result.kind === 'linked') {
      await ctx.reply(
        createTranslator(result.locale)('telegram.linked', { name: result.displayName }),
      )
    } else {
      await ctx.reply(t(result.kind === 'taken' ? 'telegram.chatTaken' : 'telegram.linkInvalid'))
    }
  })

  bot.command('stop', async (ctx) => {
    const t = createTranslator(localeOf(ctx))
    const linked = await TelegramLinks.byChat(ctx.chat.id)
    if (!linked) {
      await ctx.reply(t('telegram.notLinked'))
      return
    }
    await TelegramLinks.unlink(
      systemCtx('telegram.stop', { initiatorId: linked.userId }),
      linked.userId,
      'user',
    )
    await ctx.reply(t('telegram.stopped'))
  })

  // Кнопки действий дел Входящих: принять, отчитаться, продлить (ADR-0082)
  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.from.id
    await TelegramActions.press(ctx, chatId, ctx.callbackQuery.data)
  })

  // Ответ на вопрос бота: текст отчёта, причина, «дата и обоснование»
  bot.on('message:text', async (ctx, next) => {
    if (await TelegramActions.reply(ctx, ctx.chat.id, ctx.message.text)) return
    await next()
  })

  // Любое другое сообщение — подсказка: бот присылает уведомления с кнопками действий
  bot.on('message', async (ctx) => {
    await ctx.reply(createTranslator(localeOf(ctx))('telegram.help'))
  })

  bot.catch((error) => {
    logger().warn({ err: safeError(error.error) }, 'Telegram: ошибка обработки сообщения')
  })
}
