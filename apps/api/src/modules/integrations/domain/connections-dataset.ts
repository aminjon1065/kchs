import type { FieldSemantic, FieldType, LangText } from '@kchs/contracts'
import type { ResolvedDataset, ResolvedField } from '@kchs/query'
import { hasCapability } from '~/kernel/access/authorize.js'
import type { SystemDatasetDefinition } from '~/kernel/system-datasets.js'
import type { Ctx } from '~/shared/context.js'
import { MANAGE } from './object-types.js'

const field = (
  key: string,
  type: FieldType,
  semantic: FieldSemantic,
  label: LangText,
): ResolvedField => ({ key, type, physical: key, semantic, label })

/**
 * Поля представления `ds.sys_connections` (миграция gateway-connections, ADR-0206):
 * подключение за сутки — кто, каким каналом, с какого времени, объём за день,
 * полнота (доля дней с передачами за 30 дней) и своевременность (последняя
 * передача, молчание дольше суток).
 */
const FIELDS: ResolvedField[] = [
  field('day', 'date', 'time', { ru: 'День', tg: 'Рӯз', en: 'Day' }),
  field('connection_id', 'identifier', 'identifier', {
    ru: 'Идентификатор подключения',
    tg: 'Мушаххаси пайвастшавӣ',
    en: 'Connection ID',
  }),
  field('connection', 'text', 'category', {
    ru: 'Подключение',
    tg: 'Пайвастшавӣ',
    en: 'Connection',
  }),
  field('kind', 'select', 'category', { ru: 'Что подключено', tg: 'Чӣ пайваст аст', en: 'Kind' }),
  field('channel', 'select', 'category', { ru: 'Канал', tg: 'Канал', en: 'Channel' }),
  field('owner', 'user', 'dimension', { ru: 'Владелец', tg: 'Соҳиб', en: 'Owner' }),
  field('status', 'select', 'category', { ru: 'Состояние', tg: 'Ҳолат', en: 'Status' }),
  field('since', 'datetime', 'time', { ru: 'Подключено с', tg: 'Пайваст аз', en: 'Since' }),
  field('requests', 'integer', 'measure', { ru: 'Запросы', tg: 'Дархостҳо', en: 'Requests' }),
  field('rows', 'integer', 'measure', { ru: 'Строки', tg: 'Сатрҳо', en: 'Rows' }),
  field('errors', 'integer', 'measure', { ru: 'Ошибки', tg: 'Хатоҳо', en: 'Errors' }),
  field('active', 'boolean', 'category', {
    ru: 'Были передачи',
    tg: 'Интиқол буд',
    en: 'Had transfers',
  }),
  field('last_at', 'datetime', 'time', {
    ru: 'Последняя передача',
    tg: 'Интиқоли охирин',
    en: 'Last transfer',
  }),
  field('hours_since_last', 'number', 'measure', {
    ru: 'Часов без передач',
    tg: 'Соатҳо бе интиқол',
    en: 'Hours since last transfer',
  }),
  field('stale', 'boolean', 'category', {
    ru: 'Молчит дольше суток',
    tg: 'Зиёда аз як шабонарӯз хомӯш',
    en: 'Silent over a day',
  }),
  field('active_days_30', 'integer', 'measure', {
    ru: 'Дней с передачами за 30 дней',
    tg: 'Рӯзҳои интиқол дар 30 рӯз',
    en: 'Active days in 30',
  }),
  field('completeness', 'integer', 'measure', {
    ru: 'Полнота за 30 дней, %',
    tg: 'Пуррагӣ дар 30 рӯз, %',
    en: 'Completeness over 30 days, %',
  }),
  field('last_error', 'text', 'text', {
    ru: 'Последняя ошибка',
    tg: 'Хатои охирин',
    en: 'Last error',
  }),
  field('last_error_at', 'datetime', 'time', {
    ru: 'Время ошибки',
    tg: 'Вақти хато',
    en: 'Error time',
  }),
  field('is_today', 'boolean', 'category', { ru: 'Сегодня', tg: 'Имрӯз', en: 'Today' }),
]

/**
 * Права смотрящего: кто управляет интеграциями (`automation.manage`, как и сами
 * интеграции и вебхуки), видит все подключения; остальные — только свои токены.
 */
export async function resolveConnectionsDataset(ctx: Ctx): Promise<ResolvedDataset> {
  const all = hasCapability(ctx, MANAGE)
  return {
    id: 'system:connections',
    table: 'ds.sys_connections',
    fields: FIELDS,
    rowPolicy:
      all || ctx.kind !== 'user'
        ? { kind: 'all' }
        : { kind: 'filter', where: { field: 'owner', op: 'eq', value: ctx.userId } },
    columnPolicy: { hide: [], mask: [] },
    version: 0,
    systemColumns: false,
  }
}

export const CONNECTIONS_SYSTEM_DATASET: SystemDatasetDefinition = {
  name: 'connections',
  resolve: resolveConnectionsDataset,
  timeField: 'day',
}
