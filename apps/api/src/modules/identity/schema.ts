import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from '../../kernel/directory/schema.js'
import { bytea, createdAt, tsCol, updatedAt } from '../../shared/db/columns.js'

export const credentials = pgTable('credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  algo: text('algo').notNull().default('argon2id'),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: tsCol('locked_until'),
  /** Хэши последних паролей — политика истории (17-security.md §2). */
  history: jsonb('history').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  updatedAt: updatedAt(),
})

export const mfaFactors = pgTable(
  'mfa_factors',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    secretEnc: bytea('secret_enc').notNull(),
    name: text('name'),
    verifiedAt: tsCol('verified_at'),
    lastUsedAt: tsCol('last_used_at'),
    /** Шаг TOTP последнего принятого кода: код нельзя предъявить повторно. */
    lastStep: bigint('last_step', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [index('mfa_factors_user_idx').on(t.userId)],
)

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: tsCol('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
)

export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array(),
    name: text('name'),
    /**
     * Ключ подтверждает личность (PIN, отпечаток) — ADR-0098: только такой
     * годится как самостоятельный вход и закрывает требование второго фактора.
     */
    userVerified: boolean('user_verified').notNull().default(false),
    /** Ключ синхронизируется между устройствами (облачный passkey). */
    backedUp: boolean('backed_up').notNull().default(false),
    aaguid: text('aaguid'),
    createdAt: createdAt(),
    lastUsedAt: tsCol('last_used_at'),
  },
  (t) => [index('webauthn_user_idx').on(t.userId)],
)

/**
 * Незавершённая проверка ключа входа (ADR-0098). Вызов одноразовый: строка
 * удаляется при первой проверке, поэтому повтор ответа браузера не проходит.
 * `userId` пуст для входа по ключу без логина (discoverable credential),
 * `challengeId` — для второго фактора поверх вызова входа.
 */
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey(),
    /** `register` — добавление ключа, `login` — вход, `mfa` — второй фактор. */
    purpose: text('purpose').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    challenge: text('challenge').notNull().unique(),
    /** Вызов входа, к которому привязан второй фактор (`mfa_challenges.id`). */
    mfaChallengeId: uuid('mfa_challenge_id'),
    expiresAt: tsCol('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('webauthn_challenges_expires_idx').on(t.expiresAt)],
)

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    csrfToken: text('csrf_token').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    deviceName: text('device_name'),
    /** Сессия действует «от имени» другого пользователя (режим замещения). */
    onBehalfOf: uuid('on_behalf_of'),
    /**
     * Режим администратора (ADR-0080): до этого времени администратор системы
     * видит объекты с грифом выше допуска; обоснование — в аудите и здесь.
     */
    adminModeUntil: tsCol('admin_mode_until'),
    adminModeReason: text('admin_mode_reason'),
    mfaVerifiedAt: tsCol('mfa_verified_at'),
    createdAt: createdAt(),
    lastActiveAt: tsCol('last_active_at').notNull().default(sql`now()`),
    expiresAt: tsCol('expires_at').notNull(),
    revokedAt: tsCol('revoked_at'),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId, t.revokedAt),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
)

export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tsCol('expires_at').notNull(),
    usedAt: tsCol('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('password_resets_user_idx').on(t.userId)],
)

/** Незавершённый вход, ожидающий второго фактора. */
export const mfaChallenges = pgTable(
  'mfa_challenges',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    attempts: integer('attempts').notNull().default(0),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: tsCol('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('mfa_challenges_user_idx').on(t.userId)],
)

export const ssoIdentities = pgTable(
  'sso_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    profile: jsonb('profile').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sso_identities_provider_subject_key').on(t.provider, t.subject)],
)

/**
 * Поставщики входа: каталог LDAP/AD и единый вход OIDC (ADR-0098).
 * По одной строке на вид — установка обслуживает одну организацию (ADR-0020).
 * Секрет (пароль учётной записи чтения, секрет клиента) шифруется мастер-ключом
 * и наружу не возвращается.
 */
export const authProviders = pgTable('auth_providers', {
  kind: text('kind').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  secretEnc: bytea('secret_enc'),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** Журнал синхронизаций каталога и предпросмотров «что изменится» (ADR-0098). */
export const directorySyncs = pgTable(
  'directory_syncs',
  {
    id: uuid('id').primaryKey(),
    /** `preview` — ничего не записано; `manual`/`scheduled` — прогон. */
    mode: text('mode').notNull(),
    status: text('status').notNull().default('running'),
    stats: jsonb('stats').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    /** Список изменений: планируемых для предпросмотра, выполненных для прогона. */
    changes: jsonb('changes').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    error: text('error'),
    initiatorId: uuid('initiator_id'),
    startedAt: tsCol('started_at').notNull().default(sql`now()`),
    finishedAt: tsCol('finished_at'),
  },
  (t) => [index('directory_syncs_started_idx').on(t.startedAt)],
)

/**
 * Незавершённый вход через IdP (ADR-0098): `state` хранится хэшем (как токен
 * сессии), `nonce` сверяется с id_token, проверочный код PKCE зашифрован.
 * Строка одноразовая и живёт минуты — чужой `state` не подойдёт.
 */
export const ssoAuthRequests = pgTable(
  'sso_auth_requests',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    stateHash: text('state_hash').notNull().unique(),
    nonce: text('nonce').notNull(),
    codeVerifierEnc: bytea('code_verifier_enc').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: tsCol('expires_at').notNull(),
    usedAt: tsCol('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('sso_auth_requests_expires_idx').on(t.expiresAt)],
)

export type SessionRow = typeof sessions.$inferSelect
