import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
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
import { createdAt, type LangTextValue, tsCol, updatedAt } from '../../shared/db/columns.js'

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
    /**
     * Вид учётной записи (ADR-0130): `person` — сотрудник, `service` — служебная
     * запись правил и интеграций: без входа, без уведомлений и дел, не выбирается
     * назначениями и пикерами людей.
     */
    kind: text('kind').notNull().default('person'),
    /** Назначение служебной учётной записи — видно в консоли и при выборе `run_as`. */
    description: text('description'),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Чем проверяется пароль при входе (ADR-0098): `local` — хэш в `credentials`,
     * `ldap` — bind в каталоге. Учётная запись каталога локального пароля не имеет.
     */
    authSource: text('auth_source').notNull().default('local'),
    /** Устойчивый идентификатор записи в каталоге (objectGUID / entryUUID). */
    directoryId: text('directory_id'),
    /** Различающееся имя записи каталога: по нему выполняется bind при входе. */
    directoryDn: text('directory_dn'),
    /** Когда запись последний раз подтверждена синхронизацией каталога. */
    directorySyncedAt: tsCol('directory_synced_at'),
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
    check('users_kind_check', sql`${t.kind} in ('person', 'service')`),
  ],
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

export type UserRow = typeof users.$inferSelect

export type OrgUnitRow = typeof orgUnits.$inferSelect
