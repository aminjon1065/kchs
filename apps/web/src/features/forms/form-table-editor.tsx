import type { FieldDef, Locale } from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import { type ControlProps, Field, FieldControl, IconButton, useMediaQuery } from '@kchs/ui'
import { Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { type CellErrors, columnTotals, type TableRow } from './form-table.js'

const labelOf = (field: FieldDef, locale: Locale) => field.label[locale] ?? field.label.ru

/**
 * Таблица строк сводки (ADR-0129): поля формы — столбцами, строки добавляются
 * и удаляются, внизу — «Итого» по числовым столбцам. На узком экране строки
 * идут карточками с подписанными полями: таблицу из многих столбцов на
 * телефоне не заполнить.
 */
export function FormTableEditor({
  fields,
  rows,
  onChange,
  renderControl,
  errors = {},
  rowErrors = [],
  readOnly = false,
}: {
  fields: readonly FieldDef[]
  rows: readonly TableRow[]
  onChange: (rows: TableRow[]) => void
  renderControl?: (control: ControlProps) => ReactNode | undefined
  errors?: CellErrors
  /** Номера (с нуля) полностью пустых строк. */
  rowErrors?: readonly number[]
  readOnly?: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const baseId = useId()
  const wide = useMediaQuery('(min-width: 768px)')
  // Устойчивые ключи строк: удаление из середины не перерисовывает соседей
  const counter = useRef(0)
  const nextKey = () => {
    counter.current += 1
    return `row-${counter.current}`
  }
  const [keys, setKeys] = useState<string[]>(() => rows.map(() => nextKey()))
  // biome-ignore lint/correctness/useExhaustiveDependencies: ключи пересобираются только при смене числа строк извне
  useEffect(() => {
    if (keys.length !== rows.length) setKeys(rows.map(() => nextKey()))
  }, [rows.length])

  const setCell = (index: number, key: string, value: unknown) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, [key]: value } : row)))
  const removeRow = (index: number) => {
    setKeys((current) => current.filter((_, at) => at !== index))
    onChange(rows.filter((_, at) => at !== index))
  }

  const controlFor = (index: number, field: FieldDef): ControlProps => {
    const error = errors[`${index}:${field.key}`]
    return {
      field,
      value: rows[index]?.[field.key],
      onChange: (value) => setCell(index, field.key, value),
      id: `${baseId}-${index}-${field.key}`,
      invalid: Boolean(error),
      disabled: readOnly || field.readOnly,
    }
  }
  const renderCell = (control: ControlProps) =>
    renderControl?.(control) ?? <FieldControl {...control} />

  const totals = columnTotals(fields, rows)
  const hasTotals = rows.length > 0 && totals.some((value) => value !== null)
  const keyOf = (index: number) => keys[index] ?? `row-index-${index}`

  if (!wide) {
    return (
      <div className="flex flex-col gap-3">
        <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label={t('forms.table.title')}>
          {rows.map((_, index) => (
            <li
              key={keyOf(index)}
              className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-fg">
                  {t('forms.table.row', { number: index + 1 })}
                </span>
                {readOnly ? null : (
                  <IconButton
                    type="button"
                    size="sm"
                    label={t('forms.table.removeRow', { number: index + 1 })}
                    onClick={() => removeRow(index)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </IconButton>
                )}
              </div>
              {rowErrors.includes(index) ? (
                <p role="alert" className="text-xs text-danger">
                  {t('forms.table.emptyRow')}
                </p>
              ) : null}
              {fields.map((field) => {
                const control = controlFor(index, field)
                return (
                  <Field
                    key={field.key}
                    label={labelOf(field, locale)}
                    htmlFor={control.id}
                    required={field.required}
                    error={errors[`${index}:${field.key}`]}
                  >
                    {renderCell(control)}
                  </Field>
                )
              })}
            </li>
          ))}
        </ol>
        {hasTotals ? (
          <dl className="m-0 flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-3 text-sm">
            <dt className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {t('forms.table.total')}
            </dt>
            {fields.map((field, index) =>
              totals[index] === null ? null : (
                <dd key={field.key} className="m-0 flex justify-between gap-3">
                  <span className="text-fg-muted">{labelOf(field, locale)}</span>
                  <span className="tabular-nums text-fg">
                    {formatValue(totals[index], field, { locale })}
                  </span>
                </dd>
              ),
            )}
          </dl>
        ) : null}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full min-w-max text-sm" aria-label={t('forms.table.title')}>
        <thead>
          <tr className="border-b border-line bg-surface-2 text-xs text-fg-muted">
            <th scope="col" className="w-10 px-2 py-2 text-right font-medium">
              {t('forms.table.number')}
            </th>
            {fields.map((field) => (
              <th key={field.key} scope="col" className="min-w-40 px-2 py-2 text-left font-medium">
                {labelOf(field, locale)}
                {field.required ? <span className="ml-0.5 text-danger">*</span> : null}
              </th>
            ))}
            {readOnly ? null : (
              <th scope="col" className="w-10 px-2 py-2">
                <span className="sr-only">{t('forms.table.actions')}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((_, index) => (
            <tr key={keyOf(index)} className="border-b border-line align-top last:border-0">
              <th scope="row" className="px-2 py-2.5 text-right font-normal text-fg-muted">
                {index + 1}
              </th>
              {fields.map((field) => {
                const control = controlFor(index, field)
                const error = errors[`${index}:${field.key}`]
                return (
                  <td key={field.key} className="px-2 py-1.5">
                    <label htmlFor={control.id} className="sr-only">
                      {t('forms.table.cellLabel', {
                        field: labelOf(field, locale),
                        number: index + 1,
                      })}
                    </label>
                    {renderCell(control)}
                    {error ? (
                      <p role="alert" className="mt-1 text-xs text-danger">
                        {error}
                      </p>
                    ) : null}
                  </td>
                )
              })}
              {readOnly ? null : (
                <td className="px-2 py-1.5">
                  <IconButton
                    type="button"
                    size="sm"
                    label={t('forms.table.removeRow', { number: index + 1 })}
                    onClick={() => removeRow(index)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </IconButton>
                  {rowErrors.includes(index) ? (
                    <span role="alert" className="sr-only">
                      {t('forms.table.emptyRow')}
                    </span>
                  ) : null}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {hasTotals ? (
          <tfoot>
            <tr className="border-t border-line bg-surface-2 font-medium">
              <th scope="row" className="px-2 py-2 text-right text-xs text-fg-muted">
                {t('forms.table.total')}
              </th>
              {fields.map((field, index) => (
                <td key={field.key} className="px-2 py-2 tabular-nums text-fg">
                  {totals[index] === null ? null : formatValue(totals[index], field, { locale })}
                </td>
              ))}
              {readOnly ? null : <td />}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}
