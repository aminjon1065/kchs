import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Каталог LDAP / Active Directory (14-automation-integrations.md §5, P5-E04,
 * ADR-0098): одно подключение на установку. Секрет (пароль учётной записи
 * чтения) хранится зашифрованным и наружу не возвращается — вместо него
 * приходит признак `hasBindPassword`.
 */

/** Соответствие полей записи каталога полям профиля. */
export const DirectoryAttributeMap = z.object({
  login: z.string().min(1).max(64).default('sAMAccountName'),
  email: z.string().max(64).default('mail'),
  firstName: z.string().max(64).default('givenName'),
  lastName: z.string().max(64).default('sn'),
  middleName: z.string().max(64).default(''),
  displayName: z.string().max(64).default('displayName'),
  phone: z.string().max(64).default('telephoneNumber'),
  /** Устойчивый идентификатор записи: по нему узнаётся переименованный сотрудник. */
  externalId: z.string().max(64).default('objectGUID'),
  /** Поле отключения записи. Для AD — `userAccountControl` (бит 2). */
  disabled: z.string().max(64).default('userAccountControl'),
  /** Подразделение сотрудника (код или имя, сопоставляется со справочником). */
  unit: z.string().max(64).default('department'),
  position: z.string().max(64).default('title'),
  /** Группы записи — для сопоставления с ролями платформы. */
  memberOf: z.string().max(64).default('memberOf'),
})
export type DirectoryAttributeMap = z.infer<typeof DirectoryAttributeMap>

/** Группа каталога → роль платформы. */
export const GroupRoleMapping = z.object({
  /** DN группы или её имя (сравнение без учёта регистра, по вхождению `cn=`). */
  group: z.string().min(1).max(512),
  roleKey: z.string().min(1).max(64),
})
export type GroupRoleMapping = z.infer<typeof GroupRoleMapping>

/** Что делать с сотрудником, исчезнувшим из каталога или отключённым в нём. */
export const DirectoryMissingAction = z.enum(['ignore', 'block'])
export type DirectoryMissingAction = z.infer<typeof DirectoryMissingAction>

export const DirectorySettings = z.object({
  enabled: z.boolean().default(false),
  /** `ldap://dc.example.org:389` или `ldaps://dc.example.org:636`. */
  url: z.string().max(300).default(''),
  /** Поднять TLS на обычном соединении (StartTLS) — для `ldap://`. */
  startTls: z.boolean().default(false),
  /** Проверять сертификат сервера. Выключается только для внутреннего центра сертификации. */
  tlsRejectUnauthorized: z.boolean().default(true),
  /** Учётная запись чтения; пустая — анонимный поиск. */
  bindDn: z.string().max(300).default(''),
  /** Корень поиска пользователей. */
  baseDn: z.string().max(300).default(''),
  userFilter: z.string().max(500).default('(objectClass=person)'),
  /** Корень поиска подразделений; пусто — не синхронизировать структуру. */
  unitBaseDn: z.string().max(300).default(''),
  unitFilter: z.string().max(500).default('(objectClass=organizationalUnit)'),
  attributes: DirectoryAttributeMap.prefault({}),
  groupMappings: z.array(GroupRoleMapping).max(100).default([]),
  /** Роли сотрудника, не попавшего ни в одно сопоставление групп. */
  defaultRoleKeys: z.array(z.string().max(64)).max(10).default(['employee']),
  onMissing: DirectoryMissingAction.default('block'),
  /** Как часто запускается синхронизация по расписанию. */
  syncIntervalMinutes: z.number().int().min(15).max(1440).default(60),
  /** Вход сотрудников каталога по паролю каталога (bind). */
  allowPasswordLogin: z.boolean().default(true),
  pageSize: z.number().int().min(50).max(5000).default(500),
})
export type DirectorySettings = z.infer<typeof DirectorySettings>

/** Настройки на запись: пароль учётной записи чтения задаётся только здесь. */
export const DirectorySettingsInput = DirectorySettings.extend({
  /** Новый пароль учётной записи чтения; не передан — прежний сохраняется, `''` — стирается. */
  bindPassword: z.string().max(400).optional(),
})
export type DirectorySettingsInput = z.infer<typeof DirectorySettingsInput>

export const DirectorySyncStatus = z.enum(['running', 'succeeded', 'failed'])
export type DirectorySyncStatus = z.infer<typeof DirectorySyncStatus>

export const DirectorySyncMode = z.enum(['preview', 'manual', 'scheduled'])
export type DirectorySyncMode = z.infer<typeof DirectorySyncMode>

/** Одно планируемое или выполненное изменение. */
export const DirectoryChange = z.object({
  kind: z.enum(['user', 'unit']),
  action: z.enum(['create', 'update', 'block', 'unblock', 'skip']),
  login: z.string(),
  title: z.string(),
  /** Что именно меняется: поле → «было → стало». */
  fields: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })).default([]),
  reason: z.string().nullable().default(null),
})
export type DirectoryChange = z.infer<typeof DirectoryChange>

export const DirectorySyncStats = z.object({
  scanned: z.number().int().nonnegative().default(0),
  created: z.number().int().nonnegative().default(0),
  updated: z.number().int().nonnegative().default(0),
  blocked: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  unitsCreated: z.number().int().nonnegative().default(0),
  unitsUpdated: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
})
export type DirectorySyncStats = z.infer<typeof DirectorySyncStats>

export const DirectorySyncRun = z.object({
  id: Uuid,
  mode: DirectorySyncMode,
  status: DirectorySyncStatus,
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  stats: DirectorySyncStats,
  error: z.string().nullable(),
  initiatorId: Uuid.nullable(),
  /** Список изменений: для предпросмотра — планируемых, для прогона — выполненных. */
  changes: z.array(DirectoryChange).default([]),
})
export type DirectorySyncRun = z.infer<typeof DirectorySyncRun>

/** Что видит администратор: настройки без секрета плюс состояние. */
export const DirectoryState = DirectorySettings.extend({
  hasBindPassword: z.boolean(),
  updatedAt: Timestamp.nullable(),
  lastRun: DirectorySyncRun.nullable(),
})
export type DirectoryState = z.infer<typeof DirectoryState>

export const DirectoryTestResult = z.object({
  ok: z.boolean(),
  /** Сообщение об ошибке — без пароля и содержимого записей. */
  error: z.string().nullable(),
  /** Сколько записей нашёл фильтр пользователей. */
  users: z.number().int().nonnegative(),
  units: z.number().int().nonnegative(),
  /** Первые логины для проверки сопоставления полей. */
  sample: z.array(z.string()).max(5),
  elapsedMs: z.number().int().nonnegative(),
})
export type DirectoryTestResult = z.infer<typeof DirectoryTestResult>
