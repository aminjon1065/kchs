import { eq, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { bumpPrincipalsVersion } from '~/kernel/access/principal-set.js'
import { DiscussionService } from '~/kernel/discussions/service.js'
import { reindexAll } from '~/kernel/search/index-service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { FileService } from '~/modules/files/domain/file-service.js'
import { OrgService, UserService } from '~/modules/identity/public.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { orgUnits, positions, spaceMembers, users } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import {
  FEMALE_FIRST_NAMES,
  FIRST_NAMES,
  LAST_NAMES,
  MIDDLE_NAMES,
  ORG_TREE,
  POSITIONS,
  type SeedUnit,
  SPACES,
} from './data.js'

export interface SeedOptions {
  profile: 'minimal' | 'demo'
  adminLogin: string
  adminPassword: string
  employeePassword: string
}

/** Детерминированный генератор: один и тот же seed даёт одинаковые данные. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

export async function runSeed(
  options: SeedOptions,
): Promise<{ users: number; units: number; spaces: number }> {
  const log = logger().child({ module: 'seed' })
  const ctx = systemCtx('seed')
  const random = makeRandom(20_260_917)

  const existing = await db().select({ id: users.id }).from(users).limit(1)
  if (existing.length > 0) {
    log.warn('данные уже существуют — seed пропущен (используйте db:reset)')
    return { users: 0, units: 0, spaces: 0 }
  }

  // ── Должности ──────────────────────────────────────────────────────────────
  const positionIds = new Map<string, string>()
  for (const position of POSITIONS) {
    const id = newId()
    await db().insert(positions).values({ id, name: position.name, rank: position.rank })
    positionIds.set(position.key, id)
  }

  // ── Администратор ─────────────────────────────────────────────────────────
  const admin = await db().transaction((tx) =>
    UserService.create(tx, ctx, {
      login: options.adminLogin,
      email: `${options.adminLogin}@kchs.local`,
      lastName: 'Системный',
      firstName: 'Администратор',
      roleKeys: ['system_admin'],
      password: options.adminPassword,
      mustChangePassword: false,
      locale: 'ru',
      timezone: 'Asia/Dushanbe',
    }),
  )
  const adminCtx = systemCtx('seed', { initiatorId: admin.id })
  log.info({ login: options.adminLogin }, 'администратор создан')

  // ── Оргструктура ──────────────────────────────────────────────────────────
  const unitIds = new Map<string, string>()
  const createUnit = async (unit: SeedUnit, parentId: string | null): Promise<void> => {
    const id = await db().transaction((tx) =>
      OrgService.createUnit(tx, adminCtx, {
        parentId,
        code: unit.code,
        name: { ru: unit.name.ru, tg: unit.name.tg, en: unit.name.en },
        kind: unit.kind,
        sort: 0,
        isActive: true,
        createSpace: unit.kind !== 'committee',
      }),
    )
    unitIds.set(unit.code, id)
    for (const child of unit.children ?? []) await createUnit(child, id)
  }
  await createUnit(ORG_TREE, null)
  log.info({ units: unitIds.size }, 'оргструктура создана')

  if (options.profile === 'minimal') {
    await bumpPrincipalsVersion()
    return { users: 1, units: unitIds.size, spaces: 0 }
  }

  // ── Сотрудники ────────────────────────────────────────────────────────────
  const unitCodes = [...unitIds.keys()].filter((c) => c !== 'HQ')
  const created: Array<{ id: string; unitCode: string; positionKey: string; displayName: string }> =
    []
  let index = 0

  const makeName = (): { last: string; first: string; middle: string | null } => {
    const isFemale = random() < 0.35
    const last = LAST_NAMES[Math.floor(random() * LAST_NAMES.length)]!
    const first = isFemale
      ? FEMALE_FIRST_NAMES[Math.floor(random() * FEMALE_FIRST_NAMES.length)]!
      : FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)]!
    const middle = isFemale ? null : MIDDLE_NAMES[Math.floor(random() * MIDDLE_NAMES.length)]!
    return { last: isFemale ? `${last}а` : last, first, middle }
  }

  const addUser = async (
    unitCode: string,
    positionKey: string,
    roleKeys: string[],
  ): Promise<string> => {
    index += 1
    const name = makeName()
    const login = `user${String(index).padStart(3, '0')}`
    const result = await db().transaction((tx) =>
      UserService.create(tx, adminCtx, {
        login,
        email: `${login}@kchs.local`,
        lastName: name.last,
        firstName: name.first,
        middleName: name.middle,
        unitId: unitIds.get(unitCode) ?? null,
        positionId: positionIds.get(positionKey) ?? null,
        roleKeys,
        password: options.employeePassword,
        mustChangePassword: false,
        locale: 'ru',
        timezone: 'Asia/Dushanbe',
      }),
    )
    created.push({
      id: result.id,
      unitCode,
      positionKey,
      displayName: [name.last, name.first, name.middle].filter(Boolean).join(' '),
    })
    return result.id
  }

  // Руководство
  const chairmanId = await addUser('HQ', 'chairman', ['employee'])
  await db().update(orgUnits).set({ headUserId: chairmanId }).where(eq(orgUnits.code, 'HQ'))

  // Начальники управлений и отделов
  const departmentCodes = ['UA', 'UO', 'UD', 'UT', 'RG']
  for (const code of departmentCodes) {
    const headId = await addUser(code, 'head_dept', ['employee'])
    await db().update(orgUnits).set({ headUserId: headId }).where(eq(orgUnits.code, code))
  }
  for (const code of unitCodes.filter((c) => c.includes('-'))) {
    const headId = await addUser(code, 'head_div', ['employee'])
    await db().update(orgUnits).set({ headUserId: headId }).where(eq(orgUnits.code, code))
  }

  // Специалисты
  const specialistPlan: Array<[string, string, string[]]> = [
    ['UA-DATA', 'analyst', ['employee', 'data_steward']],
    ['UA-DATA', 'gis_specialist', ['employee', 'gis_admin']],
    ['UA-MON', 'analyst', ['employee', 'data_steward']],
    ['UA-FORE', 'chief_spec', ['employee']],
    ['UO-DUTY', 'specialist', ['employee']],
    ['UO-DUTY', 'specialist', ['employee']],
    ['UO-RESC', 'lead_spec', ['employee']],
    ['UO-RES', 'specialist', ['employee']],
    ['UD-CANC', 'registrar', ['employee', 'registrar']],
    ['UD-CANC', 'registrar', ['employee', 'registrar']],
    ['UD-HR', 'specialist', ['employee', 'org_admin']],
    ['UD-LEGAL', 'lead_spec', ['employee']],
    ['UT-INFRA', 'chief_spec', ['employee']],
    ['UT-DEV', 'lead_spec', ['employee']],
    ['UT-SEC', 'chief_spec', ['employee', 'security_auditor']],
    ['RG-SUG', 'chief_spec', ['employee']],
    ['RG-KHA', 'chief_spec', ['employee']],
    ['RG-GBAO', 'specialist', ['employee']],
    ['RG-DRS', 'specialist', ['employee']],
  ]
  for (const [unitCode, positionKey, roleKeys] of specialistPlan) {
    await addUser(unitCode, positionKey, roleKeys)
  }
  // Добираем до 60 сотрудников
  while (created.length < 60) {
    const unitCode = unitCodes[Math.floor(random() * unitCodes.length)]!
    await addUser(unitCode, random() < 0.3 ? 'lead_spec' : 'specialist', ['employee'])
  }
  log.info({ users: created.length + 1 }, 'сотрудники созданы')

  // ── Пространства ──────────────────────────────────────────────────────────
  const spaceIds = new Map<string, string>()
  for (const space of SPACES) {
    const id = await db().transaction((tx) =>
      SpaceService.create(tx, adminCtx, {
        key: space.key,
        name: space.name,
        kind: space.kind,
        description: space.description,
        ownerId: chairmanId,
      }),
    )
    spaceIds.set(space.key, id)
  }

  // Все сотрудники — участники общего пространства
  const orgSpaceId = spaceIds.get('org')!
  await db()
    .insert(spaceMembers)
    .values(
      created.map((user) => ({ spaceId: orgSpaceId, userId: user.id, role: 'member' as const })),
    )
    .onConflictDoNothing()

  // Штаб паводка — аналитики, оперативники и руководство
  const floodSpaceId = spaceIds.get('flood-2026')!
  const floodMembers = created.filter(
    (u) =>
      u.unitCode.startsWith('UA') || u.unitCode.startsWith('UO') || u.positionKey === 'chairman',
  )
  await db()
    .insert(spaceMembers)
    .values(
      floodMembers.map((user) => ({
        spaceId: floodSpaceId,
        userId: user.id,
        role: user.positionKey === 'head_dept' ? ('admin' as const) : ('editor' as const),
      })),
    )
    .onConflictDoNothing()

  const mapSpaceId = spaceIds.get('digital-map')!
  const mapMembers = created.filter((u) => u.unitCode === 'UA-DATA' || u.unitCode.startsWith('UT'))
  await db()
    .insert(spaceMembers)
    .values(
      mapMembers.map((user) => ({ spaceId: mapSpaceId, userId: user.id, role: 'editor' as const })),
    )
    .onConflictDoNothing()

  log.info({ spaces: spaceIds.size }, 'пространства созданы')

  // ── Разделы и демонстрационное содержимое ─────────────────────────────────
  await db().transaction(async (tx) => {
    const regulations = await FileService.createFolder(tx, adminCtx, {
      name: 'Регламенты',
      spaceId: orgSpaceId,
    })
    await FileService.createFolder(tx, adminCtx, { name: 'Формы и шаблоны', spaceId: orgSpaceId })
    await FileService.createFolder(tx, adminCtx, {
      name: 'Сводки',
      spaceId: floodSpaceId,
    })
    await FileService.createFolder(tx, adminCtx, {
      name: 'Материалы совещаний',
      spaceId: floodSpaceId,
      parentId: null,
    })

    // Обсуждение у раздела «Регламенты» — чтобы лента активности была не пустой
    await DiscussionService.postSystem(tx, adminCtx, regulations.id, 'discussion.system.created', {
      actor: 'Системный администратор',
    })

    // Руководителю управления делами — права управления разделом регламентов
    const udHead = created.find((u) => u.unitCode === 'UD' && u.positionKey === 'head_dept')
    if (udHead) {
      await grantAccess(tx, adminCtx, regulations.id, [
        { principal: { type: 'user', id: udHead.id }, level: 'manage' },
      ])
    }
  })

  await bumpPrincipalsVersion()

  // Объекты созданы без запущенного worker — индексируем явно
  const indexed = await reindexAll().catch((error) => {
    log.warn({ err: error }, 'индексация пропущена: поиск недоступен')
    return 0
  })
  log.info({ indexed }, 'поисковый индекс заполнен')

  const [{ count } = { count: '0' }] = await db().execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM users`,
  )

  log.info({ users: Number(count), units: unitIds.size, spaces: spaceIds.size }, 'seed завершён')
  return { users: Number(count), units: unitIds.size, spaces: spaceIds.size }
}

/**
 * Полная очистка данных (db:reset). Схему не трогает.
 * DELETE вместо TRUNCATE: роль kchs_app намеренно не владеет таблицами.
 */
export async function resetData(): Promise<void> {
  const statements = [
    sql`DELETE FROM activities`,
    sql`DELETE FROM notifications`,
    sql`DELETE FROM inbox_items`,
    sql`DELETE FROM jobs`,
    sql`DELETE FROM objects`,
    sql`DELETE FROM employments`,
    sql`DELETE FROM user_roles`,
    sql`DELETE FROM group_members`,
    sql`DELETE FROM delegations`,
    sql`DELETE FROM sessions`,
    sql`DELETE FROM credentials`,
    sql`DELETE FROM users`,
    sql`DELETE FROM org_closure`,
    sql`DELETE FROM org_units`,
    sql`DELETE FROM positions`,
    sql`DELETE FROM groups`,
    sql`DELETE FROM role_capabilities`,
    sql`DELETE FROM roles`,
    sql`DELETE FROM settings`,
    sql`DELETE FROM tags`,
    sql`DELETE FROM business_calendar`,
    sql`DELETE FROM announcements`,
    sql`DELETE FROM ops.outbox`,
    sql`DELETE FROM ops.event_consumptions`,
  ]
  for (const statement of statements) {
    await db().execute(statement)
  }
}
