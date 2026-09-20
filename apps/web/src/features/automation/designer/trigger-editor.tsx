import {
  type ObjectType,
  RULE_TRIGGER_KINDS,
  type RuleCatalog,
  type RuleTrigger,
  type RuleTriggerKind,
} from '@kchs/contracts'
import {
  Button,
  Field,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@kchs/ui'
import { Plus, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { useT } from '~/app/i18n.js'

/** Заготовка триггера выбранного вида. */
export function defaultTrigger(kind: RuleTriggerKind): RuleTrigger {
  switch (kind) {
    case 'event':
      return { kind, type: 'object.created', filter: {} }
    case 'schedule':
      return { kind, cron: '0 9 * * *', timezone: 'Asia/Dushanbe', objectId: null }
    case 'webhook':
      return { kind, hookKey: 'hook' }
    case 'manual':
      return { kind, objectTypes: ['document'], confirm: false }
    case 'metric':
      return {
        kind,
        metricId: '00000000-0000-7000-8000-000000000000',
        condition: 'value > 0',
        cron: '0 8 * * *',
        timezone: 'Asia/Dushanbe',
      }
  }
}

/**
 * Блок «когда» конструктора (ADR-0096): вид триггера и его поля. Подсказки
 * типов событий — из каталога событий платформы.
 */
export function TriggerEditor({
  trigger,
  catalog,
  webhookUrl,
  onChange,
  disabled,
}: {
  trigger: RuleTrigger
  catalog: RuleCatalog | undefined
  webhookUrl: string | null
  onChange: (next: RuleTrigger) => void
  disabled?: boolean
}) {
  const t = useT()
  const kindId = useId()
  const typeId = useId()
  const cronId = useId()

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={t('automation.fields.trigger')} htmlFor={kindId}>
        <Select
          value={trigger.kind}
          onValueChange={(value) => onChange(defaultTrigger(value as RuleTriggerKind))}
          disabled={disabled}
        >
          <SelectTrigger id={kindId} aria-label={t('automation.fields.trigger')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RULE_TRIGGER_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`automation.triggers.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {trigger.kind === 'event' ? (
        <>
          <Field
            label={t('automation.designer.eventType')}
            htmlFor={typeId}
            hint={t('automation.designer.eventTypeHint')}
          >
            <Input
              id={typeId}
              list={`${typeId}-events`}
              value={trigger.type}
              disabled={disabled}
              onChange={(event) => onChange({ ...trigger, type: event.target.value })}
            />
            <datalist id={`${typeId}-events`}>
              {(catalog?.events ?? []).map((hint) => (
                <option key={hint.type} value={hint.type} />
              ))}
            </datalist>
          </Field>
          <div className="md:col-span-2">
            <FilterEditor
              filter={trigger.filter}
              disabled={disabled}
              onChange={(filter) => onChange({ ...trigger, filter })}
            />
          </div>
        </>
      ) : null}

      {trigger.kind === 'schedule' || trigger.kind === 'metric' ? (
        <>
          <Field
            label={t('automation.designer.cron')}
            htmlFor={cronId}
            hint={t('automation.designer.cronHint')}
          >
            <Input
              id={cronId}
              value={trigger.cron}
              disabled={disabled}
              onChange={(event) => onChange({ ...trigger, cron: event.target.value })}
            />
          </Field>
          <Field label={t('automation.designer.timezone')}>
            <Input
              value={trigger.timezone}
              disabled={disabled}
              aria-label={t('automation.designer.timezone')}
              onChange={(event) => onChange({ ...trigger, timezone: event.target.value })}
            />
          </Field>
        </>
      ) : null}

      {trigger.kind === 'metric' ? (
        <>
          <Field label={t('automation.designer.metricId')}>
            <Input
              value={trigger.metricId}
              disabled={disabled}
              aria-label={t('automation.designer.metricId')}
              onChange={(event) => onChange({ ...trigger, metricId: event.target.value })}
            />
          </Field>
          <Field label={t('automation.designer.metricCondition')}>
            <Input
              value={trigger.condition}
              disabled={disabled}
              aria-label={t('automation.designer.metricCondition')}
              onChange={(event) => onChange({ ...trigger, condition: event.target.value })}
            />
          </Field>
        </>
      ) : null}

      {trigger.kind === 'webhook' ? (
        <>
          <Field label={t('automation.designer.hookKey')}>
            <Input
              value={trigger.hookKey}
              disabled={disabled}
              aria-label={t('automation.designer.hookKey')}
              onChange={(event) => onChange({ ...trigger, hookKey: event.target.value })}
            />
          </Field>
          {webhookUrl ? (
            <Field
              label={t('automation.designer.webhookUrl')}
              hint={t('automation.designer.webhookUrlHint')}
            >
              <Input value={webhookUrl} readOnly aria-label={t('automation.designer.webhookUrl')} />
            </Field>
          ) : null}
        </>
      ) : null}

      {trigger.kind === 'manual' ? (
        <>
          <Field label={t('automation.designer.objectTypes')}>
            <Textarea
              value={trigger.objectTypes.join('\n')}
              disabled={disabled}
              aria-label={t('automation.designer.objectTypes')}
              onChange={(event) =>
                onChange({
                  ...trigger,
                  objectTypes: event.target.value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean) as ObjectType[],
                })
              }
            />
          </Field>
          <Field label={t('automation.designer.confirm')}>
            <Switch
              checked={trigger.confirm}
              disabled={disabled}
              aria-label={t('automation.designer.confirm')}
              onCheckedChange={(checked) => onChange({ ...trigger, confirm: checked })}
            />
          </Field>
        </>
      ) : null}
    </div>
  )
}

/** Отбор по полям конверта события: путь → значение. */
function FilterEditor({
  filter,
  onChange,
  disabled,
}: {
  filter: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  disabled?: boolean
}) {
  const t = useT()
  const entries = Object.entries(filter)

  const update = (index: number, key: string, value: string) => {
    const next = entries.map((entry, position) => (position === index ? [key, value] : entry))
    onChange(Object.fromEntries(next.filter(([entryKey]) => String(entryKey ?? '').length > 0)))
  }

  return (
    <Field label={t('automation.designer.filter')}>
      <div className="flex flex-col gap-2">
        {entries.map(([key, value], index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={key}
              disabled={disabled}
              aria-label={t('automation.designer.filterPath')}
              onChange={(event) => update(index, event.target.value, String(value ?? ''))}
            />
            <Input
              value={String(value ?? '')}
              disabled={disabled}
              aria-label={t('automation.designer.filterValue')}
              onChange={(event) => update(index, key, event.target.value)}
            />
            <IconButton
              size="sm"
              variant="ghost"
              label={t('automation.designer.actionRemove')}
              disabled={disabled}
              onClick={() =>
                onChange(Object.fromEntries(entries.filter((_, position) => position !== index)))
              }
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange({ ...filter, '': '' })}
          >
            <Plus className="size-4" />
            {t('automation.designer.filterAdd')}
          </Button>
        </div>
      </div>
    </Field>
  )
}
