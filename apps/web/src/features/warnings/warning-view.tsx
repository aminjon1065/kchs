import { formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  ErrorState,
  KeyValueList,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, ExternalLink, PencilLine, Save, Send } from 'lucide-react'
import { Suspense, useState } from 'react'
import { ObjectRoutePanel } from '~/features/processes/index.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { SEVERITY_TONE, STATUS_TONE } from './labels.js'
import { errorText, warningKeys, warningQuery, warningsApi } from './queries.js'
import { draftOf, type WarningDraft, WarningForm } from './warning-form.js'

/**
 * Карточка предупреждения (ADR-0202): содержание на трёх языках — правится в
 * черновике, отправка на решение руководства, уточнение и отмена опубликованного,
 * ссылка на CAP снаружи; вкладка «Маршрут» — линия шагов и решение подписью.
 */
export function WarningView({ objectId }: { objectId: string }) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [tab, setTab] = useState('content')
  const [draft, setDraft] = useState<WarningDraft | null>(null)
  const [confirm, setConfirm] = useState<'Update' | 'Cancel' | null>(null)
  const { data: warning, isLoading, error, refetch } = useQuery(warningQuery(objectId))

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
      setTab('route')
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
  const dateOf = (value: string | null) => (value ? formatDateTime(value, { locale }) : '—')

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-3">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-fg">{warning.title}</h2>
        {warning.msgType !== 'Alert' ? (
          <Badge tone="purple" size="sm">
            {t(`warnings.msgType.${warning.msgType}`)}
          </Badge>
        ) : null}
        <Badge tone={SEVERITY_TONE[warning.severity]} size="sm">
          {t(`warnings.severity.${warning.severity}`)}
        </Badge>
        <Badge tone={STATUS_TONE[warning.status]} size="sm" dot>
          {t(`warnings.status.${warning.status}`)}
        </Badge>
        {warning.capUrl ? (
          <a
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            href={warning.capUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('warnings.card.cap')}
          </a>
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
        {warning.canSubmit ? (
          <Button
            variant="primary"
            size="sm"
            icon={<Send className="size-3.5" />}
            loading={submit.isPending}
            onClick={() => submit.mutate()}
          >
            {t('warnings.card.submit')}
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

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-2.5">
          <TabsTrigger value="content">{t('warnings.card.content')}</TabsTrigger>
          <TabsTrigger value="route">{t('warnings.card.route')}</TabsTrigger>
        </TabsList>
        <TabsContent value="content" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <div className="mx-auto flex max-w-[960px] flex-col gap-5">
            {warning.canEdit ? null : (
              <p className="text-xs text-fg-muted">{t('warnings.card.readOnly')}</p>
            )}
            <WarningForm
              warning={warning}
              draft={current}
              onChange={setDraft}
              readOnly={!warning.canEdit}
            />
            <KeyValueList
              columns={2}
              items={[
                {
                  key: 'identifier',
                  label: t('warnings.fields.identifier'),
                  value: <span className="font-mono text-xs">{warning.identifier}</span>,
                },
                {
                  key: 'source',
                  label: t('warnings.fields.source'),
                  value: warning.source
                    ? (warning.source.title ?? warning.source.rowId)
                    : t('warnings.card.noSource'),
                },
                {
                  key: 'author',
                  label: t('warnings.fields.author'),
                  value: warning.author?.displayName ?? '—',
                },
                {
                  key: 'approvedBy',
                  label: t('warnings.fields.approvedBy'),
                  value: warning.approvedBy
                    ? `${warning.approvedBy.displayName} · ${dateOf(warning.approvedAt)}`
                    : '—',
                },
                {
                  key: 'published',
                  label: t('warnings.fields.published'),
                  value: dateOf(warning.publishedAt),
                },
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
              ]}
            />
          </div>
        </TabsContent>
        <TabsContent value="route" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <div className="mx-auto max-w-[860px]">
            <Suspense fallback={<Skeleton className="h-40 w-full" />}>
              <ObjectRoutePanel objectId={objectId} onChanged={() => void refresh()} />
            </Suspense>
          </div>
        </TabsContent>
      </Tabs>

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
