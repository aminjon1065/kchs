import type { FieldSemantic, FieldType, LangText } from '@kchs/contracts'
import type { ResolvedDataset, ResolvedField } from '@kchs/query'
import type { SystemDatasetDefinition } from '~/kernel/system-datasets.js'
import type { Ctx } from '~/shared/context.js'

const field = (
  key: string,
  type: FieldType,
  semantic: FieldSemantic,
  label: LangText,
): ResolvedField => ({ key, type, physical: key, semantic, label })

/**
 * Поля представления `ds.sys_territories` (миграция gis_analysis, ADR-0069):
 * справочник территорий с границами — источник запросов и цель шага `spatial`
 * (присвоение территории, отбор по территориям). Компилятор опирается на поля
 * `id`, `code`, `level`, `geom`.
 */
const FIELDS: ResolvedField[] = [
  field('id', 'territory', 'territory', { ru: 'Территория', en: 'Territory' }),
  field('code', 'identifier', 'identifier', { ru: 'Код', en: 'Code' }),
  field('level', 'select', 'category', { ru: 'Уровень', en: 'Level' }),
  field('parent_id', 'territory', 'territory', { ru: 'Входит в', en: 'Parent' }),
  field('name', 'text', 'text', { ru: 'Название', en: 'Name' }),
  field('name_tg', 'text', 'text', { ru: 'Название (тоҷикӣ)', en: 'Name (Tajik)' }),
  field('name_en', 'text', 'text', { ru: 'Название (English)', en: 'Name (English)' }),
  field('geom', 'geometry', 'geometry', { ru: 'Граница', en: 'Boundary' }),
  field('area_km2', 'number', 'measure', { ru: 'Площадь, км²', en: 'Area, km²' }),
]

/**
 * Справочник открыт сотрудникам (ACL everyone, как `GET /territories`); гостю
 * по ссылке — ни одной строки.
 */
export async function resolveTerritoriesDataset(ctx: Ctx): Promise<ResolvedDataset> {
  const guest = ctx.kind === 'user' && ctx.shareLink !== null
  return {
    id: 'system:territories',
    table: 'ds.sys_territories',
    fields: FIELDS,
    rowPolicy: guest ? { kind: 'none' } : { kind: 'all' },
    columnPolicy: { hide: [], mask: [] },
    version: 0,
    systemColumns: false,
  }
}

export const TERRITORIES_SYSTEM_DATASET: SystemDatasetDefinition = {
  name: 'territories',
  resolve: resolveTerritoriesDataset,
}
