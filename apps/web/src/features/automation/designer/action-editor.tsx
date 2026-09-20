import { RULE_ACTION_TYPES, type RuleAction, type RuleActionType } from '@kchs/contracts'
import {
  Button,
  Card,
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
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { useT } from '~/app/i18n.js'
import { ACTION_FIELDS, type ActionField, defaultAction } from './action-fields.js'

/**
 * Блок «то» конструктора (ADR-0096): список действий по порядку, у каждого —
 * свои поля. Значения — шаблоны `{{…}}` и выражения назначений: их проверяет
 * сервер и показывает в блоке проверки.
 */
export function ActionEditor({
  actions,
  onChange,
  disabled,
}: {
  actions: RuleAction[]
  onChange: (next: RuleAction[]) => void
  disabled?: boolean
}) {
  const t = useT()

  const replace = (index: number, next: RuleAction) => {
    onChange(actions.map((item, position) => (position === index ? next : item)))
  }
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= actions.length) return
    const next = [...actions]
    const [item] = next.splice(index, 1)
    if (item) next.splice(target, 0, item)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {actions.map((action, index) => (
        <Card key={`${action.type}-${index}`} className="flex flex-col gap-3 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-secondary">{index + 1}</span>
            <Select
              value={action.type}
              onValueChange={(value) => replace(index, defaultAction(value as RuleActionType))}
              disabled={disabled}
            >
              <SelectTrigger aria-label={t('automation.designer.actionType')} className="w-[16rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RULE_ACTION_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`automation.actions.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ms-auto flex items-center gap-1">
              <IconButton
                size="sm"
                variant="ghost"
                label={t('automation.designer.actionUp')}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-4" />
              </IconButton>
              <IconButton
                size="sm"
                variant="ghost"
                label={t('automation.designer.actionDown')}
                disabled={disabled || index === actions.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-4" />
              </IconButton>
              <IconButton
                size="sm"
                variant="ghost"
                label={t('automation.designer.actionRemove')}
                disabled={disabled}
                onClick={() => onChange(actions.filter((_, position) => position !== index))}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {ACTION_FIELDS[action.type].map((field) => (
              <ActionFieldInput
                key={field.key}
                field={field}
                action={action}
                disabled={disabled}
                onChange={(next) => replace(index, next)}
              />
            ))}
          </div>
        </Card>
      ))}
      <div>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => onChange([...actions, defaultAction('notify')])}
        >
          <Plus className="size-4" />
          {t('automation.designer.actionAdd')}
        </Button>
      </div>
    </div>
  )
}

type Values = Record<string, unknown>

function ActionFieldInput({
  field,
  action,
  onChange,
  disabled,
}: {
  field: ActionField
  action: RuleAction
  onChange: (next: RuleAction) => void
  disabled?: boolean
}) {
  const t = useT()
  const id = useId()
  const values = action as unknown as Values
  const label = t(`automation.actionFields.${field.label}`)
  const set = (value: unknown) =>
    onChange({ ...(values as object), [field.key]: value } as RuleAction)

  // Цель задачи ИИ — объект `{kind, key}`: вид выбирается, ключ поля вводится
  if (action.type === 'ai_task' && field.key === 'target') {
    const target = action.target
    return (
      <div className="flex flex-col gap-2">
        <Field label={label} htmlFor={id}>
          <Select
            value={target.kind}
            onValueChange={(value) =>
              set(value === 'comment' ? { kind: 'comment' } : { kind: 'field', key: '' })
            }
            disabled={disabled}
          >
            <SelectTrigger id={id} aria-label={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="comment">{t('automation.actionFields.comment')}</SelectItem>
              <SelectItem value="field">{t('automation.actionFields.fields')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {target.kind === 'field' ? (
          <Input
            value={target.key}
            disabled={disabled}
            aria-label={t('automation.actionFields.keyValueKey')}
            onChange={(event) => set({ kind: 'field', key: event.target.value })}
          />
        ) : null}
      </div>
    )
  }

  const value = values[field.key]

  switch (field.kind) {
    case 'textarea':
      return (
        <Field label={label} htmlFor={id}>
          <Textarea
            id={id}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => set(event.target.value)}
          />
        </Field>
      )
    case 'number':
      return (
        <Field label={label} htmlFor={id}>
          <Input
            id={id}
            type="number"
            value={typeof value === 'number' ? String(value) : ''}
            disabled={disabled}
            onChange={(event) => set(event.target.value === '' ? null : Number(event.target.value))}
          />
        </Field>
      )
    case 'boolean':
      return (
        <Field label={label}>
          <Switch
            checked={value === true}
            disabled={disabled}
            aria-label={label}
            onCheckedChange={(checked) => set(checked)}
          />
        </Field>
      )
    case 'list':
      return (
        <Field label={label} htmlFor={id} hint={t('automation.designer.conditionsHint')}>
          <Textarea
            id={id}
            value={Array.isArray(value) ? value.join('\n') : ''}
            disabled={disabled}
            onChange={(event) =>
              set(
                event.target.value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
          />
        </Field>
      )
    case 'map':
      return <MapInput label={label} value={value} disabled={disabled} onChange={set} />
    case 'select':
      return (
        <Field label={label} htmlFor={id}>
          <Select
            value={typeof value === 'string' ? value : (field.options?.[0] ?? '')}
            onValueChange={set}
            disabled={disabled}
          >
            <SelectTrigger id={id} aria-label={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )
    default:
      return (
        <Field label={label} htmlFor={id}>
          <Input
            id={id}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => set(event.target.value === '' ? null : event.target.value)}
          />
        </Field>
      )
  }
}

/** Пары «ключ — значение»: поля карточки, переменные маршрута, заголовки вызова. */
function MapInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: unknown
  onChange: (next: Record<string, string>) => void
  disabled?: boolean
}) {
  const t = useT()
  const entries = Object.entries((value as Record<string, string> | undefined) ?? {})

  const update = (index: number, key: string, item: string) => {
    const next = entries.map((entry, position) => (position === index ? [key, item] : entry))
    onChange(Object.fromEntries(next.filter(([entryKey]) => (entryKey ?? '').length > 0)))
  }

  return (
    <Field label={label}>
      <div className="flex flex-col gap-2">
        {entries.map(([key, item], index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={key}
              disabled={disabled}
              aria-label={t('automation.actionFields.keyValueKey')}
              onChange={(event) => update(index, event.target.value, item)}
            />
            <Input
              value={item}
              disabled={disabled}
              aria-label={t('automation.actionFields.keyValueValue')}
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
            onClick={() => onChange({ ...Object.fromEntries(entries), '': '' })}
          >
            <Plus className="size-4" />
            {t('automation.actionFields.keyValueAdd')}
          </Button>
        </div>
      </div>
    </Field>
  )
}
