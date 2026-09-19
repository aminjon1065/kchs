import { randomUUID } from 'node:crypto'
import type { Bot } from 'grammy'
import { config } from '~/shared/config/index.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import { safeError, telegramBot, telegramConfigured } from './bot.js'

/**
 * Долгий опрос Bot API в роли worker (ADR-0061). Установка on-prem обычно не
 * принимает входящих соединений из интернета, поэтому вебхук не используется.
 * `getUpdates` допускает одного читателя: среди нескольких worker опрашивает
 * держатель блокировки в Redis, остальные ждут.
 */
const LOCK_KEY = 'kchs:telegram:poller'
const LOCK_TTL_MS = 30_000
const TICK_MS = 10_000
/** После сбоя опроса (неверный токен, конфликт) — пауза, чтобы не засорять журнал. */
const FAILURE_PAUSE_MS = 60_000

/** Продлить блокировку, только если она наша. */
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`
/** Снять блокировку, только если она наша. */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`

const owner = randomUUID()
let timer: NodeJS.Timeout | null = null
let active: Bot | null = null
let loop: Promise<void> | null = null
let pausedUntil = 0

export function startTelegramPolling(): void {
  if (timer || !telegramConfigured() || !config().TELEGRAM_POLLING) return
  const tick = () => {
    void lead().catch((error: unknown) =>
      logger().warn({ err: safeError(error) }, 'Telegram: сбой блокировки опроса'),
    )
  }
  timer = setInterval(tick, TICK_MS)
  timer.unref()
  tick()
}

export async function stopTelegramPolling(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  await stopActive()
}

async function lead(): Promise<void> {
  if (active) {
    const renewed = await redis().eval(RENEW, 1, LOCK_KEY, owner, String(LOCK_TTL_MS))
    // Блокировку забрал другой worker (например, после долгой паузы процесса)
    if (renewed !== 1) await stopActive()
    return
  }
  if (Date.now() < pausedUntil) return
  const acquired = await redis().set(LOCK_KEY, owner, 'PX', LOCK_TTL_MS, 'NX')
  if (acquired !== 'OK') return

  const bot = telegramBot()
  active = bot
  loop = connect(bot)
    .then(() =>
      bot.start({
        allowed_updates: ['message'],
        onStart: (info) => logger().info({ bot: info.username }, 'Telegram: опрос запущен'),
      }),
    )
    .catch((error: unknown) => {
      pausedUntil = Date.now() + FAILURE_PAUSE_MS
      logger().error({ err: safeError(error) }, 'Telegram: опрос остановлен ошибкой')
    })
    .finally(async () => {
      if (active !== bot) return
      active = null
      await release()
    })
}

/**
 * Знакомство с Bot API (`getMe`) без встроенных повторов grammy: недоступный
 * API они повторяют молча, удваивая паузу до 20 минут. Здесь сбой уходит в
 * журнал и в паузу `FAILURE_PAUSE_MS` — опрос возобновится через минуту после
 * появления связи.
 */
async function connect(bot: Bot): Promise<void> {
  if (!bot.isInited()) bot.botInfo = await bot.api.getMe()
}

async function stopActive(): Promise<void> {
  const bot = active
  active = null
  if (bot?.isRunning()) {
    await bot.stop().catch((error: unknown) => {
      logger().debug({ err: safeError(error) }, 'Telegram: остановка опроса')
    })
  }
  await loop
  loop = null
  if (bot) await release()
}

async function release(): Promise<void> {
  await redis()
    .eval(RELEASE, 1, LOCK_KEY, owner)
    .catch(() => undefined)
}
