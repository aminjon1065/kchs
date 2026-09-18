import { FieldDef, type FieldSchema } from '@kchs/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { KIND_LABELS } from '../stories/incidents.js'
import { type FormValues, InlineProperties, SchemaForm } from './schema-form.js'

const meta = {
  title: 'Композиты/Форма из схемы',
  id: 'composites-schema-form',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

type FieldInput = Omit<Partial<FieldDef>, 'label'> &
  Pick<FieldDef, 'key' | 'type'> & {
    label: string
  }

/** Поле схемы с умолчаниями контракта (FieldDef.parse заполняет default). */
function field({ label, ...rest }: FieldInput, order: number): FieldDef {
  return FieldDef.parse({ ...rest, label: { ru: label }, order })
}

const DISTRICTS: Record<string, string[]> = {
  rrp: ['Вахдат', 'Варзоб', 'Гиссар', 'Рудаки', 'Файзабад'],
  khatlon: ['Бохтар', 'Кулоб', 'Дангара', 'Муминобод'],
  sughd: ['Айни', 'Истаравшан', 'Панджакент'],
  gbao: ['Ишкашим', 'Рушан', 'Шугнан'],
}

const REPORT: Pick<FieldSchema, 'fields' | 'groups' | 'columns'> = {
  columns: 2,
  groups: [
    { key: 'details', label: { ru: 'Подробности' }, collapsed: false },
    { key: 'contacts', label: { ru: 'Контакты' }, collapsed: true },
  ],
  fields: [
    field({ key: 'title', label: 'Краткое описание', type: 'text', required: true }, 1),
    field(
      {
        key: 'kind',
        label: 'Вид происшествия',
        type: 'select',
        required: true,
        options: Object.entries(KIND_LABELS).map(([value, label]) => ({
          value,
          label: { ru: label },
        })),
      },
      2,
    ),
    field(
      {
        key: 'region',
        label: 'Регион',
        type: 'select',
        required: true,
        options: [
          { value: 'rrp', label: { ru: 'Районы республиканского подчинения' } },
          { value: 'khatlon', label: { ru: 'Хатлонская область' } },
          { value: 'sughd', label: { ru: 'Согдийская область' } },
          { value: 'gbao', label: { ru: 'ГБАО' } },
        ],
      },
      3,
    ),
    field(
      {
        key: 'district',
        label: 'Район',
        type: 'select',
        required: true,
        description: 'Список зависит от региона',
      },
      4,
    ),
    field({ key: 'reported_at', label: 'Время сообщения', type: 'datetime', required: true }, 5),
    field(
      {
        key: 'victims',
        label: 'Пострадавшие',
        type: 'integer',
        validation: { min: 0 },
        default: 0,
      },
      6,
    ),
    field({ key: 'evacuation', label: 'Проводилась эвакуация', type: 'boolean' }, 7),
    field(
      {
        key: 'evacuated',
        label: 'Эвакуировано, человек',
        type: 'integer',
        validation: { min: 1 },
        requiredIf: { field: 'evacuation', op: 'is_true' },
        description: 'Обязательно, если проводилась эвакуация',
      },
      8,
    ),
    field(
      {
        key: 'description',
        label: 'Обстановка',
        type: 'long_text',
        group: 'details',
        validation: { maxLength: 2000 },
        placeholder: 'Что произошло, какие объекты затронуты, какие силы задействованы',
      },
      9,
    ),
    field(
      {
        key: 'measures',
        label: 'Принятые меры',
        type: 'multi_select',
        group: 'details',
        options: [
          { value: 'rescue', label: { ru: 'Спасательные работы' } },
          { value: 'shelter', label: { ru: 'Временное размещение' } },
          { value: 'medical', label: { ru: 'Медицинская помощь' } },
          { value: 'road', label: { ru: 'Перекрытие дороги' } },
        ],
      },
      10,
    ),
    field(
      { key: 'contact_phone', label: 'Телефон дежурного', type: 'phone', group: 'contacts' },
      11,
    ),
    field({ key: 'contact_email', label: 'Почта для связи', type: 'email', group: 'contacts' }, 12),
  ],
}

const FILLED: FormValues = {
  title: 'Сход селя на автодороге Душанбе — Чанак',
  kind: 'mudflow',
  region: 'rrp',
  district: 'Варзоб',
  reported_at: '2026-09-12T06:15:00.000Z',
  victims: 2,
  evacuation: true,
  evacuated: 48,
  description: 'Селевой поток перекрыл дорогу на 120 м, повреждены две опоры ЛЭП.',
  measures: ['rescue', 'road'],
}

function FormDemo({ initial, readOnly }: { initial: FormValues; readOnly?: boolean }) {
  const [values, setValues] = useState<FormValues>(initial)
  return (
    <div className="max-w-[760px]">
      <SchemaForm
        schema={REPORT}
        values={values}
        onChange={setValues}
        onSubmit={() => undefined}
        submitLabel="Отправить донесение"
        readOnly={readOnly}
        optionsFor={(def, current) =>
          def.key === 'district'
            ? (DISTRICTS[String(current.region ?? '')] ?? []).map((name) => ({
                value: name,
                label: name,
              }))
            : undefined
        }
      />
    </div>
  )
}

export const Report: Story = {
  name: 'Донесение о происшествии',
  render: () => <FormDemo initial={{ victims: 0 }} />,
}

export const ValidationErrors: Story = {
  name: 'Ошибки проверки и условная обязательность',
  render: () => (
    <FormDemo
      initial={{
        title: 'Паводок',
        evacuation: true,
        victims: -1,
        contact_email: 'дежурный@',
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Отправить донесение' }))
    await canvas.findByText(/Проверьте/)
    // «Эвакуировано» обязательно только при включённой эвакуации (requiredIf)
    await expect(canvas.getByLabelText(/Эвакуировано, человек/)).toBeInTheDocument()
    // Ошибка в свёрнутой группе «Контакты» не прячется: группа раскрылась
    await expect(canvas.getByRole('button', { name: 'Контакты' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await canvas.findByText('Некорректный адрес почты')
  },
}

export const HiddenFieldFocus: Story = {
  name: 'Ошибка в свёрнутой группе получает фокус',
  render: () => <FormDemo initial={{ ...FILLED, contact_email: 'дежурный@' }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Отправить донесение' }))
    // Единственная ошибка — в свёрнутой группе: группа раскрыта, поле в фокусе
    await waitFor(() => expect(canvas.getByLabelText('Почта для связи')).toHaveFocus())
  },
}

export const ReadOnly: Story = {
  name: 'Только чтение',
  render: () => <FormDemo initial={FILLED} readOnly />,
}

function PropertiesDemo({ readOnly }: { readOnly?: boolean }) {
  const [values, setValues] = useState<FormValues>({ ...FILLED, evacuated: null })
  return (
    <div className="max-w-[420px] rounded-md border border-line bg-surface p-3">
      <InlineProperties
        schema={{ fields: REPORT.fields.filter((def) => !def.group) }}
        values={values}
        readOnly={readOnly}
        onCommit={async (key, value) => setValues((current) => ({ ...current, [key]: value }))}
      />
    </div>
  )
}

export const Properties: Story = {
  name: 'Свойства на месте',
  render: () => <PropertiesDemo />,
}

export const PropertyEditing: Story = {
  name: 'Свойства на месте — правка',
  render: () => <PropertiesDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const [firstEdit] = canvas.getAllByRole('button', { name: 'Изменить' })
    if (firstEdit) await userEvent.click(firstEdit)
    // Контрол правки озвучен названием свойства
    await canvas.findByRole('textbox', { name: 'Краткое описание' })
  },
}

export const PropertiesReadOnly: Story = {
  name: 'Свойства — только чтение',
  render: () => <PropertiesDemo readOnly />,
}
