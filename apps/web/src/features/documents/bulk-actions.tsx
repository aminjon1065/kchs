import type { DocumentBulkResult, PrincipalRef } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  RadioGroup,
  RadioItem,
  SearchInput,
  Switch,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookCheck, Briefcase, FileSpreadsheet } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { PrincipalsPicker } from './principals-picker.js'
import { casesQuery, documentKeys } from './queries.js'
import { errorText, localToday } from './status.js'

type BulkDialog = 'file' | 'acknowledge' | null

/**
 * Массовые действия в списке документов (ADR-0152): подшить исполненные в одно
 * дело, отправить на ознакомление, выгрузить реестр выбранных в Excel. Сервер
 * проверяет каждый документ сам; итог — сделано и пропущено с причиной.
 */
export function DocumentsBulkActions({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const t = useT()
  const [dialog, setDialog] = useState<BulkDialog>(null)

  const exportRegistry = () => {
    // Реестр собирает сервер: только видимые документы, подписи — на языке сотрудника
    const link = document.createElement('a')
    link.href = `/api/v1/documents/registry.xlsx?ids=${ids.join(',')}`
    link.download = ''
    link.click()
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<Briefcase className="size-3.5" />}
        onClick={() => setDialog('file')}
      >
        {t('documents.actions.file')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon={<BookCheck className="size-3.5" />}
        onClick={() => setDialog('acknowledge')}
      >
        {t('documents.bulk.acknowledge')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon={<FileSpreadsheet className="size-3.5" />}
        onClick={exportRegistry}
      >
        {t('documents.bulk.registry.action')}
      </Button>
      {dialog === 'file' ? (
        <BulkFileDialog ids={ids} onClose={() => setDialog(null)} onDone={onDone} />
      ) : null}
      {dialog === 'acknowledge' ? (
        <BulkAcknowledgeDialog ids={ids} onClose={() => setDialog(null)} onDone={onDone} />
      ) : null}
    </>
  )
}

/**
 * Запуск массового действия. Всё сделано — тост и диалог закрывается; что-то
 * пропущено — итог остаётся в диалоге: сколько сделано, что пропущено и почему.
 */
function useBulk(onDone: () => void, onClose: () => void) {
  const toast = useToast()
  const t = useT()
  const client = useQueryClient()
  const [result, setResult] = useState<DocumentBulkResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      http.post<DocumentBulkResult>('/documents/bulk', body),
    onSuccess: (outcome) => {
      void client.invalidateQueries({ queryKey: ['objects'] })
      void client.invalidateQueries({ queryKey: documentKeys.all })
      onDone()
      if (outcome.skipped.length === 0) {
        toast.show({
          title: t('documents.bulk.done', { count: outcome.done.length }),
          tone: 'success',
        })
        onClose()
        return
      }
      setResult(outcome)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })
  return { run, result, failure }
}

function BulkResult({ result }: { result: DocumentBulkResult }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-3">
      <Callout tone={result.done.length > 0 ? 'success' : 'warning'}>
        {t('documents.bulk.done', { count: result.done.length })}
      </Callout>
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-fg-secondary">
          {t('documents.bulk.skipped', { count: result.skipped.length })}
        </h3>
        <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto text-sm">
          {result.skipped.map((item) => (
            <li key={item.id} className="flex flex-col">
              <span className="truncate text-fg">{item.title || t('documents.bulk.hidden')}</span>
              <span className="text-xs text-fg-muted">{item.reason}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function CloseFooter({ onClose }: { onClose: () => void }) {
  const t = useT()
  return (
    <Button variant="primary" onClick={onClose}>
      {t('common.actions.close')}
    </Button>
  )
}

function BulkFileDialog({
  ids,
  onClose,
  onDone,
}: {
  ids: string[]
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const [search, setSearch] = useState('')
  const [caseId, setCaseId] = useState('')
  const { data, isLoading } = useQuery(casesQuery({ status: 'open', q: search }))
  // Только дела, куда сотрудник вправе подшивать; права на документы сервер проверит сам
  const items = (data ?? []).filter((item) => item.canFile)
  const { run, result, failure } = useBulk(onDone, onClose)

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.bulk.fileTitle', { count: ids.length })}
        size="md"
        footer={
          result ? (
            <CloseFooter onClose={onClose} />
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={!caseId}
                loading={run.isPending}
                onClick={() => run.mutate({ action: 'file', ids, caseId })}
              >
                {t('documents.actions.file')}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <BulkResult result={result} />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-secondary">{t('documents.bulk.fileHint')}</p>
            {failure ? <Callout tone="danger">{failure}</Callout> : null}
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder={t('documents.cases.search')}
              aria-label={t('documents.file.case')}
            />
            {!isLoading && items.length === 0 ? (
              <Callout tone="warning">{t('documents.file.noCases')}</Callout>
            ) : (
              <RadioGroup
                value={caseId}
                onValueChange={setCaseId}
                aria-label={t('documents.file.case')}
                className="flex max-h-72 flex-col gap-1.5 overflow-y-auto"
              >
                {items.map((item) => (
                  <RadioItem
                    key={item.id}
                    value={item.id}
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-mono text-xs tabular">{item.index}</span>
                        <span className="min-w-0 truncate">{item.title}</span>
                        <span className="shrink-0 text-xs text-fg-muted">
                          {item.year}
                          {item.unit ? ` · ${item.unit.name}` : ''}
                        </span>
                      </span>
                    }
                  />
                ))}
              </RadioGroup>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BulkAcknowledgeDialog({
  ids,
  onClose,
  onDone,
}: {
  ids: string[]
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const formId = useId()
  const [recipients, setRecipients] = useState<PrincipalRef[]>([])
  const [dueDate, setDueDate] = useState('')
  const [requireCode, setRequireCode] = useState(false)
  const [note, setNote] = useState('')
  const { run, result, failure } = useBulk(onDone, onClose)
  const pick = (type: string) =>
    recipients.filter((item) => item.type === type).map((item) => item.id)

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.bulk.acknowledgeTitle', { count: ids.length })}
        size="md"
        footer={
          result ? (
            <CloseFooter onClose={onClose} />
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={recipients.length === 0}
                loading={run.isPending}
                onClick={() =>
                  run.mutate({
                    action: 'acknowledge',
                    ids,
                    request: {
                      userIds: pick('user'),
                      unitIds: pick('unit'),
                      groupIds: pick('group'),
                      dueDate: dueDate || null,
                      requireSecondFactor: requireCode,
                      note: note.trim() || null,
                    },
                  })
                }
              >
                {t('documents.acknowledgments.sendSubmit')}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <BulkResult result={result} />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-secondary">{t('documents.bulk.acknowledgeHint')}</p>
            {failure ? <Callout tone="danger">{failure}</Callout> : null}
            <Field label={t('documents.acknowledgments.recipients')} required>
              <PrincipalsPicker
                value={recipients}
                onChange={setRecipients}
                label={t('documents.acknowledgments.recipients')}
              />
            </Field>
            <Field
              label={t('documents.acknowledgments.due')}
              hint={t('documents.acknowledgments.dueHint')}
              htmlFor={`${formId}-due`}
            >
              <Input
                id={`${formId}-due`}
                type="date"
                min={localToday()}
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </Field>
            <Switch
              label={t('documents.acknowledgments.requireCode')}
              checked={requireCode}
              onCheckedChange={setRequireCode}
            />
            <Field label={t('documents.acknowledgments.note')} htmlFor={`${formId}-note`}>
              <Textarea
                id={`${formId}-note`}
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
