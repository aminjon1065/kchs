import type { FieldDef } from '@kchs/contracts'

/** Вычисляемые и особые типы форма не спрашивает — как на сервере (ADR-0103). */
const NOT_ASKABLE = new Set(['formula', 'lookup', 'rollup', 'file', 'signature'])

/** Спрашивает ли форма поле; геометрию — только точкой, на карте или координатами (ADR-0157). */
export const askable = (field: Pick<FieldDef, 'type' | 'geometryType'>): boolean =>
  field.type === 'geometry'
    ? !field.geometryType || field.geometryType === 'point' || field.geometryType === 'any'
    : !NOT_ASKABLE.has(field.type)
