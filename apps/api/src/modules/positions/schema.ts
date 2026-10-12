import { sql } from 'drizzle-orm'
import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { orgUnits, users } from '../../kernel/directory/schema.js'
import { objects } from '../../kernel/objects/schema.js'
import { createdAt, tsCol, updatedAt } from '../../shared/db/columns.js'

/**
 * Устройство слежения (ADR-0203) — объект реестра `device`: права, пространство,
 * поиск и корзина как у всех объектов. Внешний номер — то, чем устройство
 * называет себя у поставщика (IMEI, логин трекера); он уникален в установке.
 * Последняя точка хранится здесь же: карточка, список и проекция в датасет
 * читают её без обращения к журналу точек.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    kind: text('kind').notNull().default('vehicle'),
    /** Код строки датасета «Силы и средства»: к какой единице сил относится устройство. */
    forcesCode: text('forces_code'),
    unitId: uuid('unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
    /** Кто передаёт координаты: служебная запись поставщика или сотрудник группы. */
    reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    active: boolean('active').notNull().default(true),
    lastAt: tsCol('last_at'),
    lastLat: doublePrecision('last_lat'),
    lastLon: doublePrecision('last_lon'),
    lastSpeed: real('last_speed'),
    lastHeading: real('last_heading'),
    lastBattery: real('last_battery'),
    /** До какой точки последняя позиция уже записана в датасет проекции. */
    projectedAt: tsCol('projected_at'),
    /** Состояние связи, записанное проекцией: «на связи» стареет и без новых точек. */
    projectedLink: text('projected_link'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('devices_external_uq').on(t.externalId),
    index('devices_last_idx').on(t.lastAt),
    index('devices_reporter_idx').on(t.reporterId),
  ],
)

/**
 * Журнал точек — временной ряд, разбитый на партиции по месяцам (`at`), как журнал
 * аудита (ADR-0173): старые месяцы удаляются целиком по сроку хранения. Ключ
 * (устройство, время) — идемпотентность: повтор пакета поставщика не пишет точку
 * второй раз. Таблица создана миграцией `PARTITION BY RANGE (at)`; Drizzle
 * описывает её как обычную — для запросов.
 */
export const devicePositions = pgTable(
  'device_positions',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    at: tsCol('at').notNull(),
    receivedAt: tsCol('received_at').notNull().default(sql`now()`),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    speed: real('speed'),
    heading: real('heading'),
    battery: real('battery'),
    /** Откуда точка: `token` — поставщик по токену, `session` — сотрудник с телефона. */
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.at], name: 'device_positions_pk' })],
)

export type DeviceRow = typeof devices.$inferSelect
