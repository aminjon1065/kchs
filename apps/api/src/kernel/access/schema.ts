import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, tsCol } from '../../shared/db/columns.js'
import { objects } from '../objects/schema.js'

// ─── Доступ ──────────────────────────────────────────────────────────────────

export const aclEntries = pgTable(
  'acl_entries',
  {
    id: uuid('id').primaryKey(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    principalType: text('principal_type').notNull(),
    principalId: text('principal_id').notNull(),
    /** none=0 … owner=5 (03-access-model.md). */
    level: smallint('level').notNull(),
    grantedBy: uuid('granted_by'),
    grantedAt: createdAt(),
    expiresAt: tsCol('expires_at'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('acl_entries_object_principal_key').on(t.objectId, t.principalType, t.principalId),
    index('acl_entries_principal_idx').on(t.principalType, t.principalId),
  ],
)

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    level: smallint('level').notNull().default(1),
    passwordHash: text('password_hash'),
    expiresAt: tsCol('expires_at'),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    includeAttachments: boolean('include_attachments').notNull().default(false),
    revokedAt: tsCol('revoked_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('share_links_object_idx').on(t.objectId)],
)

export type AclEntryRow = typeof aclEntries.$inferSelect
