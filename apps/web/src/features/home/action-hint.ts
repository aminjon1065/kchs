import type { InboxItem } from '@kchs/contracts'

/**
 * Подсказка «что сделать» у дела во Входящих — подпись первой кнопки (у действия свой
 * labelKey: ключ действия со словарём не совпадает). У приглашения кнопки «Да», «Возможно»,
 * «Нет» — подсказка «Ответить».
 */
export function actionHint(item: Pick<InboxItem, 'actions'>): string {
  if (item.actions.some((action) => action.key === 'tentative')) return 'inbox.actions.respond'
  return item.actions[0]?.labelKey ?? 'inbox.actions.open'
}
