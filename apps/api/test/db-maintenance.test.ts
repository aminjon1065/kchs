import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Обслуживание базы (ADR-0173): мигратор не принимает правку применённой
 * миграции, журнал аудита разбит на месячные партиции на месяцы вперёд и
 * остаётся только на добавление — в том числе в обход родителя, через партицию;
 * старт нескольких реплик не оставляет роли без способностей и не перестраивает
 * таблицы датасетов наперегонки.
 */
registerLifecycle()

let fx: TestContext

const { runMigrations, withMigratorConnection, EditedMigrationError } = await import(
  '../src/shared/db/migrate.js'
)
const { ensureAuditPartitions } = await import('../src/shared/db/partitions.js')
const { pgErrorCode } = await import('../src/shared/db/pg-error.js')

/** Код ошибки Postgres, с которой упал запрос (или null, если не упал). */
async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return pgErrorCode(error) ?? 'unknown'
  }
}

const INSUFFICIENT_PRIVILEGE = '42501'

beforeAll(async () => {
  fx = await setupFixture()
})

describe('мигратор', () => {
  it('правка применённой миграции останавливает запуск с подсказкой', async () => {
    const [first] = await db().execute<{ name: string; hash: string }>(
      sql`SELECT name, hash FROM public.__migrations ORDER BY name LIMIT 1`,
    )
    if (!first) throw new Error('журнал миграций пуст')
    // Журнал правит только мигратор (ADR-0187) — как и при настоящей правке руками
    await withMigratorConnection(
      (owner) => owner`UPDATE public.__migrations SET hash = 'edited' WHERE name = ${first.name}`,
    )
    try {
      const failure = await runMigrations().then(
        () => null,
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(EditedMigrationError)
      expect((failure as Error).message).toContain(first.name)
      expect((failure as Error).message).toContain(`SET hash = '${first.hash}'`)
    } finally {
      await withMigratorConnection(
        (owner) =>
          owner`UPDATE public.__migrations SET hash = ${first.hash} WHERE name = ${first.name}`,
      )
    }
    await expect(runMigrations()).resolves.toMatchObject({ applied: [] })
  })

  it('журнал миграций приложение только читает; мигратор работает как прежде', async () => {
    const [first] = await db().execute<{ name: string }>(
      sql`SELECT name FROM public.__migrations ORDER BY name LIMIT 1`,
    )
    expect(first?.name).toBeTruthy()
    expect(
      await sqlState(() =>
        db().execute(sql`UPDATE public.__migrations SET hash = hash WHERE false`),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    expect(
      await sqlState(() => db().execute(sql`DELETE FROM public.__migrations WHERE false`)),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    expect(
      await sqlState(() =>
        db().execute(sql`INSERT INTO public.__migrations (name, hash) SELECT 'x', 'x' WHERE false`),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    // Повторный запуск мигратора сверяет журнал и права без ошибок
    await expect(runMigrations()).resolves.toMatchObject({ applied: [] })
  })
})

describe('партиции журнала аудита', () => {
  it('есть на текущий и три следующих месяца', async () => {
    const months = await db().execute<{ name: string; exists: boolean }>(
      sql`SELECT 'audit_log_' || to_char(m, 'YYYY_MM') AS name,
                 to_regclass('public.audit_log_' || to_char(m, 'YYYY_MM')) IS NOT NULL AS exists
            FROM generate_series(date_trunc('month', now()),
                                 date_trunc('month', now()) + interval '3 month',
                                 interval '1 month') AS m`,
    )
    expect(months).toHaveLength(4)
    expect(months.filter((month) => !month.exists).map((month) => month.name)).toEqual([])
  })

  it('только на добавление: правка и удаление в обход родителя запрещены', async () => {
    await db().execute(
      sql`INSERT INTO public.audit_log (action, details) VALUES ('test.append_only', '{}'::jsonb)`,
    )
    const [row] = await db().execute<{ part: string }>(
      sql`SELECT tableoid::regclass::text AS part FROM public.audit_log
           WHERE action = 'test.append_only' ORDER BY id DESC LIMIT 1`,
    )
    expect(row?.part).toMatch(/^audit_log_\d{4}_\d{2}$/)
    const part = row?.part as string

    expect(
      await sqlState(() =>
        db().execute(sql.raw(`DELETE FROM public.${part} WHERE action = 'test.append_only'`)),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    expect(
      await sqlState(() =>
        db().execute(
          sql.raw(`UPDATE public.${part} SET action = 'x' WHERE action = 'test.append_only'`),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    expect(
      await sqlState(() =>
        db().execute(sql`DELETE FROM public.audit_log WHERE action = 'test.append_only'`),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE)
    // Чтение остаётся: его просит pg_dump резервной копии
    expect(
      await sqlState(() => db().execute(sql.raw(`SELECT count(*) FROM public.${part}`))),
    ).toBeNull()
  })

  it('строки месяца без партиции переезжают из партиции по умолчанию', async () => {
    const [far] = await db().execute<{ at: string; name: string }>(
      sql`SELECT to_char(date_trunc('month', now()) + interval '8 month' + interval '3 day',
                         'YYYY-MM-DD"T"HH24:MI:SSOF') AS at,
                 'audit_log_' || to_char(date_trunc('month', now()) + interval '8 month', 'YYYY_MM') AS name`,
    )
    if (!far) throw new Error('нет месяца')
    try {
      await db().execute(
        sql`INSERT INTO public.audit_log (occurred_at, action, details)
            VALUES (${far.at}::timestamptz, 'test.stray', '{}'::jsonb)`,
      )
      const before = await db().execute<{ part: string }>(
        sql`SELECT tableoid::regclass::text AS part FROM public.audit_log WHERE action = 'test.stray'`,
      )
      expect(before.map((row) => row.part)).toEqual(['audit_log_default'])

      const report = await withMigratorConnection((owner) => ensureAuditPartitions(owner))
      expect(report.created).toContain(far.name)
      expect(report.moved).toBe(1)

      const after = await db().execute<{ part: string }>(
        sql`SELECT tableoid::regclass::text AS part FROM public.audit_log WHERE action = 'test.stray'`,
      )
      expect(after.map((row) => row.part)).toEqual([far.name])
      // Новая партиция тоже только на добавление
      expect(
        await sqlState(() =>
          db().execute(sql.raw(`DELETE FROM public.${far.name} WHERE action = 'test.stray'`)),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE)

      // Повтор ничего не делает
      const again = await withMigratorConnection((owner) => ensureAuditPartitions(owner))
      expect(again).toEqual({ created: [], moved: 0 })
    } finally {
      await withMigratorConnection(async (owner) => {
        await owner.unsafe(`DROP TABLE IF EXISTS public.${far.name}`)
        await owner`DELETE FROM public.audit_log_default WHERE action = 'test.stray'`
      })
    }
  })
})

describe('старт нескольких реплик', () => {
  it('способности системной роли сверяются: лишняя удаляется, нужные остаются', async () => {
    const { bootstrapPlatform } = await import('../src/bootstrap.js')
    const [employee] = await db().execute<{ id: string }>(
      sql`SELECT id FROM roles WHERE key = 'employee'`,
    )
    if (!employee) throw new Error('нет роли employee')
    await db().execute(
      sql`INSERT INTO role_capabilities (role_id, capability)
          VALUES (${employee.id}, 'admin.system') ON CONFLICT DO NOTHING`,
    )
    // Две реплики стартуют разом
    await Promise.all([bootstrapPlatform(), bootstrapPlatform()])
    const capabilities = await db().execute<{ capability: string }>(
      sql`SELECT capability FROM role_capabilities WHERE role_id = ${employee.id} ORDER BY 1`,
    )
    expect(capabilities.map((row) => row.capability)).toEqual(['ai.use', 'share_links.create'])
  })

  it('прежний полный индекс ключа перестраивает одна реплика, а не обе наперегонки', async () => {
    const { upgradeModuleStorage } = await import('../src/modules/index.js')
    const created = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Индекс до ADR-0160 ${Date.now().toString(36)}`,
        spaceId: fx.spaceId,
        fields: [{ key: 'code', label: { ru: 'Код' }, type: 'identifier' }],
        primaryKey: ['code'],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const [meta] = await db().execute<{ table: string; column: string }>(
      sql`SELECT d.physical_table AS table, f.physical_column AS column
            FROM datasets d JOIN dataset_fields f ON f.dataset_id = d.id
           WHERE d.id = ${created.json().id as string}`,
    )
    if (!meta) throw new Error('нет таблицы датасета')
    const uniqueIndexes = () =>
      db().execute<{ name: string; def: string }>(
        sql`SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS def
              FROM pg_index x
              JOIN pg_class i ON i.oid = x.indexrelid
              JOIN pg_class t ON t.oid = x.indrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'ds' AND t.relname = ${meta.table}
               AND x.indisunique AND NOT x.indisprimary`,
      )
    // Ключ — полным уникальным индексом, как в таблицах до ADR-0160
    for (const index of await uniqueIndexes()) {
      await db().execute(sql.raw(`DROP INDEX ds."${index.name}"`))
    }
    await db().execute(sql.raw(`CREATE UNIQUE INDEX ON ds."${meta.table}" ("${meta.column}")`))

    await Promise.all([upgradeModuleStorage(), upgradeModuleStorage()])

    const after = await uniqueIndexes()
    expect(after).toHaveLength(1)
    expect(after[0]?.def).toContain('WHERE (_deleted_at IS NULL)')
  })
})
