import type {
  DocumentCreateInput,
  DocumentIntakeResult,
  FormSubject,
  FormSubmission,
  FormSubmissionSubmitInput,
} from '@kchs/contracts'
import { useSyncExternalStore } from 'react'
import { http } from '~/shared/api/client.js'
import { ApiError } from '~/shared/api/errors.js'
import { getCsrfToken, getOnBehalfOf, setCsrfToken } from '~/shared/api/session.js'
import {
  forgetPhotos,
  resolvePhotos,
  type SendMode,
  sweepPhotos,
  uploadDocumentPhotos,
} from './photos.js'
import { CACHE_STORE, QUEUE_STORE, readAll, readOne, remove, write } from './store.js'

/**
 * Офлайн-очередь отправок (ADR-0204): сдача сводки и донесение (ADR-0212) без сети не
 * теряются — они ложатся в IndexedDB этого устройства и уходят сами, когда появится
 * связь. Повтор безопасен: у каждой отправки свой ключ идемпотентности (`clientKey`), и
 * сервер на повтор с тем же ключом отвечает уже записанной сдачей или созданным
 * документом, а не второй сдачей и не вторым документом.
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
  /** Сводка на сервере — или `local:…`, если её открыли без сети (ADR-0208). */
  submissionId: string
  /**
   * Сводку открыли без сети: досылка сначала открывает её на сервере (повтор
   * открытия возвращает ту же сводку), затем грузит снимки и сдаёт.
   */
  open?: { periodKey: string; subject: FormSubject } | null
  /** Ключ сводки на экране, пока она была местной: по нему экран узнаёт свою сдачу. */
  localId?: string | null
  formId: string
  body: FormSubmissionSubmitInput
  /**
   * Режим «от имени», в котором сдачу поставили в очередь (ADR-0228): досылка идёт в
   * нём же, а не в текущем. Нет поля — запись старой версии, досылается в текущем.
   */
  onBehalfOf?: string | null
}

/**
 * Донесение, созданное без сети (ADR-0212): черновик документа с реквизитами и снимками.
 * Ключ записи — ключ идемпотентности создания: повтор после потерянного ответа
 * возвращает тот же документ, снимки грузятся под своими ключами и тоже не дублируются.
 */
export interface DocumentCreateEntry {
  /** Ключ идемпотентности создания — он же ключ записи очереди. */
  id: string
  kind: 'document.create'
  userId: string
  createdAt: number
  attempts: number
  state: 'pending' | 'failed'
  error: string | null
  /** Как показать запись в очереди: тема донесения. */
  title: string
  body: DocumentCreateInput & { clientKey: string }
  /** Ключи снимков на устройстве. */
  photos: string[]
  /** Режим «от имени» на момент создания донесения (ADR-0228). */
  onBehalfOf?: string | null
}

export type OfflineEntry = FormSubmitEntry | DocumentCreateEntry

/** Сводка, открытая без сети: ключ экрана до первого ответа сервера. */
export const LOCAL_SUBMISSION = 'local:'

type Sender = (entry: FormSubmitEntry) => Promise<FormSubmission>
type Opener = (entry: FormSubmitEntry) => Promise<FormSubmission>
type SentListener = (entry: FormSubmitEntry, result: FormSubmission) => void
/**
 * Донесение дошло: документ на сервере и что с регистрацией — ушло дежурной смене (`sent`),
 * уже зарегистрировано, остаётся черновиком (у типа нет маршрута приёма) или не ушло по
 * существу (`failed`: пустая дежурная смена, допуск) — тогда черновик остаётся у автора.
 */
export interface DocumentSent {
  id: string
  intake: DocumentIntakeResult['state'] | 'failed'
  error: string | null
}

/** Создание документа со снимками и отправка на регистрацию. */
type DocumentSender = (entry: DocumentCreateEntry) => Promise<DocumentSent>
type DocumentSentListener = (entry: DocumentCreateEntry, sent: DocumentSent) => void

/** Режим записи для её запросов; запись старой версии — текущий режим. */
function modeOf(entry: OfflineEntry): SendMode {
  return entry.onBehalfOf === undefined ? {} : { onBehalfOf: entry.onBehalfOf }
}

const sendSubmit: Sender = (entry) =>
  http.post('/forms/submissions/:sid/submit', {
    ...modeOf(entry),
    params: { sid: entry.submissionId },
    body: entry.body,
  })

const openSubmission: Opener = (entry) => {
  if (!entry.open) throw new Error('open')
  return http.post('/forms/:id/submissions', {
    ...modeOf(entry),
    params: { id: entry.formId },
    body: entry.open,
  })
}

const sendDocumentCreate: DocumentSender = async (entry) => {
  const { id } = await http.post('/documents', { ...modeOf(entry), body: entry.body })
  await uploadDocumentPhotos(id, entry.userId, entry.photos, modeOf(entry))
  // На регистрацию — после снимков: в черновик они ещё ложатся. Повтор безопасен: маршрут
  // уже идёт — тот же ответ (ADR-0212)
  try {
    const result = await http.post('/documents/:id/intake', { ...modeOf(entry), params: { id } })
    return { id, intake: result.state, error: null }
  } catch (error) {
    if (isRetryable(error) || (error instanceof ApiError && error.status === 401)) throw error
    // Отказ по существу — донесение уже на сервере: черновик у автора, а не «не отправлено»
    return { id, intake: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

let send: Sender = sendSubmit
let openRemote: Opener = openSubmission
let sendDocument: DocumentSender = sendDocumentCreate
let currentUser: string | null = null
let snapshot: OfflineEntry[] = []
let flushing: Promise<void> | null = null
const listeners = new Set<() => void>()
const sentListeners = new Set<SentListener>()
const documentListeners = new Set<DocumentSentListener>()
const failedListeners = new Set<(entry: OfflineEntry) => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

async function reload(): Promise<void> {
  const all = await readAll<OfflineEntry>(QUEUE_STORE).catch(() => [])
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

/**
 * Сбой сервера (5xx) досылка повторяет, но не бесконечно: ошибка, которая
 * повторяется на каждой попытке, — это уже не сбой, а отказ, и запись ждёт человека.
 */
const MAX_SERVER_ATTEMPTS = 20

function retryLater(error: unknown, attempts: number): boolean {
  if (isRetryable(error)) return true
  return error instanceof ApiError && error.status >= 500 && attempts < MAX_SERVER_ATTEMPTS
}

type CsrfRefresher = () => Promise<string | null>

const refreshCsrf: CsrfRefresher = async () => (await http.get('/me')).session.csrfToken || null

let csrfRefresher: CsrfRefresher = refreshCsrf

/** Подмена обновления токена CSRF — для тестов очереди. */
export function setCsrfRefresher(next: CsrfRefresher | null): void {
  csrfRefresher = next ?? refreshCsrf
}

/**
 * Токен CSRF для досылки (ADR-0228). Приложение, открытое без сети по профилю
 * устройства, токена не знает (ADR-0207): сеть вернулась — досылка сначала
 * перечитывает сессию, иначе сервер отклонил бы запись как подложную. Нет сети или
 * сессии — досылка ждёт.
 */
async function ensureCsrf(force = false): Promise<boolean> {
  if (!force && getCsrfToken()) return true
  try {
    const token = await csrfRefresher()
    if (!token) return false
    setCsrfToken(token)
    return true
  } catch {
    return false
  }
}

/** Подмена отправки — для тестов очереди. */
export function setOfflineSender(next: Sender | null): void {
  send = next ?? sendSubmit
}

/** Подмена открытия сводки — для тестов очереди. */
export function setOfflineOpener(next: Opener | null): void {
  openRemote = next ?? openSubmission
}

/** Подмена создания документа — для тестов очереди. */
export function setOfflineDocumentSender(next: DocumentSender | null): void {
  sendDocument = next ?? sendDocumentCreate
}

/**
 * Донесение: создать документ со снимками сразу, а без сети — положить в очередь
 * устройства под тем же ключом. Отказ по существу (400, 403, 409) пробрасывается —
 * его показывает экран, пока человек ещё перед ним.
 */
export async function submitDocument(input: {
  userId: string
  title: string
  body: DocumentCreateInput & { clientKey: string }
  photos: string[]
}): Promise<{ queued: true } | ({ queued: false } & DocumentSent)> {
  const entry: DocumentCreateEntry = {
    id: input.body.clientKey,
    kind: 'document.create',
    userId: input.userId,
    createdAt: Date.now(),
    attempts: 0,
    state: 'pending',
    error: null,
    title: input.title,
    body: input.body,
    photos: input.photos,
    onBehalfOf: getOnBehalfOf(),
  }
  try {
    const sent = await sendDocument(entry)
    await forgetPhotos(entry.photos)
    return { queued: false, ...sent }
  } catch (error) {
    if (!isRetryable(error)) throw error
    await write(QUEUE_STORE, entry)
    if (input.userId === currentUser) await reload()
    return { queued: true }
  }
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
  open?: FormSubmitEntry['open']
}): Promise<FormSubmitEntry> {
  const all = await readAll<OfflineEntry>(QUEUE_STORE).catch(() => [])
  const existing = all.find(
    (entry): entry is FormSubmitEntry =>
      entry.kind === 'form.submit' &&
      entry.userId === input.userId &&
      entry.submissionId === input.submissionId,
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
    open: input.submissionId.startsWith(LOCAL_SUBMISSION) ? (input.open ?? null) : null,
    localId: input.submissionId.startsWith(LOCAL_SUBMISSION) ? input.submissionId : null,
    formId: input.formId,
    body: { ...input.body, clientKey: id },
    onBehalfOf: getOnBehalfOf(),
  }
  await write(QUEUE_STORE, entry)
  if (input.userId === currentUser) await reload()
  return entry
}

/** Одна запись очереди на сервер; сводка, открытая без сети, — сначала открывается. */
async function deliver(pending: OfflineEntry): Promise<void> {
  let entry: OfflineEntry = pending
  if (entry.kind === 'document.create') {
    // Донесение (ADR-0212): повтор создания с тем же ключом — тот же документ
    const sent = await sendDocument(entry)
    await remove(QUEUE_STORE, entry.id)
    await forgetPhotos(entry.photos)
    for (const listener of documentListeners) listener(entry, sent)
    return
  }
  // Сводку открыли без сети — сначала открыть на сервере (ADR-0208)
  if (entry.open && entry.submissionId.startsWith(LOCAL_SUBMISSION)) {
    const opened = await openRemote(entry)
    entry = { ...entry, submissionId: opened.id }
    await write(QUEUE_STORE, entry)
  }
  const form: FormSubmitEntry = entry
  // Снимки — до сдачи: значение поля становится файлом сервера
  const { body, uploaded } = await resolvePhotos(
    form.submissionId,
    form.userId,
    form.body,
    modeOf(form),
  )
  const result = await send({ ...form, body })
  await remove(QUEUE_STORE, form.id)
  await forgetPhotos(uploaded)
  for (const listener of sentListeners) listener(form, result)
}

/** Дослать очередь: по порядку, до первой сетевой ошибки. Один проход за раз. */
export function flushOfflineQueue(): Promise<void> {
  if (flushing) return flushing
  flushing = (async () => {
    try {
      await reload()
      const queue = snapshot.filter((item) => item.state === 'pending')
      if (queue.length === 0) return
      // Без токена CSRF изменяющий запрос сервер отклонит — сначала сессия (ADR-0228)
      if (!(await ensureCsrf())) return
      for (const pending of queue) {
        // Запись могли изменить, пока шли предыдущие: берём её свежей
        const entry =
          (await readOne<OfflineEntry>(QUEUE_STORE, pending.id).catch(() => undefined)) ?? pending
        try {
          try {
            await deliver(entry)
          } catch (error) {
            // 403 бывает и от устаревшего токена CSRF (сессию переоткрыли на другом
            // устройстве, токен в профиле пустой): один повтор со свежим токеном
            if (!(error instanceof ApiError && error.status === 403)) throw error
            if (!(await ensureCsrf(true))) throw error
            await deliver(
              (await readOne<OfflineEntry>(QUEUE_STORE, entry.id).catch(() => undefined)) ?? entry,
            )
          }
        } catch (error) {
          // Досылка могла продвинуть запись (сводка открыта на сервере) — дальше от неё
          const current =
            (await readOne<OfflineEntry>(QUEUE_STORE, entry.id).catch(() => undefined)) ?? entry
          // Сессия кончилась (приложение открыто без сети по профилю устройства):
          // отправка ждёт нового входа, а не становится «не сдана»
          if (error instanceof ApiError && error.status === 401) {
            await write(QUEUE_STORE, current)
            break
          }
          if (retryLater(error, current.attempts + 1)) {
            await write(QUEUE_STORE, { ...current, attempts: current.attempts + 1 })
            break
          }
          const failed: OfflineEntry = {
            ...current,
            attempts: current.attempts + 1,
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }
          await write(QUEUE_STORE, failed)
          for (const listener of failedListeners) listener(failed)
        }
      }
    } finally {
      flushing = null
      await reload()
    }
  })()
  return flushing
}

/**
 * Повторить отклонённую отправку (ADR-0228): человек исправил причину (допуск,
 * дежурная смена) или ошибка была временной — запись снова ждёт досылки.
 */
export async function retryOfflineEntry(id: string): Promise<void> {
  const entry = await readOne<OfflineEntry>(QUEUE_STORE, id).catch(() => undefined)
  if (!entry || entry.userId !== currentUser) return
  await write(QUEUE_STORE, { ...entry, state: 'pending', error: null, attempts: 0 })
  await reload()
  await flushOfflineQueue()
}

/**
 * Убрать отправку из очереди (сдача или донесение по существу не прошли — человек решил
 * их не слать). Снимки донесения с устройства стираются вместе с ним.
 */
export async function discardOfflineEntry(id: string): Promise<void> {
  const entry = await readOne<OfflineEntry>(QUEUE_STORE, id).catch(() => undefined)
  await remove(QUEUE_STORE, id)
  if (entry?.kind === 'document.create') await forgetPhotos(entry.photos)
  await reload()
}

/** Отправка из очереди дошла: экраны перечитывают свои данные. */
export function onOfflineSent(listener: SentListener): () => void {
  sentListeners.add(listener)
  return () => sentListeners.delete(listener)
}

/**
 * Сервер отклонил запись из очереди по существу (ADR-0228): экран давно закрыт —
 * оболочка сообщает сразу, а не только гаснущим счётчиком.
 */
export function onOfflineFailed(listener: (entry: OfflineEntry) => void): () => void {
  failedListeners.add(listener)
  return () => failedListeners.delete(listener)
}

/** Донесение из очереди дошло: документ создан на сервере, регистрация — в `sent.intake`. */
export function onOfflineDocumentSent(listener: DocumentSentListener): () => void {
  documentListeners.add(listener)
  return () => documentListeners.delete(listener)
}

/**
 * Запуск очереди для вошедшего сотрудника: дослать сразу, при появлении сети и раз в
 * полминуты, пока в очереди что-то есть. Возвращает остановку.
 */
export function startOfflineQueue(userId: string): () => void {
  currentUser = userId
  void sweepPhotos(userId)
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
export function useOfflineQueue(): OfflineEntry[] {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/**
 * Запросы и действия, которые сами решают, что делать без сети (кэш устройства,
 * очередь, снимки). По умолчанию TanStack Query после события `offline` браузера
 * ставит их на паузу, не вызывая функцию: экран сводки ждал сети вместо очереди, а
 * миниатюра снимка с устройства не показывалась. `offlineFirst` вызывает функцию
 * один раз и в офлайне, повторы — уже по сети.
 */
export const OFFLINE_AWARE = { networkMode: 'offlineFirst' } as const

/**
 * Справочник, который нужен и без сети (назначения сводок, схема формы): успешный
 * ответ запоминается на устройстве, при сетевой ошибке отдаётся запомненный. Ключ —
 * по сотруднику: на общем устройстве чужое не показывается.
 */
export async function cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const value = await fetcher()
    // Сотрудник — на момент ответа: экран мог запросить справочник раньше, чем
    // оболочка запустила очередь вошедшего
    const user = currentUser
    if (user)
      void write(CACHE_STORE, { key: `${user}:${key}`, value, at: Date.now() }).catch(() => {})
    return value
  } catch (error) {
    const user = currentUser
    if (!user || !isRetryable(error)) throw error
    const hit = await readOne<{ value: T }>(CACHE_STORE, `${user}:${key}`).catch(() => undefined)
    if (hit) return hit.value
    throw error
  }
}
