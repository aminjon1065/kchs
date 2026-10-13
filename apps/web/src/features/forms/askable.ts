import type { FieldDef } from '@kchs/contracts'

/**
 * Вычисляемые типы и подпись форма не спрашивает — как на сервере (ADR-0103); файл
 * спрашивает фотографией (ADR-0208).
 */
const NOT_ASKABLE = new Set(['formula', 'lookup', 'rollup', 'signature'])

/** Спрашивает ли форма поле; геометрию — только точкой, на карте или координатами (ADR-0157). */
export const askable = (field: Pick<FieldDef, 'type' | 'geometryType'>): boolean =>
  field.type === 'geometry'
    ? !field.geometryType || field.geometryType === 'point' || field.geometryType === 'any'
    : !NOT_ASKABLE.has(field.type)
