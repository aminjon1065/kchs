import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: модуль «Местоположение» (ADR-0203). Домены `device` и `position` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const POSITIONS_EVENTS = {
  /** Устройство слежения заведено. */
  'device.created': z.object({ externalId: z.string(), kind: z.string() }),
  /** Карточка изменена: имя, номер, вид, единица сил, подразделение, включено ли. */
  'device.updated': z.object({ changed: z.array(z.string()).default([]) }),
  /**
   * Новая последняя точка устройства (пакет поставщика или телефон группы):
   * realtime — открытым карточкам и карте обстановки; правила автоматизации.
   * Одно событие на устройство за пакет, сколько бы точек в нём ни было.
   */
  'device.located': z.object({
    at: z.string(),
    lat: z.number(),
    lon: z.number(),
    speed: z.number().nullable().default(null),
    heading: z.number().nullable().default(null),
    battery: z.number().nullable().default(null),
    /** Сколько точек устройства принято этим пакетом. */
    points: z.number().int(),
    /** Датасет проекции (слой карты обстановки), если он настроен. */
    datasetId: Uuid.nullable().default(null),
  }),
} as const satisfies Record<string, z.ZodType>
