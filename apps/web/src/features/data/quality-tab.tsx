import type {
  DatasetQuality,
  DatasetRecord,
  QualityKind,
  QualityRule,
  QualitySeverity,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
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
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Качество данных (06-analytics-engine.md §15, ADR-0101): правила датасета и
 * итог последней проверки. Правила ведёт уровень `manage`, смотреть их может
 * каждый, кто видит датасет.
 */

const KINDS: QualityKind[] = [
  'not_null',
  'unique',
  'range',
  'regex',
  'in_set',
  'referential',
  'geometry_valid',
  'freshness',
  'row_count_delta',
]

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ok: 'success',
  warning: 'warning',
  failed: 'danger',
  unknown: 'neutral',
}

export function QualityTab({ dataset }: { dataset: DatasetRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const key = ['object', dataset.id, 'quality'] as const
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => http.get<DatasetQuality>(`/datasets/${dataset.id}/quality`),
  })
  const [rules, setRules] = useState<QualityRule[]>([])

  useEffect(() => {
    if (data) setRules(data.rules)
  }, [data])

  const save = useMutation({
    mutationFn: (next: QualityRule[]) =>
      http.put<DatasetQuality>(`/datasets/${dataset.id}/quality/rules`, { rules: next }),
    onSuccess: (next) => {
      client.setQueryData(key, next)
      toast.success(t('data.quality.saved'))
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const runNow = useMutation({
    mutationFn: () => http.post<DatasetQuality>(`/datasets/${dataset.id}/quality/run`, {}),
    onSuccess: (next) => client.setQueryData(key, next),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (isLoading || !data) return <Skeleton className="h-40" />

  const results = new Map(data.results.map((item) => [item.key, item]))
  const canManage = data.canManage

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TONE[data.status] ?? 'neutral'}>
          {t(`data.quality.statuses.${data.status}`)}
        </Badge>
        {data.checkedAt ? (
          <span className="text-xs text-fg-muted">
            {t('data.quality.checkedAt', {
              when: formatDateTime(data.checkedAt, { locale }),
              version: data.version ?? 0,
            })}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          loading={runNow.isPending}
          onClick={() => runNow.mutate()}
          icon={<ShieldCheck className="size-3.5" />}
        >
          {t('data.quality.run')}
        </Button>
      </div>

      {rules.length === 0 ? (
        <EmptyState
          compact
          icon={<ShieldCheck />}
          title={t('data.quality.empty')}
          description={t('data.quality.emptyHint')}
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('data.quality.rules')}>
          {rules.map((rule, index) => {
            const result = results.get(rule.key)
            return (
              <li
                key={rule.key}
                className="flex flex-wrap items-end gap-2 rounded-md border border-line p-2"
              >
                <Field label={t('data.quality.key')} className="w-40">
                  <Input
                    value={rule.key}
                    readOnly={!canManage}
                    onChange={(event) =>
                      setRules((current) =>
                        current.map((item, position) =>
                          position === index ? { ...item, key: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </Field>
                <Choice
                  label={t('data.quality.kind')}
                  value={rule.kind}
                  disabled={!canManage}
                  onChange={(value) =>
                    setRules((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, kind: value as QualityKind } : item,
                      ),
                    )
                  }
                  options={KINDS.map((kind) => ({
                    value: kind,
                    label: t(`data.quality.kinds.${kind}`),
                  }))}
                />
                <Choice
                  label={t('data.quality.field')}
                  value={rule.field ?? ''}
                  disabled={!canManage || rule.kind === 'row_count_delta'}
                  onChange={(value) =>
                    setRules((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, field: value || null } : item,
                      ),
                    )
                  }
                  options={dataset.fields.map((field) => ({
                    value: field.key,
                    label: field.label.ru,
                  }))}
                />
                <Choice
                  label={t('data.quality.severity')}
                  value={rule.severity}
                  disabled={!canManage}
                  onChange={(value) =>
                    setRules((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, severity: value as QualitySeverity } : item,
                      ),
                    )
                  }
                  options={[
                    { value: 'error', label: t('data.quality.severities.error') },
                    { value: 'warning', label: t('data.quality.severities.warning') },
                  ]}
                />

                <RuleParams
                  rule={rule}
                  fields={dataset.fields}
                  disabled={!canManage}
                  onChange={(params) =>
                    setRules((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, params } : item,
                      ),
                    )
                  }
                />

                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {result ? (
                    <Badge tone={result.status === 'ok' ? 'success' : TONE[data.status]} size="sm">
                      {result.status === 'ok'
                        ? t('data.quality.ruleOk')
                        : (result.message ?? t('data.quality.ruleFailed'))}
                    </Badge>
                  ) : null}
                </div>

                {canManage ? (
                  <IconButton
                    size="sm"
                    label={t('common.actions.delete')}
                    onClick={() =>
                      setRules((current) => current.filter((_, position) => position !== index))
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {canManage ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-3.5" />}
            onClick={() =>
              setRules((current) => [
                ...current,
                {
                  key: `rule_${current.length + 1}`,
                  kind: 'not_null',
                  field: dataset.fields[0]?.key ?? null,
                  params: {},
                  severity: 'error',
                  enabled: true,
                },
              ])
            }
          >
            {t('data.quality.addRule')}
          </Button>
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate(rules)}>
            {t('common.actions.save')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** Выпадающий список дизайн-системы: значение, подпись и блокировка. */
/**
 * Параметры правила: у каждого вида свои (ADR-0101). Без них правило
 * сохранялось, но проверка падала — половина видов была недоступна.
 */
function RuleParams({
  rule,
  fields,
  disabled,
  onChange,
}: {
  rule: QualityRule
  fields: ReadonlyArray<{ key: string; label: { ru: string } }>
  disabled: boolean
  onChange: (params: QualityRule['params']) => void
}) {
  const t = useT()
  const params = rule.params ?? {}
  const number = (value: string) => (value.trim() === '' ? undefined : Number(value))

  if (rule.kind === 'range') {
    return (
      <>
        <Field label={t('data.quality.params.min')} className="w-28">
          <Input
            type="number"
            value={params.min ?? ''}
            readOnly={disabled}
            onChange={(event) => onChange({ ...params, min: number(event.target.value) })}
          />
        </Field>
        <Field label={t('data.quality.params.max')} className="w-28">
          <Input
            type="number"
            value={params.max ?? ''}
            readOnly={disabled}
            onChange={(event) => onChange({ ...params, max: number(event.target.value) })}
          />
        </Field>
      </>
    )
  }
  if (rule.kind === 'regex') {
    return (
      <Field label={t('data.quality.params.pattern')} className="w-56">
        <Input
          value={params.pattern ?? ''}
          readOnly={disabled}
          placeholder="^[0-9]{4}$"
          onChange={(event) => onChange({ ...params, pattern: event.target.value })}
        />
      </Field>
    )
  }
  if (rule.kind === 'in_set') {
    return (
      <Field label={t('data.quality.params.values')} className="w-56">
        <Input
          value={(params.values ?? []).join(', ')}
          readOnly={disabled}
          placeholder={t('data.quality.params.valuesHint')}
          onChange={(event) =>
            onChange({
              ...params,
              values: event.target.value
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            })
          }
        />
      </Field>
    )
  }
  if (rule.kind === 'referential') {
    return (
      <>
        <Field label={t('data.quality.params.datasetId')} className="w-56">
          <Input
            value={params.datasetId ?? ''}
            readOnly={disabled}
            placeholder={t('data.quality.params.datasetIdHint')}
            onChange={(event) => onChange({ ...params, datasetId: event.target.value })}
          />
        </Field>
        <Field label={t('data.quality.params.datasetField')} className="w-40">
          <Input
            value={params.datasetField ?? ''}
            readOnly={disabled}
            onChange={(event) => onChange({ ...params, datasetField: event.target.value })}
          />
        </Field>
      </>
    )
  }
  if (rule.kind === 'freshness') {
    return (
      <Field label={t('data.quality.params.maxAgeHours')} className="w-36">
        <Input
          type="number"
          value={params.maxAgeHours ?? ''}
          readOnly={disabled}
          onChange={(event) => onChange({ ...params, maxAgeHours: number(event.target.value) })}
        />
      </Field>
    )
  }
  if (rule.kind === 'row_count_delta') {
    return (
      <Field label={t('data.quality.params.maxDropPercent')} className="w-36">
        <Input
          type="number"
          value={params.maxDropPercent ?? ''}
          readOnly={disabled}
          onChange={(event) => onChange({ ...params, maxDropPercent: number(event.target.value) })}
        />
      </Field>
    )
  }
  // `not_null`, `unique`, `geometry_valid` настроек не требуют
  return null
}

function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  disabled: boolean
  onChange: (next: string) => void
}) {
  return (
    <Field label={label} className="w-44">
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
