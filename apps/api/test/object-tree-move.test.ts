import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Перенос поддерева и окончательное удаление (ADR-0220): замыкание предков пересчитывается
 * двумя запросами, а не тремя на каждый узел; результат — тот же, что и расчёт по родителям.
 */
registerLifecycle()

const { ObjectService } = await import('../src/kernel/objects/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

/** Дерево папок: ширина `width` на каждом уровне, глубина `depth`; корень — первый id. */
async function folderTree(width: number, depth: number, title: string): Promise<string[]> {
  const ctx = systemCtx('test', { initiatorId: fx.admin.id })
  return db().transaction(async (tx) => {
    const root = await ObjectService.create(tx, ctx, {
      type: 'folder',
      spaceId: fx.spaceId,
      title,
    })
    const ids = [root.id]
    let level = [root.id]
    for (let d = 0; d < depth; d++) {
      const next: string[] = []
      for (const parentId of level) {
        for (let w = 0; w < width; w++) {
          const child = await ObjectService.create(tx, ctx, {
            type: 'folder',
            spaceId: fx.spaceId,
            parentId,
            title: `${title} ${d}.${w}`,
          })
          next.push(child.id)
          ids.push(child.id)
        }
      }
      level = next
    }
    return ids
  })
}

/** Массив uuid одним параметром (drizzle разворачивает массив JS в список). */
const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`

/** Замыкание по указателям на родителя — эталон для сверки таблицы предков. */
async function closureMismatches(ids: string[]): Promise<number> {
  const rows = await db().execute<{ n: number }>(sql`
    WITH RECURSIVE chain(object_id, ancestor_id, depth) AS (
      SELECT id, parent_id, 1 FROM objects WHERE id = ANY(${uuidArray(ids)}) AND parent_id IS NOT NULL
      UNION ALL
      SELECT c.object_id, o.parent_id, c.depth + 1
        FROM chain c JOIN objects o ON o.id = c.ancestor_id WHERE o.parent_id IS NOT NULL
    ),
    stored AS (
      SELECT object_id, ancestor_id, depth FROM object_ancestors WHERE object_id = ANY(${uuidArray(ids)})
    )
    SELECT count(*)::int AS n FROM (
      (SELECT * FROM chain EXCEPT SELECT * FROM stored)
      UNION ALL
      (SELECT * FROM stored EXCEPT SELECT * FROM chain)
    ) diff`)
  return rows[0]?.n ?? -1
}

describe('замыкание дерева объектов', () => {
  it('перенос поддерева в другую ветку и в корень — предки совпадают с расчётом по родителям', async () => {
    const source = await folderTree(2, 3, 'Источник')
    const target = await folderTree(2, 2, 'Цель')
    const ctx = systemCtx('test', { initiatorId: fx.admin.id })
    // Средний узел источника (с потомками) — под глубокий узел цели
    const moved = source[1] as string
    const deepTarget = target.at(-1) as string
    await db().transaction((tx) => ObjectService.move(tx, ctx, moved, { parentId: deepTarget }))
    expect(await closureMismatches([...source, ...target])).toBe(0)
    // И в корень пространства
    await db().transaction((tx) => ObjectService.move(tx, ctx, moved, { parentId: null }))
    expect(await closureMismatches([...source, ...target])).toBe(0)
  })

  it('перенос папки с ~500 вложенными объектами — без запроса на каждый узел', async () => {
    const tree = await folderTree(8, 3, 'Большая') // 1 + 8 + 64 + 512 = 585 узлов
    const target = await folderTree(1, 1, 'Новое место')
    const ctx = systemCtx('test', { initiatorId: fx.admin.id })
    const started = performance.now()
    await db().transaction((tx) =>
      ObjectService.move(tx, ctx, tree[0] as string, { parentId: target[1] as string }),
    )
    // Было: по три запроса на узел, 1–2 с на 585 узлов; стало: два запроса, десятки мс
    expect(performance.now() - started).toBeLessThan(1000)
    expect(await closureMismatches([...tree, ...target])).toBe(0)
  })

  it('окончательное удаление корзины: корень, затем потомки — ни объектов, ни замыкания', async () => {
    const tree = await folderTree(3, 2, 'Удаляемая')
    const ctx = systemCtx('test', { initiatorId: fx.admin.id })
    await db().transaction((tx) => ObjectService.trash(tx, ctx, tree[0] as string))
    // Как проход trash.purge: каждый объект корзины — своей транзакцией
    for (const id of tree) await db().transaction((tx) => ObjectService.purge(tx, ctx, id))
    const rows = await db().execute<{ objects: number; ancestors: number }>(sql`
      SELECT (SELECT count(*)::int FROM objects WHERE id = ANY(${uuidArray(tree)})) AS objects,
             (SELECT count(*)::int FROM object_ancestors
               WHERE object_id = ANY(${uuidArray(tree)})) AS ancestors`)
    expect(rows[0]).toEqual({ objects: 0, ancestors: 0 })
  })
})
