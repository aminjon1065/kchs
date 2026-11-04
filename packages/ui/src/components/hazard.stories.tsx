import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '../primitives/button.js'
import { HAZARD_LEVELS, HazardBadge, type HazardLevel, HazardMark, OpsBand } from './hazard.js'

const meta = {
  title: 'Компоненты/Шкала обстановки',
  id: 'components-hazard',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const LABELS: Record<HazardLevel, string> = {
  0: 'Норма',
  1: 'Внимание',
  2: 'Опасно',
  3: 'Чрезвычайно',
}

export const Scale: Story = {
  name: 'Шкала',
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        {HAZARD_LEVELS.map((level) => (
          <HazardMark key={level} level={level} size="lg" label={LABELS[level]} />
        ))}
      </div>
      <div className="flex items-center gap-3">
        {HAZARD_LEVELS.map((level) => (
          <HazardMark key={level} level={level} />
        ))}
        {HAZARD_LEVELS.map((level) => (
          <HazardMark key={level} level={level} size="sm" />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {HAZARD_LEVELS.map((level) => (
          <HazardBadge key={level} level={level}>
            {LABELS[level]}
          </HazardBadge>
        ))}
      </div>
    </div>
  ),
}

export const Band: Story = {
  name: 'Полоса обстановки',
  render: () => (
    <div className="flex max-w-[1100px] flex-col gap-3 bg-canvas">
      {([1, 2, 3] as const).map((level) => (
        <OpsBand
          key={level}
          level={level}
          levelLabel={LABELS[level]}
          title="Снежная лавина"
          details="Айни, Варзоб · перевал Анзоб"
          meta="до 05.11.2026, 18:00 · ещё 2"
          actions={
            <Button size="sm" variant="secondary">
              Открыть
            </Button>
          }
        />
      ))}
    </div>
  ),
}
