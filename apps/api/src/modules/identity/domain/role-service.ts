import type { RoleInput, RolePatch } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { roleCapabilities, roles, userRoles } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { assertCanDefineRole, assertCanEditRole } from './role-policy.js'

async function editableRole(tx: Executor, roleId: string) {
  const [role] = await tx
    .select({ id: roles.id, key: roles.key, isSystem: roles.isSystem })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1)
  if (!role) throw errors.notFound('Роль')
  if (role.isSystem) {
    throw errors.validation(
      'Способности системной роли задаёт платформа: её не меняют и не удаляют',
    )
  }
  return role
}

async function setCapabilities(tx: Executor, roleId: string, capabilities: readonly string[]) {
  await tx.delete(roleCapabilities).where(eq(roleCapabilities.roleId, roleId))
  const unique = [...new Set(capabilities)]
  if (unique.length > 0) {
    await tx.insert(roleCapabilities).values(unique.map((capability) => ({ roleId, capability })))
  }
}

async function capabilitiesOf(tx: Executor, roleId: string): Promise<string[]> {
  const rows = await tx
    .select({ capability: roleCapabilities.capability })
    .from(roleCapabilities)
    .where(eq(roleCapabilities.roleId, roleId))
  return rows.map((row) => row.capability).sort()
}

/**
 * Свои роли организации (ADR-0165): название на трёх языках и набор способностей.
 * Системные роли задаёт платформа — их способности переписываются при каждом старте, поэтому
 * здесь они не меняются. Смена способностей роли меняет права всех её держателей: версию
 * множеств принципалов повышает вызывающий после фиксации транзакции — повышенная внутри,
 * она дала бы соседнему запросу закэшировать прежние способности под новой версией.
 */
export const RoleService = {
  async create(tx: Executor, ctx: Ctx, input: RoleInput): Promise<{ id: string; key: string }> {
    assertCanDefineRole(ctx, input.capabilities)
    const key = input.key ?? `role_${newId().replace(/-/g, '').slice(-10)}`
    const [taken] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).limit(1)
    if (taken) {
      throw errors.conflict('Роль с таким ключом уже есть', { key })
    }
    const id = newId()
    await tx.insert(roles).values({
      id,
      key,
      name: input.name,
      description: input.description ?? null,
      isSystem: false,
    })
    await setCapabilities(tx, id, input.capabilities)
    const capabilities = [...new Set(input.capabilities)].sort()
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.roleCreated,
        objectId: id,
        objectType: 'role',
        details: { key, name: input.name, capabilities },
        severity: 'warning',
      },
      tx,
    )
    await publishEvent(tx, ctx, {
      type: 'role.created',
      object: { id, type: 'role', title: input.name.ru },
      payload: { roleId: id, key, capabilities },
    })
    return { id, key }
  },

  async update(
    tx: Executor,
    ctx: Ctx,
    roleId: string,
    patch: RolePatch,
  ): Promise<{ capabilitiesChanged: boolean }> {
    const role = await editableRole(tx, roleId)
    await assertCanEditRole(tx, ctx, role.key)
    const values: Record<string, unknown> = {}
    if (patch.name !== undefined) values.name = patch.name
    if (patch.description !== undefined) values.description = patch.description
    if (Object.keys(values).length > 0) {
      await tx.update(roles).set(values).where(eq(roles.id, roleId))
    }
    const before = await capabilitiesOf(tx, roleId)
    let after = before
    if (patch.capabilities !== undefined) {
      assertCanDefineRole(ctx, patch.capabilities)
      await setCapabilities(tx, roleId, patch.capabilities)
      after = [...new Set(patch.capabilities)].sort()
    }
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.roleUpdated,
        objectId: roleId,
        objectType: 'role',
        details: {
          key: role.key,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(after.join() !== before.join() ? { capabilities: { before, after } } : {}),
        },
        severity: 'warning',
      },
      tx,
    )
    await publishEvent(tx, ctx, {
      type: 'role.updated',
      object: { id: roleId, type: 'role' },
      payload: { roleId, key: role.key, capabilities: after },
    })
    return { capabilitiesChanged: after.join() !== before.join() }
  },

  async remove(tx: Executor, ctx: Ctx, roleId: string): Promise<void> {
    const role = await editableRole(tx, roleId)
    await assertCanEditRole(tx, ctx, role.key)
    const [holders] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId))
    if ((holders?.count ?? 0) > 0) {
      throw errors.conflict(
        `Роль назначена сотрудникам (${holders?.count}): сначала снимите её в «Пользователях»`,
      )
    }
    await tx.delete(roles).where(eq(roles.id, roleId))
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.roleDeleted,
        objectId: roleId,
        objectType: 'role',
        details: { key: role.key },
        severity: 'warning',
      },
      tx,
    )
    await publishEvent(tx, ctx, {
      type: 'role.deleted',
      object: { id: roleId, type: 'role' },
      payload: { roleId, key: role.key },
    })
  },
}
