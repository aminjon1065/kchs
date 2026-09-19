import type { EventEditScope } from '@kchs/contracts'
import { Button, Dialog, DialogContent, RadioGroup, RadioItem } from '@kchs/ui'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'

/**
 * Правка или удаление повторяющегося события: «только это», «это и
 * следующие», «все события серии».
 */
export function ScopeDialog({
  mode,
  onClose,
  onConfirm,
  allowOccurrence = true,
  loading,
}: {
  mode: 'edit' | 'delete'
  onClose: () => void
  onConfirm: (scope: EventEditScope) => void
  /** Изменились поля серии (участники, повтор) — «только это» недоступно. */
  allowOccurrence?: boolean
  loading?: boolean
}) {
  const t = useT()
  const [scope, setScope] = useState<EventEditScope>(allowOccurrence ? 'occurrence' : 'following')
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="sm"
        title={t(mode === 'edit' ? 'calendar.scope.title' : 'calendar.scope.deleteTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant={mode === 'delete' ? 'danger' : 'primary'}
              loading={loading}
              onClick={() => onConfirm(scope)}
            >
              {t(mode === 'edit' ? 'common.actions.save' : 'calendar.event.delete')}
            </Button>
          </>
        }
      >
        <RadioGroup
          value={scope}
          onValueChange={(value) => setScope(value as EventEditScope)}
          aria-label={t('calendar.scope.label')}
          className="flex flex-col gap-2.5"
        >
          <RadioItem
            value="occurrence"
            label={t('calendar.scope.occurrence')}
            disabled={!allowOccurrence}
          />
          <RadioItem value="following" label={t('calendar.scope.following')} />
          <RadioItem value="series" label={t('calendar.scope.series')} />
        </RadioGroup>
        {!allowOccurrence ? (
          <p className="mt-3 text-xs text-fg-muted">{t('calendar.scope.seriesOnlyHint')}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
