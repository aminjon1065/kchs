import type { Executor } from '~/shared/db/client.js'

/**
 * Порт учётных данных (ADR-0179). Справочник людей живёт в ядре, а пароли и
 * сессии — забота модуля входа `identity`: заводя сотрудника или блокируя его,
 * ядро просит модуль задать временный пароль и закрыть сессии, не зная, как они
 * хранятся. Реализацию регистрирует identity при старте — как порт второго фактора.
 */
export interface CredentialsProvider {
  /** Задать пароль учётной записи (временный — при создании или сбросе). */
  setPassword: (userId: string, password: string, login: string, tx?: Executor) => Promise<void>
  /** Закрыть все сессии пользователя (блокировка, сброс пароля). */
  revokeSessions: (userId: string, tx?: Executor) => Promise<void>
}

const NONE: CredentialsProvider = {
  setPassword: async () => {
    throw new Error('Модуль входа не зарегистрирован: пароль задать некому')
  },
  revokeSessions: async () => {},
}

let provider: CredentialsProvider = NONE

export function setCredentialsProvider(next: CredentialsProvider): void {
  provider = next
}

export function credentials(): CredentialsProvider {
  return provider
}
