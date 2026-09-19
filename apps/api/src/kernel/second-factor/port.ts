import { AppError, errors } from '~/shared/errors.js'
import { cacheKeys, redis } from '~/shared/redis/index.js'

/**
 * Порт подтверждения действия вторым фактором (подпись в маршруте с
 * `requireMfa`, ADR-0079). Ядро не знает, как хранятся факторы: реализацию
 * регистрирует модуль identity (`AuthService.verifyTotp`) — так же, как порт
 * справочника (ADR-0031).
 */
export interface SecondFactorProvider {
  /** У пользователя подключён второй фактор. */
  enrolled: (userId: string) => Promise<boolean>
  /** Код верен; повтор уже использованного кода отклоняется. */
  verify: (userId: string, code: string) => Promise<boolean>
}

let provider: SecondFactorProvider = {
  enrolled: async () => false,
  verify: async () => false,
}

export function setSecondFactorProvider(next: SecondFactorProvider): void {
  provider = next
}

/** Неудачных попыток подтверждения до блокировки и срок блокировки. */
const MAX_FAILURES = 5
const WINDOW_SECONDS = 15 * 60

/**
 * Подтверждение действия кодом второго фактора того, кто действует (при
 * замещении — заместителя). Неверные коды считаются: после пяти за 15 минут
 * подтверждение закрыто — перебор шестизначного кода невозможен.
 */
export async function confirmSecondFactor(userId: string, code: string | undefined): Promise<void> {
  const token = code?.replace(/\s/g, '') ?? ''
  if (!token) {
    throw new AppError('validation_failed', 'Введите код подтверждения', 400, {
      fieldErrors: [
        { path: 'code', message: 'Введите код подтверждения', code: 'second_factor_required' },
      ],
    })
  }
  if (!(await provider.enrolled(userId))) {
    throw errors.policyViolation(
      'Для подписи с подтверждением подключите второй фактор в профиле',
      { reason: 'second_factor_not_enrolled' },
    )
  }
  const key = cacheKeys.rateLimit('second-factor', userId)
  const failures = Number((await redis().get(key)) ?? 0)
  if (failures >= MAX_FAILURES) throw errors.rateLimited(WINDOW_SECONDS)
  if (await provider.verify(userId, token)) {
    await redis().del(key)
    return
  }
  const count = await redis().incr(key)
  if (count === 1) await redis().expire(key, WINDOW_SECONDS)
  throw new AppError('validation_failed', 'Неверный код подтверждения', 400, {
    fieldErrors: [
      { path: 'code', message: 'Неверный код подтверждения', code: 'second_factor_invalid' },
    ],
  })
}
