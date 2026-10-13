import type { FeedPathInfo } from '@kchs/contracts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kchs/ui'
import { useT } from '~/shared/i18n.js'

export const NONE = '__none'

export function sample(value: unknown): string {
  if (value === null || value === undefined) return '—'
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

/** Выбор пути записи ленты: пути предпросмотра с примером значения. */
export function PathSelect({
  value,
  onChange,
  paths,
  label,
  className,
}: {
  value: string
  onChange: (path: string) => void
  paths: readonly FeedPathInfo[]
  label: string
  className?: string
}) {
  const t = useT()
  const known = !value || paths.some((info) => info.path === value)
  return (
    <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
      <SelectTrigger aria-label={label} className={className ?? 'h-7 text-xs'}>
        <SelectValue placeholder={t('admin.dataSources.feed.pickPath')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('admin.dataSources.feed.pickPath')}</SelectItem>
        {known ? null : <SelectItem value={value}>{value}</SelectItem>}
        {paths.map((info) => (
          <SelectItem key={info.path} value={info.path}>
            <span className="font-mono">{info.path}</span>
            <span className="ml-2 text-fg-muted">{sample(info.sample)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
