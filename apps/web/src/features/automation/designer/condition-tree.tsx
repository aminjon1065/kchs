import type { RuleCondition } from '@kchs/contracts'
import {
  Button,
  Card,
  Checkbox,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { FolderPlus, Plus, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { useT } from '~/app/i18n.js'
import {
  type ConditionNode,
  conditionText,
  fromConditionNode,
  MAX_CONDITION_DEPTH,
  toConditionNode,
} from './conditions.js'

type Group = Extract<ConditionNode, { kind: 'group' }>

/**
 * Блок «если» конструктора (ADR-0163): группы «все условия» / «любое из» с вложенностью и
 * флажком «не» у строки и группы. Дерево контракта правится как есть — форма не теряет
 * групп, пришедших из API или предметного пакета.
 */
export function ConditionTreeEditor({
  condition,
  onChange,
  disabled,
}: {
  condition: RuleCondition | null
  onChange: (next: RuleCondition | null) => void
  disabled?: boolean
}) {
  const t = useT()
  const root = toConditionNode(condition) as Group
  const whole = condition ? conditionText(condition) : null
  return (
    <div className="flex flex-col gap-3">
      <GroupEditor
        group={root}
        depth={1}
        disabled={disabled}
        onChange={(next) => onChange(fromConditionNode(next))}
      />
      {whole ? (
        <p className="text-xs text-fg-secondary">
          {t('automation.designer.conditionWhole')}{' '}
          <code className="font-mono text-xs text-fg">{whole}</code>
        </p>
      ) : null}
    </div>
  )
}

function GroupEditor({
  group,
  depth,
  onChange,
  onRemove,
  disabled,
}: {
  group: Group
  depth: number
  onChange: (next: Group) => void
  onRemove?: () => void
  disabled?: boolean
}) {
  const t = useT()
  const opId = useId()
  const replace = (index: number, next: ConditionNode) =>
    onChange({ ...group, items: group.items.map((item, i) => (i === index ? next : item)) })
  const remove = (index: number) =>
    onChange({ ...group, items: group.items.filter((_, i) => i !== index) })

  const body = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={group.op}
          disabled={disabled}
          onValueChange={(op) => onChange({ ...group, op: op as Group['op'] })}
        >
          <SelectTrigger
            id={opId}
            aria-label={t('automation.designer.conditionOp')}
            className="w-56"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">{t('automation.designer.conditionAll')}</SelectItem>
            <SelectItem value="or">{t('automation.designer.conditionAny')}</SelectItem>
          </SelectContent>
        </Select>
        {depth > 1 ? (
          <Checkbox
            checked={group.negated}
            disabled={disabled}
            label={t('automation.designer.conditionNot')}
            onCheckedChange={(checked) => onChange({ ...group, negated: checked === true })}
          />
        ) : null}
        {onRemove ? (
          <IconButton
            size="sm"
            variant="ghost"
            className="ms-auto"
            label={t('automation.designer.conditionGroupRemove')}
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </IconButton>
        ) : null}
      </div>
      {group.items.map((item, index) =>
        item.kind === 'group' ? (
          <GroupEditor
            key={index}
            group={item}
            depth={depth + 1}
            disabled={disabled}
            onChange={(next) => replace(index, next)}
            onRemove={() => remove(index)}
          />
        ) : (
          <div key={index} className="flex items-center gap-2">
            <Checkbox
              checked={item.negated}
              disabled={disabled}
              label={t('automation.designer.conditionNot')}
              onCheckedChange={(checked) => replace(index, { ...item, negated: checked === true })}
            />
            <Input
              value={item.expr}
              disabled={disabled}
              placeholder={t('automation.designer.conditionPlaceholder')}
              aria-label={t('automation.designer.if')}
              onChange={(event) => replace(index, { ...item, expr: event.target.value })}
            />
            <IconButton
              size="sm"
              variant="ghost"
              label={t('automation.designer.conditionRemove')}
              disabled={disabled}
              onClick={() => remove(index)}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ),
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...group,
              items: [...group.items, { kind: 'expr', expr: 'true', negated: false }],
            })
          }
        >
          <Plus className="size-4" />
          {t('automation.designer.conditionAdd')}
        </Button>
        {depth < MAX_CONDITION_DEPTH ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...group,
                items: [
                  ...group.items,
                  {
                    kind: 'group',
                    op: group.op === 'and' ? 'or' : 'and',
                    negated: false,
                    items: [{ kind: 'expr', expr: 'true', negated: false }],
                  },
                ],
              })
            }
          >
            <FolderPlus className="size-4" />
            {t('automation.designer.conditionGroupAdd')}
          </Button>
        ) : null}
      </div>
    </div>
  )

  return depth === 1 ? body : <Card className="border-dashed bg-surface-sunken p-3">{body}</Card>
}
