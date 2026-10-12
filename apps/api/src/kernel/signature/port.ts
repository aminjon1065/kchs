import type { QesValidationPolicy } from '@kchs/contracts'

/**
 * Порт квалифицированной электронной подписи (ADR-0205). Ядро не знает, какой
 * удостоверяющий центр (УЦ) подключён: реализацию регистрирует модуль integrations
 * (интеграция «Удостоверяющий центр», `qes_ca`) — так же, как порт второго фактора
 * (`kernel/second-factor/port.ts`) регистрирует identity.
 *
 * Подпись версии идёт в три операции; их исполняет модуль, которому принадлежат
 * версии (документы, `QualifiedSignatures`), по данным УЦ отсюда:
 *
 * - `prepare(versionId) → { signatureId, dataToSign, mode }` (`QesPageState`: `dataToSign` —
 *   SHA-256 в base64, `mode` — `cms-detached`) — движок готовит PDF с полем
 *   подписи и штампом, `dataToSign` — SHA-256 `ByteRange`; операция асинхронная: хэш
 *   появляется в сеансе подписания, когда движок закончит;
 * - `attach(signatureId, cms)` — CMS агента УЦ встраивается (со штампом времени TSA) и
 *   проверяется; только проверенная подпись становится решением шага;
 * - `verify(signatureId)` — повторная проверка встроенной подписи (цепочка, отзыв, время).
 *
 * Ключей подписи нет ни у api, ни у движка (ADR-0176): подписывает агент УЦ на рабочем
 * месте, ключ не покидает токена или хранилища агента.
 */

/** Подключённый удостоверяющий центр — всё, что нужно для подписи и проверки. */
export interface QualifiedSignatureAuthority {
  /** Интеграция `qes_ca`, из которой взяты данные. */
  integrationId: string
  name: string
  /** Агент УЦ на рабочем месте (петлевой адрес): его зовёт страница подписания. */
  agentUrl: string
  /** Сервер штампов времени; `null` — подпись без штампа (PAdES-B-B). */
  timestamp: { url: string; username: string | null; password: string | null } | null
  /** Доверенные корни, строгость отзыва, походы за OCSP и CRL — для движка. */
  policy: QesValidationPolicy
}

export interface QualifiedSignatureProvider {
  /** Подключённый и включённый УЦ; `null` — квалифицированная подпись не настроена. */
  authority: () => Promise<QualifiedSignatureAuthority | null>
}

let provider: QualifiedSignatureProvider = { authority: async () => null }

export function setQualifiedSignatureProvider(next: QualifiedSignatureProvider): void {
  provider = next
}

/** Порт УЦ для модулей: подключён ли он и с какими параметрами. */
export function qualifiedSignature(): QualifiedSignatureProvider {
  return provider
}
