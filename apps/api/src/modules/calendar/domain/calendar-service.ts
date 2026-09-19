import {
  atLeast,
  type CalendarColor,
  type CalendarCreateInput,
  type CalendarKind,
  type CalendarListQuery,
  type CalendarPermissions,
  type CalendarRecord,
  type CalendarSettings,
  type CalendarUpdateInput,
  type Level,
  type ResourceInfo,
} from '@kchs/contracts'
import { and, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize, loadObject, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { UserService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { encryptSecret } from '~/shared/crypto/secrets.js'
import { db, type Executor } from '~/shared/db/client.js'
import { calendars, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { calendarSettings } from './settings.js'

/** Цвет нового календаря по виду. */
const DEFAULT_COLOR: Record<CalendarKind, CalendarColor> = {
  personal: 'blue',
  team: 'green',
  project: 'purple',
  resource: 'slate',
  subscription: 'orange',
}

/** Задание синхронизации подписки (очередь `automation` — исполнитель воркер). */
export const CALENDAR_SYNC_JOB = { queue: 'automation', name: 'calendar.sync' } as const

const COLUMNS = {
  id: calendars.id,
  kind: calendars.kind,
  ownerId: calendars.ownerId,
  color: calendars.color,
  timezone: calendars.timezone,
  description: calendars.description,
  systemKey: calendars.systemKey,
  projectId: calendars.projectId,
  resource: calendars.resource,
  sourceHost: calendars.sourceHost,
  syncStatus: calendars.syncStatus,
  syncedAt: calendars.syncedAt,
  syncError: calendars.syncError,
  title: objects.title,
  spaceId: objects.spaceId,
  parentId: objects.parentId,
  accessMode: objects.accessMode,
  archivedAt: objects.archivedAt,
  updatedAt: objects.updatedAt,
}

export function selectCalendars(executor: Executor) {
  return executor.select(COLUMNS).from(calendars).innerJoin(objects, eq(objects.id, calendars.id))
}

export type CalendarRow = Awaited<ReturnType<typeof selectCalendars>>[number]

const alive = sql`${objects.deletedAt} IS NULL`

export async function loadCalendar(executor: Executor, id: string): Promise<CalendarRow | null> {
  const [row] = await selectCalendars(executor)
    .where(and(eq(calendars.id, id), alive))
    .limit(1)
  return row ?? null
}

/** Кто действует: заместитель работает с календарём того, кого замещает. */
export function principalUser(ctx: UserCtx): string {
  return ctx.onBehalfOf ?? ctx.userId
}

export function permissionsOf(kind: string, level: Level): CalendarPermissions {
  const own = kind !== 'resource' && kind !== 'subscription'
  return {
    edit: own && atLeast(level, 'edit'),
    manage: atLeast(level, 'manage'),
    book: kind === 'resource' && atLeast(level, 'view'),
    feed: atLeast(level, 'view'),
  }
}

/** Адрес подписки: http(s) или webcal (читается как https). */
function subscriptionUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'))
  } catch {
    throw errors.validation('Адрес календаря записан неверно', [
      { path: 'url', message: 'Адрес календаря записан неверно' },
    ])
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw errors.validation('Подписка — только по адресу http(s) или webcal', [
      { path: 'url', message: 'Адрес должен начинаться с https://, http:// или webcal://' },
    ])
  }
  if (url.username || url.password) {
    throw errors.validation('Адрес с логином и паролем не поддерживается', [
      { path: 'url', message: 'Адрес с логином и паролем не поддерживается' },
    ])
  }
  return url
}

/** Сериализуемая блокировка создания автоматического календаря по ключу. */
async function lockKey(tx: Executor, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar:${key}`}))`)
}

async function bySystemKey(executor: Executor, key: string): Promise<string | null> {
  const [row] = await executor
    .select({ id: calendars.id })
    .from(calendars)
    .innerJoin(objects, eq(objects.id, calendars.id))
    .where(and(eq(calendars.systemKey, key), alive))
    .limit(1)
  return row?.id ?? null
}

export const CalendarService = {
  /**
   * Личный календарь пользователя — создаётся при первом обращении в его
   * личном пространстве; владелец — сам пользователь.
   */
  async ensurePersonal(tx: Executor, ctx: Ctx, userId: string): Promise<string> {
    const key = `personal:${userId}`
    const existing = await bySystemKey(tx, key)
    if (existing) return existing
    await lockKey(tx, key)
    const again = await bySystemKey(tx, key)
    if (again) return again

    const profile = await UserService.profile(userId)
    if (!profile) throw errors.notFound('Сотрудник')
    const spaceId = await SpaceService.ensurePersonal(tx, ctx, userId, profile.displayName)
    const object = await ObjectService.create(tx, ctx, {
      type: 'calendar',
      spaceId,
      title: profile.displayName,
      ownerId: userId,
      meta: { kind: 'personal' },
    })
    await tx.insert(calendars).values({
      id: object.id,
      kind: 'personal',
      ownerId: userId,
      color: DEFAULT_COLOR.personal,
      timezone: profile.timezone,
      systemKey: key,
    })
    await publishEvent(tx, ctx, {
      type: 'calendar.created',
      object: { id: object.id, type: 'calendar', spaceId, title: profile.displayName },
      payload: { kind: 'personal' },
    })
    return object.id
  },

  /** Личный календарь без записи, если он уже есть (чтение не открывает транзакцию). */
  async personalId(userId: string): Promise<string | null> {
    return bySystemKey(db(), `personal:${userId}`)
  },

  /** Календарь пространства подразделения — создаётся автоматически, права — от ролей пространства. */
  async ensureSpaceCalendar(tx: Executor, ctx: Ctx, spaceId: string): Promise<string | null> {
    const key = `space:${spaceId}`
    const existing = await bySystemKey(tx, key)
    if (existing) return existing
    const space = await loadObject(spaceId, tx)
    if (space?.type !== 'space' || space.deletedAt) return null
    await lockKey(tx, key)
    const again = await bySystemKey(tx, key)
    if (again) return again

    const object = await ObjectService.create(tx, ctx, {
      type: 'calendar',
      spaceId,
      title: space.title,
      ownerId: null,
      meta: { kind: 'team' },
    })
    await tx.insert(calendars).values({
      id: object.id,
      kind: 'team',
      color: DEFAULT_COLOR.team,
      timezone: config().TZ,
      systemKey: key,
    })
    await publishEvent(tx, ctx, {
      type: 'calendar.created',
      object: { id: object.id, type: 'calendar', spaceId, title: space.title },
      payload: { kind: 'team' },
    })
    return object.id
  },

  async create(tx: Executor, ctx: UserCtx, input: CalendarCreateInput): Promise<string> {
    const me = principalUser(ctx)
    const profile = await UserService.profile(me)
    const timezone = input.timezone ?? profile?.timezone ?? config().TZ
    const color = input.color ?? DEFAULT_COLOR[input.kind]
    const description = input.description?.trim() || null

    let spaceId: string
    let parentId: string | null = null
    let title = input.title?.trim() ?? ''
    let ownerId: string | null = me
    let systemKey: string | null = null
    let resource: ResourceInfo | null = null
    let everyone = false
    let source: { enc: Buffer; host: string } | null = null

    switch (input.kind) {
      case 'team': {
        await authorize(ctx, 'create_child', input.spaceId ?? '')
        spaceId = input.spaceId ?? ''
        break
      }
      case 'project': {
        const project = await loadObject(input.projectId ?? '', tx)
        if (project?.type !== 'project' || project.deletedAt) {
          throw errors.notFound('Проект')
        }
        await authorize(ctx, 'manage', project.id)
        systemKey = `project:${project.id}`
        if (await bySystemKey(tx, systemKey)) {
          throw errors.conflict('У проекта уже есть календарь')
        }
        spaceId = project.spaceId ?? ''
        parentId = project.id
        title = title || project.title
        break
      }
      case 'resource': {
        const space = await loadObject(input.spaceId ?? '', tx)
        if (space?.type !== 'space') throw errors.notFound('Пространство')
        await authorize(ctx, 'manage', space.id)
        spaceId = space.id
        ownerId = null
        resource = input.resource ?? { kind: 'room', location: null, capacity: null }
        // Ресурсы «Общего» пространства видят и бронируют все сотрудники
        everyone = space.meta.kind === 'org'
        break
      }
      case 'subscription': {
        const url = subscriptionUrl(input.url ?? '')
        spaceId = await SpaceService.ensurePersonal(tx, ctx, me, '')
        source = { enc: encryptSecret(url.toString()), host: url.host }
        title = title || url.host
        break
      }
    }
    if (!spaceId) throw errors.validation('Не указано пространство календаря')

    const object = await ObjectService.create(tx, ctx, {
      type: 'calendar',
      spaceId,
      parentId,
      title,
      subtitle: description,
      ownerId,
      meta: { kind: input.kind },
    })
    await tx.insert(calendars).values({
      id: object.id,
      kind: input.kind,
      ownerId,
      color,
      timezone,
      description,
      systemKey,
      projectId: input.kind === 'project' ? parentId : null,
      resource,
      sourceEnc: source?.enc ?? null,
      sourceHost: source?.host ?? null,
      syncStatus: source ? 'pending' : null,
    })
    if (everyone) {
      await grantAccess(
        tx,
        ctx,
        object.id,
        [{ principal: { type: 'everyone', id: '*' }, level: 'view' }],
        { quiet: true },
      )
    }
    await publishEvent(tx, ctx, {
      type: 'calendar.created',
      object: { id: object.id, type: 'calendar', spaceId, title },
      payload: { kind: input.kind },
    })
    if (source) {
      await JobService.schedule(tx, ctx, {
        ...CALENDAR_SYNC_JOB,
        data: { calendarId: object.id },
        objectId: object.id,
        idempotencyKey: `calendar.sync:${object.id}:created`,
      })
    }
    return object.id
  },

  async update(tx: Executor, ctx: UserCtx, id: string, patch: CalendarUpdateInput): Promise<void> {
    await authorize(ctx, 'manage', id)
    const row = await loadCalendar(tx, id)
    if (!row) throw errors.notFound('Календарь')
    const changed: string[] = []
    const values: Partial<typeof calendars.$inferInsert> = {}
    if (patch.color !== undefined && patch.color !== row.color) {
      values.color = patch.color
      changed.push('color')
    }
    if (patch.timezone !== undefined && patch.timezone !== row.timezone) {
      values.timezone = patch.timezone
      changed.push('timezone')
    }
    if (patch.description !== undefined && (patch.description || null) !== row.description) {
      values.description = patch.description || null
      changed.push('description')
    }
    if (patch.resource !== undefined && row.kind === 'resource') {
      values.resource = patch.resource
      changed.push('resource')
    }
    if (Object.keys(values).length > 0) {
      await tx.update(calendars).set(values).where(eq(calendars.id, id))
    }
    if (patch.title !== undefined && patch.title !== row.title) {
      await ObjectService.update(tx, ctx, id, { title: patch.title }, { silent: true })
      changed.push('title')
    }
    if (patch.description !== undefined) {
      await ObjectService.update(
        tx,
        ctx,
        id,
        { subtitle: patch.description || null },
        { silent: true },
      )
    }
    if (changed.length === 0) return
    await publishEvent(tx, ctx, {
      type: 'calendar.updated',
      object: { id, type: 'calendar', spaceId: row.spaceId, title: patch.title ?? row.title },
      payload: { changed },
    })
  },

  async get(ctx: UserCtx, id: string): Promise<CalendarRecord> {
    const decision = await authorize(ctx, 'view', id)
    const row = await loadCalendar(db(), id)
    if (!row) throw errors.notFound('Календарь')
    const settings = await calendarSettings(principalUser(ctx))
    const [record] = await recordsOf(ctx, [{ row, level: decision.level }], settings)
    if (!record) throw errors.notFound('Календарь')
    return record
  },

  /**
   * Мой список: личный календарь, календари пространств, где я участник,
   * проектные календари этих пространств, ресурсы и добавленные вручную.
   * `available` — все видимые мне календари вне списка (для добавления).
   */
  async list(ctx: UserCtx, query: CalendarListQuery): Promise<CalendarRecord[]> {
    const me = principalUser(ctx)
    if (query.scope === 'mine') {
      if (!(await CalendarService.personalId(me))) {
        await db().transaction((tx) => CalendarService.ensurePersonal(tx, ctx, me))
      }
    }
    const settings = await calendarSettings(me)
    const spaceIds = Object.keys(ctx.principals.spaceRoles)
    const listed: SQL = or(
      eq(calendars.ownerId, me),
      and(
        inArray(calendars.kind, ['team', 'project']),
        spaceIds.length > 0 ? inArray(objects.spaceId, spaceIds) : sql`false`,
      ),
      eq(calendars.kind, 'resource'),
      settings.addedCalendarIds.length > 0
        ? inArray(calendars.id, settings.addedCalendarIds)
        : sql`false`,
    ) as SQL
    const conditions: SQL[] = [
      alive,
      isNull(objects.archivedAt),
      visibleObjectsSql(ctx, 'calendar'),
      query.scope === 'mine' ? listed : sql`NOT (${listed})`,
    ]
    if (query.scope === 'available') {
      // Чужие личные календари в «доступных» — только те, что открыли мне явно
      // (администратор видит все объекты, но не выбирает из тысячи календарей)
      conditions.push(sql`(${calendars.kind} <> 'personal' OR ${objects.ownerId} = ${me})`)
    }
    if (query.kind) conditions.push(eq(calendars.kind, query.kind))
    const search = query.q?.trim()
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
      conditions.push(sql`${objects.title} ILIKE ${pattern}`)
    }
    const rows = await selectCalendars(db())
      .where(and(...conditions))
      .orderBy(objects.title)
      .limit(query.scope === 'mine' ? 300 : 50)
    const decided: Array<{ row: CalendarRow; level: Level }> = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'view', row.id, { soft: true })
      if (decision.allowed) decided.push({ row, level: decision.level })
    }
    return recordsOf(ctx, decided, settings)
  },

  /**
   * Календари выборки диапазона: заданные (видимые пользователю) или
   * отмеченные календари моего списка. Уровень — для прав правки событий.
   */
  async resolve(
    ctx: UserCtx,
    ids: string[] | null,
  ): Promise<Array<{ row: CalendarRow; level: Level }>> {
    if (ids === null) {
      const mine = await CalendarService.list(ctx, { scope: 'mine' })
      const shown = mine.filter((item) => item.shown)
      const rows = shown.length
        ? await selectCalendars(db()).where(
            and(
              inArray(
                calendars.id,
                shown.map((item) => item.id),
              ),
              alive,
            ),
          )
        : []
      const levels = new Map(shown.map((item) => [item.id, item.level]))
      return rows.map((row) => ({ row, level: levels.get(row.id) ?? 'view' }))
    }
    const unique = [...new Set(ids)].slice(0, 100)
    if (unique.length === 0) return []
    const rows = await selectCalendars(db()).where(and(inArray(calendars.id, unique), alive))
    const result: Array<{ row: CalendarRow; level: Level }> = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'view', row.id, { soft: true })
      if (decision.allowed) result.push({ row, level: decision.level })
    }
    return result
  },
}

async function recordsOf(
  ctx: UserCtx,
  items: Array<{ row: CalendarRow; level: Level }>,
  settings: CalendarSettings,
): Promise<CalendarRecord[]> {
  const me = principalUser(ctx)
  const ownerIds = [
    ...new Set(items.map((item) => item.row.ownerId).filter((id): id is string => Boolean(id))),
  ]
  const spaceIds = [
    ...new Set(items.map((item) => item.row.spaceId).filter((id): id is string => Boolean(id))),
  ]
  const [owners, spaces] = await Promise.all([
    directory().refs(ownerIds),
    ObjectService.summaries(spaceIds),
  ])
  const added = new Set(settings.addedCalendarIds)
  return items.map(({ row, level }) => {
    const mine = row.kind === 'personal' && row.ownerId === me
    const explicit = settings.shown[row.id]
    return {
      id: row.id,
      kind: row.kind as CalendarKind,
      title: row.title,
      description: row.description,
      color: row.color as CalendarColor,
      timezone: row.timezone,
      spaceId: row.spaceId,
      spaceName: row.spaceId ? (spaces.get(row.spaceId)?.title ?? null) : null,
      owner: row.ownerId ? (owners.get(row.ownerId) ?? null) : null,
      projectId: row.projectId,
      resource: (row.resource as ResourceInfo | null) ?? null,
      subscription:
        row.kind === 'subscription'
          ? {
              host: row.sourceHost ?? '',
              status: (row.syncStatus as 'pending' | 'ok' | 'error' | null) ?? 'pending',
              syncedAt: row.syncedAt,
              error: row.syncError,
            }
          : null,
      mine,
      added: added.has(row.id),
      shown: explicit ?? row.kind !== 'resource',
      level,
      can: permissionsOf(row.kind, level),
      updatedAt: row.updatedAt,
    }
  })
}
