import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { type SystemCtx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { employments, objects, orgUnits, spaces, users } from '~/shared/db/schema/index.js'

/**
 * Предметный пакет «Чрезвычайные ситуации» (P5-E08, ADR-0128): конфигурация и данные
 * поверх платформы, без своего кода в модулях. Каждый объект пакета помечен устойчивым
 * ключом `meta.packKey` (показатели и дашборды — `meta.systemKey`), по нему повторная
 * установка находит уже созданное и ничего не дублирует.
 */
export const PACK = 'emergency'

export const packKey = (key: string) => `${PACK}.${key}`

/** Пространство пакета: обстановка, сообщения, сводки, дежурство, заседания штаба. */
export const PACK_SPACE_KEY = 'emergency'

export interface PackContext {
  /** Системный контекст с инициатором — владельцем объектов пакета. */
  ctx: SystemCtx
  /** Тот же администратор как пользователь: сервисам, которым нужен UserCtx. */
  user: UserCtx
  adminId: string
  /**
   * Установка демо-мира (профиль `demo`): участники и состав групп из демо-людей,
   * назначения регионам, руководители в правилах, синтетические строки. Чистая
   * установка (`minimal`) получает те же объекты пустыми — их наполняет администратор.
   */
  demo: boolean
  /** «Общее» — реестры общего пользования, в нём же демо-датасеты генератора. */
  orgSpaceId: string
  /** Пространство пакета «Оперативный штаб ЧС» — заполняется шагом структуры. */
  spaceId: string
  log: (message: string, details?: Record<string, unknown>) => void
}

/**
 * «Общее» — пространство всей организации (вид `org`): его заводит демо-сид, а на
 * чистой установке (`kchs init`, профиль `minimal`) его ещё нет — пакет создаёт его сам
 * с тем же ключом, чтобы общие реестры происшествий и зон риска видели все сотрудники.
 */
async function ensureOrgSpace(ctx: SystemCtx, ownerId: string): Promise<string> {
  const [org] = await db()
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.key, 'org'))
    .limit(1)
  if (org) return org.id
  return db().transaction((tx) =>
    SpaceService.create(tx, ctx, {
      key: 'org',
      name: 'Общее',
      kind: 'org',
      description: 'Справочники, регламенты, общие материалы',
      ownerId,
    }),
  )
}

export async function packContext(
  adminLogin: string,
  options: { demo: boolean },
  log: PackContext['log'],
): Promise<Omit<PackContext, 'spaceId'>> {
  const [admin] = await db()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.login}) = ${adminLogin.toLowerCase()}`)
    .limit(1)
  if (!admin) throw new Error(`Нет администратора «${adminLogin}» — сначала kchs init или db:seed`)
  const user = await buildUserCtxFor(admin.id)
  if (!user) throw new Error('Администратор недоступен как пользователь')
  const ctx = systemCtx('seed.emergency', { initiatorId: admin.id })
  return {
    ctx,
    user,
    adminId: admin.id,
    demo: options.demo,
    orgSpaceId: await ensureOrgSpace(ctx, admin.id),
    log,
  }
}

/** Объект пакета по устойчивому ключу; удалённые не считаются. */
export async function findPackObject(
  type: string,
  key: string,
  database: Executor = db(),
): Promise<string | null> {
  const [row] = await database
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.type, type as typeof objects.$inferSelect.type),
        isNull(objects.deletedAt),
        sql`coalesce(${objects.meta}->>'packKey', ${objects.meta}->>'systemKey') = ${packKey(key)}`,
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/** Пометить созданный объект ключом пакета — без события: это служебная метка. */
export async function markPackObject(
  tx: Executor,
  ctx: SystemCtx,
  id: string,
  key: string,
): Promise<void> {
  await ObjectService.update(
    tx,
    ctx,
    id,
    { meta: { packKey: packKey(key) }, mergeMeta: true },
    { silent: true },
  )
}

/** Подразделение демо-оргструктуры по коду. */
export async function unitId(code: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(eq(orgUnits.code, code))
    .limit(1)
  return row?.id ?? null
}

/** Руководитель подразделения по коду. */
export async function headOf(code: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: orgUnits.headUserId })
    .from(orgUnits)
    .where(eq(orgUnits.code, code))
    .limit(1)
  return row?.id ?? null
}

/**
 * Активные сотрудники подразделений (основное место работы) — по кодам или префиксам
 * кодов (`RG-` — все региональные управления); руководителей можно исключить.
 */
export async function staffOf(
  codes: readonly string[],
  options: { prefix?: boolean; heads?: boolean } = {},
): Promise<string[]> {
  const units = await db()
    .select({ id: orgUnits.id, code: orgUnits.code, head: orgUnits.headUserId })
    .from(orgUnits)
  const wanted = units.filter((unit) =>
    codes.some((code) => (options.prefix ? unit.code.startsWith(code) : unit.code === code)),
  )
  if (wanted.length === 0) return []
  const heads = new Set(wanted.map((unit) => unit.head).filter(Boolean))
  const rows = await db()
    .select({ id: users.id })
    .from(users)
    .innerJoin(employments, eq(employments.userId, users.id))
    .where(
      and(
        inArray(
          employments.unitId,
          wanted.map((unit) => unit.id),
        ),
        eq(employments.isPrimary, true),
        eq(users.status, 'active'),
      ),
    )
    .orderBy(users.login)
  const ids = [...new Set(rows.map((row) => row.id))]
  return options.heads === false ? ids.filter((id) => !heads.has(id)) : ids
}
