import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { backups } from '../src/db-schema.js'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Резервные копии (P5-E06, 15-admin-operations.md §5): список, копия по
 * требованию и отметка о проверке восстановлением. Сам дамп делает `pg_dump`
 * — там, где его нет (машина разработчика), проверяется честный отказ.
 */
registerLifecycle()

let fx: TestContext
let hasPgDump = false

beforeAll(async () => {
  fx = await setupFixture()
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' })
    hasPgDump = true
  } catch {
    hasPgDump = false
  }
})

describe('резервные копии', () => {
  it('список и запуск — только администратору системы', async () => {
    const read = await call(fx.app, { url: '/admin/backups', as: fx.users.member })
    expect(read.statusCode).toBe(403)
    const write = await call(fx.app, {
      method: 'POST',
      url: '/admin/backups',
      as: fx.users.member,
    })
    expect(write.statusCode).toBe(403)
  })

  it('копия по требованию: удача с дампом, честный отказ без `pg_dump`', async () => {
    const response = await call(fx.app, { method: 'POST', url: '/admin/backups', as: fx.admin })
    expect(response.statusCode, response.body).toBe(200)
    const record = response.json()
    if (hasPgDump) {
      expect(record.status).toBe('done')
      expect(record.sizeBytes).toBeGreaterThan(0)
    } else {
      expect(record.status).toBe('failed')
      expect(record.error).toContain('pg_dump')
    }

    const list = await call(fx.app, { url: '/admin/backups', as: fx.admin })
    expect((list.json().items as unknown[]).length).toBeGreaterThan(0)
  })

  it('отметка о проверке восстановлением сохраняется и идёт в аудит', async () => {
    const id = randomUUID()
    await db()
      .insert(backups)
      .values({ id, status: 'done', key: `pg/${id}.dump`, sizeBytes: 1024 })

    const response = await call(fx.app, {
      method: 'POST',
      url: `/admin/backups/${id}/verified`,
      as: fx.admin,
      payload: { note: 'восстановлено в тестовом контуре' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      verifiedNote: 'восстановлено в тестовом контуре',
    })
    expect(response.json().verifiedAt).toBeTruthy()

    const trail = await call(fx.app, { url: '/admin/audit?action=backup.verified', as: fx.admin })
    expect((trail.json().items as unknown[]).length).toBeGreaterThan(0)
  })

  it('отметка и её аудит — одной транзакцией: время одно, сбой фиксации уносит обе (ADR-0216)', async () => {
    const verify = (id: string) =>
      call(fx.app, {
        method: 'POST',
        url: `/admin/backups/${id}/verified`,
        as: fx.admin,
        payload: { note: 'проверка атомарности' },
      })
    const id = randomUUID()
    await db()
      .insert(backups)
      .values({ id, status: 'done', key: `pg/${id}.dump`, sizeBytes: 1 })
    expect((await verify(id)).statusCode).toBe(200)
    // now() Postgres — время начала транзакции: совпадает только в одной транзакции
    const [same] = await db().execute<{ same: boolean }>(
      sql`SELECT b.verified_at = a.occurred_at AS same FROM ops.backups b
           JOIN audit_log a ON a.action = 'backup.verified' AND a.details->>'backupId' = ${id}
          WHERE b.id = ${id}`,
    )
    expect(same?.same).toBe(true)

    // Фиксация срывается отложенным триггером: нет ни отметки, ни записи аудита
    const failing = randomUUID()
    await db()
      .insert(backups)
      .values({ id: failing, status: 'done', key: `pg/${failing}.dump`, sizeBytes: 1 })
    const { withMigratorConnection } = await import('../src/shared/db/migrate.js')
    const drop = () =>
      withMigratorConnection(async (migrator) => {
        await migrator.unsafe('DROP TRIGGER IF EXISTS test_fail_commit ON ops.backups')
        await migrator.unsafe('DROP FUNCTION IF EXISTS ops.test_fail_commit()')
      })
    await drop()
    try {
      await withMigratorConnection(async (migrator) => {
        await migrator.unsafe(`CREATE FUNCTION ops.test_fail_commit() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'сбой фиксации'; END $$`)
        await migrator.unsafe(`CREATE CONSTRAINT TRIGGER test_fail_commit AFTER UPDATE ON ops.backups
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.id = '${failing}')
          EXECUTE FUNCTION ops.test_fail_commit()`)
      })
      expect((await verify(failing)).statusCode).toBeGreaterThanOrEqual(500)
    } finally {
      await drop()
    }
    const [trail] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM audit_log
           WHERE action = 'backup.verified' AND details->>'backupId' = ${failing}`,
    )
    expect(trail?.total).toBe(0)
    const [row] = await db()
      .select({ verifiedAt: backups.verifiedAt })
      .from(backups)
      .where(eq(backups.id, failing))
    expect(row?.verifiedAt).toBeNull()
  })

  it('копия по расписанию тоже идёт в аудит: иначе её пропажу не заметить', async () => {
    // Задание `backup.run` работает без человека (ctx = null). Раньше такая
    // копия не оставляла записи в аудите — и «копий не делалось» было не
    // отличить от «расписание выключили» (17-security.md §6)
    const { BackupService } = await import('../src/kernel/backup/service.js')
    const record = await BackupService.run(null)

    const action = hasPgDump ? 'backup.created' : 'backup.failed'
    const trail = await call(fx.app, { url: `/admin/audit?action=${action}`, as: fx.admin })
    expect(trail.statusCode, trail.body).toBe(200)
    const items = trail.json().items as { details?: Record<string, unknown> }[]
    const entry = items.find((item) => item.details?.backupId === record.id)
    expect(entry, `нет записи аудита ${action} для ${record.id}`).toBeTruthy()
    expect(entry?.details?.scheduled).toBe(true)
  })

  it('несделанная копия — предупреждение в аудите, а не только строка прогона', async () => {
    // Отказ получается тем же способом, что на машине без клиента PostgreSQL:
    // `pg_dump` не находится. Наружу ошибка не летит (иначе задание ушло бы в
    // повтор и било по базе), но в аудите она обязана быть — серия таких
    // записей означает, что восстанавливать будет нечего
    const path = process.env.PATH
    process.env.PATH = '/kchs-no-such-dir'
    let response: Awaited<ReturnType<typeof call>>
    try {
      response = await call(fx.app, { method: 'POST', url: '/admin/backups', as: fx.admin })
    } finally {
      process.env.PATH = path
    }
    expect(response.statusCode, response.body).toBe(200)
    const record = response.json()
    expect(record.status).toBe('failed')

    const trail = await call(fx.app, { url: '/admin/audit?action=backup.failed', as: fx.admin })
    const items = trail.json().items as { severity?: string; details?: Record<string, unknown> }[]
    const entry = items.find((item) => item.details?.backupId === record.id)
    expect(entry, `нет записи аудита backup.failed для ${record.id}`).toBeTruthy()
    expect(entry?.severity).toBe('warning')
  })

  it('отметка на несуществующей копии — «не найдено»', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: `/admin/backups/${randomUUID()}/verified`,
      as: fx.admin,
      payload: { note: '' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('переиндексация поиска ставится заданием и только администратору', async () => {
    const denied = await call(fx.app, {
      method: 'POST',
      url: '/admin/maintenance/reindex',
      as: fx.users.member,
    })
    expect(denied.statusCode).toBe(403)

    const response = await call(fx.app, {
      method: 'POST',
      url: '/admin/maintenance/reindex',
      as: fx.admin,
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().jobId).toBeTruthy()
  })
})
