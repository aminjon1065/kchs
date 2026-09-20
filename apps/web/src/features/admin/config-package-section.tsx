import type {
  ConfigImportPreview,
  ConfigImportResult,
  ConfigPackage,
  ConfigSection,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FileJson } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

const STATUS_TONES: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  new: 'success',
  changed: 'warning',
  same: 'neutral',
  conflict: 'danger',
  unsupported: 'neutral',
}

/**
 * «Конфигурация» в администрировании (14-automation-integrations.md §6,
 * ADR-0097): выгрузка настройки в JSON-пакет по стабильным ключам и импорт с
 * предпросмотром различий — конфликт применяется только по явному согласию.
 */
export function ConfigPackageSection() {
  const t = useT()
  const toast = useToast()
  const [selected, setSelected] = useState<ConfigSection[]>([])
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<ConfigImportPreview | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sections = useQuery({
    queryKey: ['config', 'sections'],
    queryFn: () => http.get<{ items: ConfigSection[] }>('/config/sections'),
    select: (data: { items: ConfigSection[] }) => data.items,
  })

  const exportPackage = useMutation({
    mutationFn: () => http.post<ConfigPackage>('/config/export', { sections: selected }),
    onSuccess: (pkg) => {
      setText(JSON.stringify(pkg, null, 2))
      setPreview(null)
      toast.show({ title: t('admin.config.exported'), tone: 'success' })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const parsePackage = (): ConfigPackage => {
    try {
      return JSON.parse(text) as ConfigPackage
    } catch {
      throw new Error(t('admin.config.badJson'))
    }
  }

  const check = useMutation({
    mutationFn: () =>
      http.post<ConfigImportPreview>('/config/import/preview', { package: parsePackage() }),
    onSuccess: (result) => {
      setPreview(result)
      setError(null)
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : (err as Error).message || t('errors.unknown'),
      ),
  })

  const apply = useMutation({
    mutationFn: () =>
      http.post<ConfigImportResult>('/config/import', {
        package: parsePackage(),
        overwriteConflicts: overwrite,
      }),
    onSuccess: (result) => {
      toast.show({
        title: t('admin.config.applied', {
          applied: result.applied.length,
          skipped: result.skipped.length,
        }),
        tone: 'success',
      })
      setPreview(null)
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : (err as Error).message || t('errors.unknown'),
      ),
  })

  const toggleSection = (section: ConfigSection) =>
    setSelected((current) =>
      current.includes(section)
        ? current.filter((item) => item !== section)
        : [...current, section],
    )

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-4 p-5">
      <p className="text-sm text-fg-secondary">{t('admin.config.hint')}</p>

      <Card title={t('admin.config.exportTitle')}>
        <div className="flex flex-wrap gap-3">
          {(sections.data ?? []).map((section) => (
            <Checkbox
              key={section}
              checked={selected.includes(section)}
              onCheckedChange={() => toggleSection(section)}
              label={t(`admin.config.sections.${section}`)}
            />
          ))}
        </div>
        <Button
          className="mt-3"
          variant="secondary"
          size="sm"
          loading={exportPackage.isPending}
          disabled={selected.length === 0}
          onClick={() => exportPackage.mutate()}
        >
          {t('admin.config.export')}
        </Button>
      </Card>

      <Card title={t('admin.config.importTitle')}>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <Field label={t('admin.config.packageJson')} hint={t('admin.config.packageHint')}>
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={10}
            spellCheck={false}
          />
        </Field>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            loading={check.isPending}
            disabled={text.trim().length === 0}
            onClick={() => check.mutate()}
          >
            {t('admin.config.preview')}
          </Button>
          <Checkbox
            checked={overwrite}
            onCheckedChange={(next) => setOverwrite(next === true)}
            label={t('admin.config.overwrite')}
          />
          <Button
            variant="primary"
            size="sm"
            loading={apply.isPending}
            disabled={preview === null}
            onClick={() => apply.mutate()}
          >
            {t('admin.config.apply')}
          </Button>
        </div>
      </Card>

      {preview ? (
        <Card title={t('admin.config.diffTitle')} padded={false}>
          {preview.entries.length === 0 ? (
            <EmptyState compact icon={<FileJson />} title={t('admin.config.diffEmpty')} />
          ) : (
            <ul className="divide-y divide-line">
              {preview.entries.map((entry) => (
                <li
                  key={`${entry.section}:${entry.key}`}
                  className="flex flex-wrap items-start gap-2 px-4 py-2"
                >
                  <Badge tone={STATUS_TONES[entry.status] ?? 'neutral'} size="sm">
                    {t(`admin.config.statuses.${entry.status}`)}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-fg">{entry.title}</span>
                    <p className="text-xs text-fg-muted">
                      <code>
                        {entry.section}:{entry.key}
                      </code>
                      {entry.changedFields.length > 0 ? ` · ${entry.changedFields.join(', ')}` : ''}
                      {entry.reason ? ` · ${entry.reason}` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  )
}
