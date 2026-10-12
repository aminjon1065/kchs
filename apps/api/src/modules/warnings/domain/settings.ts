import type { WarningLanguage } from '@kchs/contracts'
import { SettingsService } from '~/kernel/settings/service.js'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import type { Tx } from '~/shared/db/client.js'

/** Системная настройка модуля: пространство предупреждений и датасет сообщений-источников. */
const KEY = 'warnings.settings'

export interface WarningConfig {
  spaceId: string | null
  sourceDatasetId: string | null
  /** Группа уполномоченных подписывать решение о выпуске; пусто — любой сотрудник. */
  signerGroupId: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const idOrNull = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null

/** Отправитель в документах CAP: от имени Комитета на всех трёх языках. */
export const SENDER_NAMES: Record<WarningLanguage, string> = {
  tg: 'Кумитаи ҳолатҳои фавқулодда ва мудофиаи граждании назди Ҳукумати Ҷумҳурии Тоҷикистон',
  ru: 'Комитет по чрезвычайным ситуациям и гражданской обороне при Правительстве Республики Таджикистан',
  en: 'Committee of Emergency Situations and Civil Defence under the Government of the Republic of Tajikistan',
}

/** Язык блока `info` по RFC 3066. */
export const CAP_LANGUAGE: Record<WarningLanguage, string> = {
  tg: 'tg-TJ',
  ru: 'ru-RU',
  en: 'en-US',
}

/**
 * Настройки модуля (ADR-0202). Их заводит пакет ЧС при установке: пространство
 * «Оперативный штаб ЧС», реестр «Сообщения об опасных явлениях» и группа
 * «Руководство штаба ЧС» — кто подписывает решение о выпуске. Без пакета
 * пространство передают при создании, а «из сообщения» — с датасетом.
 */
export const WarningSettingsService = {
  async current(): Promise<WarningConfig> {
    const raw = await SettingsService.get<Record<string, unknown> | null>(
      KEY,
      [{ scope: 'system' }],
      null,
    )
    return {
      spaceId: idOrNull(raw?.spaceId),
      sourceDatasetId: idOrNull(raw?.sourceDatasetId),
      signerGroupId: idOrNull(raw?.signerGroupId),
    }
  },

  /** Заполнить незаданное: выбор администратора повторная установка пакета не трогает. */
  async ensure(tx: Tx, ctx: Ctx, defaults: WarningConfig): Promise<WarningConfig> {
    const current = await WarningSettingsService.current()
    const next: WarningConfig = {
      spaceId: current.spaceId ?? defaults.spaceId,
      sourceDatasetId: current.sourceDatasetId ?? defaults.sourceDatasetId,
      signerGroupId: current.signerGroupId ?? defaults.signerGroupId,
    }
    if (
      next.spaceId !== current.spaceId ||
      next.sourceDatasetId !== current.sourceDatasetId ||
      next.signerGroupId !== current.signerGroupId
    ) {
      await SettingsService.set(tx, ctx, 'system', null, KEY, next)
    }
    return next
  },
}

/** Внешний адрес API: тот же адрес установки, снаружи — через шлюз DMZ (ADR-0200). */
export function publicApiUrl(path: string): string {
  return `${config().KCHS_BASE_URL.replace(/\/+$/, '')}/api/v1${path}`
}

/** Отправитель CAP (`sender`): имя узла установки — устойчиво и уникально у Комитета. */
export function capSender(): string {
  try {
    return new URL(config().KCHS_BASE_URL).hostname || 'kchs'
  } catch {
    return 'kchs'
  }
}

export const capUrlOf = (id: string) => publicApiUrl(`/public/cap/${id}.xml`)

export function feedUrls(): { atom: string; rss: Record<WarningLanguage, string> } {
  return {
    atom: publicApiUrl('/public/cap/feed.xml'),
    rss: {
      tg: publicApiUrl('/public/cap/rss/tg.xml'),
      ru: publicApiUrl('/public/cap/rss/ru.xml'),
      en: publicApiUrl('/public/cap/rss/en.xml'),
    },
  }
}
