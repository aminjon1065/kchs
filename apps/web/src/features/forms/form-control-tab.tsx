import {
  FORM_CELL_STATES,
  type FormCellState,
  type FormControlCell,
  type FormRecord,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Card,
  cn,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { formControlQuery } from './queries.js'
import { SubmissionPanel } from './submission-panel.js'

/**
 * Контроль сдачи (ADR-0103): матрица «назначения × периоды». Ячейка —
 * состояние сводки; просроченная выделяется и ведёт к отправке.
 */

const STATE_TONE: Record<FormCellState, string> = {
  missing: 'text-fg-muted',
  draft: 'text-warning',
  submitted: 'text-accent',
  accepted: 'text-success',
  returned: 'text-danger',
}

const SHORT: Record<FormCellState, string> = {
  missing: '—',
  draft: '◌',
  submitted: '◍',
  accepted: '●',
  returned: '↩',
}

export function FormControlTab({ form }: { form: FormRecord }) {
  const t = useT()
  const [periods, setPeriods] = useState('8')
  const [state, setState] = useState<'all' | FormCellState>('all')
  const [selected, setSelected] = useState<FormControlCell | null>(null)
  const { data, isLoading } = useQuery(formControlQuery(form.id, Number(periods)))

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (!data || data.rows.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardCheck className="size-5" />}
        title={t('forms.control.empty')}
        description={t('forms.control.emptyHint')}
      />
    )
  }

  const rows =
    state === 'all'
      ? data.rows
      : data.rows.filter((row) => row.cells.some((cell) => cell.state === state))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{t('forms.control.expected', { count: data.totals.expected })}</Badge>
        <Badge tone="success">{t('forms.control.accepted', { count: data.totals.accepted })}</Badge>
        <Badge tone="accent">
          {t('forms.control.submitted', { count: data.totals.submitted })}
        </Badge>
        <Badge tone="danger">{t('forms.control.overdue', { count: data.totals.overdue })}</Badge>
        <Select value={state} onValueChange={(value) => setState(value as 'all' | FormCellState)}>
          <SelectTrigger aria-label={t('forms.control.state')} className="ml-auto w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('forms.control.allStates')}</SelectItem>
            {FORM_CELL_STATES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`forms.states.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={periods} onValueChange={setPeriods}>
          <SelectTrigger aria-label={t('forms.control.periods')} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['4', '8', '12', '24'].map((value) => (
              <SelectItem key={value} value={value}>
                {t('forms.control.lastPeriods', { count: Number(value) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card title={t('forms.control.matrix')} padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={t('forms.control.matrix')}>
            <thead>
              <tr className="border-b border-line bg-surface-2 text-xs text-fg-muted">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t('forms.control.subject')}
                </th>
                {data.periods.map((period) => (
                  <th key={period.key} scope="col" className="px-2 py-2 text-center font-medium">
                    {period.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.subject.kind}:${row.subject.id}`}
                  className="border-b border-line last:border-0 hover:bg-surface-2"
                >
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-fg">
                    {row.name}
                  </th>
                  {row.cells.map((cell) => (
                    <td key={cell.periodKey} className="px-2 py-1 text-center">
                      <button
                        type="button"
                        aria-pressed={
                          selected?.submissionId === cell.submissionId && selected !== null
                        }
                        aria-label={t('forms.control.cellLabel', {
                          subject: row.name,
                          period: cell.periodKey,
                          state: t(`forms.states.${cell.state}`),
                        })}
                        onClick={() => setSelected(cell)}
                        className={cn(
                          'rounded-xs px-1.5 py-0.5 text-sm hover:underline',
                          STATE_TONE[cell.state],
                          cell.overdue && 'bg-danger-subtle',
                        )}
                      >
                        {SHORT[cell.state]}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {selected?.submissionId ? (
        <SubmissionPanel
          form={form}
          submissionId={selected.submissionId}
          onClose={() => setSelected(null)}
        />
      ) : selected ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
          <span className="text-sm">{selected.periodKey}</span>
          <Badge tone={selected.overdue ? 'danger' : 'neutral'} size="sm">
            {t(`forms.states.${selected.state}`)}
          </Badge>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(null)}>
            {t('common.actions.close')}
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-fg-muted">{t('forms.control.legend')}</p>
    </div>
  )
}
