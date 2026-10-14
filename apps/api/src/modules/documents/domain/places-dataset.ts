import type { FieldSemantic, FieldType, LangText } from '@kchs/contracts'
import type { ResolvedDataset, ResolvedField } from '@kchs/query'
import type { SystemDatasetDefinition } from '~/kernel/system-datasets.js'
import type { Ctx } from '~/shared/context.js'
import { documentViewerPolicy } from './system-dataset.js'

const field = (
  key: string,
  type: FieldType,
  semantic: FieldSemantic,
  label: LangText,
): ResolvedField => ({ key, type, physical: key, semantic, label })

/**
 * Поля представления `ds.sys_document_places` (миграция document_places, ADR-0223):
 * документ с точкой в реквизитах карточки — тип, номер, дата, тема, район и точка.
 */
const FIELDS: ResolvedField[] = [
  field('id', 'object_ref', 'identifier', { ru: 'Документ', tg: 'Ҳуҷҷат', en: 'Document' }),
  field('type_key', 'select', 'category', { ru: 'Тип', tg: 'Намуд', en: 'Type' }),
  field('type_name', 'text', 'category', {
    ru: 'Название типа',
    tg: 'Номи намуд',
    en: 'Type name',
  }),
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
  field('subject', 'text', 'text', { ru: 'Тема', tg: 'Мавзӯъ', en: 'Subject' }),
  field('status', 'select', 'category', { ru: 'Статус', tg: 'Ҳолат', en: 'Status' }),
  field('territory', 'territory', 'dimension', { ru: 'Район', tg: 'Ноҳия', en: 'District' }),
  field('location', 'geometry', 'geometry', {
    ru: 'Место на карте',
    tg: 'Ҷой дар харита',
    en: 'Location on map',
  }),
  field('created_at', 'datetime', 'time', { ru: 'Создан', tg: 'Сохта шуд', en: 'Created' }),
  field('confidentiality', 'select', 'category', { ru: 'Гриф', tg: 'Гриф', en: 'Classification' }),
  // Служебные столбцы: номер объекта тайла и политика строк — скрыты от смотрящего
  field('_id', 'integer', 'system', { ru: 'Номер строки', en: 'Row number' }),
  field('grif_rank', 'integer', 'system', { ru: 'Ранг грифа', en: 'Classification rank' }),
  field('viewers', 'multi_select', 'system', { ru: 'Видят', en: 'Viewers' }),
]

/**
 * Документы на карте с правами смотрящего — как у системного датасета «Документы»
 * (ADR-0080): строка видна, если документ виден смотрящему и гриф не строже допуска.
 * Слой карты над этим источником показывает место документа только тем, кому открыт
 * сам документ (N161).
 */
export async function resolveDocumentPlaces(ctx: Ctx): Promise<ResolvedDataset> {
  return {
    id: 'system:document_places',
    table: 'ds.sys_document_places',
    fields: FIELDS,
    rowPolicy: documentViewerPolicy(ctx),
    columnPolicy: { hide: ['viewers', 'grif_rank'], mask: [] },
    version: 0,
    systemColumns: false,
  }
}

export const DOCUMENT_PLACES_SYSTEM_DATASET: SystemDatasetDefinition = {
  name: 'document_places',
  resolve: resolveDocumentPlaces,
  timeField: 'reg_date',
  geometry: { field: 'location', type: 'point' },
}
