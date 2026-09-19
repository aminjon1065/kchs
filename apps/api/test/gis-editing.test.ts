import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Правка объектов слоя и модерация правок (07-gis-engine.md §7, ADR-0076):
 * запись строки через слой с проверкой геометрии, версией строки и событиями
 * `feature.*`; предложения модерируемого слоя — от подачи до применения и
 * отклонения; политика строк не даёт видеть и править чужие строки.
 */
registerLifecycle()

const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
/** Участник пространства (роль member → comment): предлагает правки. */
let suggester: TestUser
let datasetId: string
let layerId: string
const run = Date.now().toString(36)

const square = (lon: number, lat: number, size: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ],
})

/** Внешнее кольцо по часовой стрелке — сервер разворачивает его (RFC 7946). */
const clockwise = (lon: number, lat: number, size: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lon, lat],
      [lon, lat + size],
      [lon + size, lat + size],
      [lon + size, lat],
      [lon, lat],
    ],
  ],
})

const editing = (as: TestUser = fx.admin) =>
  call(fx.app, { url: `/gis/layers/${layerId}/editing`, as })

const patchLayer = (payload: Record<string, unknown>) =>
  call(fx.app, { method: 'PATCH', url: `/gis/layers/${layerId}`, as: fx.admin, payload })

const createFeature = (payload: Record<string, unknown>, as: TestUser = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/gis/layers/${layerId}/features`, as, payload })

const submit = (payload: Record<string, unknown>, as: TestUser = suggester) =>
  call(fx.app, { method: 'POST', url: `/gis/layers/${layerId}/edits`, as, payload })

const review = (editId: string, payload: Record<string, unknown>, as: TestUser = fx.admin) =>
  call(fx.app, {
    method: 'POST',
    url: `/gis/layers/${layerId}/edits/${editId}/review`,
    as,
    payload,
  })

async function outbox(type: string) {
  return db().execute<{ payload: Record<string, unknown>; object: Record<string, unknown> }>(
    sql`SELECT event->'payload' AS payload, event->'object' AS object FROM ops.outbox
         WHERE type = ${type} AND event->'object'->>'id' = ${layerId} ORDER BY id`,
  )
}

async function inboxItems(user: TestUser) {
  const response = await call(fx.app, { url: '/inbox?state=open', as: user })
  expect(response.statusCode, response.body).toBe(200)
  return (
    response.json().items as Array<{
      id: string
      kind: string
      title: string
      object: { id: string } | null
      payload: Record<string, unknown>
      actions: Array<{ key: string; requiresComment: boolean }>
    }>
  ).filter((item) => item.kind === 'review_edit' && item.object?.id === layerId)
}

/** Подписчики уведомлений по неопубликованным событиям outbox — как воркер. */
async function drainOutbox(): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'gis-feature-notifications')) {
    const { registerGisBackground } = await import('../src/modules/gis/module.js')
    registerGisBackground()
  }
  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 1000`,
  )
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (subscriber.name !== 'gis-feature-notifications') continue
      if (!matchesType(subscriber.types, event.type)) continue
      await subscriber.handle(event as never)
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

beforeAll(async () => {
  fx = await setupFixture()
  suggester = await createUser(fx.app, 'suggester_gis', ['employee'])
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, suggester.id, 'member'),
  )
  await redis().del(`kchs:principals:${suggester.id}`)

  // Пустой датасет: тип слоя — из описания поля геометрии
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Зоны затопления ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'name', label: { ru: 'Название' }, type: 'text', required: true },
        {
          key: 'level',
          label: { ru: 'Уровень' },
          type: 'select',
          options: [
            { value: 'low', label: { ru: 'Низкий' } },
            { value: 'high', label: { ru: 'Высокий' } },
          ],
        },
        { key: 'depth', label: { ru: 'Глубина, м' }, type: 'number' },
        {
          key: 'area',
          label: { ru: 'Контур' },
          type: 'geometry',
          semantic: 'geometry',
          geometryType: 'polygon',
        },
      ],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const layer = await call(fx.app, {
    method: 'POST',
    url: '/gis/layers',
    as: fx.admin,
    payload: { name: `Зоны затопления ${run}`, spaceId: fx.spaceId, datasetId },
  })
  expect(layer.statusCode, layer.body).toBe(200)
  layerId = layer.json().id
})

describe('режим правки', () => {
  it('пустой датасет — слой полигонов по описанию поля; правка выключена, пока слой не редактируемый', async () => {
    const record = await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.admin })
    expect(record.json()).toMatchObject({ geometryType: 'polygon', editable: false })
    expect((await editing()).json()).toEqual({
      mode: 'none',
      reason: 'layer_readonly',
      canReview: false,
      pending: 0,
    })
    const write = await createFeature({ values: { name: 'Зона' }, geometry: square(69, 38, 0.1) })
    expect(write.statusCode).toBe(403)
  })

  it('редактируемый слой: владелец и редактор — напрямую, участник и читатель — нет, посторонний — 404', async () => {
    expect((await patchLayer({ editable: true })).statusCode).toBe(200)
    expect((await editing()).json()).toMatchObject({ mode: 'direct', reason: null })
    expect((await editing(fx.users.member)).json()).toMatchObject({ mode: 'direct' })
    expect((await editing(suggester)).json()).toMatchObject({ mode: 'none', reason: 'no_rights' })
    expect((await editing(fx.users.viewer)).json()).toMatchObject({
      mode: 'none',
      reason: 'no_rights',
    })
    expect((await editing(fx.users.stranger)).statusCode).toBe(404)
  })
})

describe('правка напрямую', () => {
  let rowId: string

  it('создание: строка с геометрией, кольцо против часовой стрелки, события в одной транзакции', async () => {
    const created = await createFeature({
      values: { name: 'Пойма Вахша', level: 'high', depth: 1.5 },
      geometry: clockwise(69, 38, 0.1),
    })
    expect(created.statusCode, created.body).toBe(200)
    const feature = created.json()
    rowId = feature.id
    expect(feature).toMatchObject({ ver: 1, values: { name: 'Пойма Вахша', level: 'high' } })
    const ring = feature.geometry.coordinates[0] as number[][]
    // Правило правой руки: второй узел — на востоке от первого, а не на севере
    expect(ring[1]).toEqual([69.1, 38])

    const read = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: fx.users.viewer,
    })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().geometry.type).toBe('Polygon')

    expect((await outbox('feature.created')).map((row) => row.payload)).toEqual([
      { datasetId, rowId, editId: null },
    ])
    const changed = await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ops.outbox
           WHERE type = 'dataset.rows_changed' AND event->'object'->>'id' = ${datasetId}`,
    )
    expect(changed[0]?.count).toBe(1)
    const layer = await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.admin })
    expect(layer.json()).toMatchObject({ featureCount: 1 })
    expect(layer.json().datasetVersion).toBeGreaterThan(1)
  })

  it('проверки: тип геометрии слоя, геометрия в значениях, вырожденный полигон, обязательные поля', async () => {
    const point = await createFeature({
      values: { name: 'Точка' },
      geometry: { type: 'Point', coordinates: [69, 38] },
    })
    expect(point.statusCode).toBe(400)
    expect(point.json().errors[0]).toMatchObject({ path: 'geometry', code: 'geometry_type' })

    const inValues = await createFeature({
      values: { name: 'Двойная', area: square(69, 38, 0.1) },
      geometry: square(69, 38, 0.1),
    })
    expect(inValues.statusCode).toBe(400)

    const flat = await createFeature({
      values: { name: 'Линия' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            // Точно на одной прямой (половины представимы без погрешности)
            [69, 38],
            [69.5, 38.5],
            [70, 39],
            [69, 38],
          ],
        ],
      },
    })
    expect(flat.statusCode).toBe(400)
    expect(flat.json().errors[0]).toMatchObject({ code: 'geometry_degenerate' })

    const noName = await createFeature({ values: {}, geometry: square(69, 38, 0.1) })
    expect(noName.statusCode).toBe(400)
    expect(noName.json().errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'name', code: 'required' })]),
    )
  })

  it('самопересекающийся контур исправляется в составной полигон', async () => {
    const bowtie = await createFeature({
      values: { name: 'Бабочка' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [70, 38],
            [70.1, 38.1],
            [70.1, 38],
            [70, 38.1],
            [70, 38],
          ],
        ],
      },
    })
    expect(bowtie.statusCode, bowtie.body).toBe(200)
    expect(bowtie.json().geometry.type).toBe('MultiPolygon')
  })

  it('правка с версией; устаревшая — 409 с текущими значениями и изменёнными полями', async () => {
    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: fx.users.member,
      payload: { values: { depth: 2 }, geometry: square(69.05, 38, 0.1), ver: 1 },
    })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json()).toMatchObject({ ver: 2, values: { depth: 2, name: 'Пойма Вахша' } })

    const stale = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: fx.admin,
      payload: { values: { name: 'Устаревшая' }, ver: 1 },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().data.current._ver).toBe(2)
    expect(stale.json().data.changedFields).toEqual(expect.arrayContaining(['depth', 'area']))

    const updated = await outbox('feature.updated')
    expect(updated.map((row) => row.payload)).toEqual([
      { datasetId, rowId, editId: null, fields: ['depth', 'area'] },
    ])

    // История строки хранит прежнюю геометрию — «как было» и откат одной правки
    const history = await call(fx.app, {
      url: `/datasets/${datasetId}/rows/${rowId}/history`,
      as: fx.admin,
    })
    expect(history.statusCode, history.body).toBe(200)
    const [last] = history.json().items
    expect(last).toMatchObject({ op: 'update', ver: 2 })
    expect(last.previous.area.coordinates[0][0]).toEqual([69, 38])
    expect(last.values.area.coordinates[0][0]).toEqual([69.05, 38])

    const reverted = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: fx.admin,
      payload: { values: { depth: last.previous.depth }, geometry: last.previous.area, ver: 2 },
    })
    expect(reverted.statusCode, reverted.body).toBe(200)
    expect(reverted.json()).toMatchObject({ ver: 3, values: { depth: 1.5 } })
    expect(reverted.json().geometry.coordinates[0][0]).toEqual([69, 38])
  })

  it('читатель и участник не правят (403), посторонний — 404', async () => {
    for (const user of [fx.users.viewer, suggester]) {
      const write = await call(fx.app, {
        method: 'PATCH',
        url: `/gis/layers/${layerId}/features/${rowId}`,
        as: user,
        payload: { values: { depth: 9 }, ver: 3 },
      })
      expect(write.statusCode, user.login).toBe(403)
    }
    const stranger = await createFeature(
      { values: { name: 'Чужая' }, geometry: square(69, 38, 0.1) },
      fx.users.stranger,
    )
    expect(stranger.statusCode).toBe(404)
  })

  it('удаление той версии, что видел пользователь; устаревшая — 409', async () => {
    const extra = await createFeature({ values: { name: 'Лишняя' }, geometry: square(71, 38, 0.1) })
    const id = extra.json().id as string
    const stale = await call(fx.app, {
      method: 'DELETE',
      url: `/gis/layers/${layerId}/features/${id}?ver=7`,
      as: fx.admin,
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().data.current._ver).toBe(1)
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/gis/layers/${layerId}/features/${id}?ver=1`,
      as: fx.admin,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect((await outbox('feature.deleted')).map((row) => row.payload)).toEqual([
      { datasetId, rowId: id, editId: null },
    ])
    const gone = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${id}`,
      as: fx.admin,
    })
    expect(gone.statusCode).toBe(404)
  })
})

describe('модерация правок', () => {
  let rowId: string
  let createdEdit: string

  it('модерируемый слой: участник предлагает на проверку, напрямую — 403; читатель не предлагает', async () => {
    expect((await patchLayer({ moderated: true })).statusCode).toBe(200)
    expect((await editing(suggester)).json()).toEqual({
      mode: 'suggest',
      reason: 'no_rights',
      canReview: false,
      pending: 0,
    })
    expect((await editing()).json()).toMatchObject({ mode: 'direct', canReview: true })
    const direct = await createFeature(
      { values: { name: 'Напрямую' }, geometry: square(69, 39, 0.1) },
      suggester,
    )
    expect(direct.statusCode).toBe(403)
    const viewer = await submit(
      { op: 'create', values: { name: 'Читатель' }, geometry: square(69, 39, 0.1) },
      fx.users.viewer,
    )
    expect(viewer.statusCode).toBe(403)
  })

  it('подача: значения проверены, правка ждёт проверки, владельцу — дело во Входящих', async () => {
    const invalid = await submit({
      op: 'create',
      values: { name: 'Без уровня', level: 'extreme' },
      geometry: square(69, 39, 0.1),
    })
    expect(invalid.statusCode).toBe(400)

    const submitted = await submit({
      op: 'create',
      values: { name: 'Новая зона', level: 'low' },
      geometry: clockwise(69, 39, 0.1),
      note: 'По данным обхода',
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const edit = submitted.json()
    createdEdit = edit.id
    expect(edit).toMatchObject({
      op: 'create',
      status: 'pending',
      rowId: null,
      values: { name: 'Новая зона', level: 'low' },
      note: 'По данным обхода',
      author: { id: suggester.id },
      reviewer: null,
    })
    // Геометрия предложения — уже исправленная, как её запишет строка
    expect(edit.geometry.coordinates[0][1]).toEqual([69.1, 39])

    expect((await outbox('feature.edit_submitted')).map((row) => row.payload)).toEqual([
      { editId: createdEdit, op: 'create', datasetId, rowId: null, authorId: suggester.id },
    ])
    const [item] = await inboxItems(fx.admin)
    expect(item).toMatchObject({
      payload: { editId: createdEdit, op: 'create' },
      actions: [
        { key: 'approve', requiresComment: false },
        { key: 'reject', requiresComment: true },
      ],
    })
    expect(item?.title).toContain(`Зоны затопления ${run}`)

    expect((await editing(suggester)).json().pending).toBe(1)
    expect((await editing()).json().pending).toBe(1)
    const layer = await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.admin })
    expect(layer.json().featureCount).toBe(2)
  })

  it('список: проверяющему — все правки, участнику — свои, читателю — ничего', async () => {
    const all = await call(fx.app, { url: `/gis/layers/${layerId}/edits`, as: fx.users.member })
    expect(all.json().items.map((item: { id: string }) => item.id)).toEqual([createdEdit])
    const own = await call(fx.app, { url: `/gis/layers/${layerId}/edits`, as: suggester })
    expect(own.json().items).toHaveLength(1)
    const viewer = await call(fx.app, { url: `/gis/layers/${layerId}/edits`, as: fx.users.viewer })
    expect(viewer.json().items).toEqual([])
  })

  it('принятие применяет правку строкой, закрывает дело и сообщает автору', async () => {
    const forbidden = await review(createdEdit, { decision: 'approve' }, suggester)
    expect(forbidden.statusCode).toBe(403)

    const approved = await review(createdEdit, { decision: 'approve' })
    expect(approved.statusCode, approved.body).toBe(200)
    rowId = approved.json().rowId
    expect(approved.json()).toMatchObject({ status: 'approved', reviewer: { id: fx.admin.id } })
    expect(rowId).toMatch(/^\d+$/)

    const feature = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: suggester,
    })
    expect(feature.json()).toMatchObject({ ver: 1, values: { name: 'Новая зона', level: 'low' } })
    expect((await outbox('feature.created')).at(-1)?.payload).toEqual({
      datasetId,
      rowId,
      editId: createdEdit,
    })
    expect((await outbox('feature.edit_reviewed')).map((row) => row.payload)).toEqual([
      {
        editId: createdEdit,
        op: 'create',
        decision: 'approved',
        datasetId,
        rowId,
        authorId: suggester.id,
      },
    ])
    expect(await inboxItems(fx.admin)).toEqual([])

    const again = await review(createdEdit, { decision: 'reject' })
    expect(again.statusCode).toBe(409)

    await drainOutbox()
    const notes = await db().execute<{ user_id: string; title_key: string }>(
      sql`SELECT user_id, title_key FROM notifications WHERE object_id = ${layerId} ORDER BY id`,
    )
    expect(notes.map((row) => [row.user_id, row.title_key])).toEqual([
      [fx.admin.id, 'notifications.tpl.featureEditSubmitted'],
      [suggester.id, 'notifications.tpl.featureEditApproved'],
    ])
  })

  it('строку изменили после подачи — 409 с текущими значениями; «применить всё равно»', async () => {
    const submitted = await submit({
      op: 'update',
      rowId,
      ver: 1,
      values: { depth: 3 },
      geometry: square(69.02, 39, 0.1),
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const editId = submitted.json().id as string

    const direct = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: fx.admin,
      payload: { values: { name: 'Новая зона (уточнена)' }, ver: 1 },
    })
    expect(direct.statusCode, direct.body).toBe(200)

    const stale = await submit({ op: 'update', rowId, ver: 1, values: { depth: 4 } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().data.current._ver).toBe(2)

    const conflict = await review(editId, { decision: 'approve' })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().data.current._ver).toBe(2)
    expect(conflict.json().data.changedFields).toContain('name')

    const forced = await review(editId, { decision: 'approve', force: true })
    expect(forced.statusCode, forced.body).toBe(200)
    const feature = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: fx.admin,
    })
    expect(feature.json()).toMatchObject({
      ver: 3,
      values: { name: 'Новая зона (уточнена)', depth: 3 },
    })
    expect(feature.json().geometry.coordinates[0][0]).toEqual([69.02, 39])
  })

  it('отклонение с комментарием: строка не меняется, автору — уведомление', async () => {
    const submitted = await submit({ op: 'delete', rowId, ver: 3, note: 'Зона устарела' })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const editId = submitted.json().id as string

    const rejected = await review(editId, { decision: 'reject', comment: 'Зона ещё действует' })
    expect(rejected.statusCode, rejected.body).toBe(200)
    expect(rejected.json()).toMatchObject({ status: 'rejected', comment: 'Зона ещё действует' })
    const feature = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: fx.admin,
    })
    expect(feature.statusCode).toBe(200)

    await drainOutbox()
    const notes = await db().execute<{ title_key: string }>(
      sql`SELECT title_key FROM notifications WHERE user_id = ${suggester.id} ORDER BY id`,
    )
    expect(notes.map((row) => row.title_key)).toContain('notifications.tpl.featureEditRejected')
  })

  it('решение из Входящих: «Принять» применяет удаление', async () => {
    const submitted = await submit({ op: 'delete', rowId, ver: 3 })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const [item] = await inboxItems(fx.admin)
    expect(item?.payload.op).toBe('delete')
    const acted = await call(fx.app, {
      method: 'POST',
      url: `/inbox/${item?.id}/act`,
      as: fx.admin,
      payload: { action: 'approve' },
    })
    expect(acted.statusCode, acted.body).toBe(200)
    const gone = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${rowId}`,
      as: fx.admin,
    })
    expect(gone.statusCode).toBe(404)
    const edits = await call(fx.app, {
      url: `/gis/layers/${layerId}/edits?status=approved&scope=mine`,
      as: suggester,
    })
    expect(edits.json().items.map((edit: { op: string }) => edit.op)).toEqual([
      'delete',
      'update',
      'create',
    ])
  })
})

describe('политика строк', () => {
  let visibleRow: string
  let hiddenRow: string

  it('читатель с политикой строк не видит чужие строки и не правит их', async () => {
    const a = await createFeature({
      values: { name: 'Своя', level: 'low' },
      geometry: square(72, 38, 0.1),
    })
    const b = await createFeature({
      values: { name: 'Чужая', level: 'high' },
      geometry: square(72.5, 38, 0.1),
    })
    visibleRow = a.json().id
    hiddenRow = b.json().id
    for (const user of [fx.users.member, suggester]) {
      await db().execute(
        sql`INSERT INTO dataset_row_policies (id, dataset_id, principal_type, principal_id, filter)
            VALUES (gen_random_uuid(), ${datasetId}, 'user', ${user.id},
                    ${JSON.stringify({ field: 'level', op: 'eq', value: 'low' })}::jsonb)`,
      )
    }

    // Редактор под политикой строк напрямую не правит — только предлагает
    expect((await editing(fx.users.member)).json()).toMatchObject({
      mode: 'suggest',
      reason: 'row_policy',
      canReview: false,
    })
    const direct = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}/features/${visibleRow}`,
      as: fx.users.member,
      payload: { values: { depth: 1 }, ver: 1 },
    })
    expect(direct.statusCode).toBe(403)

    const hidden = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${hiddenRow}`,
      as: suggester,
    })
    expect(hidden.statusCode).toBe(404)
    const listed = await call(fx.app, { url: `/gis/layers/${layerId}/features`, as: suggester })
    const names = listed
      .json()
      .features.map((feature: { id: string }) => feature.id)
      .sort()
    expect(names).toContain(visibleRow)
    expect(names).not.toContain(hiddenRow)

    const foreign = await submit({ op: 'update', rowId: hiddenRow, ver: 1, values: { depth: 5 } })
    expect(foreign.statusCode).toBe(404)
    const own = await submit({ op: 'update', rowId: visibleRow, ver: 1, values: { depth: 5 } })
    expect(own.statusCode, own.body).toBe(200)
  })
})
