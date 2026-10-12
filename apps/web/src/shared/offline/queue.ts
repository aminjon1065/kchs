import type { FormSubmission, FormSubmissionSubmitInput } from '@kchs/contracts'
import { useSyncExternalStore } from 'react'
import { ApiError, http } from '~/shared/api/client.js'
import { CACHE_STORE, QUEUE_STORE, readAll, readOne, remove, write } from './store.js'

/**
 * Офлайн-очередь отправок (ADR-0204): сдача сводки без сети не теряется — она ложится
 * в IndexedDB этого устройства и уходит сама, когда появится связь. Повтор безопасен:
 * у каждой отправки свой ключ идемпотентности (`clientKey`), и сервер на повтор с тем
 * же ключом отвечает уже записанной сдачей, а не второй сдачей и не «уже сдана».
 *
 * Очередь — по сотруднику: на общем устройстве чужие отправки не уходят от вашего
 * имени и не видны вам.
 */
export interface FormSubmitEntry {
  /** Ключ идемпотентности — он же ключ записи очереди. */
  id: string
  kind: 'form.submit'
  userId: string
  createdAt: number
  attempts: number
  /** `failed` — сервер отказал по существу (не сеть): нужен человек. */
  state: 'pending' | 'failed'
  error: string | null
  submissionId: string
  formId: string
  body: FormSubmissionSubmitInput
}

type Sender = (entry: FormSubmitEntry) => Promise<FormSubmission>
type SentListener = (entry: FormSubmitEntry, result: FormSubmission) => void

const sendSubmit: Sender = (entry) =>
  http.post('/forms/submissions/:sid/submit', {
    params: { sid: entry.submissionId },
    body: entry.body,
  })

let send: Sender = sendSubmit
let currentUser: string | null = null
let snapshot: FormSubmitEntry[] = []
let flushing: Promise<void> | null = null
const listeners = new Set<() => void>()
const sentListeners = new Set<SentListener>()

function emit(): void {
  for (const listener of listeners) listener()
}

async function reload(): Promise<void> {
  const all = await readAll<FormSubmitEntry>(QUEUE_STORE).catch(() => [])
  snapshot = all
    .filter((entry) => entry.userId === currentUser)
    .sort((a, b) => a.createdAt - b.createdAt)
  emit()
}

/**
 * Ошибка сети, а не ответ по существу: нет соединения, шлюз не дождался api,
 * сервер перегружен. Такую отправку надо повторить позже.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error instanceof ApiError) return [0, 408, 429, 502, 503, 504].includes(error.status)
  return false
}

/** Подмена отправки — для тестов очереди. */
export function setOfflineSender(next: Sender | null): void {
  send = next ?? sendSubmit
}

/**
 * Сдача сводки в очередь. Сводка уже ждёт отправки — новая правка заменяет её
 * значения, а ключ остаётся прежним: если прежняя попытка всё же дошла до
 * сервера, повтор вернёт её, а не «уже сдана».
 */
export async function enqueueFormSubmit(input: {
  userId: string
  submissionId: string
  formId: string
  body: FormSubmissionSubmitInput
}): Promise<FormSubmitEntry> {
  const all = await readAll<FormSubmitEntry>(QUEUE_STORE).catch(() => [])
  const existing = all.find(
    (entry) => entry.userId === input.userId && entry.submissionId === input.submissionId,
  )
  const id = existing?.id ?? input.body.clientKey ?? crypto.randomUUID()
  const entry: FormSubmitEntry = {
    id,
    kind: 'form.submit',
    userId: input.userId,
    createdAt: existing?.createdAt ?? Date.now(),
    attempts: existing?.attempts ?? 0,
    state: 'pending',
    error: null,
    submissionId: input.submissionId,
    formId: input.formId,
    body: { ...input.body, clientKey: id },
  }
  await write(QUEUE_STORE, entry)
  if (input.userId === currentUser) await reload()
  return entry
}

/** Дослать очередь: по порядку, до первой сетевой ошибки. Один проход за раз. */
export function flushOfflineQueue(): Promise<void> {
  if (flushing) return flushing
  flushing = (async () => {
    try {
      await reload()
      for (const entry of snapshot.filter((item) => item.state === 'pending')) {
        try {
          const result = await send(entry)
          await remove(QUEUE_STORE, entry.id)
          for (const listener of sentListeners) listener(entry, result)
        } catch (error) {
          if (isRetryable(error)) {
            await write(QUEUE_STORE, { ...entry, attempts: entry.attempts + 1 })
            break
          }
          await write(QUEUE_STORE, {
            ...entry,
            attempts: entry.attempts + 1,
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      flushing = null
      await reload()
    }
  })()
  return flushing
}

/** Убрать отправку из очереди (сдача по существу не прошла — человек решил её не слать). */
export async function discardOfflineEntry(id: string): Promise<void> {
  await remove(QUEUE_STORE, id)
  await reload()
}

/** Отправка из очереди дошла: экраны перечитывают свои данные. */
export function onOfflineSent(listener: SentListener): () => void {
  sentListeners.add(listener)
  return () => sentListeners.delete(listener)
}

/**
 * Запуск очереди для вошедшего сотрудника: дослать сразу, при появлении сети и раз в
 * полминуты, пока в очереди что-то есть. Возвращает остановку.
 */
export function startOfflineQueue(userId: string): () => void {
  currentUser = userId
  void flushOfflineQueue()
  const online = () => void flushOfflineQueue()
  window.addEventListener('online', online)
  const timer = window.setInterval(() => {
    if (snapshot.some((entry) => entry.state === 'pending')) void flushOfflineQueue()
  }, 30_000)
  return () => {
    window.removeEventListener('online', online)
    window.clearInterval(timer)
    currentUser = null
    snapshot = []
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Отправки вошедшего сотрудника, которые ждут сети или ответа человека. */
export function useOfflineQueue(): FormSubmitEntry[] {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/**
 * Справочник, который нужен и без сети (назначения сводок, схема формы): успешный
 * ответ запоминается на устройстве, при сетевой ошибке отдаётся запомненный. Ключ —
 * по сотруднику: на общем устройстве чужое не показывается.
 */
export async function cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const user = currentUser
  try {
    const value = await fetcher()
    if (user)
      void write(CACHE_STORE, { key: `${user}:${key}`, value, at: Date.now() }).catch(() => {})
    return value
  } catch (error) {
    if (!user || !isRetryable(error)) throw error
    const hit = await readOne<{ value: T }>(CACHE_STORE, `${user}:${key}`).catch(() => undefined)
    if (hit) return hit.value
    throw error
  }
}
