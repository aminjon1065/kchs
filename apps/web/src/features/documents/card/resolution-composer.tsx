import type { ResolutionInput } from '@kchs/contracts'
import { Button, cn, Field, Kbd, Switch, Textarea, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, PenLine } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, Suspense, useId, useState } from 'react'
import { type PickedUser, UserPicker, UsersPicker } from '~/entities/people/user-picker.js'
import { type DueValue, emptyDue, LazyDueInput } from '~/features/tasks/index.js'
import { useT } from '~/shared/i18n.js'
import { acknowledgmentsQuery, documentKeys, resolutionsQuery } from '../queries.js'
import { errorText } from '../status.js'
import { useDocument } from './document-context.js'
import { documentsCardApi } from './queries.js'
import {
  dueOf,
  ResolutionDialog,
  type ResolutionDraft,
  ResolutionRequestDialog,
} from './resolution-dialogs.js'

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Резолюция, закреплённая внизу карточки (ADR-0230): у кого открыто направление на
 * резолюцию, тот накладывает её здесь же — текст, ответственный и соисполнители, срок,
 * контроль; ⌘↵ (Ctrl+↵) — наложить. Шаблон, контролёр и резолюция от имени — в полном
 * диалоге «Все параметры» (он продолжает с набранного), переадресация — диалог
 * направления. Права и проверки — те же, что у диалога на вкладке резолюций.
 */
export function ResolutionComposer() {
  const { document } = useDocument()
  // Резолюции только у зарегистрированного документа типа, где они разрешены
  if (!document.type.settings.allowResolutions || !document.regNumber) return null
  return <Composer />
}

function Composer() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const { document, openSection } = useDocument()
  const { data: view } = useQuery(resolutionsQuery(document.id))
  const { data: acknowledgments } = useQuery({
    ...acknowledgmentsQuery(document.id),
    enabled: Boolean(view?.can.resolve),
  })
  const [text, setText] = useState('')
  const [responsible, setResponsible] = useState<PickedUser | null>(null)
  const [coExecutors, setCoExecutors] = useState<PickedUser[]>([])
  const [due, setDue] = useState<DueValue>(() => emptyDue())
  const [control, setControl] = useState(true)
  const [dialog, setDialog] = useState<'full' | 'forward' | null>(null)
  // Свёрнута — строка текста и кнопки; остальные поля раскрываются с фокусом или вводом,
  // чтобы на узкой рабочей области форма не закрывала карточку
  const [open, setOpen] = useState(false)
  const expanded = open || text.trim() !== '' || responsible !== null || coExecutors.length > 0
  const dueInput = dueOf(due)
  const ready = text.trim() !== '' && responsible !== null && dueInput !== null

  const reset = () => {
    setText('')
    setResponsible(null)
    setCoExecutors([])
    setDue(emptyDue())
    setControl(true)
    setOpen(false)
  }

  const save = useMutation({
    mutationFn: () => {
      const body: ResolutionInput = {
        text: text.trim(),
        responsibleId: responsible?.id ?? '',
        coExecutorIds: coExecutors.map((user) => user.id),
        ...dueInput,
        control,
        parentId: null,
      }
      return documentsCardApi.postResolutions(document.id, body)
    },
    onSuccess: (next) => {
      client.setQueryData(documentKeys.resolutions(document.id), next)
      void client.invalidateQueries({ queryKey: ['object', document.id] })
      void client.invalidateQueries({ queryKey: documentKeys.all })
      void client.invalidateQueries({ queryKey: ['inbox'] })
      toast.show({ title: t('documents.resolutions.saved'), tone: 'success' })
      reset()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const acknowledge = useMutation({
    mutationFn: () => documentsCardApi.postObjectsAcknowledgmentsAcknowledge(document.id, {}),
    onSuccess: (next) => {
      client.setQueryData(documentKeys.acknowledgments(document.id), next)
      void client.invalidateQueries({ queryKey: ['inbox'] })
      toast.show({ title: t('documents.acknowledgments.acknowledged'), tone: 'success' })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  if (!view?.can.resolve) return null

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (ready && !save.isPending) save.mutate()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }
  const draft: ResolutionDraft = { text, responsible, coExecutors, due, control }
  const mine = acknowledgments?.mine.pending ? acknowledgments.mine : null

  return (
    <>
      <form
        aria-label={t('documents.composer.label')}
        onSubmit={submit}
        onKeyDown={onKeyDown}
        className="@container flex shrink-0 flex-col gap-3 border-t border-line bg-surface px-6 pt-3.5 pb-4"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <PenLine className="size-4 text-accent" aria-hidden />
          <h2 className="text-sm font-semibold text-fg">{t('documents.composer.title')}</h2>
          <span className="text-xs text-fg-muted">{t('documents.composer.hint')}</span>
        </div>
        <div
          className={cn(
            'grid items-start gap-3',
            expanded && '@3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]',
          )}
        >
          <Field label={t('documents.resolutions.text')} htmlFor={`${formId}-text`} required>
            <Textarea
              id={`${formId}-text`}
              rows={expanded ? 4 : 1}
              maxLength={4000}
              value={text}
              placeholder={t('documents.composer.placeholder')}
              onFocus={() => setOpen(true)}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          {expanded ? (
            <div className="grid gap-3">
              <Field label={t('documents.resolutions.responsible')} required>
                <UserPicker
                  value={responsible}
                  onChange={(user) => {
                    setResponsible(user)
                    if (user) setCoExecutors((list) => list.filter((item) => item.id !== user.id))
                  }}
                  label={t('documents.resolutions.responsible')}
                />
              </Field>
              <Field label={t('documents.resolutions.coExecutors')}>
                <UsersPicker
                  value={coExecutors}
                  onChange={setCoExecutors}
                  label={t('documents.resolutions.coExecutors')}
                  exclude={responsible ? [responsible.id] : []}
                />
              </Field>
              <div className="grid items-start gap-3 @lg:grid-cols-[minmax(0,1fr)_auto]">
                <Suspense fallback={null}>
                  <LazyDueInput
                    value={due}
                    onChange={setDue}
                    label={t('documents.resolutions.due')}
                    required
                    error={
                      due.mode === 'working' && due.days.trim() !== '' && !dueInput
                        ? t('documents.resolutions.workingDaysMin')
                        : undefined
                    }
                  />
                </Suspense>
                <div className="flex flex-col gap-1.5 pt-0.5">
                  <span className="text-xs font-medium text-fg-secondary">
                    {t('documents.resolutions.control')}
                  </span>
                  <Switch
                    label={t(
                      control ? 'documents.composer.controlOn' : 'documents.composer.controlOff',
                    )}
                    checked={control}
                    onCheckedChange={setControl}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!ready} loading={save.isPending}>
            {t('documents.resolutions.add')}
          </Button>
          {mine ? (
            <Button
              type="button"
              variant="secondary"
              icon={<Check className="size-4" />}
              loading={acknowledge.isPending}
              onClick={() =>
                // Ознакомление с кодом второго фактора — в своей вкладке, где есть ввод кода
                mine.requireSecondFactor ? openSection('acknowledgments') : acknowledge.mutate()
              }
            >
              {t('documents.composer.acknowledge')}
            </Button>
          ) : null}
          {view.can.request ? (
            <Button type="button" variant="ghost" onClick={() => setDialog('forward')}>
              {t('documents.composer.forward')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={() => setDialog('full')}>
            {t('documents.composer.more')}
          </Button>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Kbd>{MAC ? '⌘↵' : 'Ctrl+↵'}</Kbd>
            {t('documents.composer.shortcut')}
          </span>
        </div>
      </form>
      {dialog === 'full' ? (
        <ResolutionDialog
          document={document}
          view={view}
          parent={null}
          initial={draft}
          onSaved={reset}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'forward' ? (
        <ResolutionRequestDialog document={document} onClose={() => setDialog(null)} />
      ) : null}
    </>
  )
}
