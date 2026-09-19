import { ObjectIcon, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useT } from '~/app/i18n.js'
import { objectListQuery } from '~/shared/api/queries.js'

const NONE = '__none'

/**
 * Источник ячейки — датасет, график, показатель, карта или слой из доступных
 * пользователю (сначала — пространство тетради). Объект из чужого пространства, уже
 * выбранный соавтором, остаётся в списке под своим именем.
 */
export function ObjectPicker({
  type,
  value,
  onChange,
  label,
  placeholder,
  spaceId,
  disabled,
}: {
  type: 'dataset' | 'chart' | 'metric' | 'map' | 'layer'
  value: string | null
  onChange: (id: string) => void
  label: string
  placeholder: string
  spaceId: string | null
  disabled?: boolean
}) {
  const t = useT()
  const { data: local } = useQuery({
    ...objectListQuery({ types: type, ...(spaceId ? { spaceId } : {}), limit: 100 }),
    enabled: Boolean(spaceId),
  })
  const { data: all } = useQuery(objectListQuery({ types: type, limit: 100 }))
  const items = [...(local?.items ?? [])]
  for (const item of all?.items ?? []) {
    if (!items.some((known) => known.id === item.id)) items.push(item)
  }
  const known = !value || items.some((item) => item.id === value)
  return (
    <Select
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== NONE) onChange(next)
      }}
    >
      <SelectTrigger aria-label={label} className="h-7 w-64 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {value ? null : (
          <SelectItem value={NONE} disabled>
            {placeholder}
          </SelectItem>
        )}
        {known ? null : (
          <SelectItem value={value as string}>{t('data.notebook.otherSource')}</SelectItem>
        )}
        {items.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            <span className="flex min-w-0 items-center gap-1.5">
              <ObjectIcon type={type} className="size-3.5 shrink-0 text-fg-muted" />
              <span className="truncate">{item.title}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
