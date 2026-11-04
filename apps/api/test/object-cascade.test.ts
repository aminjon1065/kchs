import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Каскад архива, корзины и восстановления (ADR-0228): событие — каждому затронутому
 * объекту поддерева (с `cascadeOf`), а восстановление возвращает только то, что ушло
 * вместе с корнем; удалённое раньше отдельно остаётся в корзине со своей отметкой.
 */
registerLifecycle()

const { ObjectService } = await import('../src/kernel/objects/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

const ctx = () => systemCtx('test', { initiatorId: fx.admin.id })

/** Корень → две папки, у первой — вложенная. */
async function tree(title: string) {
  return db().transaction(async (tx) => {
    const folder = (parentId: string | null, name: string) =>
      ObjectService.create(tx, ctx(), {
        type: 'folder',
        spaceId: fx.spaceId,
        parentId,
        title: `${title} ${name}`,
      })
    const root = await folder(null, 'корень')
    const a = await folder(root.id, 'A')
    const b = await folder(a.id, 'B')
    const c = await folder(root.id, 'C')
    return { root: root.id, a: a.id, b: b.id, c: c.id }
  })
}

async function stateOf(id: string) {
  const [row] = await db().execute<{ deleted_at: string | null; archived_at: string | null }>(
    sql`SELECT deleted_at, archived_at FROM objects WHERE id = ${id}`,
  )
  return row
}

/** События каскада с корнем `rootId` (из outbox) — по идентификатору объекта. */
async function cascadeEvents(type: string, rootId: string): Promise<string[]> {
  const rows = await db().execute<{ object_id: string }>(sql`
    SELECT event->'object'->>'id' AS object_id FROM ops.outbox
     WHERE type = ${type} AND event->'payload'->>'cascadeOf' = ${rootId}`)
  return rows.map((row) => row.object_id).sort()
}

describe('каскад корзины и восстановления', () => {
  it('корзина: событие у каждого потомка, удалённый раньше остаётся в корзине', async () => {
    const t = await tree('Корзина')
    await db().transaction((tx) => ObjectService.trash(tx, ctx(), t.c))
    const cBefore = await stateOf(t.c)
    await new Promise((resolve) => setTimeout(resolve, 20))

    await db().transaction((tx) => ObjectService.trash(tx, ctx(), t.root))
    expect(await cascadeEvents('object.trashed', t.root)).toEqual([t.a, t.b].sort())
    // Своя отметка удалённого раньше не переписана — его срок очистки прежний
    expect((await stateOf(t.c))?.deleted_at).toBe(cBefore?.deleted_at)

    await db().transaction((tx) => ObjectService.restore(tx, ctx(), t.root))
    expect((await stateOf(t.root))?.deleted_at).toBeNull()
    expect((await stateOf(t.a))?.deleted_at).toBeNull()
    expect((await stateOf(t.b))?.deleted_at).toBeNull()
    expect((await stateOf(t.c))?.deleted_at).not.toBeNull()
    expect(await cascadeEvents('object.restored', t.root)).toEqual([t.a, t.b].sort())
  })

  it('архив: событие у каждого потомка, заархивированный раньше остаётся в архиве', async () => {
    const t = await tree('Архив')
    await db().transaction((tx) => ObjectService.archive(tx, ctx(), t.c))
    await new Promise((resolve) => setTimeout(resolve, 20))

    await db().transaction((tx) => ObjectService.archive(tx, ctx(), t.root))
    expect(await cascadeEvents('object.archived', t.root)).toEqual([t.a, t.b].sort())

    await db().transaction((tx) => ObjectService.restore(tx, ctx(), t.root))
    expect((await stateOf(t.a))?.archived_at).toBeNull()
    expect((await stateOf(t.b))?.archived_at).toBeNull()
    expect((await stateOf(t.c))?.archived_at).not.toBeNull()
  })

  it('лента активности: одна запись о корне, а не о каждом потомке', async () => {
    const { recordActivity } = await import('../src/kernel/activity/service.js')
    const t = await tree('Лента')
    await db().transaction((tx) => ObjectService.trash(tx, ctx(), t.root))
    const events = await db().execute<{ event: Record<string, unknown> }>(sql`
      SELECT event FROM ops.outbox
       WHERE type = 'object.trashed'
         AND (event->'object'->>'id' = ${t.root} OR event->'payload'->>'cascadeOf' = ${t.root})`)
    for (const row of events) await recordActivity(row.event as never)
    const [feed] = await db().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM activities
       WHERE verb = 'trashed' AND object_id = ANY(${`{${[t.root, t.a, t.b].join(',')}}`}::uuid[])`)
    expect(feed?.n).toBe(1)
  })
})
