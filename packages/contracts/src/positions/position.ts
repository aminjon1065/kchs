import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Местоположение сил и средств (концепт-нота КЧСиГО, компонент 5; ADR-0203):
 * устройство слежения — трекер техники, телефон оперативной группы, — его
 * позиции и последняя известная точка. Поставщик услуг мониторинга передаёт
 * позиции пакетом по токену с областью `write:positions`, сотрудник с телефона —
 * в своей сессии; права — на устройство, как на любой объект реестра.
 */

/** Что везёт устройство: техника, группа, воздушное судно, плавсредство, человек. */
export const DEVICE_KINDS = ['vehicle', 'team', 'aircraft', 'boat', 'person', 'other'] as const
export const DeviceKind = z.enum(DEVICE_KINDS)
export type DeviceKind = z.infer<typeof DeviceKind>

/**
 * Связь: «на связи» — последняя точка свежее порога `staleMinutes` настроек,
 * «нет связи» — старше, «не выходило» — точек ещё не было.
 */
export const DEVICE_LINK_STATES = ['online', 'stale', 'never'] as const
export const DeviceLinkState = z.enum(DEVICE_LINK_STATES)
export type DeviceLinkState = z.infer<typeof DeviceLinkState>

/** Внешний номер устройства у поставщика: IMEI, номер борта, логин трекера. */
export const DeviceExternalId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:@-]+$/, 'латинские буквы, цифры и . _ : @ -')

/** Точка: время фиксации, координаты WGS 84, скорость км/ч, курс в градусах, заряд %. */
export const PositionFix = z.object({
  at: Timestamp,
  lat: z.number(),
  lon: z.number(),
  speed: z.number().nullable(),
  heading: z.number().nullable(),
  battery: z.number().nullable(),
})
export type PositionFix = z.infer<typeof PositionFix>

export const DeviceRecord = z.object({
  id: Uuid,
  spaceId: Uuid,
  name: z.string(),
  externalId: z.string(),
  kind: DeviceKind,
  /** Код строки датасета «Силы и средства» — к какой единице сил относится устройство. */
  forcesCode: z.string().nullable(),
  /** Подразделение, за которым закреплено устройство. */
  unitId: Uuid.nullable(),
  /**
   * Кто передаёт координаты: служебная учётная запись поставщика мониторинга или
   * сотрудник с телефоном группы. Ему достаточно этого — других прав на объекты
   * пространства ему не нужно (ADR-0203).
   */
  reporterId: Uuid.nullable(),
  note: z.string().nullable(),
  /** Выключенное устройство позиции не принимает. */
  active: z.boolean(),
  last: PositionFix.nullable(),
  link: DeviceLinkState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  can: z.object({ edit: z.boolean(), report: z.boolean() }),
})
export type DeviceRecord = z.infer<typeof DeviceRecord>

export const DeviceListQuery = z.object({
  spaceId: Uuid.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})
export type DeviceListQuery = z.infer<typeof DeviceListQuery>

export const DeviceList = z.object({
  items: z.array(DeviceRecord),
  /** Порог «нет связи» в минутах — для подписи в интерфейсе. */
  staleMinutes: z.number().int(),
})
export type DeviceList = z.infer<typeof DeviceList>

export const DeviceCreateInput = z.object({
  spaceId: Uuid,
  name: z.string().trim().min(1).max(200),
  externalId: DeviceExternalId,
  kind: DeviceKind.default('vehicle'),
  forcesCode: z.string().trim().min(1).max(64).nullish(),
  unitId: Uuid.nullish(),
  reporterId: Uuid.nullish(),
  note: z.string().trim().max(2000).nullish(),
})
export type DeviceCreateInput = z.infer<typeof DeviceCreateInput>

export const DeviceUpdateInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  externalId: DeviceExternalId.optional(),
  kind: DeviceKind.optional(),
  forcesCode: z.string().trim().min(1).max(64).nullish(),
  unitId: Uuid.nullish(),
  reporterId: Uuid.nullish(),
  note: z.string().trim().max(2000).nullish(),
  active: z.boolean().optional(),
})
export type DeviceUpdateInput = z.infer<typeof DeviceUpdateInput>

/** Предел точек в одном пакете: больше — несколькими запросами. */
export const POSITION_BATCH_MAX = 500

/** Точка от поставщика: `deviceId` — внешний номер устройства, не идентификатор реестра. */
export const PositionInput = z.object({
  deviceId: DeviceExternalId,
  at: Timestamp,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Скорость по данным устройства, км/ч. */
  speed: z.number().min(0).max(2000).nullish(),
  heading: z.number().min(0).max(360).nullish(),
  battery: z.number().min(0).max(100).nullish(),
})
export type PositionInput = z.infer<typeof PositionInput>

export const PositionBatchInput = z.object({
  positions: z.array(PositionInput).min(1).max(POSITION_BATCH_MAX),
})
export type PositionBatchInput = z.infer<typeof PositionBatchInput>

/**
 * Почему точка не принята: устройство не заведено (или передавать его точки
 * этому отправителю нельзя — номер чужого устройства не подтверждается),
 * выключено; время из будущего или слишком давнее; скорость, которой у техники
 * не бывает.
 */
export const POSITION_REJECT_REASONS = [
  'unknown_device',
  'inactive_device',
  'future',
  'too_old',
  'impossible_speed',
] as const
export const PositionRejectReason = z.enum(POSITION_REJECT_REASONS)
export type PositionRejectReason = z.infer<typeof PositionRejectReason>

/** Итог пакета: повтор той же точки (устройство + время) второй раз не записывается. */
export const PositionBatchResult = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  rejected: z.array(
    z.object({ index: z.number().int(), deviceId: z.string(), reason: PositionRejectReason }),
  ),
})
export type PositionBatchResult = z.infer<typeof PositionBatchResult>

export const DeviceTrackQuery = z.object({
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(2000),
})
export type DeviceTrackQuery = z.infer<typeof DeviceTrackQuery>

export const DeviceTrack = z.object({
  deviceId: Uuid,
  points: z.array(PositionFix),
  /** Точек больше предела — показаны последние. */
  truncated: z.boolean(),
})
export type DeviceTrack = z.infer<typeof DeviceTrack>

/**
 * Настройки установки: срок хранения точек в месяцах, датасет, куда проецируется
 * последняя точка каждого устройства (слой карты обстановки), порог «нет связи».
 */
export const PositionsSettings = z.object({
  retentionMonths: z.number().int().min(1).max(120),
  projectionDatasetId: Uuid.nullable(),
  staleMinutes: z.number().int().min(1).max(1440),
})
export type PositionsSettings = z.infer<typeof PositionsSettings>

export const POSITIONS_DEFAULT_SETTINGS: PositionsSettings = {
  retentionMonths: 12,
  projectionDatasetId: null,
  staleMinutes: 15,
}
