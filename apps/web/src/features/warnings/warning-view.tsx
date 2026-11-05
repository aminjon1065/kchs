import type { WarningLanguage } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Breadcrumbs,
  Button,
  ErrorState,
  KeyValueList,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, ExternalLink, FileInput, FilePlus2, PencilLine, Save } from 'lucide-react'
import { useState } from 'react'
import { spacesQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { STATUS_TONE } from './labels.js'
import { errorText, warningKeys, warningQuery, warningsApi } from './queries.js'
import { WarningDecisionPanel } from './warning-decision.js'
import {
  draftOf,
  WarningAreasSection,
  WarningContentSection,
  type WarningDraft,
  WarningParamsSection,
} from './warning-form.js'

/**
 * Карточка предупреждения (ADR-0202, ADR-0230): шапка с состоянием, видом сообщения и
 * источником; содержание на трёх языках, параметры CAP и области — правятся в
 * черновике; справа — решение руководства штаба (маршрут выпуска, проверка, предпросмотр,
 * подпись с кодом). Уточнение и отмена опубликованного, ссылка на CAP снаружи.
 * Сетка — по ширине рабочей области (контейнерные запросы), а не окна.
 */
export function WarningView({ objectId }: { objectId: string }) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [draft, setDraft] = useState<WarningDraft | null>(null)
  const [language, setLanguage] = useState<WarningLanguage>('tg')
  const [confirm, setConfirm] = useState<'Update' | 'Cancel' | null>(null)
  const { data: warning, isLoading, error, refetch } = useQuery(warningQuery(objectId))
  const { data: spaces } = useQuery(spacesQuery())

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: warningKeys.warning(objectId) })
    await client.invalidateQueries({ queryKey: warningKeys.all })
  }
  const failed = (error_: unknown) => toast.error(errorText(error_, t('errors.unknown')))
  const open = (link: { id: string; title: string }) =>
    openTab({
      kind: 'object',
      objectId: link.id,
      objectType: 'warning',
      title: link.title,
      icon: 'warning',
      mode: 'permanent',
    })
  const openList = () =>
    openTab({
      kind: 'screen',
      screen: 'warnings',
      title: t('shell.rail.warnings'),
      icon: 'warnings',
      mode: 'permanent',
    })

  const save = useMutation({
    mutationFn: (body: WarningDraft) => warningsApi.update(objectId, body),
    onSuccess: async () => {
      setDraft(null)
      toast.success(t('warnings.card.saved'))
      await refresh()
    },
    onError: failed,
  })

  const submit = useMutation({
    mutationFn: async () => {
      if (draft) await warningsApi.update(objectId, draft)
      return warningsApi.submit(objectId)
    },
    onSuccess: async () => {
      setDraft(null)
      toast.success(t('warnings.card.submitted'))
      await refresh()
    },
    onError: failed,
  })

  const supersede = useMutation({
    mutationFn: (msgType: 'Update' | 'Cancel') => warningsApi.supersede(objectId, msgType),
    onSuccess: async (result) => {
      setConfirm(null)
      toast.success(t('warnings.card.supersedeCreated'))
      await refresh()
      open({ id: result.id, title: t('objects.types.warning') })
    },
    onError: failed,
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (error || !warning) {
    return <ErrorState title={t('warnings.card.notFound')} onRetry={() => void refetch()} />
  }
  const current = draft ?? draftOf(warning)
  const readOnly = !warning.canEdit
  const dateOf = (value: string | null) => (value ? formatDateTime(value, { locale }) : '—')
  const spaceName = warning.spaceId
    ? (spaces?.find((space) => space.id === warning.spaceId)?.name ?? null)
    : null
  const statusLabel = t(`warnings.status.${warning.status}`)
  const links = [
    ...(warning.references
      ? [
          {
            key: 'references',
            label: t('warnings.fields.references'),
            value: (
              <Button
                variant="link"
                size="sm"
                onClick={() => warning.references && open(warning.references)}
              >
                {warning.references.title}
              </Button>
            ),
          },
        ]
      : []),
    ...(warning.supersededBy
      ? [
          {
            key: 'supersededBy',
            label: t('warnings.fields.supersededBy'),
            value: (
              <Button
                variant="link"
                size="sm"
                onClick={() => warning.supersededBy && open(warning.supersededBy)}
              >
                {`${t(`warnings.msgType.${warning.supersededBy.msgType}`)} · ${warning.supersededBy.title}`}
              </Button>
            ),
          },
        ]
      : []),
    ...(warning.approvedBy
      ? [
          {
            key: 'approvedBy',
            label: t('warnings.fields.approvedBy'),
            value: `${warning.approvedBy.displayName} · ${dateOf(warning.approvedAt)}`,
          },
        ]
      : []),
    ...(warning.publishedAt
      ? [
          {
            key: 'published',
            label: t('warnings.fields.published'),
            value: dateOf(warning.publishedAt),
          },
        ]
      : []),
  ]

  return (
    <div className="@container h-full min-h-0 overflow-y-auto bg-canvas">
      <div className="flex flex-col gap-4 px-7 pt-4.5 pb-6">
        <header className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Breadcrumbs
                items={[
                  { id: 'warnings', label: t('warnings.title'), onClick: openList },
                  ...(spaceName ? [{ id: 'space', label: spaceName }] : []),
                ]}
              />
              <Badge tone={STATUS_TONE[warning.status]} size="sm" dot>
                {statusLabel}
              </Badge>
              <Badge tone="neutral" size="sm">
                {`${t(`warnings.msgType.${warning.msgType}`)} · ${t(`warnings.capStatus.${warning.capStatus}`)}`}
              </Badge>
              <span className="font-mono text-2xs text-fg-muted">{warning.identifier}</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-pretty text-fg">
              {warning.title}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-8 max-w-96 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg">
              {warning.source ? (
                <>
                  <FileInput className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                  <span className="truncate">
                    {t('warnings.card.fromMessage', {
                      title: warning.source.title ?? warning.source.rowId,
                    })}
                  </span>
                </>
              ) : (
                <>
                  <FilePlus2 className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                  {t('warnings.card.noSource')}
                </>
              )}
            </span>
            {warning.capUrl ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<ExternalLink className="size-3.5" />}
                asChild
              >
                <a href={warning.capUrl} target="_blank" rel="noreferrer">
                  {t('warnings.card.cap')}
                </a>
              </Button>
            ) : null}
            {warning.canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Save className="size-3.5" />}
                disabled={!draft}
                loading={save.isPending}
                onClick={() => draft && save.mutate(draft)}
              >
                {t('warnings.card.save')}
              </Button>
            ) : null}
            {warning.canSupersede ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<PencilLine className="size-3.5" />}
                  onClick={() => setConfirm('Update')}
                >
                  {t('warnings.card.update')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Ban className="size-3.5" />}
                  onClick={() => setConfirm('Cancel')}
                >
                  {t('warnings.card.cancel')}
                </Button>
              </>
            ) : null}
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_20rem] @6xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_21.25rem]">
          <WarningContentSection
            draft={current}
            onChange={setDraft}
            readOnly={readOnly}
            readOnlyNote={readOnly ? t('warnings.card.readOnlyAs', { status: statusLabel }) : null}
            language={language}
            onLanguage={setLanguage}
            className="@3xl:col-start-1"
          />
          <WarningParamsSection
            warning={warning}
            draft={current}
            onChange={setDraft}
            readOnly={readOnly}
            className="@3xl:col-start-1 @6xl:col-start-2 @6xl:row-start-1"
          />
          <WarningDecisionPanel
            warning={warning}
            draft={current}
            language={language}
            onSubmit={() => submit.mutate()}
            submitting={submit.isPending}
            onChanged={() => void refresh()}
            className="@3xl:sticky @3xl:top-4 @3xl:col-start-2 @3xl:row-span-3 @3xl:row-start-1 @3xl:self-start @6xl:col-start-3 @6xl:row-span-2"
          />
          <WarningAreasSection
            draft={current}
            onChange={setDraft}
            readOnly={readOnly}
            className="@3xl:col-start-1 @6xl:col-span-2"
          />
        </div>

        {links.length > 0 ? (
          <KeyValueList
            columns={2}
            className="rounded-lg border border-line bg-surface px-4.5 py-3.5"
            items={links}
          />
        ) : null}
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(next) => (next ? undefined : setConfirm(null))}
        title={t(
          confirm === 'Cancel' ? 'warnings.confirm.cancelTitle' : 'warnings.confirm.updateTitle',
        )}
        description={t(
          confirm === 'Cancel' ? 'warnings.confirm.cancelText' : 'warnings.confirm.updateText',
        )}
        confirmLabel={t(confirm === 'Cancel' ? 'warnings.card.cancel' : 'warnings.card.update')}
        destructive={confirm === 'Cancel'}
        loading={supersede.isPending}
        onConfirm={() => {
          if (confirm) supersede.mutate(confirm)
        }}
      />
    </div>
  )
}
