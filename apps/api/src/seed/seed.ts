import { eq, inArray, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { bumpPrincipalsVersion } from '~/kernel/access/principal-set.js'
import { DiscussionService } from '~/kernel/discussions/service.js'
import { reindexAll } from '~/kernel/search/index-service.js'
import { BrandingService } from '~/kernel/settings/branding.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { type DemoDocumentPeople, DocumentsSeed } from '~/modules/documents/public.js'
import { FileService } from '~/modules/files/domain/file-service.js'
import { BasemapService, type TerritoryInput, TerritoryService } from '~/modules/gis/public.js'
import { OrgService, UserService } from '~/modules/identity/public.js'
import { KnowledgeSeed } from '~/modules/knowledge/public.js'
import { ensureControlMetrics } from '~/modules/tasks/domain/control-metrics.js'
import { seedDemoInstructions } from '~/modules/tasks/domain/demo-instructions.js'
import { type SystemCtx, systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import {
  employments,
  orgUnits,
  positions,
  roles,
  spaceMembers,
  spaces,
  userRoles,
  users,
} from '~/shared/db/schema/index.js'
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
import SETTLEMENTS from './settlements.json' with { type: 'json' }
import TERRITORIES from './territories.json' with { type: 'json' }
import BOUNDARIES from './territory-boundaries.json' with { type: 'json' }
import POPULATION from './territory-population.json' with { type: 'json' }

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

  // ── Территории ────────────────────────────────────────────────────────────
  // Справочник, границы и численность населения нужны и чистой установке (профиль
  // minimal); загрузка повторяема: существующие коды не меняются, те же границы и
  // численность не перезаписываются (seeds/README.md, ADR-0057, ADR-0067). Кишлаки
  // демо-мира синтетические — только в профиле demo
  const loaded = await db().transaction(async (tx) => ({
    created: await TerritoryService.load(tx, ctx, TERRITORIES as unknown as TerritoryInput[]),
    settlements:
      options.profile === 'demo'
        ? await TerritoryService.load(tx, ctx, SETTLEMENTS as unknown as TerritoryInput[])
        : 0,
    boundaries: await TerritoryService.loadBoundaries(tx, ctx, BOUNDARIES),
    // Официальная статистика (вопрос N7) поверх оценок генератора из справочника
    population: await TerritoryService.loadPopulation(tx, ctx, POPULATION),
  }))
  await TerritoryService.invalidate()
  const territoryIds = new Map(
    (await TerritoryService.list()).map((territory) => [territory.code, territory.id]),
  )
  log.info({ territories: territoryIds.size, ...loaded }, 'справочник территорий загружен')
  const territoryOf = (unit: SeedUnit) =>
    unit.territory ? (territoryIds.get(unit.territory) ?? null) : null

  // ── Базовые карты ─────────────────────────────────────────────────────────
  // Векторная подложка по умолчанию, если сборка PMTiles загружена в хранилище,
  // иначе — «без подложки» (ADR-0066); повторный запуск ничего не меняет
  const basemaps = await BasemapService.sync(ctx)
  log.info(
    { created: basemaps.created, updated: basemaps.updated, default: basemaps.defaultName },
    'реестр базовых карт синхронизирован',
  )

  // Демо-данные уже загружены — признак: корень демо-оргструктуры. Пустая база
  // с администратором от `kchs init` данными не считается (06-handoff.md:
  // установка — `kchs init`, затем seed)
  const seeded = await db()
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(eq(orgUnits.code, ORG_TREE.code))
    .limit(1)
  if (seeded.length > 0) {
    await linkUnitTerritories(ctx, territoryOf)
    // Справочники документооборота дозагружаются и на заполненной базе
    await seedDocuments(ctx, options.profile === 'demo')
    // Канцелярия и демо-документы (ADR-0086) — тоже: они появились позже демо-мира
    if (options.profile === 'demo') await seedOffice(await seedAdminCtx(options.adminLogin))
    if (options.profile === 'demo') await seedBranding(await seedAdminCtx(options.adminLogin))
    // Разделы базы знаний (ADR-0095) и руководство (P5-E07) появились позже
    await seedKnowledge(await seedAdminCtx(options.adminLogin))
    log.warn('демо-данные уже загружены — seed пропущен (используйте db:reset)')
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
  // Созданный `kchs init` администратор сохраняется со своим паролем
  const [existingAdmin] = await db()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.login}) = ${options.adminLogin.toLowerCase()}`)
    .limit(1)
  const admin =
    existingAdmin ??
    (await db().transaction((tx) =>
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
    ))
  const adminCtx = systemCtx('seed', { initiatorId: admin.id })
  log.info(
    { login: options.adminLogin, reused: Boolean(existingAdmin) },
    existingAdmin ? 'администратор уже есть — используется' : 'администратор создан',
  )

  // ── Оргструктура ──────────────────────────────────────────────────────────
  const unitIds = new Map<string, string>()
  const createUnit = async (unit: SeedUnit, parentId: string | null): Promise<void> => {
    const id = await db().transaction((tx) =>
      OrgService.createUnit(tx, adminCtx, {
        parentId,
        code: unit.code,
        name: { ru: unit.name.ru, tg: unit.name.tg, en: unit.name.en },
        kind: unit.kind,
        territoryId: territoryOf(unit),
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
    await seedDocuments(adminCtx, false)
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

  // Показатели контроля исполнения над системным датасетом «Поручения» (ADR-0082)
  const metrics = await db().transaction((tx) => ensureControlMetrics(tx, adminCtx, orgSpaceId))
  log.info({ metrics: metrics.length }, 'показатели контроля поручений заведены')

  // Демо-поручения (ADR-0082): руководитель — сотрудникам своего подразделения, а
  // если их нет — руководителям вложенных; все состояния контроля исполнения
  const HEAD_POSITIONS = new Set(['chairman', 'head_dept', 'head_div'])
  const heads = created.filter((user) => HEAD_POSITIONS.has(user.positionKey))
  const teams = heads.map((head) => {
    const direct = created.filter((user) => user.unitCode === head.unitCode && user.id !== head.id)
    const nested = heads.filter(
      (user) =>
        user.id !== head.id &&
        (head.unitCode === ORG_TREE.code
          ? !user.unitCode.includes('-')
          : user.unitCode.startsWith(`${head.unitCode}-`)),
    )
    return { headId: head.id, memberIds: (direct.length > 0 ? direct : nested).map((u) => u.id) }
  })
  const instructions = await seedDemoInstructions(teams)
  log.info({ instructions }, 'демо-поручения созданы')

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

  await seedDocuments(adminCtx, true)
  await seedOffice(adminCtx)
  await seedBranding(adminCtx)
  await seedKnowledge(adminCtx)
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
 * Демо-мир — это Комитет (Q13): название организации в брендировании — подзаголовок
 * экрана входа под «Портал КЧС» и шапки печатных форм. Только если его ещё никто не
 * задал: правку администратора сид не перетирает. Рабочей установке название задаёт
 * администратор в консоли.
 */
async function seedBranding(ctx: SystemCtx): Promise<void> {
  const current = await BrandingService.current()
  if (current.name) return
  await db().transaction((tx) =>
    BrandingService.update(tx, ctx, {
      name: 'Комитет по чрезвычайным ситуациям и гражданской обороне при Правительстве Республики Таджикистан',
      shortName: 'КЧС и ГО',
    }),
  )
  BrandingService.invalidate()
}

/**
 * База знаний в пространстве «Общее»: разделы по умолчанию
 * (13-search-knowledge-ai.md §2, ADR-0095) и краткое руководство пользователя
 * в разделе «Обучение» (P5-E07). Идемпотентно: страница с таким названием на
 * своём месте не дублируется, уже написанный текст не перезаписывается.
 * Контекст — с инициатором: иначе у страниц не будет владельца, и механизм
 * пересмотра для них не заработает.
 */
async function seedKnowledge(ctx: SystemCtx): Promise<void> {
  const [org] = await db()
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.key, 'org'))
    .limit(1)
  if (!org) return
  const log = logger().child({ module: 'seed' })
  const created = await KnowledgeSeed.ensureDefaultSections(ctx, org.id)
  log.info({ created }, 'разделы базы знаний заведены')
  const guide = await KnowledgeSeed.ensureUserGuide(ctx, org.id)
  log.info(guide, 'руководство пользователя в базе знаний заведено')
}

/**
 * Стартовые журналы и типы документов (08-documents.md §2, §5) — идемпотентно;
 * журналы ведёт канцелярия демо-оргструктуры, корреспонденты — демо-миру.
 */
async function seedDocuments(ctx: SystemCtx, demo: boolean): Promise<void> {
  const [registry] = await db()
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(eq(orgUnits.code, 'UD-CANC'))
    .limit(1)
  const summary = await DocumentsSeed.ensureStarterSet(ctx, { unitId: registry?.id ?? null, demo })
  logger().child({ module: 'seed' }).info(summary, 'справочники документооборота загружены')
}

/** Типовая номенклатура дел для подразделений демо-мира: прошлый и текущий год. */
async function typicalNomenclature(ctx: SystemCtx): Promise<void> {
  const units = await db().select({ id: orgUnits.id, code: orgUnits.code }).from(orgUnits)
  const year = new Date().getFullYear()
  const result = await DocumentsSeed.seedTypicalNomenclature(
    ctx,
    new Map(units.map((unit) => [unit.code, unit.id])),
    [year - 1, year],
  )
  if (result.created > 0 || result.linked > 0) {
    logger().child({ module: 'seed' }).info(result, 'типовая номенклатура дел заведена')
  }
}

/**
 * Повтор после предметного пакета: его типы документов (распоряжения и протоколы штаба,
 * оперативные сводки) появляются позже номенклатуры и привязываются к её делам.
 */
export async function linkTypicalNomenclature(adminLogin: string): Promise<void> {
  await typicalNomenclature(await seedAdminCtx(adminLogin))
}

/** Контекст сида от имени администратора демо-стенда (для повторного запуска). */
async function seedAdminCtx(adminLogin: string): Promise<SystemCtx> {
  const [admin] = await db()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.login}) = ${adminLogin.toLowerCase()}`)
    .limit(1)
  return systemCtx('seed', { initiatorId: admin?.id ?? null })
}

/**
 * Канцелярия демо-мира (ADR-0086): показатели и дашборд «Канцелярия» в
 * пространстве «Общее», около двухсот демо-документов с номенклатурой дел,
 * маршруты и резолюции в работе — идемпотентно, в том числе на заполненной
 * раньше базе.
 */
async function seedOffice(ctx: SystemCtx): Promise<void> {
  const log = logger().child({ module: 'seed' })
  const [org] = await db()
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.key, 'org'))
    .limit(1)
  if (org) {
    const office = await db().transaction((tx) =>
      DocumentsSeed.ensureOfficeDashboard(tx, ctx, org.id),
    )
    log.info(office, 'показатели и дашборд «Канцелярия» заведены')
  }
  // Типовая номенклатура по подразделениям (N20, ADR-0135) — до демо-документов: их номер
  // «подразделение-дело/номер» берёт индекс дела из неё (ADR-0134)
  await typicalNomenclature(ctx)
  const people = await demoDocumentPeople()
  const summary = await DocumentsSeed.seedDemoDocuments(people)
  log.info(summary, summary.skipped ? 'демо-документы уже есть' : 'демо-документы созданы')
  // Маршруты и резолюции поверх демо-документов: согласования и поручения в работе
  const workflow = await DocumentsSeed.seedDemoWorkflow(people)
  log.info(workflow, workflow.skipped ? 'демо-маршруты уже есть' : 'демо-маршруты созданы')
}

/** Люди демо-мира для документов: делопроизводители, руководители, исполнители. */
async function demoDocumentPeople(): Promise<DemoDocumentPeople> {
  const rows = await db().execute<{
    id: string
    unit_id: string | null
    unit_code: string | null
    is_head: boolean
    registrar: boolean
  }>(sql`
    SELECT u.id, e.unit_id, ou.code AS unit_code,
           coalesce(ou.head_user_id = u.id, false) AS is_head,
           EXISTS (SELECT 1 FROM ${userRoles} ur JOIN ${roles} r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id AND r.key = 'registrar') AS registrar
      FROM ${users} u
      LEFT JOIN ${employments} e ON e.user_id = u.id AND e.is_primary AND e.ends_at IS NULL
      LEFT JOIN ${orgUnits} ou ON ou.id = e.unit_id
     WHERE u.status = 'active' AND u.login LIKE 'user%'
     ORDER BY u.login`)
  const person = (row: { id: string; unit_id: string | null }) => ({
    id: row.id,
    unitId: row.unit_id,
  })
  const [office] = await db()
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(eq(orgUnits.code, 'UD-CANC'))
    .limit(1)
  return {
    registrars: rows.filter((row) => row.registrar).map(person),
    heads: rows.filter((row) => row.is_head).map(person),
    staff: rows.filter((row) => !row.is_head && !row.registrar).map(person),
    officeUnitId: office?.id ?? null,
  }
}

/**
 * Полная очистка данных (db:reset). Схему не трогает.
 * DELETE вместо TRUNCATE: роль kchs_app намеренно не владеет таблицами.
 */
/**
 * Демо-оргструктура загружена раньше справочника территорий: подразделениям
 * `ORG_TREE` без территории она назначается — повторный seed их связывает.
 */
async function linkUnitTerritories(
  ctx: SystemCtx,
  territoryOf: (unit: SeedUnit) => string | null,
): Promise<void> {
  const wanted = new Map<string, string>()
  const walk = (unit: SeedUnit): void => {
    const territoryId = territoryOf(unit)
    if (territoryId) wanted.set(unit.code, territoryId)
    for (const child of unit.children ?? []) walk(child)
  }
  walk(ORG_TREE)
  if (wanted.size === 0) return
  const rows = await db()
    .select({ id: orgUnits.id, code: orgUnits.code, territoryId: orgUnits.territoryId })
    .from(orgUnits)
    .where(inArray(orgUnits.code, [...wanted.keys()]))
  for (const row of rows) {
    const territoryId = wanted.get(row.code)
    if (row.territoryId || !territoryId) continue
    await db().transaction((tx) => OrgService.updateUnit(tx, ctx, row.id, { territoryId }))
  }
}

export async function resetData(): Promise<void> {
  const statements = [
    sql`DELETE FROM activities`,
    sql`DELETE FROM notifications`,
    sql`DELETE FROM inbox_items`,
    sql`DELETE FROM jobs`,
    // Очередь «Из почты» (ADR-0113): записи писем живут дольше своих черновиков
    sql`DELETE FROM mail_messages`,
    // Документы — до реестра: регистрации держат журналы и типы (FK без каскада)
    sql`DELETE FROM documents`,
    // Акты об уничтожении — записи операций, не объекты: номер акта — порядковый в году
    sql`DELETE FROM case_destruction_acts`,
    sql`DELETE FROM objects`,
    // Экземпляры маршрутов удалены вместе с объектами — определения свободны
    sql`DELETE FROM process_definitions`,
    sql`DELETE FROM employments`,
    sql`DELETE FROM user_roles`,
    sql`DELETE FROM group_members`,
    sql`DELETE FROM delegations`,
    sql`DELETE FROM sessions`,
    sql`DELETE FROM credentials`,
    // Поставщики входа и следы внешних входов (ADR-0098): ключи, вызовы и
    // связи с IdP уходят каскадом вместе с пользователями
    sql`DELETE FROM auth_providers`,
    sql`DELETE FROM directory_syncs`,
    sql`DELETE FROM sso_auth_requests`,
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
