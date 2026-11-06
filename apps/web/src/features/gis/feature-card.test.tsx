import type { LayerRecord } from '@kchs/contracts'
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { FeatureCard } from './feature-card.js'

/**
 * Карточка объекта по щелчку: справочные поля — подписью, как в таблице датасета
 * (ADR-0057), а не кодом и идентификатором; длинное значение — строкой во всю ширину.
 */
const LAYER_ID = '00000000-0000-4000-8000-00000000b001'
const DATASET_ID = '00000000-0000-4000-8000-00000000b002'
const KINDS_ID = '00000000-0000-4000-8000-00000000b003'
const TERRITORY_ID = '01a1348b-75da-7a71-948c-3902a948fdbb'
const LONG =
  'Тибқи ҳуҷҷатҳои пешниҳоднамудаи Комиссия оид ба ҳолатҳои фавқулоддаи шаҳри Ҳисор бар асари боришоти борон ва сел хисорот расид.'

const layer = {
  id: LAYER_ID,
  name: 'История ЧС 1988–2026',
  datasetId: DATASET_ID,
  systemSource: null,
  geometryField: 'geometry',
  style: { popup: { title: null, fields: ['type_code', 'territory', 'deaths', 'description'] } },
} as unknown as LayerRecord

const dataset = {
  id: DATASET_ID,
  name: 'Происшествия',
  territoryField: 'territory',
  fields: [
    {
      key: 'type_code',
      label: { ru: 'Тип' },
      type: 'text',
      lookup: { datasetId: KINDS_ID, keyField: 'code', labelField: 'name' },
    },
    { key: 'territory', label: { ru: 'Территория' }, type: 'territory' },
    { key: 'deaths', label: { ru: 'Погибшие' }, type: 'integer' },
    { key: 'description', label: { ru: 'Описание' }, type: 'text' },
    { key: 'geometry', label: { ru: 'Место' }, type: 'geometry' },
  ],
}

afterEach(() => vi.restoreAllMocks())

describe('FeatureCard', () => {
  it('вид и территория — подписью; длинное описание — отдельной строкой', async () => {
    stubApi({
      [`/gis/layers/${LAYER_ID}/features/row-1`]: {
        id: 'row-1',
        ver: 1,
        values: { type_code: 'MUDFLOW', territory: TERRITORY_ID, deaths: 2, description: LONG },
        geometry: null,
      },
      [`/datasets/${DATASET_ID}`]: dataset,
      'POST /queries/run': {
        fields: [{ name: 'code' }, { name: 'name' }],
        rows: [['MUDFLOW', 'Сель']],
      },
      '/territories': {
        items: [
          {
            id: TERRITORY_ID,
            code: 'TJ-RRP-HISOR',
            parentId: null,
            level: 'district',
            name: { ru: 'Гиссар' },
            kind: 'город',
            centroid: null,
          },
        ],
      },
    })
    renderWithClient(<FeatureCard layer={layer} rowId="row-1" onClose={() => undefined} />)

    // Вид явления словами — и в заголовке (первое поле), и в строке «Тип»
    expect(await screen.findAllByText('Сель')).toHaveLength(2)
    expect(await screen.findByText('Гиссар')).toBeInTheDocument()
    expect(screen.queryByText('MUDFLOW')).toBeNull()
    expect(screen.queryByText(TERRITORY_ID)).toBeNull()
    // Короткие значения — в списке «подпись — значение», длинные — во всю ширину под ним
    expect(screen.getByText('2').closest('dl')).not.toBeNull()
    expect(screen.getByText(LONG).closest('dl')).toBeNull()
  })
})
