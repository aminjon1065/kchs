import {
  AdminUserCreateInput,
  type JobRecord,
  type Locale,
  USERS_IMPORT_FIELDS,
  USERS_IMPORT_MAX_BYTES,
  type UsersImportField,
  type UsersImportIssue,
  type UsersImportIssueCode,
  UsersImportMode,
  UsersImportParsed,
  UsersImportReport,
  type UsersImportRow,
  type UsersImportRowStatus,
  type UsersImportStartInput,
  type UsersImportStatus,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { UnrecoverableError } from 'bullmq'
import { eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { authorize, hasCapability } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { JobService } from '~/kernel/jobs/service.js'
import { fileSource } from '~/modules/files/public.js'
import { config } from '~/shared/config/index.js'
import { systemCtx, type UserCtx } from '~/shared/context.js'
import { decryptSecret, encryptSecret } from '~/shared/crypto/secrets.js'
import { CSV_BOM, csvLine } from '~/shared/csv.js'
import { db } from '~/shared/db/client.js'
import { orgUnits, positions, roles, users } from '~/shared/db/schema/index.js'
import { AppError, errors, isAppError } from '~/shared/errors.js'
import { cacheKeys, redis } from '~/shared/redis/index.js'
import { assertCanAssignRoles } from './role-policy.js'
import { UserService } from './user-service.js'

/**
 * Импорт пользователей из Excel (P0-E04 S04, ADR-0041).
 *
 * Поток: файл (объект реестра в личном пространстве администратора) →
 * задание движка `imports:users.parse` (openpyxl) → внутренний маршрут
 * `/internal/users-import/{id}/parsed` → задание воркера
 * `maintenance:identity.users-import`: проверка строк и, в режиме «apply»,
 * создание пользователей через `UserService` → отчёт в результате задания.
 * Идентификатор импорта — идентификатор задания разбора.
 */
export const PARSE_JOB = { queue: 'imports', name: 'users.parse' } as const
export const APPLY_JOB = { queue: 'maintenance', name: 'identity.users-import' } as const

/** Временные пароли ждут одноразовой выгрузки не дольше двух часов. */
export const CREDENTIALS_TTL_SECONDS = 2 * 60 * 60
/** Создание — Argon2 и личное пространство на каждого: несколько параллельно. */
const CREATE_CONCURRENCY = 4
const DEFAULT_ROLE = 'employee'
const DEFAULT_TIMEZONE = 'Asia/Dushanbe'

const applyKey = (importId: string) => `users-import:${importId}`

const StartPayload = z.object({ mode: UsersImportMode, fileId: z.uuid() })
const ApplyData = z.object({
  importId: z.uuid(),
  mode: UsersImportMode,
  fileId: z.uuid(),
  parsed: UsersImportParsed,
})

/** Сравнение имён из файла со справочниками: регистр, «ё» и пробелы не важны. */
function fold(text: string): string {
  return text.replace(/ё/gi, 'е').toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim()
}

const LOCALE_ALIASES: Record<string, Locale> = {
  ru: 'ru',
  рус: 'ru',
  русский: 'ru',
  russian: 'ru',
  tg: 'tg',
  тоҷикӣ: 'tg',
  таджикский: 'tg',
  tajik: 'tg',
  en: 'en',
  eng: 'en',
  english: 'en',
  английский: 'en',
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const Email = z.email()
const Login = AdminUserCreateInput.shape.login
const NAME_MAX = 100
const PHONE_MAX = 32

function issue(
  code: UsersImportIssueCode,
  field: UsersImportField | null,
  params: Record<string, string | number> = {},
): UsersImportIssue {
  return { code, field, params }
}

// ── Справочники организации ──────────────────────────────────────────────────

interface UnitRef {
  id: string
  code: string
  active: boolean
}

interface Lookups {
  roles: Map<string, string>
  unitsByCode: Map<string, UnitRef>
  unitsByName: Map<string, UnitRef[]>
  positions: Array<{ id: string; names: Set<string>; unitId: string | null; rank: number }>
}

function names(value: { ru: string; tg?: string; en?: string }): string[] {
  return [value.ru, value.tg, value.en].filter((v): v is string => Boolean(v?.trim())).map(fold)
}

async function loadLookups(): Promise<Lookups> {
  const [roleRows, unitRows, positionRows] = await Promise.all([
    db().select({ key: roles.key, name: roles.name }).from(roles),
    db()
      .select({
        id: orgUnits.id,
        code: orgUnits.code,
        name: orgUnits.name,
        active: orgUnits.isActive,
      })
      .from(orgUnits),
    db()
      .select({
        id: positions.id,
        name: positions.name,
        unitId: positions.unitId,
        rank: positions.rank,
      })
      .from(positions),
  ])

  const roleIndex = new Map<string, string>()
  for (const role of roleRows) {
    roleIndex.set(fold(role.key), role.key)
    for (const name of names(role.name)) if (!roleIndex.has(name)) roleIndex.set(name, role.key)
  }
  const unitsByCode = new Map<string, UnitRef>()
  const unitsByName = new Map<string, UnitRef[]>()
  for (const unit of unitRows) {
    const ref = { id: unit.id, code: unit.code, active: unit.active }
    unitsByCode.set(fold(unit.code), ref)
    for (const name of new Set(names(unit.name))) {
      unitsByName.set(name, [...(unitsByName.get(name) ?? []), ref])
    }
  }
  return {
    roles: roleIndex,
    unitsByCode,
    unitsByName,
    positions: positionRows.map((row) => ({
      id: row.id,
      names: new Set(names(row.name)),
      unitId: row.unitId,
      rank: row.rank,
    })),
  }
}

// ── Проверка строки ──────────────────────────────────────────────────────────

interface Candidate {
  row: number
  login: string | null
  displayName: string | null
  issues: UsersImportIssue[]
  input: AdminUserCreateInput | null
  status: UsersImportRowStatus
  userId: string | null
}

function checkRow(parsedRow: UsersImportParsed['rows'][number], lookups: Lookups): Candidate {
  const value = (field: UsersImportField) => parsedRow.values[field]?.trim() || null
  const issues: UsersImportIssue[] = []

  const login = value('login')
  const lastName = value('lastName')
  const firstName = value('firstName')
  const middleName = value('middleName')
  for (const [field, present] of [
    ['login', login],
    ['lastName', lastName],
    ['firstName', firstName],
  ] as const) {
    if (!present) issues.push(issue('required', field))
  }
  if (login && !Login.safeParse(login).success) issues.push(issue('invalid_login', 'login'))
  for (const [field, text] of [
    ['lastName', lastName],
    ['firstName', firstName],
    ['middleName', middleName],
  ] as const) {
    if (text && text.length > NAME_MAX) issues.push(issue('too_long', field, { max: NAME_MAX }))
  }

  const email = value('email')
  if (email && !Email.safeParse(email).success) issues.push(issue('invalid_email', 'email'))
  const phone = value('phone')
  if (phone && phone.length > PHONE_MAX) issues.push(issue('too_long', 'phone', { max: PHONE_MAX }))

  let unit: UnitRef | null = null
  const unitText = value('unit')
  if (unitText) {
    const byCode = lookups.unitsByCode.get(fold(unitText))
    const byName = lookups.unitsByName.get(fold(unitText)) ?? []
    if (byCode) unit = byCode
    else if (byName.length === 1) unit = byName[0] ?? null
    else if (byName.length > 1) issues.push(issue('ambiguous_unit', 'unit', { value: unitText }))
    else issues.push(issue('unknown_unit', 'unit', { value: unitText }))
    if (unit && !unit.active) {
      issues.push(issue('inactive_unit', 'unit', { value: unit.code }))
      unit = null
    }
  }

  let positionId: string | null = null
  const positionText = value('position')
  if (positionText) {
    if (!unitText) {
      issues.push(issue('position_without_unit', 'position'))
    } else if (unit) {
      const wanted = fold(positionText)
      const matches = lookups.positions
        .filter((p) => p.names.has(wanted) && (p.unitId === unit?.id || p.unitId === null))
        // Должность подразделения важнее общей
        .sort((a, b) => Number(b.unitId !== null) - Number(a.unitId !== null) || a.rank - b.rank)
      if (matches[0]) positionId = matches[0].id
      else issues.push(issue('unknown_position', 'position', { value: positionText }))
    }
  }

  const roleKeys: string[] = []
  for (const part of (value('roles') ?? '').split(/[,;\n]/)) {
    const wanted = part.trim()
    if (!wanted) continue
    const key = lookups.roles.get(fold(wanted))
    if (!key) issues.push(issue('unknown_role', 'roles', { role: wanted }))
    else if (!roleKeys.includes(key)) roleKeys.push(key)
  }
  if (roleKeys.length === 0) roleKeys.push(DEFAULT_ROLE)

  const localeText = value('locale')
  const locale = localeText ? LOCALE_ALIASES[fold(localeText)] : 'ru'
  if (!locale) issues.push(issue('invalid_locale', 'locale', { value: localeText ?? '' }))

  const timezone = value('timezone') ?? DEFAULT_TIMEZONE
  if (!validTimeZone(timezone))
    issues.push(issue('invalid_timezone', 'timezone', { value: timezone }))

  const displayName = [lastName, firstName, middleName].filter(Boolean).join(' ') || null
  const input =
    issues.length === 0 && login && lastName && firstName && locale
      ? AdminUserCreateInput.parse({
          login,
          email,
          phone,
          lastName,
          firstName,
          middleName,
          unitId: unit?.id ?? null,
          positionId,
          roleKeys,
          mustChangePassword: true,
          locale,
          timezone,
        })
      : null

  return {
    row: parsedRow.row,
    login,
    displayName,
    issues,
    input,
    status: issues.length ? 'error' : 'ready',
    userId: null,
  }
}

/** Права администратора на роли строки: результат по набору ролей кэшируется. */
async function checkRolePermissions(actor: UserCtx, candidates: Candidate[]): Promise<void> {
  const verdicts = new Map<string, string | null>()
  for (const candidate of candidates) {
    if (!candidate.input) continue
    const keys = [...candidate.input.roleKeys].sort()
    const cacheKey = keys.join(',')
    if (!verdicts.has(cacheKey)) {
      try {
        await assertCanAssignRoles(db(), actor, keys)
        verdicts.set(cacheKey, null)
      } catch (error) {
        if (!isAppError(error)) throw error
        verdicts.set(cacheKey, keys.join(', '))
      }
    }
    const forbidden = verdicts.get(cacheKey)
    if (forbidden) {
      candidate.issues.push(issue('role_forbidden', 'roles', { roles: forbidden }))
      candidate.input = null
      candidate.status = 'error'
    }
  }
}

/**
 * Дубликаты в файле и в базе. Строка с логином, который уже есть, пропускается
 * (`exists`): повторный импорт того же файла ничего не создаёт.
 */
async function resolveExisting(
  candidates: Candidate[],
  createdByThisImport: Set<string>,
): Promise<void> {
  const logins = [...new Set(candidates.map((c) => c.login?.toLowerCase()).filter(Boolean))]
  const emails = [
    ...new Set(candidates.map((c) => c.input?.email?.toLowerCase()).filter(Boolean)),
  ] as string[]
  const existingLogins = new Map<string, string>()
  const takenEmails = new Map<string, string>()
  for (let i = 0; i < logins.length; i += 1000) {
    const chunk = logins.slice(i, i + 1000) as string[]
    const rows = await db()
      .select({ id: users.id, login: sql<string>`lower(${users.login})` })
      .from(users)
      .where(inArray(sql`lower(${users.login})`, chunk))
    for (const row of rows) existingLogins.set(row.login, row.id)
  }
  for (let i = 0; i < emails.length; i += 1000) {
    const chunk = emails.slice(i, i + 1000)
    const rows = await db()
      .select({
        email: sql<string>`lower(${users.email})`,
        login: sql<string>`lower(${users.login})`,
      })
      .from(users)
      .where(inArray(sql`lower(${users.email})`, chunk))
    for (const row of rows) takenEmails.set(row.email, row.login)
  }

  const firstLogin = new Map<string, number>()
  const firstEmail = new Map<string, number>()
  for (const candidate of candidates) {
    const login = candidate.login?.toLowerCase()
    if (!login || candidate.issues.some((i) => i.field === 'login')) continue

    const earlier = firstLogin.get(login)
    if (earlier !== undefined) {
      candidate.issues.push(issue('duplicate_login', 'login', { row: earlier }))
      candidate.input = null
      candidate.status = 'error'
      continue
    }
    firstLogin.set(login, candidate.row)

    const existing = existingLogins.get(login)
    if (existing) {
      // Строка пропускается целиком: её данные не используются, замечания не нужны
      candidate.status = createdByThisImport.has(login) ? 'created' : 'exists'
      candidate.userId = existing
      candidate.issues = []
      candidate.input = null
      continue
    }
    if (!candidate.input) continue

    const email = candidate.input.email?.toLowerCase()
    if (email) {
      const earlierEmail = firstEmail.get(email)
      if (earlierEmail !== undefined) {
        candidate.issues.push(issue('duplicate_email', 'email', { row: earlierEmail }))
      } else if (takenEmails.has(email)) {
        candidate.issues.push(issue('email_taken', 'email'))
      }
      if (earlierEmail === undefined) firstEmail.set(email, candidate.row)
      if (candidate.issues.length) {
        candidate.input = null
        candidate.status = 'error'
      }
    }
  }
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      if (item !== undefined) await run(item)
    }
  })
  await Promise.all(workers)
}

// ── Временные пароли ─────────────────────────────────────────────────────────

interface Credential {
  login: string
  displayName: string
  password: string
}

async function storeCredential(importId: string, credential: Credential): Promise<void> {
  const key = cacheKeys.usersImportCredentials(importId)
  const sealed = encryptSecret(JSON.stringify(credential)).toString('base64')
  await redis()
    .multi()
    .hset(key, credential.login.toLowerCase(), sealed)
    .expire(key, CREDENTIALS_TTL_SECONDS)
    .exec()
}

async function acting(importId: string, userId: string): Promise<UserCtx> {
  const [user] = await db()
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const ctx = user?.status === 'active' ? await buildUserCtxFor(userId) : null
  // Права проверяются на момент выполнения: администратора могли лишить роли
  if (!ctx || !hasCapability(ctx, 'users.manage')) {
    throw new UnrecoverableError('Инициатор импорта больше не может управлять пользователями')
  }
  return { ...ctx, sessionId: `users-import:${importId}`, requestId: `users-import:${importId}` }
}

function jobError(job: JobRecord): string {
  const error = job.error as { message?: unknown } | null
  return typeof error?.message === 'string' ? error.message : 'задание не выполнено'
}

async function parseJobFor(ctx: UserCtx, importId: string): Promise<JobRecord> {
  const job = await JobService.get(importId)
  const visible =
    job?.queue === PARSE_JOB.queue &&
    job.name === PARSE_JOB.name &&
    (job.initiatorId === ctx.userId || hasCapability(ctx, 'admin.system'))
  if (!job || !visible) throw errors.notFound('Импорт')
  return job
}

export const UsersImport = {
  /** Постановка разбора файла; идентификатор импорта — задание движка. */
  async start(ctx: UserCtx, input: UsersImportStartInput): Promise<string> {
    await authorize(ctx, 'view', input.fileId)
    const source = await fileSource(input.fileId)
    if (!source) throw errors.notFound('Файл')
    if (!/\.xlsx$/i.test(source.name)) {
      throw errors.validation('Нужен файл Excel в формате .xlsx', [
        { path: 'fileId', message: 'admin.usersImport.errors.notXlsx', code: 'not_xlsx' },
      ])
    }
    if (source.size > USERS_IMPORT_MAX_BYTES) {
      throw errors.payloadTooLarge('Файл импорта больше 10 МБ')
    }
    return JobService.enqueue(ctx, {
      queue: PARSE_JOB.queue,
      name: PARSE_JOB.name,
      objectId: source.fileId,
      data: {
        mode: input.mode,
        fileId: source.fileId,
        versionId: source.versionId,
        bucket: source.bucket,
        storageKey: source.storageKey,
      },
      options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    })
  },

  /**
   * Строки от движка → задание проверки и создания. Повтор вызова (движок
   * повторил задание) возвращает то же задание: ключ идемпотентности — импорт.
   */
  async acceptParsed(importId: string, parsed: UsersImportParsed): Promise<string> {
    const job = await JobService.get(importId)
    if (job?.queue !== PARSE_JOB.queue || job.name !== PARSE_JOB.name) {
      throw errors.notFound('Импорт')
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw errors.conflict('Импорт отменён или завершился ошибкой')
    }
    const start = StartPayload.parse(await JobService.payload(importId))
    return JobService.enqueue(systemCtx('users-import', { initiatorId: job.initiatorId }), {
      queue: APPLY_JOB.queue,
      name: APPLY_JOB.name,
      objectId: start.fileId,
      idempotencyKey: applyKey(importId),
      data: { importId, mode: start.mode, fileId: start.fileId, parsed },
      options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    })
  },

  /** Задание воркера: проверка строк и, в режиме «apply», создание пользователей. */
  async run(
    data: unknown,
    progress: (value: number, message?: string) => Promise<void>,
  ): Promise<UsersImportReport> {
    const { importId, mode, fileId, parsed } = ApplyData.parse(data)
    const parseJob = await JobService.get(importId)
    if (!parseJob?.initiatorId) throw new UnrecoverableError('У импорта нет инициатора')
    const actor = await acting(importId, parseJob.initiatorId)

    const credentialsKey = cacheKeys.usersImportCredentials(importId)
    const createdEarlier = new Set(await redis().hkeys(credentialsKey))

    const lookups = await loadLookups()
    const candidates = parsed.rows.map((row) => checkRow(row, lookups))
    await checkRolePermissions(actor, candidates)
    await resolveExisting(candidates, createdEarlier)
    await progress(0.1)

    if (mode === 'apply') {
      const pending = candidates.filter((c) => c.status === 'ready' && c.input)
      let done = 0
      await pool(pending, CREATE_CONCURRENCY, async (candidate) => {
        const input = candidate.input as AdminUserCreateInput
        try {
          const created = await db().transaction((tx) => UserService.create(tx, actor, input))
          if (created.temporaryPassword) {
            await storeCredential(importId, {
              login: input.login,
              displayName: candidate.displayName ?? input.login,
              password: created.temporaryPassword,
            })
          }
          candidate.status = 'created'
          candidate.userId = created.id
        } catch (error) {
          if (isAppError(error) && error.code === 'conflict') {
            // Логин заняли параллельно (другой импорт или администратор)
            candidate.status = 'exists'
          } else {
            candidate.status = 'error'
            candidate.issues.push(
              issue('create_failed', null, {
                message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
              }),
            )
          }
        }
        done += 1
        if (done % 10 === 0 || done === pending.length) {
          await progress(0.1 + (0.9 * done) / pending.length)
        }
      })
    }

    const counts = { ready: 0, created: 0, exists: 0, error: 0 }
    for (const candidate of candidates) counts[candidate.status] += 1
    const credentialsAlive = mode === 'apply' && (await redis().exists(credentialsKey)) === 1

    if (mode === 'apply') {
      await audit(actor, {
        action: AUDIT_ACTIONS.usersImported,
        objectId: fileId,
        objectType: 'file',
        severity: 'notice',
        details: { importId, total: parsed.totalRows, ...counts },
      })
    }

    return UsersImportReport.parse({
      mode,
      fileId,
      totalRows: parsed.totalRows,
      counts,
      columns: parsed.columns,
      warnings: parsed.warnings,
      fileError: parsed.fileError,
      rows: candidates.map(
        (candidate): UsersImportRow => ({
          row: candidate.row,
          login: candidate.login,
          displayName: candidate.displayName,
          status: candidate.status,
          userId: candidate.userId,
          issues: candidate.issues,
        }),
      ),
      credentialsExpireAt: credentialsAlive
        ? new Date(Date.now() + CREDENTIALS_TTL_SECONDS * 1000).toISOString()
        : null,
    })
  },

  /** Состояние импорта для экрана: разбор → проверка → создание → отчёт. */
  async status(ctx: UserCtx, importId: string): Promise<UsersImportStatus> {
    const parse = await parseJobFor(ctx, importId)
    const start = StartPayload.parse(await JobService.payload(importId))
    const apply = await JobService.findByIdempotencyKey(applyKey(importId))

    let state: UsersImportStatus['state']
    let progress = 0
    let error: string | null = null
    let report: UsersImportReport | null = null
    if (parse.status === 'failed' || parse.status === 'cancelled') {
      state = 'failed'
      error = jobError(parse)
    } else if (!apply) {
      state = parse.status === 'succeeded' ? 'validating' : 'parsing'
      progress = 0.3 * (parse.progress ?? 0)
    } else if (apply.status === 'failed' || apply.status === 'cancelled') {
      state = 'failed'
      error = jobError(apply)
    } else if (apply.status === 'succeeded') {
      state = 'succeeded'
      progress = 1
      report = UsersImportReport.parse(apply.result)
    } else {
      state = start.mode === 'apply' ? 'importing' : 'validating'
      progress = 0.3 + 0.7 * (apply.progress ?? 0)
    }

    const credentialsAvailable =
      state === 'succeeded' &&
      start.mode === 'apply' &&
      parse.initiatorId === ctx.userId &&
      (await redis().exists(cacheKeys.usersImportCredentials(importId))) === 1

    return {
      importId,
      mode: start.mode,
      fileId: start.fileId,
      state,
      progress,
      error,
      report,
      credentialsAvailable,
      createdAt: parse.createdAt,
    }
  },

  /** Отчёт по строкам в CSV на языке запросившего. */
  async reportCsv(ctx: UserCtx, importId: string): Promise<string> {
    const status = await UsersImport.status(ctx, importId)
    if (!status.report) throw errors.conflict('Отчёт ещё не готов')
    const report = status.report
    const t = createTranslator(ctx.locale)
    const describe = (item: UsersImportIssue) => {
      // Столбец — как он назван в файле, без пометки обязательности «*»
      const field = item.field
        ? (
            report.columns[item.field] ??
            USERS_IMPORT_FIELDS.find((spec) => spec.key === item.field)?.headers[ctx.locale] ??
            item.field
          )
            .replace(/\s*\*\s*$/, '')
            .trim()
        : ''
      const text = t(`admin.usersImport.issues.${item.code}`, item.params)
      return field ? `${field}: ${text}` : text
    }

    let out = CSV_BOM
    out += csvLine([
      t('admin.usersImport.columns.row'),
      t('admin.usersImport.columns.login'),
      t('admin.usersImport.columns.name'),
      t('admin.usersImport.columns.status'),
      t('admin.usersImport.columns.issues'),
    ])
    if (report.fileError) out += csvLine(['', '', '', '', describe(report.fileError)])
    for (const warning of report.warnings) out += csvLine(['', '', '', '', describe(warning)])
    for (const row of report.rows) {
      out += csvLine([
        row.row,
        row.login,
        row.displayName,
        t(`admin.usersImport.statuses.${row.status}`),
        row.issues.map(describe).join('; '),
      ])
    }
    return out
  },

  /**
   * Файл с временными паролями — только инициатору и только один раз:
   * чтение и удаление атомарны, выгрузка пишется в аудит.
   */
  async takeCredentials(ctx: UserCtx, importId: string): Promise<string> {
    const parse = await parseJobFor(ctx, importId)
    if (parse.initiatorId !== ctx.userId) throw errors.notFound('Импорт')
    const key = cacheKeys.usersImportCredentials(importId)
    const result = await redis().multi().hgetall(key).del(key).exec()
    const entries = (result?.[0]?.[1] ?? {}) as Record<string, string>
    const credentials = Object.values(entries)
      .map((sealed) => JSON.parse(decryptSecret(Buffer.from(sealed, 'base64'))) as Credential)
      .sort((a, b) => a.login.localeCompare(b.login))
    if (credentials.length === 0) {
      throw new AppError(
        'not_found',
        'Файл с временными паролями уже скачан или срок его хранения истёк',
        404,
      )
    }

    await audit(ctx, {
      action: AUDIT_ACTIONS.usersImportCredentialsDownloaded,
      objectId: parse.objectId,
      objectType: 'file',
      severity: 'warning',
      details: { importId, count: credentials.length },
    })

    const t = createTranslator(ctx.locale)
    let out = CSV_BOM
    out += csvLine([
      t('admin.usersImport.columns.login'),
      t('admin.usersImport.columns.name'),
      t('admin.usersImport.columns.password'),
    ])
    for (const credential of credentials) {
      out += csvLine([credential.login, credential.displayName, credential.password])
    }
    return out
  },

  /** Шаблон XLSX собирает движок: русские заголовки и справочники организации. */
  async template(): Promise<Buffer> {
    const env = config()
    if (!env.ENGINE_INTERNAL_URL || !env.INTERNAL_SERVICE_TOKEN) {
      throw errors.unavailable('Движок недоступен: не заданы ENGINE_INTERNAL_URL и сервисный токен')
    }
    const [roleRows, unitRows, positionRows] = await Promise.all([
      db().select({ key: roles.key, name: roles.name }).from(roles).orderBy(roles.key),
      db()
        .select({ code: orgUnits.code, name: orgUnits.name, active: orgUnits.isActive })
        .from(orgUnits)
        .orderBy(orgUnits.code),
      db()
        .select({ name: positions.name, unitCode: orgUnits.code })
        .from(positions)
        .leftJoin(orgUnits, eq(orgUnits.id, positions.unitId))
        .orderBy(positions.rank),
    ])
    let response: Response
    try {
      response = await fetch(`${env.ENGINE_INTERNAL_URL}/templates/users-import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kchs-service-token': env.INTERNAL_SERVICE_TOKEN,
        },
        body: JSON.stringify({
          roles: roleRows.map((row) => ({ key: row.key, name: row.name.ru })),
          units: unitRows.map((row) => ({ code: row.code, name: row.name.ru, active: row.active })),
          positions: positionRows.map((row) => ({ name: row.name.ru, unitCode: row.unitCode })),
        }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw errors.dependencyFailed('Движок не ответил', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    if (!response.ok) {
      throw errors.dependencyFailed('Движок не выдал шаблон', { status: response.status })
    }
    return Buffer.from(await response.arrayBuffer())
  },
}
