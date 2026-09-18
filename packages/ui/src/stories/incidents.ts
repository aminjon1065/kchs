import { formatNumber } from '@kchs/fields'

/**
 * Демонстрационные данные историй Storybook: происшествия по районам
 * Таджикистана. Значения фиксированы — снимки не должны зависеть от даты.
 */
export type IncidentKind = 'flood' | 'mudflow' | 'landslide' | 'avalanche' | 'earthquake'
export type IncidentStatus = 'todo' | 'in_progress' | 'on_approval' | 'done'

export interface Incident {
  id: string
  title: string
  district: string
  kind: IncidentKind
  status: IncidentStatus
  victims: number
  /** Ущерб, тыс. сомони. */
  damage: number
  reportedAt: string
  owner: string
}

export const KIND_LABELS: Record<IncidentKind, string> = {
  flood: 'Паводок',
  mudflow: 'Сель',
  landslide: 'Оползень',
  avalanche: 'Лавина',
  earthquake: 'Землетрясение',
}

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  todo: 'Новое',
  in_progress: 'В работе',
  on_approval: 'На согласовании',
  done: 'Закрыто',
}

export const INCIDENTS: Incident[] = [
  {
    id: 'inc-01',
    title: 'Подтопление кишлака Чорбог',
    district: 'Рудаки',
    kind: 'flood',
    status: 'in_progress',
    victims: 0,
    damage: 1240,
    reportedAt: '12.09.2026 08:40',
    owner: 'Каримова Зарина',
  },
  {
    id: 'inc-02',
    title: 'Сход селя на автодороге Душанбе — Чанак',
    district: 'Варзоб',
    kind: 'mudflow',
    status: 'todo',
    victims: 2,
    damage: 5870,
    reportedAt: '12.09.2026 11:15',
    owner: 'Назаров Фаррух',
  },
  {
    id: 'inc-03',
    title: 'Оползень у школы № 14',
    district: 'Файзабад',
    kind: 'landslide',
    status: 'on_approval',
    victims: 0,
    damage: 310,
    reportedAt: '11.09.2026 17:05',
    owner: 'Шарипова Мадина',
  },
  {
    id: 'inc-04',
    title: 'Размыв дамбы на реке Кафирниган',
    district: 'Вахдат',
    kind: 'flood',
    status: 'in_progress',
    victims: 0,
    damage: 2980,
    reportedAt: '11.09.2026 06:30',
    owner: 'Каримова Зарина',
  },
  {
    id: 'inc-05',
    title: 'Лавина на перевале Анзоб',
    district: 'Айни',
    kind: 'avalanche',
    status: 'done',
    victims: 1,
    damage: 760,
    reportedAt: '09.09.2026 14:50',
    owner: 'Рахимов Далер',
  },
  {
    id: 'inc-06',
    title: 'Трещины в жилых домах после толчков',
    district: 'Гиссар',
    kind: 'earthquake',
    status: 'todo',
    victims: 0,
    damage: 450,
    reportedAt: '10.09.2026 22:10',
    owner: 'Назаров Фаррух',
  },
  {
    id: 'inc-07',
    title: 'Подтопление полей в джамоате Лолазор',
    district: 'Кулоб',
    kind: 'flood',
    status: 'done',
    victims: 0,
    damage: 1880,
    reportedAt: '08.09.2026 09:25',
    owner: 'Шарипова Мадина',
  },
  {
    id: 'inc-08',
    title: 'Селевой поток в ущелье Кондара',
    district: 'Варзоб',
    kind: 'mudflow',
    status: 'on_approval',
    victims: 0,
    damage: 920,
    reportedAt: '10.09.2026 16:40',
    owner: 'Рахимов Далер',
  },
  {
    id: 'inc-09',
    title: 'Обрушение склона у моста через Вахш',
    district: 'Бохтар',
    kind: 'landslide',
    status: 'in_progress',
    victims: 3,
    damage: 4150,
    reportedAt: '12.09.2026 07:55',
    owner: 'Каримова Зарина',
  },
  {
    id: 'inc-10',
    title: 'Паводок на реке Зеравшан',
    district: 'Панджакент',
    kind: 'flood',
    status: 'todo',
    victims: 0,
    damage: 2310,
    reportedAt: '12.09.2026 13:20',
    owner: 'Шарипова Мадина',
  },
]

/** Числа — форматтером платформы, как в интерфейсе. */
export function formatAmount(value: number): string {
  return formatNumber(value, {}, { locale: 'ru' })
}
