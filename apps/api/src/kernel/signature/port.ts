import type { QesValidationPolicy } from '@kchs/contracts'

/**
 * Порт квалифицированной электронной подписи (ADR-0205, ADR-0218). Ядро не знает, кто
 * выпускает сертификаты: поставщиков регистрируют модули — УЦ Комитета (`pki`, ключ
 * сотрудника на его устройстве) и внешний УЦ с агентом на рабочем месте (интеграция
 * `qes_ca`, модуль integrations), — так же, как порт второго фактора регистрирует identity.
 *
 * Подпись версии идёт в три операции; их исполняет модуль, которому принадлежат версии
 * (документы, `QualifiedSignatures`), по данным УЦ отсюда:
 *
 * - `prepare` — движок готовит PDF с полем подписи и штампом, хэш `ByteRange`;
 * - подпись: агент УЦ подписывает хэш и возвращает CMS (`agent`) или ключ устройства
 *   подписывает подписываемые атрибуты, а CMS собирает поставщик (`device`);
 * - `attach` — CMS встраивается со штампом времени и проверяется; только проверенная
 *   подпись становится решением шага;
 * - `verify` — повторная проверка встроенной подписи (цепочка, отзыв, время).
 *
 * Ключей подписи сотрудников нет ни у api, ни у движка (ADR-0176): ключ — в агенте УЦ или
 * неизвлекаемым ключом WebCrypto на устройстве сотрудника.
 */

/** Подпись ключом устройства (ADR-0218): что подписывает браузер и как из этого CMS. */
export interface DeviceSigning {
  /** Подписываемые атрибуты CMS (DER `SET OF`) для хэша `ByteRange` и сертификата. */
  signedAttributes: (certificateDer: Buffer, digest: Buffer) => Buffer
  /** CMS из подписи браузера; подпись проверяется, чужая — ошибка. */
  assemble: (certificateDer: Buffer, digest: Buffer, signature: Buffer) => Promise<Buffer>
  /** Чей сертификат: выпущен ли этим УЦ, кому и действует ли; `null` — не наш. */
  owner: (
    certificateDer: Buffer,
  ) => Promise<{ userId: string; purpose: 'person' | 'seal'; active: boolean } | null>
}

/** Подключённый удостоверяющий центр — всё, что нужно для подписи и проверки. */
export interface QualifiedSignatureAuthority {
  /** `agent` — внешний УЦ и агент на рабочем месте; `device` — УЦ Комитета, ключ в браузере. */
  kind: 'agent' | 'device-key'
  /** Интеграция `qes_ca`, из которой взяты данные; у УЦ Комитета — `null`. */
  integrationId: string | null
  name: string
  /** Агент УЦ на рабочем месте (петлевой адрес): его зовёт страница подписания. */
  agentUrl: string | null
  /**
   * Сервер штампов времени; `null` — подпись без штампа (PAdES-B-B). Адрес от `/` — служба
   * самой платформы: движок дополняет его своим адресом api.
   */
  timestamp: { url: string; username: string | null; password: string | null } | null
  /** Доверенные корни, строгость отзыва, данные проверки — для движка. */
  policy: QesValidationPolicy
  device?: DeviceSigning
}

export interface QualifiedSignatureProvider {
  /** Подключённый и включённый УЦ; `null` — этот поставщик не настроен. */
  authority: () => Promise<QualifiedSignatureAuthority | null>
}

const providers = new Map<string, { priority: number; provider: QualifiedSignatureProvider }>()

/**
 * Поставщик под именем: повторная регистрация заменяет прежнего. Порядок — по приоритету:
 * явно настроенный внешний УЦ важнее УЦ Комитета, который есть в каждой установке.
 */
export function setQualifiedSignatureProvider(
  key: string,
  provider: QualifiedSignatureProvider,
  priority = 0,
): void {
  providers.set(key, { priority, provider })
}

/** Порт УЦ для модулей: первый настроенный поставщик по приоритету. */
export function qualifiedSignature(): QualifiedSignatureProvider {
  return {
    authority: async () => {
      const ordered = [...providers.values()].sort((a, b) => b.priority - a.priority)
      for (const { provider } of ordered) {
        const found = await provider.authority()
        if (found) return found
      }
      return null
    },
  }
}
