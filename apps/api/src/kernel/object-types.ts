import type { ObjectSummary } from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { conversations, objects, spaces } from '~/shared/db/schema/index.js'
import { registerObjectType } from './objects/registry.js'

/**
 * Типы объектов, принадлежащие самому ядру: пространство, папка/раздел,
 * представление, беседа (02-platform-kernel.md, 04-domain-model.md).
 */
export function registerKernelObjectTypes(): void {
  registerObjectType({
    type: 'space',
    labelKey: 'objects.types.space',
    icon: 'layout-grid',
    route: (id) => `/spaces/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'manage' },
      manage: { minLevel: 'manage' },
      invite: { minLevel: 'manage' },
      delete: { minLevel: 'owner' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    summary: async (ids) => {
      const rows = await db()
        .select({ id: spaces.id, key: spaces.key, kind: spaces.kind })
        .from(spaces)
        .where(inArray(spaces.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          { meta: { key: row.key, kind: row.kind } } as Partial<ObjectSummary>,
        ]),
      )
    },
  })

  registerObjectType({
    type: 'folder',
    labelKey: 'objects.types.folder',
    icon: 'folder',
    route: (id) => `/files/folders/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'edit' },
      create_child: { minLevel: 'edit' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    summary: async (ids) => {
      const rows = await db()
        .select({ id: objects.id, parentId: objects.parentId })
        .from(objects)
        .where(inArray(objects.id, ids))
      return new Map(rows.map((row) => [row.id, { meta: { parentId: row.parentId } }]))
    },
  })

  registerObjectType({
    type: 'view',
    labelKey: 'objects.types.view',
    icon: 'list-filter',
    route: (id) => `/views/${id}`,
    levels: ['view', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'edit' },
      share: { minLevel: 'manage' },
    },
    discussable: false,
    linkable: false,
    hasParentTree: false,
  })

  registerObjectType({
    type: 'conversation',
    labelKey: 'objects.types.conversation',
    icon: 'message-square',
    route: (id) => `/chats/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      post: { minLevel: 'comment' },
      manage: { minLevel: 'manage' },
    },
    discussable: false,
    linkable: true,
    hasParentTree: false,
    internal: true,
    summary: async (ids) => {
      const rows = await db()
        .select({
          id: conversations.id,
          kind: conversations.kind,
          objectId: conversations.objectId,
        })
        .from(conversations)
        .where(inArray(conversations.id, ids))
      return new Map(
        rows.map((row) => [row.id, { meta: { kind: row.kind, objectId: row.objectId } }]),
      )
    },
    policy: {
      // Участник беседы видит её и может писать
      derive: async (ctx, object) => {
        const [row] = await db()
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, object.id))
          .limit(1)
        if (!row) return []
        const members = await db().execute<{ user_id: string }>(
          sql`SELECT user_id FROM conversation_members
               WHERE conversation_id = ${object.id} AND user_id = ${ctx.userId}`,
        )
        if (members.length === 0) return []
        return [
          {
            level: 'comment' as const,
            reason: {
              kind: 'type_policy' as const,
              level: 'comment' as const,
              messageKey: 'access.reason.type_policy',
              params: { policy: 'Участник беседы' },
            },
          },
        ]
      },
    },
  })
}
