import type { MeetingSettings } from '@kchs/contracts'
import { Button, Card, Field, Input, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

const settingsKey = ['admin', 'meetings', 'settings'] as const

/**
 * Настройки встреч установки (N29, ADR-0138): срок хранения записей встреч в
 * месяцах, 0 — бессрочно. За неделю до удаления организатор получает
 * предупреждение и может закрепить запись. Правка попадает в аудит.
 */
export function MeetingsSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const monthsId = useId()
  const { data } = useQuery({
    queryKey: settingsKey,
    queryFn: () => http.get<MeetingSettings>('/admin/meetings/settings'),
  })
  const [draft, setDraft] = useState<MeetingSettings | null>(null)

  const save = useMutation({
    mutationFn: (next: MeetingSettings) =>
      http.put<MeetingSettings>('/admin/meetings/settings', next),
    onSuccess: (saved) => {
      client.setQueryData(settingsKey, saved)
      setDraft(null)
      toast.show({ title: t('meetings.settings.saved'), tone: 'success' })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const value = draft ?? data
  if (!value) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
        <Skeleton className="h-32" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
      <Card title={t('meetings.settings.title')}>
        <div className="flex flex-col gap-3">
          <Field
            label={t('meetings.settings.retention')}
            hint={t('meetings.settings.retentionHint')}
            htmlFor={monthsId}
          >
            <Input
              id={monthsId}
              type="number"
              min={0}
              max={120}
              className="w-32"
              value={String(value.recordingRetentionMonths)}
              onChange={(event) =>
                setDraft({
                  recordingRetentionMonths: Math.max(
                    0,
                    Math.min(120, Math.trunc(Number(event.target.value) || 0)),
                  ),
                })
              }
            />
          </Field>
          <div>
            <Button
              variant="primary"
              disabled={!draft}
              loading={save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              {t('meetings.settings.save')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
