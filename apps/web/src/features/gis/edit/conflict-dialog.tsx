import type { DatasetRecord, Locale } from '@kchs/contracts'
import { Badge, Button, Callout, Dialog, DialogContent } from '@kchs/ui'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { fieldLabel } from '../../data/field-types.js'
import type { RowConflict } from './edit-api.js'
import { useFieldText } from './field-text.js'

/**
 * Конфликт версии объекта (07-gis-engine.md §7, ADR-0051): объект изменили после
 * того, как его открыли. Показываются поля правки и изменённые другими — «моё»
 * и «сейчас»; можно перезаписать своими значениями или отменить свою правку.
 */
export function ConflictDialog({
  dataset,
  geometryField,
  mine,
  conflict,
  busy,
  overwriteLabel,
  discardLabel,
  mineLabel,
  onOverwrite,
  onDiscard,
  onClose,
}: {
  dataset: DatasetRecord
  geometryField: string
  /** Значения правки пользователя; геометрия — под ключом поля геометрии. */
  mine: Record<string, unknown>
  conflict: RowConflict
  busy: boolean
  overwriteLabel: string
  /** По умолчанию — «Отменить мою правку». */
  discardLabel?: string
  /** Заголовок столбца правки; по умолчанию — «Моё значение». */
  mineLabel?: string
  onOverwrite: () => void
  onDiscard: () => void
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const keys = [...new Set([...Object.keys(mine), ...conflict.changedFields])]
  const byKey = new Map(dataset.fields.map((field) => [field.key, field]))
  const fieldText = useFieldText(dataset)
  const text = (key: string, value: unknown): string =>
    key === geometryField ? (value ? t('gis.edit.conflict.geometry') : '—') : fieldText(key, value)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('gis.edit.conflict.title')}
        description={t('gis.edit.conflict.description', { ver: conflict.current._ver })}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onDiscard} disabled={busy}>
              {discardLabel ?? t('gis.edit.conflict.discard')}
            </Button>
            <Button variant="primary" loading={busy} onClick={onOverwrite}>
              {overwriteLabel}
            </Button>
          </>
        }
      >
        {keys.length === 0 ? (
          <Callout tone="info">{t('gis.edit.conflict.noFields')}</Callout>
        ) : (
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="w-1/3 pb-1 font-medium">{t('gis.edit.conflict.field')}</th>
                <th className="w-1/3 pb-1 font-medium">
                  {mineLabel ?? t('gis.edit.conflict.mine')}
                </th>
                <th className="w-1/3 pb-1 font-medium">{t('gis.edit.conflict.current')}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const field = byKey.get(key)
                const changed = conflict.changedFields.includes(key)
                return (
                  <tr key={key} className="border-t border-line align-top">
                    <td className="py-1.5 pr-2 text-fg-secondary">
                      <span className="flex flex-wrap items-center gap-1">
                        {field ? fieldLabel(field, locale) : key}
                        {changed ? (
                          <Badge size="sm" tone="warning">
                            {t('gis.edit.conflict.changed')}
                          </Badge>
                        ) : null}
                      </span>
                    </td>
                    <td className="break-words py-1.5 pr-2">
                      {key in mine ? text(key, mine[key]) : '—'}
                    </td>
                    <td className="break-words py-1.5">
                      {text(key, conflict.current.values[key])}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </DialogContent>
    </Dialog>
  )
}
