/**
 * Хранилище офлайн-режима (ADR-0204): IndexedDB браузера — очередь отправок, кэш
 * справочников и снимки, которые ещё не ушли на сервер (ADR-0208). Без IndexedDB
 * (приватный режим, старый браузер) — память вкладки: отправка всё равно дождётся
 * сети, пока страница открыта.
 */

const DB_NAME = 'kchs-offline'
const DB_VERSION = 2
export const QUEUE_STORE = 'queue'
export const CACHE_STORE = 'cache'
export const PHOTOS_STORE = 'photos'

type StoreName = typeof QUEUE_STORE | typeof CACHE_STORE | typeof PHOTOS_STORE

let opening: Promise<IDBDatabase | null> | null = null
const memory: Record<StoreName, Map<string, unknown>> = {
  queue: new Map(),
  cache: new Map(),
  photos: new Map(),
}

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening
  opening = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(PHOTOS_STORE)) {
          db.createObjectStore(PHOTOS_STORE, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => {
        // Другая вкладка обновляет схему хранилища — уступить ей соединение
        request.result.onversionchange = () => {
          request.result.close()
          opening = null
        }
        resolve(request.result)
      }
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opening
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Все записи хранилища. */
export async function readAll<T>(store: StoreName): Promise<T[]> {
  const db = await open()
  if (!db) return [...memory[store].values()] as T[]
  return done(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>
}

export async function readOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open()
  if (!db) return memory[store].get(key) as T | undefined
  return done(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<
    T | undefined
  >
}

/** Запись по ключу записи (`id` очереди, `key` кэша). */
export async function write<T extends { id: string } | { key: string }>(
  store: StoreName,
  value: T,
): Promise<void> {
  const db = await open()
  const key = 'id' in value ? value.id : value.key
  if (!db) {
    memory[store].set(key, value)
    return
  }
  await done(db.transaction(store, 'readwrite').objectStore(store).put(value))
}

export async function remove(store: StoreName, key: string): Promise<void> {
  const db = await open()
  if (!db) {
    memory[store].delete(key)
    return
  }
  await done(db.transaction(store, 'readwrite').objectStore(store).delete(key))
}
