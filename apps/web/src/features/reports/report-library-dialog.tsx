import { formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  Input,
  Skeleton,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, RotateCcw, Save } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { reportKeys, reportLibraryApi, reportVersionsQuery } from './queries.js'

/**
 * Версии и шаблон (ADR-0164): «Сохранить версию» с подписью, список версий с возвратом и
 * отметка «Шаблон библиотеки» — из отчёта создают новые. Возврат пишет снимок в документ:
 * соавторы видят его сразу, текущий шаблон перед этим становится версией.
 */
export function ReportLibraryDialog({
  reportId,
  open,
  onOpenChange,
  canEdit,
  canManage,
  template,
}: {
  reportId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  canEdit: boolean
  canManage: boolean
  template: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const [label, setLabel] = useState('')
  const [target, setTarget] = useState<{ id: string; number: number } | null>(null)
  const { data: versions = [], isLoading } = useQuery({
    ...reportVersionsQuery(reportId),
    enabled: open,
  })
  const failed = (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
  const refresh = () => client.invalidateQueries({ queryKey: keys.object(reportId) })

  const save = useMutation({
    mutationFn: () => reportLibraryApi.saveVersion(reportId, label.trim() || null),
    onSuccess: ({ number }) => {
      setLabel('')
      toast.show({ title: t('data.report.versions.saved', { number }), tone: 'success' })
      void client.invalidateQueries({ queryKey: reportKeys.versions(reportId) })
    },
    onError: failed,
  })
  const restore = useMutation({
    mutationFn: (versionId: string) => reportLibraryApi.restore(reportId, versionId),
    onSuccess: () => {
      setTarget(null)
      toast.show({ title: t('data.report.versions.restored'), tone: 'success' })
      void client.invalidateQueries({ queryKey: reportKeys.versions(reportId) })
      void refresh()
    },
    onError: (error) => {
      setTarget(null)
      failed(error)
    },
  })
  const flag = useMutation({
    mutationFn: (next: boolean) => reportLibraryApi.setTemplate(reportId, next),
    onSuccess: (record) => {
      toast.show({
        title: record.template
          ? t('data.report.templates.marked')
          : t('data.report.templates.unmarked'),
        tone: 'success',
      })
      void client.invalidateQueries({ queryKey: reportKeys.templates })
      void refresh()
    },
    onError: failed,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('data.report.versions.title')} size="lg">
        <div className="flex flex-col gap-4">
          <Switch
            checked={template}
            disabled={!canManage || flag.isPending}
            onCheckedChange={(next) => flag.mutate(next)}
            label={t('data.report.templates.flag')}
          />
          <p className="-mt-2 text-xs text-fg-secondary">{t('data.report.templates.flagHint')}</p>

          {canEdit ? (
            <div className="flex items-center gap-2">
              <Input
                value={label}
                maxLength={200}
                placeholder={t('data.report.versions.labelPlaceholder')}
                aria-label={t('data.report.versions.label')}
                onChange={(event) => setLabel(event.target.value)}
              />
              <Button
                variant="secondary"
                icon={<Save className="size-3.5" />}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                {t('data.report.versions.save')}
              </Button>
            </div>
          ) : null}

          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : versions.length === 0 ? (
            <EmptyState
              icon={<History className="size-5" />}
              title={t('data.report.versions.empty')}
              description={t('data.report.versions.emptyHint')}
              compact
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {versions.map((version) => (
                <li
                  key={version.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2"
                >
                  <span className="text-sm font-medium text-fg">
                    {t('data.report.versions.number', { number: version.number })}
                  </span>
                  <Badge tone="neutral">{t(`data.report.versions.reason.${version.reason}`)}</Badge>
                  {version.label ? (
                    <span className="truncate text-sm text-fg">{version.label}</span>
                  ) : null}
                  <span className="text-xs text-fg-secondary">
                    {formatDateTime(version.createdAt, { locale })}
                    {version.createdBy ? ` · ${version.createdBy.displayName}` : ''}
                    {` · ${t('data.report.versions.blocks', { count: version.blocks })}`}
                  </span>
                  {canEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ms-auto"
                      icon={<RotateCcw className="size-3.5" />}
                      onClick={() => setTarget({ id: version.id, number: version.number })}
                    >
                      {t('data.report.versions.restore')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <AlertDialog
          open={target !== null}
          onOpenChange={(next) => (next ? null : setTarget(null))}
          title={t('data.report.versions.restoreTitle', { number: target?.number ?? 0 })}
          description={t('data.report.versions.restoreHint')}
          confirmLabel={t('data.report.versions.restore')}
          loading={restore.isPending}
          onConfirm={() => (target ? restore.mutate(target.id) : undefined)}
        />
      </DialogContent>
    </Dialog>
  )
}
