import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Атомарность входа и прав (ADR-0177): действия после фиксации транзакции, аудит в
 * транзакции операции через точку сохранения, сброс кэша принципалов после коммита.
 */
registerLifecycle()

const { afterCommit } = await import('../src/shared/db/client.js')
const { audit } = await import('../src/kernel/audit/service.js')
const { getPrincipalSet } = await import('../src/kernel/access/principal-set.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
const run = Date.now().toString(36)

async function auditCount(action: string): Promise<number> {
  const rows = await db().execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`,
  )
  return rows[0]?.n ?? 0
}

beforeAll(async () => {
  fx = await setupFixture()
})

describe('действия после фиксации', () => {
  it('выполняются после коммита, а откат их отбрасывает', async () => {
    const calls: string[] = []
    await db().transaction(async (tx) => {
      await afterCommit(tx, () => {
        calls.push('после фиксации')
      })
      calls.push('в транзакции')
    })
    expect(calls).toEqual(['в транзакции', 'после фиксации'])

    await expect(
      db().transaction(async (tx) => {
        await afterCommit(tx, () => {
          calls.push('отброшено')
        })
        throw new Error('откат')
      }),
    ).rejects.toThrow('откат')
    expect(calls).not.toContain('отброшено')
  })

  it('откат точки сохранения отбрасывает только её действия', async () => {
    const calls: string[] = []
    await db().transaction(async (tx) => {
      await afterCommit(tx, () => {
        calls.push('внешняя')
      })
      await tx.transaction(async (inner) => {
        await afterCommit(inner, () => {
          calls.push('удачная точка')
        })
      })
      await tx
        .transaction(async (inner) => {
          await afterCommit(inner, () => {
            calls.push('откатанная точка')
          })
          throw new Error('откат точки')
        })
        .catch(() => undefined)
    })
    expect(calls).toEqual(['внешняя', 'удачная точка'])
  })

  it('вне транзакции — сразу', async () => {
    const calls: string[] = []
    await afterCommit(db(), () => {
      calls.push('сразу')
    })
    expect(calls).toEqual(['сразу'])
  })
})

describe('аудит в транзакции операции', () => {
  it('сбой записи журнала не обрывает операцию, а откат операции уносит её запись', async () => {
    const action = `test.atomic.${run}`
    await db().transaction(async (tx) => {
      // object_id — UUID: запись падает в Postgres, но транзакция операции живёт дальше
      await audit(systemCtx('test'), { action: `${action}.broken`, objectId: 'не-uuid' }, tx)
      await audit(systemCtx('test'), { action: `${action}.ok` }, tx)
    })
    expect(await auditCount(`${action}.broken`)).toBe(0)
    expect(await auditCount(`${action}.ok`)).toBe(1)

    await db()
      .transaction(async (tx) => {
        await audit(systemCtx('test'), { action: `${action}.rolled` }, tx)
        throw new Error('операция не удалась')
      })
      .catch(() => undefined)
    expect(await auditCount(`${action}.rolled`)).toBe(0)
  })
})

describe('кэш принципалов', () => {
  it('сброс в транзакции — после фиксации: параллельный запрос не оставляет прежний набор', async () => {
    const user = fx.users.viewer
    expect((await getPrincipalSet(user.id)).spaceRoles[fx.spaceId]).toBe('viewer')

    await db().transaction(async (tx) => {
      await SpaceService.removeMember(tx, systemCtx('test'), fx.spaceId, user.id)
      // Параллельный запрос до фиксации читает прежнее состояние и кладёт его в кэш
      expect((await getPrincipalSet(user.id)).spaceRoles[fx.spaceId]).toBe('viewer')
    })

    expect((await getPrincipalSet(user.id)).spaceRoles[fx.spaceId]).toBeUndefined()
    await db().transaction((tx) =>
      SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, user.id, 'viewer'),
    )
    expect((await getPrincipalSet(user.id)).spaceRoles[fx.spaceId]).toBe('viewer')
  })
})
