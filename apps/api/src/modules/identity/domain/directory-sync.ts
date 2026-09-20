import type {
  DirectoryChange,
  DirectorySettings,
  DirectorySyncMode,
  DirectorySyncRun,
  DirectorySyncStats,
  DirectoryTestResult,
} from '@kchs/contracts'
import { and, desc, eq, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx } from '~/shared/context.js'
import { actorId, systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { directorySyncs, orgUnits, positions, roles, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId, randomToken } from '~/shared/ids.js'
import { AuthProviders } from './auth-providers.js'
import {
  attributeValues as all,
  type DirectoryEntry,
  attributeValue as first,
  entryDisabled as isDisabled,
  LdapClient,
} from './ldap-client.js'
import { OrgService, UserService } from './user-service.js'

/**
 * Синхронизация каталога LDAP/AD (ADR-0098). Прогон всегда строит план
 * изменений и только потом применяет его: предпросмотр — тот же план без
 * записи, поэтому администратор видит ровно то, что произойдёт.
 *
 * Все изменения идут через `UserService`/`OrgService` — те же проверки, события
 * и аудит, что и у действий администратора вручную. Ошибка на одной записи не
 * отменяет прогон: она попадает в план со статусом `skip` и в счётчик `failed`.
 */

const KEEP_RUNS = 50

/** Сотрудник каталога после сопоставления полей. */
interface DirectoryPerson {
  externalId: string | null
  dn: string
  login: string
  email: string | null
  phone: string | null
  firstName: string
  lastName: string
  middleName: string | null
  unitKey: string | null
  positionName: string | null
  disabled: boolean
  roleKeys: string[]
}

/** Имя группы из DN: `CN=Аналитики,OU=Groups,…` → `аналитики`. */
function groupNames(dn: string): string[] {
  const lower = dn.toLowerCase().trim()
  const cn = /(?:^|,)\s*cn=([^,]+)/.exec(lower)?.[1]?.trim()
  return cn ? [lower, cn] : [lower]
}

/** Логин каталога в форму, которую принимает платформа: латиница, цифры, `. _ -`. */
function normalizeLogin(raw: string): string {
  const withoutDomain = raw.includes('@') ? (raw.split('@')[0] ?? raw) : raw
  const cleaned = withoutDomain.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64)
  return cleaned.toLowerCase()
}

/** Код подразделения из имени: «Отдел ГИС» → `ОТДЕЛ-ГИС`. */
function unitCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

function mapPerson(entry: DirectoryEntry, settings: DirectorySettings): DirectoryPerson | null {
  const map = settings.attributes
  const rawLogin = first(entry, map.login)
  if (!rawLogin) return null
  const login = normalizeLogin(rawLogin)
  if (login.length < 3) return null

  const displayName = first(entry, map.displayName) ?? ''
  const parts = displayName.split(/\s+/).filter(Boolean)
  const lastName = first(entry, map.lastName) ?? parts[0] ?? login
  const firstName = first(entry, map.firstName) ?? parts[1] ?? login

  const memberOf = all(entry, map.memberOf).flatMap(groupNames)
  const matched = settings.groupMappings
    .filter((mapping) => memberOf.includes(mapping.group.toLowerCase().trim()))
    .map((mapping) => mapping.roleKey)
  const roleKeys = matched.length > 0 ? [...new Set(matched)] : [...settings.defaultRoleKeys]

  const unitRaw = first(entry, map.unit)
  const email = first(entry, map.email)

  return {
    externalId: first(entry, map.externalId),
    dn: entry.dn,
    login,
    // Каталог иногда отдаёт логин вместо адреса: явно негодное значение не сохраняем
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    phone: first(entry, map.phone),
    firstName: firstName.slice(0, 100),
    lastName: lastName.slice(0, 100),
    middleName: first(entry, map.middleName)?.slice(0, 100) ?? null,
    unitKey: unitRaw ? unitCode(unitRaw) : null,
    positionName: first(entry, map.position),
    disabled: isDisabled(entry, map.disabled),
    roleKeys,
  }
}

function emptyStats(): DirectorySyncStats {
  return {
    scanned: 0,
    created: 0,
    updated: 0,
    blocked: 0,
    skipped: 0,
    unitsCreated: 0,
    unitsUpdated: 0,
    failed: 0,
  }
}

function change(
  kind: DirectoryChange['kind'],
  action: DirectoryChange['action'],
  login: string,
  title: string,
  fields: DirectoryChange['fields'] = [],
  reason: string | null = null,
): DirectoryChange {
  return { kind, action, login, title, fields, reason }
}

function field(
  name: string,
  from: unknown,
  to: unknown,
): { field: string; from: string; to: string } {
  return {
    field: name,
    from: from === null || from === undefined ? '' : String(from),
    to: to === null || to === undefined ? '' : String(to),
  }
}

/** Непригодный пароль для учётной записи каталога: вход идёт только через bind. */
function unusablePassword(): string {
  return `ldap-${randomToken(24)}-Aa1!`
}

export const DirectorySync = {
  /** Проверка соединения и фильтров без изменения данных. */
  async test(): Promise<DirectoryTestResult> {
    const started = Date.now()
    const { settings, bindPassword } = await AuthProviders.directory()
    try {
      const entries = await LdapClient.users(settings, bindPassword)
      const units = await LdapClient.units(settings, bindPassword)
      const people = entries
        .map((entry) => mapPerson(entry, settings))
        .filter((person): person is DirectoryPerson => person !== null)
      return {
        ok: true,
        error: null,
        users: people.length,
        units: units.length,
        sample: people.slice(0, 5).map((person) => person.login),
        elapsedMs: Date.now() - started,
      }
    } catch (error) {
      return {
        ok: false,
        // Текст ошибки библиотеки: пароль в него не попадает — мы его не передаём в сообщения
        error: error instanceof Error ? error.message.slice(0, 300) : 'неизвестная ошибка',
        users: 0,
        units: 0,
        sample: [],
        elapsedMs: Date.now() - started,
      }
    }
  },

  /** Предпросмотр: тот же план, что и у прогона, но ничего не записывается. */
  async preview(ctx: Ctx): Promise<DirectorySyncRun> {
    return runSync(ctx, 'preview')
  },

  async run(ctx: Ctx, mode: Exclude<DirectorySyncMode, 'preview'>): Promise<DirectorySyncRun> {
    return runSync(ctx, mode)
  },

  async history(limit: number): Promise<DirectorySyncRun[]> {
    const rows = await db()
      .select()
      .from(directorySyncs)
      .orderBy(desc(directorySyncs.startedAt))
      .limit(limit)
    return rows.map(toRun)
  },

  async lastRun(): Promise<DirectorySyncRun | null> {
    const [row] = await db()
      .select()
      .from(directorySyncs)
      .orderBy(desc(directorySyncs.startedAt))
      .limit(1)
    return row ? toRun(row) : null
  },

  /**
   * Пора ли синхронизироваться: расписание общее (раз в час), а интервал задаёт
   * администратор. Так один повторяемый job обслуживает любой интервал.
   */
  async due(): Promise<boolean> {
    const { enabled, settings } = await AuthProviders.directory()
    if (!enabled || !settings.url) return false
    const [row] = await db()
      .select({ startedAt: directorySyncs.startedAt })
      .from(directorySyncs)
      .where(sql`${directorySyncs.mode} <> 'preview'`)
      .orderBy(desc(directorySyncs.startedAt))
      .limit(1)
    if (!row) return true
    return Date.now() - new Date(row.startedAt).getTime() >= settings.syncIntervalMinutes * 60_000
  },
}

function toRun(row: typeof directorySyncs.$inferSelect): DirectorySyncRun {
  return {
    id: row.id,
    mode: row.mode as DirectorySyncRun['mode'],
    status: row.status as DirectorySyncRun['status'],
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    stats: { ...emptyStats(), ...row.stats },
    error: row.error,
    initiatorId: row.initiatorId,
    changes: (row.changes ?? []) as DirectoryChange[],
  }
}

async function runSync(ctx: Ctx, mode: DirectorySyncMode): Promise<DirectorySyncRun> {
  const { enabled, settings, bindPassword } = await AuthProviders.directory()
  if (!enabled) throw errors.validation('Каталог не подключён')
  if (!settings.url || !settings.baseDn) {
    throw errors.validation('Не заданы адрес каталога или корень поиска')
  }

  const runId = newId()
  const initiatorId = actorId(ctx)
  await db().insert(directorySyncs).values({ id: runId, mode, status: 'running', initiatorId })

  const stats = emptyStats()
  const changes: DirectoryChange[] = []
  // Прогон идёт от имени системы: его записи в аудите не смешиваются с ручными
  // действиями администратора, а инициатор сохраняется отдельным полем
  const sys = systemCtx('directory.sync', { initiatorId })

  try {
    const entries = await LdapClient.users(settings, bindPassword)
    const unitEntries = await LdapClient.units(settings, bindPassword)
    const people: DirectoryPerson[] = []
    for (const entry of entries) {
      const person = mapPerson(entry, settings)
      if (person) people.push(person)
      else stats.skipped += 1
    }
    stats.scanned = people.length

    const unitIndex = await syncUnits(sys, mode, unitEntries, stats, changes)
    await syncPeople(sys, mode, settings, people, unitIndex, stats, changes)

    await finish(runId, 'succeeded', stats, changes, null)
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'неизвестная ошибка'
    await finish(runId, 'failed', stats, changes, message)
  }

  const [row] = await db()
    .select()
    .from(directorySyncs)
    .where(eq(directorySyncs.id, runId))
    .limit(1)
  const run = row ? toRun(row) : null
  if (!run) throw errors.internal('Прогон синхронизации не сохранён')

  await audit(ctx, {
    action: AUDIT_ACTIONS.directorySynced,
    severity: run.status === 'failed' ? 'warning' : 'notice',
    details: { runId, mode, status: run.status, stats: run.stats },
  })
  await db().transaction(async (tx) => {
    await publishEvent(tx, ctx, {
      type: 'directory.synced',
      payload: {
        runId,
        mode,
        status: run.status,
        created: run.stats.created,
        updated: run.stats.updated,
        blocked: run.stats.blocked,
      },
    })
  })
  await prune()
  return run
}

async function finish(
  runId: string,
  status: 'succeeded' | 'failed',
  stats: DirectorySyncStats,
  changes: DirectoryChange[],
  error: string | null,
): Promise<void> {
  await db()
    .update(directorySyncs)
    .set({ status, stats, changes, error, finishedAt: sql`now()` })
    .where(eq(directorySyncs.id, runId))
}

async function prune(): Promise<void> {
  await db().execute(sql`
    DELETE FROM directory_syncs
     WHERE id IN (
       SELECT id FROM directory_syncs ORDER BY started_at DESC OFFSET ${KEEP_RUNS}
     )`)
}

/** Подразделения каталога → справочник; возвращает индекс «код → id». */
async function syncUnits(
  ctx: Ctx,
  mode: DirectorySyncMode,
  entries: DirectoryEntry[],
  stats: DirectorySyncStats,
  changes: DirectoryChange[],
): Promise<Map<string, string>> {
  const existing = await db()
    .select({
      id: orgUnits.id,
      code: orgUnits.code,
      externalId: orgUnits.externalId,
      name: orgUnits.name,
    })
    .from(orgUnits)
  const byCode = new Map(existing.map((row) => [row.code.toUpperCase(), row.id]))
  const byExternal = new Map(
    existing.filter((row) => row.externalId).map((row) => [row.externalId as string, row]),
  )

  // Родитель — ближайшее подразделение каталога, чей DN является суффиксом
  const dns = entries.map((entry) => entry.dn.toLowerCase())
  const parentOf = (dn: string): string | null => {
    const lower = dn.toLowerCase()
    let best: string | null = null
    for (const candidate of dns) {
      if (candidate === lower || !lower.endsWith(`,${candidate}`)) continue
      if (best === null || candidate.length > best.length) best = candidate
    }
    return best
  }

  const createdIds = new Map<string, string>()
  for (const entry of entries) {
    const rawName = first(entry, 'ou') ?? first(entry, 'name')
    if (!rawName) continue
    const code = unitCode(rawName)
    if (!code) continue
    const description = first(entry, 'description') ?? rawName

    const known = byExternal.get(entry.dn) ?? null
    const existingId = known?.id ?? byCode.get(code) ?? null
    const parentDn = parentOf(entry.dn)
    const parentId = parentDn ? (createdIds.get(parentDn) ?? null) : null

    if (existingId) {
      if (known && known.name.ru === description && known.code.toUpperCase() === code) {
        createdIds.set(entry.dn.toLowerCase(), existingId)
        byCode.set(code, existingId)
        continue
      }
      changes.push(
        change('unit', 'update', code, description, [
          field('name', known?.name.ru ?? '', description),
        ]),
      )
      if (mode !== 'preview') {
        await db().transaction(async (tx) => {
          await OrgService.updateUnit(tx, ctx, existingId, { name: { ru: description } })
          await tx.update(orgUnits).set({ externalId: entry.dn }).where(eq(orgUnits.id, existingId))
        })
        stats.unitsUpdated += 1
      }
      createdIds.set(entry.dn.toLowerCase(), existingId)
      byCode.set(code, existingId)
      continue
    }

    changes.push(change('unit', 'create', code, description))
    if (mode === 'preview') {
      stats.unitsCreated += 1
      continue
    }
    const id = await db().transaction(async (tx) => {
      const created = await OrgService.createUnit(tx, ctx, {
        parentId,
        code,
        name: { ru: description },
        kind: 'department',
        sort: 0,
        isActive: true,
        createSpace: false,
      })
      await tx.update(orgUnits).set({ externalId: entry.dn }).where(eq(orgUnits.id, created))
      return created
    })
    stats.unitsCreated += 1
    createdIds.set(entry.dn.toLowerCase(), id)
    byCode.set(code, id)
  }

  return byCode
}

/**
 * Должности каталога: справочник платформы хранит их отдельными записями, а
 * каталог — строкой. Недостающие должности заводятся по ходу синхронизации.
 */
async function positionIndex(
  mode: DirectorySyncMode,
  names: string[],
): Promise<Map<string, string>> {
  const rows = await db().select({ id: positions.id, name: positions.name }).from(positions)
  const index = new Map(rows.map((row) => [row.name.ru.trim().toLowerCase(), row.id]))
  if (mode === 'preview') return index
  for (const name of new Set(names.map((value) => value.trim()).filter(Boolean))) {
    const key = name.toLowerCase()
    if (index.has(key)) continue
    const id = newId()
    await db()
      .insert(positions)
      .values({ id, name: { ru: name }, rank: 0 })
    index.set(key, id)
  }
  return index
}

async function syncPeople(
  ctx: Ctx,
  mode: DirectorySyncMode,
  settings: DirectorySettings,
  people: DirectoryPerson[],
  units: Map<string, string>,
  stats: DirectorySyncStats,
  changes: DirectoryChange[],
): Promise<void> {
  const knownRoles = new Set((await db().select({ key: roles.key }).from(roles)).map((r) => r.key))
  const jobs = await positionIndex(
    mode,
    people.map((person) => person.positionName ?? '').filter(Boolean),
  )
  const existing = await db()
    .select({
      id: users.id,
      login: users.login,
      email: users.email,
      phone: users.phone,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      status: users.status,
      authSource: users.authSource,
      directoryId: users.directoryId,
      directoryDn: users.directoryDn,
    })
    .from(users)
  const byDirectoryId = new Map(
    existing.filter((row) => row.directoryId).map((row) => [row.directoryId as string, row]),
  )
  const byLogin = new Map(existing.map((row) => [row.login.toLowerCase(), row]))

  const seen = new Set<string>()

  for (const person of people) {
    const match =
      (person.externalId ? byDirectoryId.get(person.externalId) : undefined) ??
      byLogin.get(person.login)
    const roleKeys = person.roleKeys.filter((key) => knownRoles.has(key))
    const unitId = person.unitKey ? (units.get(person.unitKey) ?? null) : null
    const positionId = person.positionName
      ? (jobs.get(person.positionName.trim().toLowerCase()) ?? null)
      : null
    const title = [person.lastName, person.firstName, person.middleName].filter(Boolean).join(' ')

    if (match) seen.add(match.id)

    if (!match) {
      changes.push(
        change('user', 'create', person.login, title, [
          field('email', '', person.email),
          field('roles', '', roleKeys.join(', ')),
        ]),
      )
      if (mode === 'preview') {
        stats.created += 1
        continue
      }
      try {
        await db().transaction(async (tx) => {
          const { id } = await UserService.create(tx, ctx, {
            login: person.login,
            email: person.email,
            phone: person.phone,
            lastName: person.lastName,
            firstName: person.firstName,
            middleName: person.middleName,
            unitId,
            positionId,
            roleKeys: roleKeys.length > 0 ? roleKeys : ['employee'],
            // Локального пароля у сотрудника каталога нет: вход — bind в каталоге
            password: unusablePassword(),
            mustChangePassword: false,
            locale: 'ru',
            timezone: 'Asia/Dushanbe',
          })
          await tx
            .update(users)
            .set({
              authSource: 'ldap',
              directoryId: person.externalId,
              directoryDn: person.dn,
              directorySyncedAt: sql`now()`,
              status: person.disabled ? 'blocked' : 'active',
            })
            .where(eq(users.id, id))
        })
        stats.created += 1
      } catch (error) {
        stats.failed += 1
        changes.pop()
        changes.push(change('user', 'skip', person.login, title, [], reasonOf(error)))
      }
      continue
    }

    // Локальная учётная запись, совпавшая по логину, каталогу не отдаётся:
    // иначе каталог перехватил бы вход администратора установки
    if (match.authSource === 'local' && !match.directoryId) {
      stats.skipped += 1
      changes.push(
        change(
          'user',
          'skip',
          person.login,
          title,
          [],
          'локальная учётная запись с тем же логином',
        ),
      )
      continue
    }

    const diff: DirectoryChange['fields'] = []
    if (match.email !== person.email) diff.push(field('email', match.email, person.email))
    if (match.phone !== person.phone) diff.push(field('phone', match.phone, person.phone))
    if (match.lastName !== person.lastName) {
      diff.push(field('lastName', match.lastName, person.lastName))
    }
    if (match.firstName !== person.firstName) {
      diff.push(field('firstName', match.firstName, person.firstName))
    }
    if (match.middleName !== person.middleName) {
      diff.push(field('middleName', match.middleName, person.middleName))
    }
    const wantStatus = person.disabled ? 'blocked' : 'active'
    if (match.status !== wantStatus) diff.push(field('status', match.status, wantStatus))
    if (match.directoryDn !== person.dn) diff.push(field('dn', match.directoryDn, person.dn))

    if (diff.length === 0) {
      if (mode !== 'preview') {
        await db()
          .update(users)
          .set({ directorySyncedAt: sql`now()` })
          .where(eq(users.id, match.id))
      }
      continue
    }

    const action = person.disabled && match.status !== 'blocked' ? 'block' : 'update'
    changes.push(change('user', action, person.login, title, diff))
    if (mode === 'preview') {
      if (action === 'block') stats.blocked += 1
      else stats.updated += 1
      continue
    }
    try {
      await db().transaction(async (tx) => {
        await UserService.patch(tx, ctx, match.id, {
          email: person.email,
          phone: person.phone,
          lastName: person.lastName,
          firstName: person.firstName,
          middleName: person.middleName,
          status: wantStatus,
          roleKeys: roleKeys.length > 0 ? roleKeys : undefined,
          ...(unitId ? { unitId, positionId } : {}),
        })
        await tx
          .update(users)
          .set({
            authSource: 'ldap',
            directoryId: person.externalId ?? match.directoryId,
            directoryDn: person.dn,
            directorySyncedAt: sql`now()`,
          })
          .where(eq(users.id, match.id))
      })
      if (action === 'block') stats.blocked += 1
      else stats.updated += 1
    } catch (error) {
      stats.failed += 1
      changes.pop()
      changes.push(change('user', 'skip', person.login, title, [], reasonOf(error)))
    }
  }

  if (settings.onMissing === 'ignore') return
  await blockMissing(ctx, mode, seen, stats, changes)
}

/** Сотрудник каталога, которого каталог больше не отдаёт, — уволен. */
async function blockMissing(
  ctx: Ctx,
  mode: DirectorySyncMode,
  seen: Set<string>,
  stats: DirectorySyncStats,
  changes: DirectoryChange[],
): Promise<void> {
  const rows = await db()
    .select({ id: users.id, login: users.login, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.authSource, 'ldap'), eq(users.status, 'active')))
  const missing = rows.filter((row) => !seen.has(row.id))

  for (const row of missing) {
    changes.push(
      change(
        'user',
        'block',
        row.login,
        row.displayName,
        [field('status', 'active', 'blocked')],
        'нет в каталоге',
      ),
    )
    if (mode === 'preview') {
      stats.blocked += 1
      continue
    }
    try {
      await db().transaction((tx) => UserService.patch(tx, ctx, row.id, { status: 'blocked' }))
      stats.blocked += 1
    } catch (error) {
      stats.failed += 1
      changes.pop()
      changes.push(change('user', 'skip', row.login, row.displayName, [], reasonOf(error)))
    }
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'ошибка'
}
