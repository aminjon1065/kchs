import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, type LangTextValue, tsCol, updatedAt } from './_shared.js'

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

// ─── Пользователи ────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    login: text('login').notNull(),
    email: text('email'),
    phone: text('phone'),
    displayName: text('display_name').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    middleName: text('middle_name'),
    locale: text('locale').notNull().default('ru'),
    timezone: text('timezone').notNull().default('Asia/Dushanbe'),
    avatarFileId: uuid('avatar_file_id'),
    status: text('status').notNull().default('active'),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    passwordChangedAt: tsCol('password_changed_at'),
    lastSeenAt: tsCol('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_login_key').on(sql`lower(${t.login})`),
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`).where(sql`${t.email} is not null`),
    index('users_status_idx').on(t.status),
    index('users_display_name_trgm').using('gin', sql`${t.displayName} extensions.gin_trgm_ops`),
  ],
)

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
    createdAt: createdAt(),
    lastUsedAt: tsCol('last_used_at'),
  },
  (t) => [index('webauthn_user_idx').on(t.userId)],
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

// ─── Организационная структура ───────────────────────────────────────────────

export const orgUnits = pgTable(
  'org_units',
  {
    id: uuid('id').primaryKey(),
    parentId: uuid('parent_id'),
    code: text('code').notNull().unique(),
    name: jsonb('name').$type<LangTextValue>().notNull(),
    kind: text('kind').notNull().default('department'),
    headUserId: uuid('head_user_id').references(() => users.id, { onDelete: 'set null' }),
    deputyUserIds: uuid('deputy_user_ids').array(),
    territoryId: uuid('territory_id'),
    spaceId: uuid('space_id'),
    sort: integer('sort').notNull().default(0),
    externalId: text('external_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('org_units_parent_idx').on(t.parentId),
    index('org_units_active_idx').on(t.isActive),
  ],
)

/** Транзитивное замыкание дерева подразделений (03-access-model.md). */
export const orgClosure = pgTable(
  'org_closure',
  {
    unitId: uuid('unit_id')
      .notNull()
      .references(() => orgUnits.id, { onDelete: 'cascade' }),
    ancestorId: uuid('ancestor_id')
      .notNull()
      .references(() => orgUnits.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.unitId, t.ancestorId] }),
    index('org_closure_ancestor_idx').on(t.ancestorId),
  ],
)

export const positions = pgTable('positions', {
  id: uuid('id').primaryKey(),
  name: jsonb('name').$type<LangTextValue>().notNull(),
  rank: integer('rank').notNull().default(0),
  unitId: uuid('unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
})

export const employments = pgTable(
  'employments',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => orgUnits.id, { onDelete: 'cascade' }),
    positionId: uuid('position_id').references(() => positions.id, { onDelete: 'set null' }),
    isPrimary: boolean('is_primary').notNull().default(true),
    startsAt: date('starts_at'),
    endsAt: date('ends_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('employments_user_idx').on(t.userId),
    index('employments_unit_idx').on(t.unitId),
    uniqueIndex('employments_primary_key')
      .on(t.userId)
      .where(sql`${t.isPrimary} and ${t.endsAt} is null`),
  ],
)

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('static'),
    spaceId: uuid('space_id'),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('groups_name_key').on(sql`lower(${t.name})`)],
)

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('group_members_user_idx').on(t.userId),
  ],
)

// ─── Роли и способности ──────────────────────────────────────────────────────

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: jsonb('name').$type<LangTextValue>().notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: createdAt(),
})

export const roleCapabilities = pgTable(
  'role_capabilities',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    capability: text('capability').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.capability] })],
)

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    /** Роль может быть ограничена пространством. */
    spaceId: uuid('space_id'),
    grantedBy: uuid('granted_by'),
    grantedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index('user_roles_role_idx').on(t.roleId)],
)

export const delegations = pgTable(
  'delegations',
  {
    id: uuid('id').primaryKey(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('all'),
    startsAt: tsCol('starts_at').notNull(),
    endsAt: tsCol('ends_at').notNull(),
    note: text('note'),
    status: text('status').notNull().default('active'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('delegations_from_idx').on(t.fromUserId, t.status),
    index('delegations_to_idx').on(t.toUserId, t.status),
  ],
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

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    expiresAt: tsCol('expires_at'),
    lastUsedAt: tsCol('last_used_at'),
    revokedAt: tsCol('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
)

export type UserRow = typeof users.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type OrgUnitRow = typeof orgUnits.$inferSelect
