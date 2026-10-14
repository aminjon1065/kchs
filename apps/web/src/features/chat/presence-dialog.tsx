import { Button, Dialog, DialogContent, Field, Input, SegmentedControl } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/shared/i18n.js'
import { chatApi, chatKeys } from './queries.js'
import { useReport } from './use-report.js'

/** Мой статус: «в сети / отошёл / не беспокоить» и тихие часы (P4-E01 S03). */
export function PresenceDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const report = useReport()
  const client = useQueryClient()
  const { data } = useQuery({
    queryKey: chatKeys.presence,
    queryFn: () => chatApi.getMePresence(),
  })
  const [status, setStatus] = useState<'online' | 'away' | 'dnd'>(data?.chosen ?? 'online')
  const [forHour, setForHour] = useState(false)
  const [quiet, setQuiet] = useState(
    data?.quietHours ?? { enabled: false, from: '21:00', to: '08:00' },
  )
  const save = useMutation({
    mutationFn: () =>
      chatApi.putMePresence({
        status,
        untilMinutes: forHour ? 60 : null,
        quietHours: quiet,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: chatKeys.presence })
      onClose()
    },
    onError: report,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.presence.title')}
        description={t('chats.presence.hint')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {t('chats.presence.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <SegmentedControl
            value={status}
            onValueChange={(next) => setStatus(next as 'online' | 'away' | 'dnd')}
            options={[
              { value: 'online', label: t('chats.presence.online') },
              { value: 'away', label: t('chats.presence.away') },
              { value: 'dnd', label: t('chats.presence.dnd') },
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={forHour}
              onChange={(event) => setForHour(event.target.checked)}
            />
            {t('chats.presence.forHour')}
          </label>
          <label className="flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={quiet.enabled}
              onChange={(event) => setQuiet({ ...quiet, enabled: event.target.checked })}
            />
            {t('chats.presence.quietHours')}
          </label>
          <div className="flex items-end gap-2">
            <Field label={t('chats.presence.quietFrom')}>
              <Input
                type="time"
                value={quiet.from}
                aria-label={t('chats.presence.quietFrom')}
                onChange={(event) => setQuiet({ ...quiet, from: event.target.value })}
                className="w-28"
              />
            </Field>
            <Field label={t('chats.presence.quietTo')}>
              <Input
                type="time"
                value={quiet.to}
                aria-label={t('chats.presence.quietTo')}
                onChange={(event) => setQuiet({ ...quiet, to: event.target.value })}
                className="w-28"
              />
            </Field>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
