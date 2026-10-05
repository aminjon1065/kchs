import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

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
const { withMigratorConnection } = await import('../src/shared/db/migrate.js')
const { encryptSecret } = await import('../src/shared/crypto/secrets.js')
const { credentials, mfaFactors, recoveryCodes } = await import('../src/shared/db/schema/index.js')
const { newId } = await import('../src/shared/ids.js')

let fx: TestContext
const run = Date.now().toString(36)

async function auditCount(action: string, objectId?: string): Promise<number> {
  const rows = await db().execute<{ n: number }>(
    objectId
      ? sql`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action} AND object_id = ${objectId}`
      : sql`SELECT count(*)::int AS n FROM audit_log WHERE action = ${action}`,
  )
  return rows[0]?.n ?? 0
}

async function outboxCount(type: string, objectId: string): Promise<number> {
  const rows = await db().execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ops.outbox
         WHERE type = ${type} AND event->'object'->>'id' = ${objectId}`,
  )
  return rows[0]?.n ?? 0
}

/** Запись события этого типа в outbox падает — как сбой посреди операции. */
async function withFailingOutbox<T>(type: string, action: () => Promise<T>): Promise<T> {
  await withMigratorConnection(async (migrator) => {
    await migrator.unsafe(`CREATE OR REPLACE FUNCTION ops.test_fail_outbox() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = '${type}' THEN RAISE EXCEPTION 'outbox недоступен'; END IF;
        RETURN NEW;
      END $fn$`)
    await migrator.unsafe('DROP TRIGGER IF EXISTS test_fail_outbox ON ops.outbox')
    await migrator.unsafe(`CREATE TRIGGER test_fail_outbox BEFORE INSERT ON ops.outbox
      FOR EACH ROW EXECUTE FUNCTION ops.test_fail_outbox()`)
  })
  try {
    return await action()
  } finally {
    await withMigratorConnection(async (migrator) => {
      await migrator.unsafe('DROP TRIGGER IF EXISTS test_fail_outbox ON ops.outbox')
      await migrator.unsafe('DROP FUNCTION IF EXISTS ops.test_fail_outbox()')
    })
  }
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

describe('операции входа и безопасности — одной транзакцией', () => {
  it('сброс второго фактора: сбой события оставляет факторы и коды, без аудита', async () => {
    const user = fx.users.stranger
    await db()
      .insert(mfaFactors)
      .values({
        id: newId(),
        userId: user.id,
        kind: 'totp',
        secretEnc: encryptSecret('JBSWY3DPEHPK3PXP'),
        name: 'Приложение',
        verifiedAt: new Date().toISOString(),
      })
    await db().insert(recoveryCodes).values({ id: newId(), userId: user.id, codeHash: run })
    const factorsOf = async () =>
      (await db().select().from(mfaFactors).where(eq(mfaFactors.userId, user.id))).length
    const codesOf = async () =>
      (await db().select().from(recoveryCodes).where(eq(recoveryCodes.userId, user.id))).length
    const reset = () =>
      call(fx.app, { method: 'POST', url: `/users/${user.id}/reset-mfa`, as: fx.admin })

    const failed = await withFailingOutbox('user.mfa_disabled', reset)
    expect(failed.statusCode).toBeGreaterThanOrEqual(500)
    expect(await factorsOf()).toBe(1)
    expect(await codesOf()).toBe(1)
    expect(await auditCount('user.mfa_disabled', user.id)).toBe(0)

    const done = await reset()
    expect(done.statusCode, done.body).toBe(200)
    expect(await factorsOf()).toBe(0)
    expect(await codesOf()).toBe(0)
    expect(await auditCount('user.mfa_disabled', user.id)).toBe(1)
    expect(await outboxCount('user.mfa_disabled', user.id)).toBe(1)
  })

  it('смена пароля: сбой события не меняет пароль и не пишет аудит', async () => {
    const user = fx.users.member
    const hashOf = async () =>
      (await db().select().from(credentials).where(eq(credentials.userId, user.id)))[0]
        ?.passwordHash
    const before = await hashOf()
    const failed = await withFailingOutbox('user.password_changed', () =>
      call(fx.app, {
        method: 'POST',
        url: '/me/password',
        as: user,
        payload: {
          currentPassword: user.password,
          newPassword: `Новый-Пароль-${run}-2026!`,
          revokeOtherSessions: true,
        },
      }),
    )
    expect(failed.statusCode).toBeGreaterThanOrEqual(500)
    expect(await hashOf()).toBe(before)
    expect(await auditCount('user.password_changed', user.id)).toBe(0)
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
