import type { StylePalette } from '@kchs/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Card } from '../components/data-display.js'
import { Field } from '../primitives/input.js'
import { MapColorPicker, MapIconPicker, MapPalettePicker } from './map-style-controls.js'
import { useMapTheme } from './map-theme.js'

const meta = {
  title: 'Карты/Элементы стиля',
  id: 'maps-style-controls',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** Тема карты прочитана из CSS-переменных — образцы в цветах текущей темы. */
async function themeReady({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> {
  await waitFor(() => {
    const frames = [...canvasElement.querySelectorAll('[data-theme-state]')]
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) expect(frame.getAttribute('data-theme-state')).toBe('ready')
  })
}

/** Рамка истории: тема карты по своему элементу, как у редактора стиля. */
function Themed({
  className,
  children,
}: {
  className?: string
  children: (theme: ReturnType<typeof useMapTheme>) => ReactNode
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(element)
  return (
    <div ref={setElement} data-theme-state={theme ? 'ready' : 'pending'} className={className}>
      {children(theme)}
    </div>
  )
}

function Palette({ initial, label }: { initial: StylePalette; label: string }) {
  const [value, setValue] = useState(initial)
  return (
    <Themed>
      {(theme) => (
        <Field label={label} htmlFor={`palette-${initial.name}`}>
          <MapPalettePicker
            id={`palette-${initial.name}`}
            aria-label={label}
            value={value}
            onChange={setValue}
            theme={theme}
            classes={7}
          />
        </Field>
      )}
    </Themed>
  )
}

function Color({ initial, label, auto }: { initial: string; label: string; auto?: boolean }) {
  const [value, setValue] = useState(initial)
  const id = `color-${initial.replace(/[^a-z0-9]/gi, '')}`
  return (
    <Themed>
      {(theme) => (
        <Field label={label} htmlFor={id}>
          <MapColorPicker
            id={id}
            value={value}
            onChange={setValue}
            theme={theme}
            allowAuto={auto}
            aria-label={label}
          />
        </Field>
      )}
    </Themed>
  )
}

function Icon({ initial, label }: { initial: string | null; label: string }) {
  const [value, setValue] = useState(initial)
  const id = `icon-${initial ?? 'none'}`
  return (
    <Field label={label} htmlFor={id}>
      <MapIconPicker id={id} value={value} onChange={setValue} color="#C0392B" aria-label={label} />
    </Field>
  )
}

export const Controls: Story = {
  name: 'Палитры, цвета и значки',
  play: themeReady,
  render: () => (
    <div className="w-[720px]">
      <Card title="Стиль слоя «Объекты защиты»">
        <div className="grid grid-cols-2 gap-4">
          <Palette initial={{ name: 'blue', reverse: false }} label="Палитра классов" />
          <Palette initial={{ name: 'red-blue', reverse: true }} label="Расходящаяся, обратная" />
          <Color initial="categorical.3" label="Цвет точек" />
          <Color initial="#1F6FEB" label="Свой цвет" />
          <Color initial="auto" label="Обводка" auto />
          <Color initial="danger" label="Опасные объекты" />
          <Icon initial="hospital" label="Значок больниц" />
          <Icon initial={null} label="Значок по умолчанию" />
        </div>
        <CompactRows />
      </Card>
    </div>
  ),
}

/** Компактный вид — строки категорий: только образец цвета и значок. */
function CompactRows() {
  const [rows, setRows] = useState([
    { value: 'Школа', color: 'categorical.1', icon: 'school' as string | null },
    { value: 'Больница', color: 'danger', icon: 'hospital' as string | null },
    { value: 'Прочее', color: 'other', icon: null as string | null },
  ])
  return (
    <Themed className="mt-4 flex flex-col gap-1.5">
      {(theme) =>
        rows.map((row, index) => (
          <div key={row.value} className="flex items-center gap-1.5 text-sm text-fg">
            <MapColorPicker
              compact
              value={row.color}
              theme={theme}
              aria-label={`Цвет категории «${row.value}»`}
              onChange={(color) =>
                setRows((current) =>
                  current.map((item, i) => (i === index ? { ...item, color } : item)),
                )
              }
            />
            <MapIconPicker
              compact
              value={row.icon}
              color="#1F6FEB"
              aria-label={`Значок категории «${row.value}»`}
              onChange={(icon) =>
                setRows((current) =>
                  current.map((item, i) => (i === index ? { ...item, icon } : item)),
                )
              }
            />
            <span>{row.value}</span>
          </div>
        ))
      }
    </Themed>
  )
}

export const ColorOpen: Story = {
  name: 'Выбор цвета',
  play: async (context) => {
    await themeReady(context)
    const canvas = within(context.canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /Обводка/ }))
    const dialog = await within(document.body).findByRole('dialog')
    // Поповер появляется с анимацией: ждём, пока образцы станут видимыми
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Категория 1' })).toBeVisible(),
    )
  },
  render: () => (
    <div className="h-[520px] w-[320px]">
      <Color initial="categorical.2" label="Обводка" auto />
    </div>
  ),
}

export const IconOpen: Story = {
  name: 'Выбор значка',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /Значок больниц/ }))
    const dialog = await within(document.body).findByRole('dialog')
    await expect(within(dialog).getByRole('button', { name: 'Больница' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  },
  render: () => (
    <div className="h-[400px] w-[340px]">
      <Icon initial="hospital" label="Значок больниц" />
    </div>
  ),
}

export const PaletteOpen: Story = {
  name: 'Выбор палитры',
  // Открытый Select (Radix) скрывает страницу через aria-hidden, а кнопка «Обратный
  // порядок» рядом остаётся в порядке фокуса (aria-hidden-focus) — как у «Выпадающий
  // список — открыт»; закрытое состояние проверяется в «Палитры, цвета и значки».
  tags: ['no-axe'],
  play: async (context) => {
    await themeReady(context)
    const canvas = within(context.canvasElement)
    await userEvent.click(canvas.getByRole('combobox', { name: 'Палитра классов' }))
    await within(document.body).findByRole('listbox')
  },
  render: () => (
    <div className="h-[380px] w-[320px]">
      <Palette initial={{ name: 'viridis', reverse: false }} label="Палитра классов" />
    </div>
  ),
}
