import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithClient } from '~/test/render.js'
import { PointField } from './point-field.js'

/**
 * Поле-точка карточки документа (ADR-0221): без права правки место всё равно видно —
 * «Показать на карте» открывает карту с точкой только для просмотра.
 */
vi.mock('@kchs/ui', async (original) => ({
  ...(await original<typeof import('@kchs/ui')>()),
  // Карта MapLibre в happy-dom не поднимается — подменяется подписанной областью
  MapCanvas: (props: { 'aria-label'?: string; controls?: ReactNode }) => (
    <div role="region" aria-label={props['aria-label']} />
  ),
  useMapTheme: () => null,
}))
vi.mock('../basemaps.js', () => ({
  registerPmtilesProtocol: () => undefined,
  useBasemapStyle: () => ({ style: null, auto: true, basemap: null }),
}))
vi.mock('../basemap-switcher.js', () => ({ BasemapSwitcher: () => null }))

const field = { key: 'location', label: { ru: 'Место' }, type: 'geometry' as const }
const point = { type: 'Point', coordinates: [68.787038, 38.559772] }

function render(disabled: boolean, value: unknown = point) {
  const onChange = vi.fn()
  renderWithClient(
    <PointField
      id="location"
      field={field as never}
      value={value}
      onChange={onChange}
      invalid={false}
      disabled={disabled}
    />,
  )
  return { onChange }
}

describe('PointField', () => {
  it('без права правки: «Показать на карте» — карта с местом, без полей и «Применить»', async () => {
    const user = userEvent.setup()
    render(true)
    expect(screen.queryByRole('button', { name: 'Убрать точку' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Показать на карте' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('region', { name: 'Карта с местом' })).toBeInTheDocument()
    expect(within(dialog).getByText('38.55977, 68.78704')).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Применить' })).toBeNull()
    expect(within(dialog).queryByLabelText('Широта')).toBeNull()
  })

  it('с правом правки: точку можно убрать, «Показать на карте» не нужен', () => {
    render(false)
    expect(screen.getByRole('button', { name: 'Убрать точку' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Показать на карте' })).toBeNull()
  })

  it('без точки и без права правки — смотреть нечего', () => {
    render(true, null)
    expect(screen.queryByRole('button', { name: 'Показать на карте' })).toBeNull()
  })
})
