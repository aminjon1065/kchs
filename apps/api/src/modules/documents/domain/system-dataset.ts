import type { FieldSemantic, FieldType, FilterNode, LangText } from '@kchs/contracts'
import type { ResolvedDataset, ResolvedField } from '@kchs/query'
import { visibilityPrincipals } from '~/kernel/access/authorize.js'
import { clearanceLimit } from '~/kernel/access/confidentiality.js'
import type { SystemDatasetDefinition } from '~/kernel/system-datasets.js'
import type { Ctx } from '~/shared/context.js'

const field = (
  key: string,
  type: FieldType,
  semantic: FieldSemantic,
  label: LangText,
): ResolvedField => ({ key, type, physical: key, semantic, label })

/**
 * Поля представления `ds.sys_documents` (миграция documents_system_dataset,
 * ADR-0080): документы с правами смотрящего — для запросов, графиков и
 * показателей канцелярии (08-documents.md §14): объём регистрации по типам и
 * журналам, просрочка, нагрузка на ответственных.
 */
const FIELDS: ResolvedField[] = [
  field('id', 'object_ref', 'identifier', { ru: 'Документ', tg: 'Ҳуҷҷат', en: 'Document' }),
  field('subject', 'text', 'text', { ru: 'Тема', tg: 'Мавзӯъ', en: 'Subject' }),
  field('reg_number', 'identifier', 'identifier', {
    ru: 'Рег. номер',
    tg: 'Рақами бақайдгирӣ',
    en: 'Reg. number',
  }),
  field('reg_date', 'date', 'time', {
    ru: 'Дата регистрации',
    tg: 'Санаи бақайдгирӣ',
    en: 'Registered on',
  }),
  field('status', 'select', 'category', { ru: 'Статус', tg: 'Ҳолат', en: 'Status' }),
  field('type_key', 'select', 'category', { ru: 'Тип', tg: 'Намуд', en: 'Type' }),
  field('type_name', 'text', 'category', { ru: 'Название типа', en: 'Type name' }),
  field('direction', 'select', 'category', { ru: 'Направление', tg: 'Самт', en: 'Direction' }),
  field('journal', 'object_ref', 'dimension', { ru: 'Журнал', tg: 'Маҷалла', en: 'Journal' }),
  field('journal_name', 'text', 'category', { ru: 'Название журнала', en: 'Journal name' }),
  field('unit', 'unit', 'dimension', { ru: 'Подразделение', tg: 'Воҳид', en: 'Unit' }),
  field('author', 'user', 'dimension', { ru: 'Автор', tg: 'Муаллиф', en: 'Author' }),
  field('responsible', 'user', 'dimension', {
    ru: 'Ответственный',
    tg: 'Масъул',
    en: 'Responsible',
  }),
  field('signer', 'user', 'dimension', { ru: 'Подписант', tg: 'Имзокунанда', en: 'Signer' }),
  field('controller', 'user', 'dimension', { ru: 'Контролёр', tg: 'Назоратчӣ', en: 'Controller' }),
  field('correspondent', 'object_ref', 'dimension', {
    ru: 'Корреспондент',
    tg: 'Мухбир',
    en: 'Correspondent',
  }),
  field('correspondent_name', 'text', 'category', {
    ru: 'Название корреспондента',
    en: 'Correspondent name',
  }),
  field('received_date', 'date', 'time', {
    ru: 'Дата поступления',
    tg: 'Санаи воридшавӣ',
    en: 'Received on',
  }),
  field('deadline', 'date', 'time', { ru: 'Срок', tg: 'Мӯҳлат', en: 'Deadline' }),
  field('control', 'select', 'category', { ru: 'Контроль', tg: 'Назорат', en: 'Control' }),
  field('on_control', 'boolean', 'category', {
    ru: 'На контроле',
    tg: 'Дар назорат',
    en: 'On control',
  }),
  field('overdue', 'boolean', 'category', {
    ru: 'Просрочен',
    tg: 'Мӯҳлаташ гузашт',
    en: 'Overdue',
  }),
  field('executed_at', 'datetime', 'time', { ru: 'Исполнен', tg: 'Иҷро шуд', en: 'Executed' }),
  field('cancelled_at', 'datetime', 'time', {
    ru: 'Аннулирован',
    tg: 'Бекор шуд',
    en: 'Cancelled',
  }),
  field('created_at', 'datetime', 'time', { ru: 'Создан', tg: 'Сохта шуд', en: 'Created' }),
  field('confidentiality', 'select', 'category', { ru: 'Гриф', tg: 'Гриф', en: 'Classification' }),
  // Канцелярия (ADR-0086): закрытость, доля просрочки на контроле, дело, архив, отправка
  field('closed', 'boolean', 'category', { ru: 'Закрыт', tg: 'Пӯшида', en: 'Closed' }),
  field('overdue_score', 'integer', 'measure', {
    ru: 'Просрочка на контроле, %',
    en: 'Overdue on control, %',
  }),
  field('case_id', 'object_ref', 'dimension', { ru: 'Дело', tg: 'Парванда', en: 'Case' }),
  field('case_index', 'identifier', 'category', {
    ru: 'Индекс дела',
    tg: 'Индекси парванда',
    en: 'Case index',
  }),
  field('case_title', 'text', 'category', { ru: 'Заголовок дела', en: 'Case title' }),
  field('filed_at', 'datetime', 'time', { ru: 'Подшит в дело', en: 'Filed' }),
  field('archived_at', 'datetime', 'time', { ru: 'Сдан в архив', en: 'Archived' }),
  field('sent_on', 'date', 'time', { ru: 'Отправлен', tg: 'Фиристода шуд', en: 'Sent on' }),
  // Служебные столбцы политики строк — скрыты от смотрящего
  field('grif_rank', 'integer', 'system', { ru: 'Ранг грифа', en: 'Classification rank' }),
  field('viewers', 'multi_select', 'system', { ru: 'Видят', en: 'Viewers' }),
]

/**
 * Источник компилятора с правами смотрящего: строки — документы, чьи
 * принципалы пересекаются с принципалами пользователя (как фильтр поиска,
 * ADR-0060), и гриф не строже его допуска (ADR-0080). Администратор системы
 * вне режима администратора и аудитор видят всё, кроме грифа выше допуска.
 */
export async function resolveDocumentsDataset(ctx: Ctx): Promise<ResolvedDataset> {
  const principals = visibilityPrincipals(ctx)
  const limit = clearanceLimit(ctx)
  const conditions: FilterNode[] = []
  if (principals !== null && principals.length > 0) {
    conditions.push({ field: 'viewers', op: 'in', value: principals })
  }
  if (limit !== null) conditions.push({ field: 'grif_rank', op: 'lte', value: limit })
  const none = principals !== null && principals.length === 0
  return {
    id: 'system:documents',
    table: 'ds.sys_documents',
    fields: FIELDS,
    rowPolicy: none
      ? { kind: 'none' }
      : conditions.length === 0
        ? { kind: 'all' }
        : {
            kind: 'filter',
            where: conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions },
          },
    columnPolicy: { hide: ['viewers', 'grif_rank'], mask: [] },
    version: 0,
    systemColumns: false,
  }
}

export const DOCUMENTS_SYSTEM_DATASET: SystemDatasetDefinition = {
  name: 'documents',
  resolve: resolveDocumentsDataset,
  // Показатели канцелярии считают объём по дате регистрации (ADR-0086)
  timeField: 'reg_date',
}
