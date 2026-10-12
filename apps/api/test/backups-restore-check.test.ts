import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Проверка восстановления на резервном узле (ADR-0199): `dr.sh restore-check`
 * сообщает итог токеном служебной записи с областью `write:backups` и
 * способностью `backups.report` — без входа администратором. Удачная проверка
 * копии `pg_dump` отмечает копию; история видна администратору в консоли.
 */
registerLifecycle()

const { auditLog, backups } = await import('../src/db-schema.js')
const { newId } = await import('../src/shared/ids.js')

const run = Date.now().toString(36)
let fx: TestContext
let roleKey = ''
let reporter: { id: string }
let secret = ''

const report = (token: string, payload: Record<string, unknown>) =>
  call(fx.app, {
    method: 'POST',
    url: '/backups/restore-checks',
    headers: { authorization: `Bearer ${token}` },
    payload,
  })

const now = () => new Date().toISOString()

async function issue(scopes: string[], userId = reporter.id): Promise<string> {
  const issued = await call(fx.app, {
    method: 'POST',
    url: '/me/api-tokens',
    as: fx.admin,
    payload: { name: `Резервный узел ${run} ${scopes.join(',')}`, scopes, userId },
  })
  expect(issued.statusCode, issued.body).toBe(200)
  return issued.json().secret as string
}

beforeAll(async () => {
  fx = await setupFixture()
  // Своя роль только со способностью отчёта — без администрирования
  const role = await call(fx.app, {
    method: 'POST',
    url: '/roles',
    as: fx.admin,
    payload: { name: { ru: `Резервный узел ${run}` }, capabilities: ['backups.report'] },
  })
  expect(role.statusCode, role.body).toBe(200)
  roleKey = role.json().key as string
  const account = await call(fx.app, {
    method: 'POST',
    url: '/service-accounts',
    as: fx.admin,
    payload: { name: `Резервный узел ${run}`, roleKeys: [roleKey] },
  })
  expect(account.statusCode, account.body).toBe(200)
  reporter = account.json()
  secret = await issue(['write:backups'])
})

describe('проверка восстановления на резервном узле', () => {
  it('служебная запись сообщает итог токеном; удачная проверка pg_dump отмечает копию', async () => {
    const backupId = newId()
    await db()
      .insert(backups)
      .values({
        id: backupId,
        status: 'done',
        key: `pg/test-${run}.dump`,
        sizeBytes: 1024,
        finishedAt: now(),
      })

    const started = now()
    const saved = await report(secret, {
      kind: 'dump',
      ok: true,
      startedAt: started,
      finishedAt: now(),
      backupId,
      recoveredTo: started,
      host: 'dr-node',
      details: 'pg_restore — без ошибок; таблиц 160; api отвечает',
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ kind: 'dump', ok: true, backupId, host: 'dr-node' })

    const [backup] = await db().select().from(backups).where(eq(backups.id, backupId))
    expect(backup?.verifiedAt).not.toBeNull()
    expect(backup?.verifiedBy).toBe(reporter.id)
    expect(backup?.verifiedNote).toContain('dr-node')

    const entries = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'backup.restore_checked'))
    expect(entries.some((entry) => entry.actorId === reporter.id)).toBe(true)

    const listed = await call(fx.app, { url: '/admin/backups/restore-checks', as: fx.admin })
    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json().items[0]).toMatchObject({ id: saved.json().id, ok: true })
  })

  it('неудачная проверка архива WAL — предупреждение в аудите, копии не отмечаются', async () => {
    const saved = await report(secret, {
      kind: 'pitr',
      ok: false,
      startedAt: now(),
      finishedAt: now(),
      details: 'restore_command: нет сегмента 000000010000000000000042',
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const entries = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'backup.restore_checked'))
    const failed = entries.find((entry) => entry.details.checkId === saved.json().id)
    expect(failed?.severity).toBe('warning')
    expect(failed?.details).toMatchObject({ kind: 'pitr', ok: false })
  })

  it('без области, без способности и без токена — отказ; чужая копия — 404', async () => {
    const readOnly = await issue(['read:backups'])
    const body = { kind: 'pitr', ok: true, startedAt: now(), finishedAt: now() }
    expect((await report(readOnly, body)).statusCode).toBe(403)

    // Сотрудник без способности — даже с областью записи
    const employee: TestUser = await createUser(fx.app, `backup_no_cap_${run}`, ['employee'])
    const issued = await call(fx.app, {
      method: 'POST',
      url: '/me/api-tokens',
      as: fx.admin,
      payload: { name: `Без способности ${run}`, scopes: ['write:backups'], userId: employee.id },
    })
    expect(issued.statusCode, issued.body).toBe(200)
    expect((await report(issued.json().secret as string, body)).statusCode).toBe(403)

    // Сотрудник своей сессией тоже не сообщает: нет способности
    const session = await call(fx.app, {
      method: 'POST',
      url: '/backups/restore-checks',
      as: employee,
      payload: body,
    })
    expect(session.statusCode).toBe(403)

    expect((await report('kchs_nope_nope', body)).statusCode).toBe(401)
    const unknown = await report(secret, { ...body, kind: 'dump', backupId: newId() })
    expect(unknown.statusCode).toBe(404)

    // История — только администратору
    const foreign = await call(fx.app, { url: '/admin/backups/restore-checks', as: employee })
    expect(foreign.statusCode).toBe(403)
  })
})
