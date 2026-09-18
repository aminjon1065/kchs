import { readFileSync } from 'node:fs'
import {
  SUB_1,
  SUB_2,
  TERR_DU,
  TERR_DU_1,
  TERR_DU_2,
  TERR_KH,
  UNIT_A,
  UNIT_B,
  USER_ID,
} from './fixtures.js'

/**
 * Тестовая база для выполнения скомпилированного SQL на настоящем Postgres
 * (PostGIS) под ролью `kchs_query`. Нужна база с ролями и схемами из
 * infra/compose/postgres/init. Строка подключения роли kchs_app —
 * `KCHS_QUERY_TEST_DATABASE_URL`, либо `KCHS_TEST_SLOT=N`: база `kchs_test_N`
 * по `DATABASE_URL` (из окружения или корневого .env). Без них наборы пропускаются.
 */
export function databaseUrl(): string | undefined {
  if (process.env.KCHS_QUERY_TEST_DATABASE_URL) return process.env.KCHS_QUERY_TEST_DATABASE_URL
  const slot = process.env.KCHS_TEST_SLOT
  if (!slot) return undefined
  if (!/^([1-9]|1[0-4])$/.test(slot)) throw new Error('KCHS_TEST_SLOT: целое число 1…14')
  return (process.env.DATABASE_URL ?? rootDatabaseUrl())?.replace(
    /\/kchs(\?|$)/,
    `/kchs_test_${slot}$1`,
  )
}

function rootDatabaseUrl(): string | undefined {
  try {
    const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    return /^DATABASE_URL=["']?([^"'\n]+?)["']?$/m.exec(env)?.[1]
  } catch {
    return undefined
  }
}

/** Физические таблицы тестовых датасетов (у каждого набора — свой префикс). */
export interface TestTables {
  incidents: string
  regions: string
  archive: string
  staff: string
}

export function testTables(prefix: string): TestTables {
  return {
    incidents: `ds.t_${prefix}_incidents`,
    regions: `ds.t_${prefix}_regions`,
    archive: `ds.t_${prefix}_archive`,
    staff: `ds.t_${prefix}_staff`,
  }
}

export function dropSql(t: TestTables): string {
  return `DROP TABLE IF EXISTS ${t.incidents}, ${t.regions}, ${t.archive}, ${t.staff}`
}

const SYSTEM = `_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  _ver integer NOT NULL DEFAULT 1,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  _deleted_at timestamptz,
  _import_id uuid`

/** Таблицы под поля датасетов fixtures.ts (столбцы c_N — по порядку полей). */
export function ddlSql(t: TestTables): string {
  return `
${dropSql(t)};
CREATE TABLE ${t.incidents} (${SYSTEM},
  c_1 text, c_2 text, c_3 numeric(18, 2), c_4 bigint, c_5 timestamptz, c_6 date, c_7 uuid,
  c_8 uuid, c_9 uuid, c_10 text[], c_11 extensions.geometry(Geometry, 4326), c_12 boolean,
  c_13 interval, c_14 double precision, c_15 text, c_16 time, c_17 jsonb,
  c_19 double precision, c_20 text, c_21 text, c_22 text);
CREATE TABLE ${t.regions} (${SYSTEM}, c_1 uuid, c_2 text, c_3 bigint);
CREATE TABLE ${t.archive} (${SYSTEM}, c_1 text, c_2 text, c_3 numeric(18, 2), c_4 timestamptz, c_5 date);
CREATE TABLE ${t.staff} (${SYSTEM},
  c_1 text, c_2 numeric(18, 2), c_3 text, c_4 text, c_5 date, c_6 uuid, c_7 text);
`
}

const point = (lon: number, lat: number) =>
  `extensions.ST_SetSRID(extensions.ST_MakePoint(${lon}, ${lat}), 4326)`

/** Происшествия: время — местное Душанбе (+05); строка 3 — 18 сентября по местному, 17-го по UTC. */
export function dataSql(t: TestTables): string {
  return `
INSERT INTO ${t.incidents} (_created_by, c_1, c_2, c_3, c_4, c_5, c_6, c_7, c_8, c_9, c_10, c_11, c_12,
  c_13, c_14, c_15, c_16, c_17, c_19, c_20, c_21, c_22) VALUES
('${USER_ID}', 'Пожар на складе', 'fire', 150000.50, 2, '2026-09-01 10:00+05', '2026-09-01', '${TERR_DU_1}',
  '${USER_ID}', '${UNIT_A}', '{urgent,night}', ${point(68.78, 38.56)}, true, '90 minutes', 0.5,
  '+992 900 123 456', '08:30', '{"level": 2}', 0.1, 'DU-001', 'a@gov.tj', 'учения не проводились'),
(NULL, 'Паводок', 'flood', 50000, 0, '2026-08-15 23:30+05', '2026-08-16', '${TERR_KH}',
  '${SUB_1}', '${UNIT_B}', '{urgent}', ${point(68.9, 37.9)}, false, '3 hours', 0.2,
  '+992 900 000 001', '23:30', '{"level": 1}', 0.2, 'KH-002', 'b@mail.tj', NULL),
(NULL, 'Пожар в доме', 'fire', 20000, 1, '2026-09-18 00:30+05', '2026-09-18', '${TERR_DU_2}',
  '${SUB_2}', '${UNIT_A}', '{}', ${point(68.8, 38.55)}, NULL, '45 minutes', NULL,
  '12', '12:00', NULL, 0.3, 'DU-003', 'c@gov.tj', 'Учения'),
(NULL, 'ДТП', 'accident', NULL, 3, '2025-12-31 23:59+05', '2025-12-31', '${TERR_DU}',
  NULL, NULL, NULL, NULL, true, NULL, 1.5, NULL, NULL, NULL, NULL, 'DU-004', NULL, ''),
('${USER_ID}', 'Пожар 50%_off', 'fire', 1000, 0, '2026-01-10 12:00+05', '2026-01-10', '${TERR_DU_1}',
  '${USER_ID}', '${UNIT_B}', '{night}', ${point(68.7, 38.6)}, true, '10 minutes', 0.9,
  NULL, '06:00', '{"level": 3}', 0.5, 'X-5', 'd@x.org', 'заметка'),
(NULL, 'Оползень', 'landslide', 750000, 5, '2026-09-10 08:00+05', '2026-09-10', '${TERR_KH}',
  '${SUB_1}', '${UNIT_B}', '{urgent,test}', ${point(69.5, 37.5)}, false, '2 hours', 0.05,
  '+992 111', '19:00', '{"level": 2}', 0.9, 'KH-006', 'e@gov.tj', NULL),
(NULL, 'Пожар, учения', 'fire', 0, 0, '2026-09-17 15:00+05', '2026-09-17', '${TERR_DU_2}',
  '${USER_ID}', '${UNIT_A}', '{test}', ${point(68.85, 38.58)}, true, '5 minutes', 0.3,
  NULL, '15:00', NULL, 0.0, 'DU-007', NULL, 'Учения по плану'),
(NULL, 'Наводнение', 'flood', 120000, 1, '2026-07-01 09:00+05', '2026-07-01', '${TERR_DU}',
  '${SUB_2}', '${UNIT_A}', '{}', NULL, NULL, '1 hour', 0.7, NULL, '09:00', '{"level": 1}', 0.4,
  'DU-008', 'f@gov.tj', NULL),
(NULL, 'Пожар в лесу', 'fire', 300000, 0, '2026-09-11 18:00+05', '2026-09-11', '${TERR_KH}',
  '${SUB_1}', '${UNIT_B}', '{night}', ${point(69.0, 37.8)}, false, '4 hours', 0.6, NULL, '18:00',
  NULL, 0.6, 'KH-009', NULL, NULL),
(NULL, 'Прочее', NULL, 10, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO ${t.incidents} (_deleted_at, c_1, c_2, c_3) VALUES (now(), 'Удалено', 'fire', 999999);
INSERT INTO ${t.regions} (c_1, c_2, c_3) VALUES
  ('${TERR_DU}', 'Душанбе', 1000000), ('${TERR_DU_1}', 'Сино', 400000),
  ('${TERR_DU_2}', 'Шохмансур', 300000), ('${TERR_KH}', 'Хатлон', 3000000);
INSERT INTO ${t.archive} (c_1, c_2, c_3, c_4, c_5) VALUES
  ('Архивный пожар', 'fire', 5000, '2020-05-01 10:00+05', '2020-05-01'),
  ('Архивный паводок', 'flood', 7000, '2019-04-01 10:00+05', '2019-04-01');
INSERT INTO ${t.staff} (c_1, c_2, c_3, c_4, c_5, c_6, c_7) VALUES
  ('Иван Петров', 123456.78, '+992 900 123 456', 'ivan@gov.tj', '2019-03-15', '${UNIT_A}', 'A1234567'),
  ('Мария', 0, '12', 'maria@mail.tj', '2021-07-01', '${UNIT_B}', 'B12');
`
}
