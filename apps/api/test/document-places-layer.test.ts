import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Слой «Донесения» (ADR-0223, N161): системный датасет `document_places` с правами
 * смотрящего — строка видна, если смотрящему открыт документ и гриф не строже допуска.
 * Слой над ним показывает место документа только таким смотрящим; тайлы не кэшируются
 * между пользователями, правки на карте нет.
 */
registerLifecycle()

const run = Date.now().toString(36)
// Тайл 6/44/24 покрывает Душанбе
const TILE = '6/44/24'
const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })
let fx: TestContext
let typeKey = ''
let layerId = ''
let openDoc = ''
let secretDoc = ''

const setClearance = (user: TestUser, clearance: string) =>
  call(fx.app, {
    method: 'PUT',
    url: `/users/${user.id}/clearance`,
    as: fx.admin,
    payload: { clearance, reason: 'Допуск по приказу о режиме секретности' },
  })

/** Документы источника, видимые смотрящему, — через запрос к системному датасету. */
async function placeIds(as: TestUser): Promise<string[]> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/queries/run',
    as,
    payload: {
      spec: {
        version: 1,
        source: { kind: 'system', name: 'document_places' },
        steps: [{ type: 'filter', where: { field: 'type_key', op: 'eq', value: typeKey } }],
      },
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json() as { fields: Array<{ name: string }>; rows: unknown[][] }
  const column = body.fields.findIndex((field) => field.name === 'id')
  return body.rows.map((row) => row[column] as string)
}

/** Объекты слоя, видимые смотрящему: идентификатор документа — в свойствах. */
async function layerDocs(as: TestUser): Promise<string[]> {
  const response = await call(fx.app, { url: `/gis/layers/${layerId}/features`, as })
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().features as Array<{ properties: { id: string } }>).map(
    (feature) => feature.properties.id,
  )
}

beforeAll(async () => {
  fx = await setupFixture()
  typeKey = `field_report_${run}`
  const type = await call(fx.app, {
    method: 'POST',
    url: '/document-types',
    as: fx.admin,
    payload: {
      key: typeKey,
      name: { ru: 'Донесение с места' },
      direction: 'internal',
      cardSchema: {
        fields: [
          { key: 'location', label: { ru: 'Место' }, type: 'geometry', geometryType: 'point' },
        ],
      },
    },
  })
  expect(type.statusCode, type.body).toBe(200)

  // Автор с допуском: открытое донесение — только его, конфиденциальное — ещё и ответственного
  expect((await setClearance(fx.users.member, 'confidential')).statusCode).toBe(200)
  const create = async (subject: string, extra: Record<string, unknown>) => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: fx.users.member,
      payload: { typeId: type.json().id, subject, ...extra },
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().id as string
  }
  openDoc = await create(`Подмыв дамбы ${run}`, {
    fields: { location: point(68.787, 38.5598) },
  })
  secretDoc = await create(`Обрушение склада ${run}`, {
    confidentiality: 'confidential',
    responsibleId: fx.users.viewer.id,
    fields: { location: point(68.8, 38.57) },
  })

  const layer = await call(fx.app, {
    method: 'POST',
    url: '/gis/layers',
    as: fx.users.member,
    payload: {
      name: `Донесения ${run}`,
      spaceId: fx.spaceId,
      systemSource: 'document_places',
      style: {
        version: 1,
        geometry: 'point',
        renderer: { kind: 'simple', color: 'warning' },
        filter: { field: 'type_key', op: 'eq', value: typeKey },
        popup: { title: '{{subject}}', fields: ['reg_number', 'type_name', 'id'], actions: [] },
      },
    },
  })
  expect(layer.statusCode, layer.body).toBe(200)
  layerId = layer.json().id as string
})

describe('слой над системным датасетом документов', () => {
  it('слой — над системным источником, без датасета и без правки', async () => {
    const response = await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.users.viewer })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      datasetId: null,
      systemSource: 'document_places',
      geometryField: 'location',
      geometryType: 'point',
      editable: false,
      dataAccess: true,
    })

    const editable = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.users.member,
      payload: {
        name: 'Правка донесений',
        spaceId: fx.spaceId,
        systemSource: 'document_places',
        editable: true,
      },
    })
    expect(editable.statusCode).toBe(400)
    const editing = await call(fx.app, {
      url: `/gis/layers/${layerId}/editing`,
      as: fx.users.member,
    })
    expect(editing.statusCode, editing.body).toBe(200)
    expect(editing.json()).toMatchObject({ mode: 'none', reason: 'layer_readonly' })
    const insert = await call(fx.app, {
      method: 'POST',
      url: `/gis/layers/${layerId}/features`,
      as: fx.users.member,
      payload: { values: {}, geometry: point(68.8, 38.56) },
    })
    expect(insert.statusCode).toBe(403)

    const both = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.users.member,
      payload: { name: 'Два источника', spaceId: fx.spaceId },
    })
    expect(both.statusCode).toBe(400)
  })

  it('посторонний не видит донесение: ни в запросе, ни в объектах, ни в тайле', async () => {
    expect(await placeIds(fx.users.member)).toEqual(expect.arrayContaining([openDoc, secretDoc]))
    expect(await placeIds(fx.users.viewer)).not.toContain(openDoc)
    expect(await layerDocs(fx.users.member)).toContain(openDoc)
    expect(await layerDocs(fx.users.viewer)).not.toContain(openDoc)

    // Сначала тайл автора, затем того же тайла — постороннего: общего кэша нет
    const own = await call(fx.app, {
      url: `/gis/layers/${layerId}/tiles/${TILE}.pbf`,
      as: fx.users.member,
    })
    expect(own.statusCode).toBe(200)
    expect(own.headers['cache-control']).toBe('private, no-cache')
    const foreign = await call(fx.app, {
      url: `/gis/layers/${layerId}/tiles/${TILE}.pbf`,
      as: fx.users.viewer,
    })
    expect(foreign.statusCode).toBe(204)

    // Карточка объекта по щелчку: номер объекта автора постороннему не открывается
    const features = await call(fx.app, {
      url: `/gis/layers/${layerId}/features`,
      as: fx.users.member,
    })
    const feature = (
      features.json().features as Array<{ id: string; properties: { id: string } }>
    ).find((item) => item.properties.id === openDoc)
    expect(feature).toBeDefined()
    const card = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${feature?.id}`,
      as: fx.users.member,
    })
    expect(card.statusCode, card.body).toBe(200)
    expect(card.json().values.subject).toBe(`Подмыв дамбы ${run}`)
    expect(card.json().geometry).toEqual(point(68.787, 38.5598))
    const denied = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${feature?.id}`,
      as: fx.users.viewer,
    })
    expect(denied.statusCode).toBe(404)
  })

  it('конфиденциальное донесение видно только с допуском', async () => {
    // Ответственный — участник документа, но без допуска строки не видит
    expect(await placeIds(fx.users.viewer)).not.toContain(secretDoc)
    expect(await layerDocs(fx.users.viewer)).not.toContain(secretDoc)
    expect(await placeIds(fx.admin)).not.toContain(secretDoc)

    expect((await setClearance(fx.users.viewer, 'confidential')).statusCode).toBe(200)
    expect(await placeIds(fx.users.viewer)).toContain(secretDoc)
    expect(await layerDocs(fx.users.viewer)).toContain(secretDoc)
    // Открытое донесение автора участнику конфиденциального по-прежнему не видно
    expect(await layerDocs(fx.users.viewer)).not.toContain(openDoc)
  })
})
