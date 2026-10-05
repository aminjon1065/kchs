import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/** Событие без полезной нагрузки: всё нужное — в конверте (объект, актор). */
export const empty = z.object({})

/** Строка датасета в событиях строк (ADR-0133). */
export const DatasetRowEvent = z.object({
  rowId: z.string(),
  values: z.record(z.string(), z.unknown()),
  labels: z.record(z.string(), z.string()).default({}),
  territories: z
    .record(
      z.string(),
      z.object({ id: Uuid, code: z.string(), name: z.string(), path: z.array(z.string()) }),
    )
    .default({}),
})
