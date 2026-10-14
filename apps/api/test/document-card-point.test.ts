import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Точка в реквизитах документа (ADR-0221): тип карточки допускает геометрию только
 * точкой; значение — строго GeoJSON Point в границах координат, лишние ключи отбрасываются;
 * поиск и печать получают точку текстом, а не объектом.
 */
registerLifecycle()

const run = Date.now().toString(36)
let fx: TestContext
let typeId = ''

beforeAll(async () => {
  fx = await setupFixture()
})

describe('точка в реквизитах документа', () => {
  it('тип: поле-точка разрешено, линия и полигон — нет', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/document-types',
      as: fx.admin,
      payload: {
        key: `field_report_${run}`,
        name: { ru: 'Донесение с места' },
        direction: 'internal',
        cardSchema: {
          fields: [
            { key: 'location', label: { ru: 'Место' }, type: 'geometry', geometryType: 'point' },
          ],
        },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    typeId = created.json().id as string

    for (const geometryType of ['polygon', 'line', undefined]) {
      const refused = await call(fx.app, {
        method: 'PATCH',
        url: `/document-types/${typeId}`,
        as: fx.admin,
        payload: {
          cardSchema: {
            fields: [
              {
                key: 'area',
                label: { ru: 'Зона' },
                type: 'geometry',
                ...(geometryType ? { geometryType } : {}),
              },
            ],
          },
        },
      })
      expect(refused.statusCode, `${geometryType}: ${refused.body}`).toBe(400)
      expect(refused.json().errors?.[0]?.message ?? refused.body).toContain('unsupported_type')
    }
  })

  it('документ: точка сохраняется без лишних ключей; вне границ и не точка — отказ', async () => {
    const saved = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: fx.users.member,
      payload: {
        typeId,
        subject: `Подмыв дамбы ${run}`,
        fields: {
          location: { type: 'Point', coordinates: [68.787038, 38.559772], crs: 'лишнее' },
        },
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const card = await call(fx.app, { url: `/documents/${saved.json().id}`, as: fx.users.member })
    expect(card.json().fields.location).toEqual({
      type: 'Point',
      coordinates: [68.787038, 38.559772],
    })

    for (const location of [
      { type: 'Point', coordinates: [68.7, 95] },
      { type: 'Point', coordinates: [181, 38.5] },
      { type: 'Point', coordinates: ['68.7', 38.5] },
      {
        type: 'LineString',
        coordinates: [
          [68.7, 38.5],
          [68.8, 38.6],
        ],
      },
      { type: 'Point', coordinates: [68.7] },
    ]) {
      const refused = await call(fx.app, {
        method: 'POST',
        url: '/documents',
        as: fx.users.member,
        payload: { typeId, subject: `Неверная точка ${run}`, fields: { location } },
      })
      expect(refused.statusCode, JSON.stringify(location)).toBe(400)
      expect(refused.body).toContain('invalid_point')
    }

    // Пустое место — можно: поле не обязательное
    const empty = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: fx.users.member,
      payload: { typeId, subject: `Без места ${run}`, fields: { location: null } },
    })
    expect(empty.statusCode, empty.body).toBe(200)
  })
})
