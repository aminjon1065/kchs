import type { CapCategory, CapSeverity, WarningLanguage } from '@kchs/contracts'

/**
 * Подсказки черновика из сообщения об опасном явлении (ADR-0202): явление на
 * трёх языках и категория CAP по коду явления реестра сообщений, строгость — по
 * уровню тревоги ленты. Это только начальные значения: дежурный правит их в
 * карточке до отправки на решение.
 */
export const HAZARD_EVENTS: Record<
  string,
  { event: Record<WarningLanguage, string>; category: CapCategory }
> = {
  earthquake: {
    event: { tg: 'Заминҷунбӣ', ru: 'Землетрясение', en: 'Earthquake' },
    category: 'Geo',
  },
  flood: {
    event: { tg: 'Обхезӣ, селоб', ru: 'Наводнение, паводок', en: 'Flood' },
    category: 'Met',
  },
  mudflow: { event: { tg: 'Сел', ru: 'Сель', en: 'Mudflow' }, category: 'Geo' },
  landslide: { event: { tg: 'Ярч', ru: 'Оползень', en: 'Landslide' }, category: 'Geo' },
  avalanche: { event: { tg: 'Тарма', ru: 'Снежная лавина', en: 'Avalanche' }, category: 'Geo' },
  fire: { event: { tg: 'Сӯхтор', ru: 'Пожар', en: 'Fire' }, category: 'Fire' },
  drought: { event: { tg: 'Хушксолӣ', ru: 'Засуха', en: 'Drought' }, category: 'Met' },
  cyclone: {
    event: { tg: 'Тӯфони тропикӣ', ru: 'Тропический циклон', en: 'Tropical cyclone' },
    category: 'Met',
  },
  volcano: {
    event: { tg: 'Оташфишонӣ', ru: 'Извержение вулкана', en: 'Volcanic eruption' },
    category: 'Geo',
  },
  storm: {
    event: { tg: 'Шамоли сахт', ru: 'Сильный ветер, ураган', en: 'Severe wind' },
    category: 'Met',
  },
}

/** Уровень тревоги GDACS и национальных лент → строгость CAP. */
export const ALERT_LEVEL_SEVERITY: Record<string, CapSeverity> = {
  red: 'Extreme',
  orange: 'Severe',
  green: 'Moderate',
}
