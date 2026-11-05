import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HazardLegend } from './hazard-legend.js'
import type { OverlayRow } from './overlay-layers.js'

const row = (overrides: Partial<OverlayRow> = {}): OverlayRow => ({
  id: 'warnings',
  label: 'Зоны предупреждений',
  count: 2,
  levels: [1, 2],
  visible: true,
  ...overrides,
})

/** Легенда шкалы на карте (ADR-0230): цвет уровня всегда с римской цифрой и словом. */
describe('легенда шкалы обстановки', () => {
  it('уровни зон видимых наложений — цифрой и словом', () => {
    render(<HazardLegend rows={[row()]} />)
    const legend = screen.getByRole('region', { name: 'Обстановка' })
    expect(legend.textContent).toContain('Зоны предупреждений')
    expect(legend.textContent).toContain('I')
    expect(legend.textContent).toContain('Внимание')
    expect(legend.textContent).toContain('II')
    expect(legend.textContent).toContain('Опасно')
    expect(legend.textContent).not.toContain('Чрезвычайно')
  })

  it('наложение скрыто — легенды нет', () => {
    const { container } = render(<HazardLegend rows={[row({ visible: false })]} />)
    expect(container.textContent).toBe('')
  })
})
