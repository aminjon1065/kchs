import type { PipelineStep } from '@kchs/contracts'
import { STORED_FIELD_TYPES } from '@kchs/contracts'
import {
  Callout,
  Checkbox,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@kchs/ui'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { formatPairs, parseList, parsePairs, SIMPLE_STEPS } from './step-model.js'

/**
 * Форма шага пайплайна (ADR-0106). Простые шаги правятся полями, сложные —
 * JSON: у соединения и отбора свои конструкторы появятся вместе с выбором
 * источников на экране.
 */
export function StepEditor({
  step,
  onChange,
}: {
  step: PipelineStep
  onChange: (next: PipelineStep) => void
}) {
  const t = useT()
  const id = useId()
  const patch = (values: Partial<PipelineStep>) => onChange({ ...step, ...values } as PipelineStep)

  if (!SIMPLE_STEPS.has(step.type)) return <JsonStepEditor step={step} onChange={onChange} />

  switch (step.type) {
    case 'custom_sql':
      return (
        <Field
          label={t('data.pipelines.fields.sql')}
          htmlFor={`${id}-sql`}
          hint={t('data.pipelines.fields.sqlHint')}
        >
          <Textarea
            id={`${id}-sql`}
            className="font-mono"
            rows={6}
            value={step.sql}
            onChange={(event) => patch({ sql: event.target.value })}
          />
        </Field>
      )
    case 'select':
      return (
        <Field
          label={t('data.pipelines.fields.fields')}
          htmlFor={`${id}-fields`}
          hint={t('data.pipelines.fields.fieldsHint')}
        >
          <Input
            id={`${id}-fields`}
            className="font-mono"
            value={step.fields
              .map((item) => (item.as ? `${item.field}=${item.as}` : item.field))
              .join(', ')}
            onChange={(event) =>
              patch({
                fields: parseList(event.target.value).map((part) => {
                  const at = part.indexOf('=')
                  return at < 0
                    ? { field: part }
                    : { field: part.slice(0, at).trim(), as: part.slice(at + 1).trim() }
                }),
              })
            }
          />
        </Field>
      )
    case 'rename':
      return (
        <Field
          label={t('data.pipelines.fields.renames')}
          htmlFor={`${id}-renames`}
          hint={t('data.pipelines.fields.renamesHint')}
        >
          <Textarea
            id={`${id}-renames`}
            className="font-mono"
            rows={4}
            value={formatPairs(
              step.renames.map((item) => [item.field, item.to]),
              '→',
            )}
            onChange={(event) =>
              patch({
                renames: parsePairs(event.target.value, '→').map(([field, to]) => ({ field, to })),
              })
            }
          />
        </Field>
      )
    case 'cast':
      return (
        <Field
          label={t('data.pipelines.fields.casts')}
          htmlFor={`${id}-casts`}
          hint={t('data.pipelines.fields.castsHint', {
            types: STORED_FIELD_TYPES.slice(0, 6).join(', '),
          })}
        >
          <Textarea
            id={`${id}-casts`}
            className="font-mono"
            rows={4}
            value={formatPairs(
              step.casts.map((item) => [item.field, item.to]),
              ':',
            )}
            onChange={(event) =>
              patch({
                casts: parsePairs(event.target.value, ':').map(([field, to]) => ({
                  field,
                  to: to as (typeof STORED_FIELD_TYPES)[number],
                })),
              })
            }
          />
        </Field>
      )
    case 'dedupe':
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('data.pipelines.fields.by')} htmlFor={`${id}-by`}>
            <Input
              id={`${id}-by`}
              className="font-mono"
              value={step.by.join(', ')}
              onChange={(event) => patch({ by: parseList(event.target.value) })}
            />
          </Field>
          <Field label={t('data.pipelines.fields.keep')} htmlFor={`${id}-keep`}>
            <Select
              value={step.keep}
              onValueChange={(value) => patch({ keep: value as 'first' | 'last' })}
            >
              <SelectTrigger id={`${id}-keep`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="first">{t('data.pipelines.keep.first')}</SelectItem>
                <SelectItem value="last">{t('data.pipelines.keep.last')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      )
    case 'fill':
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('data.pipelines.fields.field')} htmlFor={`${id}-field`}>
            <Input
              id={`${id}-field`}
              className="font-mono"
              value={step.field}
              onChange={(event) => patch({ field: event.target.value })}
            />
          </Field>
          <Field
            label={t('data.pipelines.fields.fillValue')}
            htmlFor={`${id}-value`}
            hint={t('data.pipelines.fields.fillHint')}
          >
            <Input
              id={`${id}-value`}
              className="font-mono"
              value={step.with.kind === 'value' ? String(step.with.value) : step.with.field}
              onChange={(event) => patch({ with: { kind: 'value', value: event.target.value } })}
            />
          </Field>
        </div>
      )
    case 'split':
      return (
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('data.pipelines.fields.field')} htmlFor={`${id}-field`}>
            <Input
              id={`${id}-field`}
              className="font-mono"
              value={step.field}
              onChange={(event) => patch({ field: event.target.value })}
            />
          </Field>
          <Field label={t('data.pipelines.fields.separator')} htmlFor={`${id}-sep`}>
            <Input
              id={`${id}-sep`}
              className="font-mono"
              maxLength={8}
              value={step.separator}
              onChange={(event) => patch({ separator: event.target.value })}
            />
          </Field>
          <Field label={t('data.pipelines.fields.into')} htmlFor={`${id}-into`}>
            <Input
              id={`${id}-into`}
              className="font-mono"
              value={step.into.join(', ')}
              onChange={(event) => patch({ into: parseList(event.target.value) })}
            />
          </Field>
        </div>
      )
    case 'merge_columns':
      return (
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('data.pipelines.fields.fields')} htmlFor={`${id}-fields`}>
            <Input
              id={`${id}-fields`}
              className="font-mono"
              value={step.fields.join(', ')}
              onChange={(event) => patch({ fields: parseList(event.target.value) })}
            />
          </Field>
          <Field label={t('data.pipelines.fields.separator')} htmlFor={`${id}-sep`}>
            <Input
              id={`${id}-sep`}
              className="font-mono"
              maxLength={8}
              value={step.separator}
              onChange={(event) => patch({ separator: event.target.value })}
            />
          </Field>
          <Field label={t('data.pipelines.fields.into')} htmlFor={`${id}-into`}>
            <Input
              id={`${id}-into`}
              className="font-mono"
              value={step.into}
              onChange={(event) => patch({ into: event.target.value })}
            />
          </Field>
        </div>
      )
    case 'compute':
      return (
        <Field
          label={t('data.pipelines.fields.compute')}
          htmlFor={`${id}-compute`}
          hint={t('data.pipelines.fields.computeHint')}
        >
          <Textarea
            id={`${id}-compute`}
            className="font-mono"
            rows={4}
            value={formatPairs(
              step.fields.map((item) => [item.name, item.expr]),
              '=',
            )}
            onChange={(event) =>
              patch({
                fields: parsePairs(event.target.value, '=').map(([name, expr]) => ({ name, expr })),
              })
            }
          />
        </Field>
      )
    case 'unpivot':
      return (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('data.pipelines.fields.keep')} htmlFor={`${id}-keep`}>
              <Input
                id={`${id}-keep`}
                className="font-mono"
                value={step.keep.join(', ')}
                onChange={(event) => patch({ keep: parseList(event.target.value) })}
              />
            </Field>
            <Field label={t('data.pipelines.fields.fields')} htmlFor={`${id}-fields`}>
              <Input
                id={`${id}-fields`}
                className="font-mono"
                value={step.fields.join(', ')}
                onChange={(event) => patch({ fields: parseList(event.target.value) })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('data.pipelines.fields.nameField')} htmlFor={`${id}-name`}>
              <Input
                id={`${id}-name`}
                className="font-mono"
                value={step.nameField}
                onChange={(event) => patch({ nameField: event.target.value })}
              />
            </Field>
            <Field label={t('data.pipelines.fields.valueField')} htmlFor={`${id}-value`}>
              <Input
                id={`${id}-value`}
                className="font-mono"
                value={step.valueField}
                onChange={(event) => patch({ valueField: event.target.value })}
              />
            </Field>
          </div>
          <Checkbox
            label={t('data.pipelines.fields.dropNulls')}
            checked={step.dropNulls}
            onCheckedChange={(checked) => patch({ dropNulls: checked === true })}
          />
        </div>
      )
    case 'geocode':
      return (
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('data.pipelines.fields.field')} htmlFor={`${id}-field`}>
            <Input
              id={`${id}-field`}
              className="font-mono"
              value={step.field}
              onChange={(event) => patch({ field: event.target.value })}
            />
          </Field>
          <Field label={t('data.pipelines.fields.match')} htmlFor={`${id}-match`}>
            <Select
              value={step.match}
              onValueChange={(value) => patch({ match: value as 'code' | 'name' })}
            >
              <SelectTrigger id={`${id}-match`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="code">{t('data.pipelines.match.code')}</SelectItem>
                <SelectItem value="name">{t('data.pipelines.match.name')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('data.pipelines.fields.as')} htmlFor={`${id}-as`}>
            <Input
              id={`${id}-as`}
              className="font-mono"
              value={step.as}
              onChange={(event) => patch({ as: event.target.value })}
            />
          </Field>
        </div>
      )
    case 'assign_territory':
      return (
        <Field label={t('data.pipelines.fields.level')} htmlFor={`${id}-level`}>
          <Select
            value={step.level}
            onValueChange={(value) => patch({ level: value as typeof step.level })}
          >
            <SelectTrigger id={`${id}-level`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['country', 'region', 'district', 'jamoat', 'settlement'] as const).map((level) => (
                <SelectItem key={level} value={level}>
                  {t(`gis.territories.levels.${level}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )
    default:
      return <JsonStepEditor step={step} onChange={onChange} />
  }
}

/** Шаг как JSON: для соединения, объединения, отбора и пространственного шага. */
function JsonStepEditor({
  step,
  onChange,
}: {
  step: PipelineStep
  onChange: (next: PipelineStep) => void
}) {
  const t = useT()
  const id = useId()
  const [text, setText] = useState(() => JSON.stringify(step, null, 2))
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState(step)
  if (source !== step) {
    setSource(step)
    setText(JSON.stringify(step, null, 2))
    setError(null)
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <Field
        label={t('data.pipelines.fields.json')}
        htmlFor={`${id}-json`}
        hint={t('data.pipelines.fields.jsonHint')}
      >
        <Textarea
          id={`${id}-json`}
          className="font-mono"
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            try {
              onChange(JSON.parse(text) as PipelineStep)
              setError(null)
            } catch {
              setError(t('data.pipelines.jsonError'))
            }
          }}
        />
      </Field>
    </div>
  )
}
