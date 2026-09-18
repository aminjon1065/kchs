import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Импорт пользователей из Excel (P0-E04 S04, ADR-0041).
 *
 * Столбцы — контракт между движком (разбор XLSX и шаблон) и API (проверка и
 * создание): движок читает `users_import.json`, сгенерированный отсюда
 * (`pnpm --filter @kchs/contracts gen:engine`). Заголовок столбца узнаётся на
 * любом языке интерфейса и по синонимам, без учёта регистра, пробелов, «ё» и
 * пометки обязательности `*`.
 */
export const USERS_IMPORT_FIELDS = [
  {
    key: 'login',
    required: true,
    headers: { ru: 'Логин', tg: 'Логин', en: 'Login' },
    aliases: ['имя пользователя', 'username', 'user name'],
  },
  {
    key: 'lastName',
    required: true,
    headers: { ru: 'Фамилия', tg: 'Насаб', en: 'Last name' },
    aliases: ['lastname', 'surname'],
  },
  {
    key: 'firstName',
    required: true,
    headers: { ru: 'Имя', tg: 'Ном', en: 'First name' },
    aliases: ['firstname', 'given name'],
  },
  {
    key: 'middleName',
    required: false,
    headers: { ru: 'Отчество', tg: 'Номи падар', en: 'Middle name' },
    aliases: ['middlename', 'patronymic'],
  },
  {
    key: 'email',
    required: false,
    headers: { ru: 'Электронная почта', tg: 'Почтаи электронӣ', en: 'Email' },
    aliases: ['почта', 'e-mail', 'эл. почта', 'mail'],
  },
  {
    key: 'phone',
    required: false,
    headers: { ru: 'Телефон', tg: 'Телефон', en: 'Phone' },
    aliases: ['мобильный телефон', 'phone number'],
  },
  {
    key: 'unit',
    required: false,
    headers: { ru: 'Подразделение (код)', tg: 'Воҳид (рамз)', en: 'Unit (code)' },
    aliases: ['подразделение', 'код подразделения', 'unit', 'unit code', 'воҳид'],
  },
  {
    key: 'position',
    required: false,
    headers: { ru: 'Должность', tg: 'Вазифа', en: 'Position' },
    aliases: ['position title', 'job title'],
  },
  {
    key: 'roles',
    required: false,
    headers: { ru: 'Роли', tg: 'Нақшҳо', en: 'Roles' },
    aliases: ['роль', 'role'],
  },
  {
    key: 'locale',
    required: false,
    headers: { ru: 'Язык', tg: 'Забон', en: 'Language' },
    aliases: ['язык интерфейса', 'locale'],
  },
  {
    key: 'timezone',
    required: false,
    headers: { ru: 'Часовой пояс', tg: 'Минтақаи вақт', en: 'Time zone' },
    aliases: ['timezone'],
  },
] as const

export type UsersImportField = (typeof USERS_IMPORT_FIELDS)[number]['key']
export const UsersImportFieldKey = z.enum(
  USERS_IMPORT_FIELDS.map((field) => field.key) as [UsersImportField, ...UsersImportField[]],
)

/** Больше строк за один импорт не принимаем: отчёт и проверка остаются обозримыми. */
export const USERS_IMPORT_MAX_ROWS = 5000
/** Предел размера файла импорта. */
export const USERS_IMPORT_MAX_BYTES = 10 * 1024 * 1024

/** «Проверить» — только отчёт, «Импортировать» — создание годных строк. */
export const UsersImportMode = z.enum(['check', 'apply'])
export type UsersImportMode = z.infer<typeof UsersImportMode>

export const UsersImportStartInput = z.object({
  fileId: Uuid,
  mode: UsersImportMode,
})
export type UsersImportStartInput = z.infer<typeof UsersImportStartInput>

/**
 * Замечание к файлу, столбцу или строке. Текст собирает клиент (или отчёт CSV)
 * из словаря по коду `admin.usersImport.issues.<code>` с параметрами.
 */
export const USERS_IMPORT_ISSUE_CODES = [
  // файл — сообщает движок
  'unreadable',
  'no_sheet',
  'no_header',
  'missing_columns',
  'duplicate_column',
  'too_many_rows',
  // столбец — сообщает движок
  'unknown_column',
  // строка — проверка в API
  'required',
  'invalid_login',
  'invalid_email',
  'too_long',
  'unknown_unit',
  'ambiguous_unit',
  'inactive_unit',
  'unknown_position',
  'position_without_unit',
  'unknown_role',
  'role_forbidden',
  'invalid_locale',
  'invalid_timezone',
  'duplicate_login',
  'duplicate_email',
  'email_taken',
  'create_failed',
] as const
export const UsersImportIssueCode = z.enum(USERS_IMPORT_ISSUE_CODES)
export type UsersImportIssueCode = z.infer<typeof UsersImportIssueCode>

export const UsersImportIssue = z.object({
  code: UsersImportIssueCode,
  /** Поле строки, к которому относится замечание; `null` — строка или файл целиком. */
  field: UsersImportFieldKey.nullable().default(null),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
})
export type UsersImportIssue = z.infer<typeof UsersImportIssue>

/** Результат разбора XLSX движком → внутренний маршрут API. */
export const UsersImportParsed = z.object({
  rows: z
    .array(
      z.object({
        /** Номер строки на листе Excel (с единицы, с учётом заголовка). */
        row: z.number().int().min(1),
        /** Только столбцы, найденные в файле. */
        values: z.partialRecord(UsersImportFieldKey, z.string().max(1000).nullable()),
      }),
    )
    .max(USERS_IMPORT_MAX_ROWS),
  /** Как столбцы названы в файле: поле → заголовок. */
  columns: z.partialRecord(UsersImportFieldKey, z.string().max(200)),
  warnings: z.array(UsersImportIssue).max(200).default([]),
  fileError: UsersImportIssue.nullable().default(null),
  totalRows: z.number().int().min(0),
})
export type UsersImportParsed = z.infer<typeof UsersImportParsed>

/**
 * `ready` — строка годна (режим проверки), `created` — пользователь создан,
 * `exists` — логин уже есть: строка пропущена (повторный импорт не создаёт
 * дублей), `error` — строку надо исправить.
 */
export const UsersImportRowStatus = z.enum(['ready', 'created', 'exists', 'error'])
export type UsersImportRowStatus = z.infer<typeof UsersImportRowStatus>

export const UsersImportRow = z.object({
  row: z.number().int(),
  login: z.string().nullable(),
  displayName: z.string().nullable(),
  status: UsersImportRowStatus,
  userId: Uuid.nullable(),
  issues: z.array(UsersImportIssue),
})
export type UsersImportRow = z.infer<typeof UsersImportRow>

export const UsersImportReport = z.object({
  mode: UsersImportMode,
  fileId: Uuid,
  totalRows: z.number().int(),
  counts: z.object({
    ready: z.number().int(),
    created: z.number().int(),
    exists: z.number().int(),
    error: z.number().int(),
  }),
  columns: z.record(z.string(), z.string()),
  warnings: z.array(UsersImportIssue),
  fileError: UsersImportIssue.nullable(),
  rows: z.array(UsersImportRow),
  /** Временные пароли созданных выдаются одноразовым файлом до этого срока. */
  credentialsExpireAt: Timestamp.nullable(),
})
export type UsersImportReport = z.infer<typeof UsersImportReport>

export const UsersImportState = z.enum([
  'parsing',
  'validating',
  'importing',
  'succeeded',
  'failed',
])
export type UsersImportState = z.infer<typeof UsersImportState>

export const UsersImportStatus = z.object({
  importId: Uuid,
  mode: UsersImportMode,
  fileId: Uuid,
  state: UsersImportState,
  progress: z.number().min(0).max(1),
  error: z.string().nullable(),
  report: UsersImportReport.nullable(),
  /** Файл с временными паролями ещё можно скачать (только инициатору, один раз). */
  credentialsAvailable: z.boolean(),
  createdAt: Timestamp,
})
export type UsersImportStatus = z.infer<typeof UsersImportStatus>
