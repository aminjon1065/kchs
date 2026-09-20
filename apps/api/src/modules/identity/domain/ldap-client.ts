import type { DirectorySettings } from '@kchs/contracts'
import { Client, type Entry } from 'ldapts'
import { errors } from '~/shared/errors.js'

/**
 * Тонкая обёртка над `ldapts` (ADR-0098). Наружу отдаёт простые записи
 * `DirectoryEntry`, чтобы синхронизация не зависела от формы ответа библиотеки.
 * Пароль учётной записи чтения приходит параметром и нигде не сохраняется.
 */

export interface DirectoryEntry {
  dn: string
  /** Значения атрибутов в нижнем регистре имён: каталоги регистр не различают. */
  attributes: Record<string, string[]>
}

/** Двоичные атрибуты AD: строкой их не прочитать, нужен шестнадцатеричный вид. */
const BINARY_ATTRIBUTES = new Set(['objectguid', 'objectsid'])

function toEntry(raw: Entry): DirectoryEntry {
  const attributes: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'dn') continue
    const name = key.toLowerCase()
    const values = Array.isArray(value) ? value : [value]
    attributes[name] = values.map((item) =>
      Buffer.isBuffer(item)
        ? BINARY_ATTRIBUTES.has(name)
          ? item.toString('hex')
          : item.toString('utf8')
        : String(item),
    )
  }
  return { dn: String(raw.dn), attributes }
}

function clientFor(settings: DirectorySettings): Client {
  if (!settings.url) throw errors.validation('Адрес каталога не задан')
  return new Client({
    url: settings.url,
    timeout: 15_000,
    connectTimeout: 10_000,
    tlsOptions: { rejectUnauthorized: settings.tlsRejectUnauthorized },
  })
}

/** Первое значение атрибута записи; имена атрибутов регистронезависимы. */
export function attributeValue(entry: DirectoryEntry, attribute: string): string | null {
  if (!attribute) return null
  const value = entry.attributes[attribute.toLowerCase()]?.[0]?.trim()
  return value ? value : null
}

export function attributeValues(entry: DirectoryEntry, attribute: string): string[] {
  if (!attribute) return []
  return entry.attributes[attribute.toLowerCase()] ?? []
}

/**
 * Запись отключена в каталоге. AD хранит признак битом 2 `userAccountControl`;
 * другие каталоги — булевым атрибутом (`nsAccountLock`, `accountDisabled`).
 */
export function entryDisabled(entry: DirectoryEntry, attribute: string): boolean {
  const raw = attributeValue(entry, attribute)
  if (raw === null) return false
  const numeric = Number(raw)
  if (Number.isFinite(numeric)) return (numeric & 2) !== 0
  return ['true', 'yes', '1'].includes(raw.toLowerCase())
}

/** Атрибуты, которые нужно запросить, — по карте сопоставления. */
export function requestedAttributes(settings: DirectorySettings): string[] {
  const map = settings.attributes
  const names = [
    map.login,
    map.email,
    map.firstName,
    map.lastName,
    map.middleName,
    map.displayName,
    map.phone,
    map.externalId,
    map.disabled,
    map.unit,
    map.position,
    map.memberOf,
  ].filter((name): name is string => Boolean(name))
  return [...new Set(names)]
}

async function connected<T>(
  settings: DirectorySettings,
  bindPassword: string | null,
  body: (client: Client) => Promise<T>,
): Promise<T> {
  const client = clientFor(settings)
  try {
    if (settings.startTls)
      await client.startTLS({ rejectUnauthorized: settings.tlsRejectUnauthorized })
    // Пустой DN — анонимный поиск: так работают каталоги, открытые на чтение
    if (settings.bindDn) await client.bind(settings.bindDn, bindPassword ?? '')
    return await body(client)
  } finally {
    await client.unbind().catch(() => undefined)
  }
}

export const LdapClient = {
  /** Пользователи каталога по фильтру настроек. */
  async users(settings: DirectorySettings, bindPassword: string | null): Promise<DirectoryEntry[]> {
    const attributes = requestedAttributes(settings)
    const binary = attributes.filter((name) => BINARY_ATTRIBUTES.has(name.toLowerCase()))
    return connected(settings, bindPassword, async (client) => {
      const result = await client.search(settings.baseDn, {
        scope: 'sub',
        filter: settings.userFilter,
        attributes,
        explicitBufferAttributes: binary,
        // Каталог AD без постраничного чтения отдаёт не больше 1000 записей
        paged: { pageSize: settings.pageSize },
      })
      return result.searchEntries.map(toEntry)
    })
  },

  /** Подразделения каталога; пустой корень — структура не синхронизируется. */
  async units(settings: DirectorySettings, bindPassword: string | null): Promise<DirectoryEntry[]> {
    if (!settings.unitBaseDn) return []
    return connected(settings, bindPassword, async (client) => {
      const result = await client.search(settings.unitBaseDn, {
        scope: 'sub',
        filter: settings.unitFilter,
        attributes: ['ou', 'name', 'description', 'distinguishedName'],
        paged: { pageSize: settings.pageSize },
      })
      return result.searchEntries.map(toEntry)
    })
  },

  /**
   * Проверка пароля сотрудника: bind под его собственным DN. Каталог сам
   * откажет отключённой записи и записи с истёкшим паролем.
   */
  async bindAs(settings: DirectorySettings, dn: string, password: string): Promise<boolean> {
    // Пустой пароль каталог принимает как анонимный bind — это не проверка пароля
    if (!password) return false
    const client = clientFor(settings)
    try {
      if (settings.startTls) {
        await client.startTLS({ rejectUnauthorized: settings.tlsRejectUnauthorized })
      }
      await client.bind(dn, password)
      return true
    } catch {
      return false
    } finally {
      await client.unbind().catch(() => undefined)
    }
  },

  /** Запись сотрудника по логину — чтобы узнать DN перед проверкой пароля. */
  async findUser(
    settings: DirectorySettings,
    bindPassword: string | null,
    login: string,
  ): Promise<DirectoryEntry | null> {
    const attributes = requestedAttributes(settings)
    const binary = attributes.filter((name) => BINARY_ATTRIBUTES.has(name.toLowerCase()))
    const filter = `(&${settings.userFilter}(${settings.attributes.login}=${escapeFilterValue(login)}))`
    return connected(settings, bindPassword, async (client) => {
      const result = await client.search(settings.baseDn, {
        scope: 'sub',
        filter,
        attributes,
        explicitBufferAttributes: binary,
        sizeLimit: 2,
      })
      const entries = result.searchEntries.map(toEntry)
      // Двусмысленный логин — отказ: подставить чужую запись нельзя
      return entries.length === 1 ? (entries[0] ?? null) : null
    })
  },
}

/** Экранирование значения в фильтре LDAP (RFC 4515): защита от инъекции фильтра. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (char) => {
    switch (char) {
      case '\\':
        return '\\5c'
      case '*':
        return '\\2a'
      case '(':
        return '\\28'
      case ')':
        return '\\29'
      default:
        return '\\00'
    }
  })
}
