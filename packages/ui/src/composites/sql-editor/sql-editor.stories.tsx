import { EditorView } from '@codemirror/view'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { type Ref, useRef, useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Button } from '../../primitives/button.js'
import {
  SqlEditor,
  type SqlEditorDiagnostic,
  type SqlEditorHandle,
  type SqlEditorParam,
  type SqlEditorProps,
  type SqlEditorTable,
} from './index.js'

const meta = {
  title: 'Композиты/SQL-редактор',
  id: 'composites-sql-editor',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

// ─── Схема: датасеты с «человеческими» именами, как их видит пользователь ────

const SCHEMA: SqlEditorTable[] = [
  {
    name: 'Происшествия',
    key: 'incidents',
    columns: [
      { label: 'Дата происшествия', key: 'incident_date', type: 'Дата' },
      { label: 'Район', key: 'district', type: 'Справочник' },
      { label: 'Вид', key: 'kind', type: 'Выбор' },
      { label: 'Пострадавшие', key: 'victims', type: 'Целое число' },
      { label: 'Ущерб, сомони', key: 'damage', type: 'Деньги' },
      { label: 'Координаты', key: 'location', type: 'Геометрия' },
    ],
  },
  {
    name: 'Районы',
    key: 'districts',
    columns: [
      { label: 'Район', key: 'name', type: 'Текст' },
      { label: 'Область', key: 'region', type: 'Выбор' },
      { label: 'Население', key: 'population', type: 'Целое число' },
    ],
  },
  {
    name: 'Паводки 2024',
    key: 'floods_2024',
    columns: [
      { label: 'Река', key: 'river', type: 'Текст' },
      { label: 'Уровень воды, см', key: 'water_level', type: 'Число' },
    ],
  },
]

const PARAMS: SqlEditorParam[] = [
  { name: 'from', label: 'Начало периода' },
  { name: 'to', label: 'Конец периода' },
  { name: 'region', label: 'Область' },
]

const QUERY = `-- Районы с наибольшим ущербом за период
SELECT п.Район,
       count(*) AS "Число происшествий",
       sum(п."Ущерб, сомони") AS ущерб
FROM Происшествия AS п
WHERE п."Дата происшествия" BETWEEN {{from}} AND {{to}}
GROUP BY п.Район
ORDER BY ущерб DESC
LIMIT 10;`

function Demo({
  initial,
  editorRef,
  ...props
}: Omit<SqlEditorProps, 'value'> & {
  initial: string
  editorRef?: Ref<SqlEditorHandle>
}) {
  const [value, setValue] = useState(initial)
  const [runs, setRuns] = useState(0)
  return (
    <div className="flex w-[720px] flex-col gap-2">
      <SqlEditor
        ref={editorRef}
        value={value}
        onChange={setValue}
        onRun={() => setRuns((count) => count + 1)}
        schema={SCHEMA}
        params={PARAMS}
        {...props}
      />
      <p className="text-xs text-fg-muted" data-testid="runs">
        {runs > 0 ? `Выполнено: ${runs}` : 'Ctrl+Enter — выполнить'}
      </p>
    </div>
  )
}

/** Редактор загружен (ленивый чанк CodeMirror) и нарисован. */
async function editorReady(canvasElement: HTMLElement): Promise<EditorView> {
  await waitFor(
    () =>
      expect(canvasElement.querySelector('[data-sql-editor-state]')).toHaveAttribute(
        'data-sql-editor-state',
        'ready',
      ),
    { timeout: 15_000 },
  )
  const dom = canvasElement.querySelector<HTMLElement>('.cm-editor')
  const view = dom ? EditorView.findFromDOM(dom) : null
  if (!view) throw new Error('редактор не найден')
  return view
}

export const Empty: Story = {
  name: 'Пустой',
  render: () => <Demo initial="" />,
  play: async ({ canvasElement }) => {
    await editorReady(canvasElement)
  },
}

export const WithCompletion: Story = {
  name: 'С запросом и автодополнением',
  render: () => (
    <div className="min-h-[560px]">
      <Demo initial={QUERY} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const view = await editorReady(canvasElement)
    // Курсор — после условия WHERE; пользователь набирает `AND п.` — открывается список полей
    const at = view.state.doc.toString().indexOf('\nGROUP BY')
    await userEvent.click(within(canvasElement).getByRole('textbox', { name: 'SQL-запрос' }))
    view.dispatch({ selection: { anchor: at } })
    view.dispatch({
      changes: { from: at, insert: '\n  AND п.' },
      selection: { anchor: at + 9 },
      userEvent: 'input.type',
    })
    const list = await within(document.body).findByRole('listbox', { name: 'Подсказки' })
    await expect(within(list).getByRole('option', { name: /Дата происшествия/ })).toBeVisible()
    await expect(within(list).getAllByRole('option')).toHaveLength(6)
  },
}

const ERRORS: SqlEditorDiagnostic[] = [
  {
    from: QUERY.replace('Происшествия AS', 'Происшествие AS').indexOf('Происшествие AS'),
    message: 'Таблица «Происшествие» не найдена. Возможно, имелась в виду «Происшествия»',
  },
]

export const WithError: Story = {
  name: 'С ошибкой',
  render: function Render() {
    const ref = useRef<SqlEditorHandle>(null)
    return (
      <div className="min-h-[360px]">
        <Demo
          initial={QUERY.replace('Происшествия AS', 'Происшествие AS')}
          diagnostics={ERRORS}
          editorRef={ref}
          aria-describedby="sql-error"
        />
        <Button
          className="mt-2"
          size="sm"
          onClick={() => ref.current?.select(ERRORS[0]?.from ?? 0)}
        >
          К ошибке
        </Button>
        <p id="sql-error" className="mt-2 text-sm text-danger">
          Запрос не выполнен: таблица не найдена
        </p>
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    await editorReady(canvasElement)
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('textbox', { name: 'SQL-запрос' })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    // Курсор на ошибке — подсказка с текстом видна и без мыши
    await userEvent.click(canvas.getByRole('button', { name: 'К ошибке' }))
    await waitFor(() =>
      expect(
        canvasElement.querySelector('.cm-tooltip-lint .cm-diagnosticText')?.textContent,
      ).toMatch(/не найдена/),
    )
  },
}

export const ReadOnly: Story = {
  name: 'Только чтение',
  render: () => <Demo initial={QUERY} readOnly height={220} />,
  play: async ({ canvasElement }) => {
    await editorReady(canvasElement)
    await expect(
      within(canvasElement).getByRole('textbox', { name: 'SQL-запрос' }),
    ).toHaveAttribute('aria-readonly', 'true')
  },
}

export const DarkTheme: Story = {
  name: 'Тёмная тема',
  render: function Render() {
    // Тема приложения — атрибут data-theme на <html> (apps/web/src/app/appearance.ts)
    const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light')
    const toggle = () => {
      const next = theme === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = next
      setTheme(next)
    }
    return (
      <div className="flex flex-col items-start gap-3">
        <Button size="sm" onClick={toggle}>
          {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        </Button>
        <Demo initial={QUERY} lineNumbers={false} />
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const view = await editorReady(canvasElement)
    const canvas = within(canvasElement)
    const field = getComputedStyle(view.dom.parentElement?.parentElement as HTMLElement)
    // Снимок — всегда в тёмной теме: из светлой переключаемся один раз, из тёмной — туда и обратно
    if (document.documentElement.dataset.theme === 'dark') {
      const dark = field.backgroundColor
      await userEvent.click(canvas.getByRole('button', { name: 'Светлая тема' }))
      await waitFor(() => expect(field.backgroundColor).not.toBe(dark))
    }
    const light = field.backgroundColor
    await userEvent.click(canvas.getByRole('button', { name: 'Тёмная тема' }))
    await waitFor(() => expect(field.backgroundColor).not.toBe(light))
    // Тот же экземпляр редактора: тема — CSS-переменные, пересоздания нет
    await expect(canvasElement.querySelector('.cm-editor')).toBe(view.dom)
  },
}
