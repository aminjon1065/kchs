/**
 * Тишина получателя (05-risks N23, ADR-0140): «не беспокоить», тихие часы и идущая встреча
 * глушат внешние каналы — Telegram, push и письма — у всех уведомлений, кроме срочных.
 * Состояние присутствия ведёт модуль чатов (ADR-0090); ядро спрашивает его через этот порт,
 * не читая чужих таблиц. Без зарегистрированного источника никто не «в тишине».
 */
export type QuietResolver = (userIds: readonly string[]) => Promise<Set<string>>

let resolver: QuietResolver = async () => new Set()

export function setQuietResolver(next: QuietResolver): void {
  resolver = next
}

/** Кто из получателей сейчас «в тишине». */
export async function quietRecipients(userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  return resolver(userIds)
}
