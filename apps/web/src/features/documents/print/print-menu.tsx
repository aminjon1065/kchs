import type { DocumentRenderRecord, PrintFormInfo } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Field,
  Input,
  Spinner,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'
import { errorText, localToday } from '../status.js'
import { printFormsQuery, renderKeys, waitForRender } from './renders.js'

/** Первый день текущего месяца — период реестра по умолчанию. */
function monthStart(today: string): string {
  return `${today.slice(0, 8)}01`
}

/**
 * Меню «Печать» (08-documents.md §5, ADR-0085): печатные формы объекта —
 * документа (из `printForms` типа) или журнала. Выбор заказывает PDF у
 * движка; пока он строится, кнопка показывает ожидание, готовый файл
 * открывается вкладкой. Недоступная форма — с причиной.
 */
export function PrintMenu({ subjectId }: { subjectId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: forms = [], isLoading } = useQuery(printFormsQuery(subjectId))
  const [periodFor, setPeriodFor] = useState<PrintFormInfo | null>(null)

  const print = useMutation({
    mutationFn: async (input: { form: PrintFormInfo; period?: { from: string; to: string } }) => {
      const render = await http.post<DocumentRenderRecord>('/documents/prints', {
        subjectId,
        form: input.form.key,
        params: input.period ? { period: input.period } : {},
      })
      return waitForRender(render.id)
    },
    onSuccess: (render, input) => {
      void client.invalidateQueries({ queryKey: renderKeys.renders(subjectId) })
      if (render.status !== 'ready' || !render.file) {
        toast.error(render.error ?? t('documents.print.failed'))
        return
      }
      const title = t(input.form.labelKey)
      toast.show({ title: t('documents.print.ready', { name: title }), tone: 'success' })
      openTab({
        kind: 'object',
        objectId: render.file.id,
        objectType: 'file',
        title: render.file.name,
        mode: 'permanent',
      })
    },
    onError: (error) => toast.error(errorText(error, t('documents.print.failed'))),
  })

  if (!isLoading && forms.length === 0) return null

  const choose = (form: PrintFormInfo) => {
    if (form.params.includes('period')) setPeriodFor(form)
    else print.mutate({ form })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={print.isPending}
            icon={
              print.isPending ? (
                <Spinner className="size-3.5" label={t('documents.print.preparing')} />
              ) : (
                <Printer className="size-3.5" />
              )
            }
          >
            {print.isPending ? t('documents.print.preparing') : t('documents.print.title')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[16rem]">
          <DropdownMenuLabel>{t('documents.print.forms.title')}</DropdownMenuLabel>
          {forms.map((form) => (
            <DropdownMenuItem
              key={form.key}
              disabled={!form.available}
              onSelect={() => choose(form)}
            >
              <span className="flex flex-col">
                <span>{t(form.labelKey)}</span>
                {form.reasonKey ? (
                  <span className="text-2xs text-fg-muted">{t(form.reasonKey)}</span>
                ) : null}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {periodFor ? (
        <PeriodDialog
          form={periodFor}
          onClose={() => setPeriodFor(null)}
          onSubmit={(period) => {
            setPeriodFor(null)
            print.mutate({ form: periodFor, period })
          }}
        />
      ) : null}
    </>
  )
}

function PeriodDialog({
  form,
  onClose,
  onSubmit,
}: {
  form: PrintFormInfo
  onClose: () => void
  onSubmit: (period: { from: string; to: string }) => void
}) {
  const t = useT()
  const id = useId()
  const today = localToday()
  const [from, setFrom] = useState(monthStart(today))
  const [to, setTo] = useState(today)
  const invalid = !from || !to || from > to
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t(form.labelKey)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={invalid}
              icon={<Printer className="size-3.5" />}
              onClick={() => onSubmit({ from, to })}
            >
              {t('documents.print.submit')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-secondary">{t('documents.print.periodHint')}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('documents.print.from')} htmlFor={`${id}-from`}>
              <Input
                id={`${id}-from`}
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field label={t('documents.print.to')} htmlFor={`${id}-to`}>
              <Input
                id={`${id}-to`}
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
          </div>
          {invalid ? <Callout tone="warning">{t('documents.print.periodInvalid')}</Callout> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
