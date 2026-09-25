import type { RuleDefinition } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { AlertDialog, Badge, Button, Card, EmptyState, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { automationApi, automationKeys, ruleVersionsQuery } from '../queries.js'

/**
 * Версии правила (ADR-0163): каждая правка определения — версия с автором и списком
 * изменённых частей; «Вернуть» делает определение версии новой версией, состояние
 * «включено» остаётся текущим.
 */
export function VersionsPanel({
  ruleId,
  canManage,
  onRestored,
}: {
  ruleId: string
  canManage: boolean
  onRestored: (definition: RuleDefinition) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const { data: versions = [], isLoading } = useQuery(ruleVersionsQuery(ruleId))
  const [target, setTarget] = useState<{ id: string; number: number } | null>(null)

  const restore = useMutation({
    mutationFn: (versionId: string) => automationApi.restore(ruleId, versionId),
    onSuccess: async (record) => {
      toast.show({ title: t('automation.versions.restored'), tone: 'success' })
      setTarget(null)
      onRestored(record.definition)
      await client.invalidateQueries({ queryKey: automationKeys.all })
    },
    onError: (error) => {
      setTarget(null)
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
    },
  })

  if (isLoading) return <Skeleton className="h-32 w-full" />
  if (versions.length === 0) {
    return (
      <EmptyState
        icon={<History className="size-5" />}
        title={t('automation.versions.empty')}
        compact
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {versions.map((version, index) => (
        <Card key={version.id} className="flex flex-wrap items-center gap-2 p-3">
          <span className="text-sm font-medium text-fg">
            {t('automation.versions.number', { number: version.number })}
          </span>
          <Badge tone={index === 0 ? 'accent' : 'neutral'}>
            {index === 0
              ? t('automation.versions.current')
              : t(`automation.versions.reason.${version.reason}`)}
          </Badge>
          <span className="text-xs text-fg-secondary">
            {formatDateTime(version.createdAt, { locale })}
            {version.createdBy ? ` · ${version.createdBy.displayName}` : ''}
          </span>
          {version.changed.length > 0 ? (
            <span className="truncate text-xs text-fg-secondary">
              {t('automation.versions.changed', {
                fields: version.changed
                  .map((field) => t(`automation.versions.fields.${field}`))
                  .join(', '),
              })}
            </span>
          ) : null}
          {index > 0 && canManage ? (
            <Button
              size="sm"
              variant="ghost"
              className="ms-auto"
              onClick={() => setTarget({ id: version.id, number: version.number })}
            >
              <RotateCcw className="size-4" />
              {t('automation.versions.restore')}
            </Button>
          ) : null}
        </Card>
      ))}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => (open ? null : setTarget(null))}
        title={t('automation.versions.restoreTitle', { number: target?.number ?? 0 })}
        description={t('automation.versions.restoreHint')}
        confirmLabel={t('automation.versions.restore')}
        loading={restore.isPending}
        onConfirm={() => (target ? restore.mutate(target.id) : undefined)}
      />
    </div>
  )
}
