import type { PositionsSettings } from '@kchs/contracts'
import {
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { objectListQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import { positionKeys, positionsApi, positionsSettingsQuery } from './queries.js'

const NONE = 'none'

/** Целое в пределах: пустое и мусор — нижняя граница. */
const clamp = (value: string, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.trunc(Number(value) || min)))

/**
 * Настройки местоположения установки (ADR-0203): срок хранения точек, порог «нет
 * связи», датасет слоя карты обстановки. Только администратору системы; правка — в
 * аудит.
 */
export function PositionsSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const retentionId = useId()
  const staleId = useId()
  const { data } = useQuery({ ...positionsSettingsQuery(), enabled: open })
  const { data: datasets } = useQuery({
    ...objectListQuery({ type: 'dataset', limit: 200 }),
    enabled: open,
  })
  const [draft, setDraft] = useState<PositionsSettings | null>(null)
  const value = draft ?? data

  const save = useMutation({
    mutationFn: (next: PositionsSettings) => positionsApi.saveSettings(next),
    onSuccess: (saved) => {
      client.setQueryData(positionKeys.settings, saved)
      setDraft(null)
      toast.show({ title: t('positions.settings.saved'), tone: 'success' })
      onOpenChange(false)
    },
    onError: (error) =>
      toast.error(error instanceof Error && error.message ? error.message : t('errors.unknown')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('positions.settings.title')}
        size="md"
        footer={
          <Button
            variant="primary"
            disabled={!draft}
            loading={save.isPending}
            onClick={() => draft && save.mutate(draft)}
          >
            {t('positions.settings.save')}
          </Button>
        }
      >
        {!value ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="flex flex-col gap-4">
            <Field
              label={t('positions.settings.retention')}
              hint={t('positions.settings.retentionHint')}
              htmlFor={retentionId}
            >
              <Input
                id={retentionId}
                type="number"
                min={1}
                max={120}
                className="w-32"
                value={String(value.retentionMonths)}
                onChange={(event) =>
                  setDraft({ ...value, retentionMonths: clamp(event.target.value, 1, 120) })
                }
              />
            </Field>
            <Field
              label={t('positions.settings.stale')}
              hint={t('positions.settings.staleHint')}
              htmlFor={staleId}
            >
              <Input
                id={staleId}
                type="number"
                min={1}
                max={1440}
                className="w-32"
                value={String(value.staleMinutes)}
                onChange={(event) =>
                  setDraft({ ...value, staleMinutes: clamp(event.target.value, 1, 1440) })
                }
              />
            </Field>
            <Field
              label={t('positions.settings.dataset')}
              hint={t('positions.settings.datasetHint')}
            >
              <Select
                value={value.projectionDatasetId ?? NONE}
                onValueChange={(next) =>
                  setDraft({ ...value, projectionDatasetId: next === NONE ? null : next })
                }
              >
                <SelectTrigger aria-label={t('positions.settings.dataset')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('positions.settings.none')}</SelectItem>
                  {(datasets?.items ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
