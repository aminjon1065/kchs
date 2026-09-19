import { eq, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { db, type Executor } from '~/shared/db/client.js'
import { yjsDocuments } from '~/shared/db/schema/index.js'

/**
 * Состояние документов Yjs в Postgres — `yjs.documents` (05-data-model.md):
 * одно полное обновление на объект. Запись сливается с сохранённым: если
 * документ правили через другой процесс, его изменения не теряются, а попадают
 * и в открытый документ этого процесса.
 */
export const CollabStore = {
  async load(objectId: string, executor: Executor = db()): Promise<Uint8Array | null> {
    const [row] = await executor
      .select({ state: yjsDocuments.state })
      .from(yjsDocuments)
      .where(eq(yjsDocuments.objectId, objectId))
      .limit(1)
    return row ? new Uint8Array(row.state) : null
  },

  /** Состояние нового объекта — в транзакции его создания. */
  async create(tx: Executor, objectId: string, state: Uint8Array): Promise<void> {
    await tx
      .insert(yjsDocuments)
      .values({ objectId, state: Buffer.from(state) })
      .onConflictDoNothing()
  },

  /**
   * Запись документа. Строка блокируется до конца транзакции: то, что записал
   * другой процесс и чего нет в документе, сначала применяется к нему (с
   * `origin` — без повторного сохранения), затем пишется объединённое состояние.
   */
  async save(tx: Executor, objectId: string, doc: Y.Doc, origin: unknown): Promise<void> {
    const [row] = await tx
      .select({ state: yjsDocuments.state })
      .from(yjsDocuments)
      .where(eq(yjsDocuments.objectId, objectId))
      .for('update')
      .limit(1)
    if (row) {
      const missing = Y.diffUpdate(new Uint8Array(row.state), Y.encodeStateVector(doc))
      Y.applyUpdate(doc, missing, origin)
    }
    const state = Buffer.from(Y.encodeStateAsUpdate(doc))
    await tx
      .insert(yjsDocuments)
      .values({ objectId, state })
      .onConflictDoUpdate({
        target: yjsDocuments.objectId,
        set: { state, updatedAt: sql`now()` },
      })
  },
}
