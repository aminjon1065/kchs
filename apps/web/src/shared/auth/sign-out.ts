import { setCsrfToken } from '~/shared/api/session.js'
import { forgetProfile } from '~/shared/offline/profile.js'
import { forgetOfflineData } from '~/shared/offline/queue.js'
import { unsubscribeDevice } from '~/shared/push/client.js'
import { forgetWorkspace } from '~/shared/workspace/store.js'

/**
 * Выход на общем компьютере (ADR-0228): то, что знает браузер о сотруднике, не должно
 * достаться следующему.
 *
 * До запроса выхода — пока сессия жива: подписка push этого устройства снимается
 * (иначе уведомления ушедшего всплывали бы у следующего), профиль запуска без сети
 * стирается (ADR-0207), справочники и открытые сводки — тоже; неотправленное —
 * по выбору сотрудника.
 */
export async function prepareSignOut(
  userId: string | undefined,
  options: { discardQueue?: boolean } = {},
): Promise<void> {
  await unsubscribeDevice().catch(() => undefined)
  await forgetProfile()
  if (userId) {
    await forgetOfflineData(userId, { discardQueue: options.discardQueue ?? false }).catch(
      () => undefined,
    )
  }
}

/** После выхода: вкладки браузера стираются без сохранения на сервер, токен CSRF — тоже. */
export function finishSignOut(): void {
  setCsrfToken(null)
  forgetWorkspace()
}
