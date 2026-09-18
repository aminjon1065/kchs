import type { Meta, StoryObj } from '@storybook/react-vite'

/**
 * Шрифты дизайн-системы (03-ui/02-design-system.md §Типографика): шкала Inter,
 * тексты на трёх языках интерфейса и моноширинный JetBrains Mono. Визуальный тест
 * visual/fonts.spec.ts проверяет по этой истории, что каждый знак блоков с
 * атрибутом data-font нарисован собственными шрифтами, а не системными.
 */
const meta = {
  title: 'Основы/Типографика',
  id: 'foundations-typography',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const SCALE = [
  ['2xl', 'text-2xl', 'Паводковая обстановка'],
  ['xl', 'text-xl', 'Сводка по районам'],
  ['lg', 'text-lg', 'Уровень воды в реке Вахш'],
  ['md', 'text-md', 'Оперативная сводка за сутки'],
  ['base', 'text-base', 'Эвакуированы жители двух подъездов'],
  ['sm', 'text-sm', 'Подтопление подвалов на улице Рудаки'],
  ['xs', 'text-xs', 'Обновлено 18 сентября в 14:05'],
  ['2xs', 'text-2xs', 'Источник: Агентство по гидрометеорологии'],
] as const

export const Scale: Story = {
  name: 'Шкала и языки',
  render: () => (
    <div className="flex max-w-[720px] flex-col gap-6 text-fg">
      <section className="flex flex-col gap-2">
        {SCALE.map(([name, className, sample]) => (
          <div key={name} className="flex items-baseline gap-4">
            <span className="w-10 shrink-0 font-mono text-2xs text-fg-muted">{name}</span>
            <span data-font="sans" className={className}>
              {sample}
            </span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-1.5 text-base">
        <p data-font="sans" lang="ru">
          Съешь же ещё этих мягких французских булок, да выпей чаю.
        </p>
        <p data-font="sans" lang="tg">
          Ҳукумати Ҷумҳурии Тоҷикистон: ғарқоб, қатъи роҳ, ӯ ва ӣ — ҒғӢӣҚқӮӯҲҳҶҷ.
        </p>
        <p data-font="sans" lang="en">
          The quick brown fox jumps over the lazy dog.
        </p>
        <p data-font="sans" className="font-semibold">
          Полужирный: Ҳисор, Ӯротеппа, Қӯрғонтеппа
        </p>
      </section>

      <section className="flex flex-col gap-1.5 text-base">
        <p data-font="sans" className="tabular">
          1 234 567,89 · 6 9 0 · 2026 · 412 см
        </p>
      </section>

      <section className="flex flex-col gap-1.5 font-mono text-sm">
        <p data-font="mono">KCH-2026-0142 · 38.5598° N, 68.7870° E</p>
        <p data-font="mono" lang="tg">
          Ҳисор-12 · Ӯротеппа · ҒғӢӣҚқӮӯҲҳҶҷ
        </p>
        <p data-font="mono">SELECT district, sum(level) FROM ds.floods WHERE level != 0</p>
      </section>
    </div>
  ),
}
