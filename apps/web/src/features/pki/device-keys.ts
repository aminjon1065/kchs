import type { PkiCertificateRecord, PkiPurpose } from '@kchs/contracts'
import { pkiApi } from './queries.js'

/**
 * Ключи подписи на этом устройстве (УЦ Комитета, ADR-0218). Ключ — неизвлекаемый ключ
 * WebCrypto (RSA 2048, RSASSA-PKCS1-v1_5/SHA-256): браузер хранит его в IndexedDB и
 * подписывает им, но отдать закрытую часть не может никому — ни странице, ни серверу.
 * Рядом лежит сертификат, выпущенный УЦ Комитета. Ту же базу читает страница подписания
 * (`/api/v1/qes/sessions/…/page`, тот же источник): имя базы, хранилища и поля — общие.
 */

const DATABASE = 'kchs-pki'
const STORE = 'keys'

export interface DeviceKey {
  /** Идентификатор сертификата на сервере. */
  id: string
  userId: string
  purpose: PkiPurpose
  privateKey: CryptoKey
  /** Сертификат DER в base64. */
  certificate: string
  fingerprint: string
  issuedAt: string
  expiresAt: string
  label: string
}

export class DeviceKeyUnsupportedError extends Error {}

function supported(): boolean {
  return typeof indexedDB !== 'undefined' && Boolean(globalThis.crypto?.subtle)
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open()
  return new Promise((resolve, reject) => {
    const request = action(database.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Ключи сотрудника на этом устройстве; без IndexedDB и WebCrypto — пусто. */
export async function deviceKeys(userId: string): Promise<DeviceKey[]> {
  if (!supported()) return []
  const all = (await withStore('readonly', (store) => store.getAll())) as DeviceKey[]
  return all.filter((item) => item.userId === userId)
}

export async function forgetDeviceKey(id: string): Promise<void> {
  if (!supported()) return
  await withStore('readwrite', (store) => store.delete(id))
}

function base64(bytes: ArrayBuffer): string {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text)
}

/**
 * Создать ключ на этом устройстве и получить на него сертификат: открытый ключ уходит на
 * сервер с подписью вызова (доказательство владения) и кодом второго фактора.
 */
export async function createDeviceKey(input: {
  userId: string
  purpose: PkiPurpose
  label: string
  code: string
}): Promise<PkiCertificateRecord> {
  if (!supported()) throw new DeviceKeyUnsupportedError()
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey)
  const { challenge } = await pkiApi.challenge(input.purpose)
  const proof = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(challenge),
  )
  const record = await pkiApi.enroll({
    publicKey: base64(publicKey),
    challenge,
    proof: base64(proof),
    deviceLabel: input.label,
    purpose: input.purpose,
    code: input.code,
  })
  const key: DeviceKey = {
    id: record.id,
    userId: input.userId,
    purpose: record.purpose,
    privateKey: pair.privateKey,
    certificate: record.certificate,
    fingerprint: record.fingerprint,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    label: record.deviceLabel,
  }
  await withStore('readwrite', (store) => store.put(key))
  return record
}
