import type { LayerRecord } from '@kchs/contracts'
import { Switch, useToast } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { gisKeys } from '../queries.js'
import { editKeys } from './edit-api.js'

/**
 * Настройки правки слоя (07-gis-engine.md §7): правка объектов на карте и
 * модерация — правки пользователей без права править данные ждут проверки.
 * Меняет редактор слоя (PATCH слоя, уровень edit).
 */
export function LayerEditSettings({ layer }: { layer: LayerRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const ids = useId()
  const update = useMutation({
    mutationFn: (patch: { editable?: boolean; moderated?: boolean }) =>
      http.patch<LayerRecord>(`/gis/layers/${layer.id}`, patch),
    onSuccess: (record) => {
      client.setQueryData(gisKeys.layer(layer.id), record)
      void client.invalidateQueries({ queryKey: editKeys.access(layer.id) })
    },
    onError: (failure) =>
      toast.error(failure instanceof ApiError ? failure.message : t('errors.unknown')),
  })
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 text-2xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('gis.edit.settings.title')}
      </legend>
      <div className="flex items-start gap-2">
        <Switch
          id={`${ids}-editable`}
          checked={layer.editable}
          disabled={update.isPending}
          onCheckedChange={(checked) => update.mutate({ editable: checked })}
        />
        <label htmlFor={`${ids}-editable`} className="flex flex-col text-sm text-fg">
          {t('gis.edit.settings.editable')}
          <span className="text-xs text-fg-muted">{t('gis.edit.settings.editableHint')}</span>
        </label>
      </div>
      <div className="flex items-start gap-2">
        <Switch
          id={`${ids}-moderated`}
          checked={layer.moderated}
          disabled={update.isPending || !layer.editable}
          onCheckedChange={(checked) => update.mutate({ moderated: checked })}
        />
        <label htmlFor={`${ids}-moderated`} className="flex flex-col text-sm text-fg">
          {t('gis.edit.settings.moderated')}
          <span className="text-xs text-fg-muted">{t('gis.edit.settings.moderatedHint')}</span>
        </label>
      </div>
    </fieldset>
  )
}
