import {
  PROTOCOL_DEFAULT_DUE_WORKING_DAYS,
  type ProtocolBlockKind,
  type UserRef,
} from '@kchs/contracts'
import {
  Button,
  cn,
  Field,
  IconButton,
  Input,
  RichTextEditor,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import type * as Y from 'yjs'
import {
  applyTextChange,
  type CellMap,
  useCellValue,
  useYChanges,
} from '~/entities/collab/notebook-doc.js'
import { useT } from '~/shared/i18n.js'
import { useProtocol } from './protocol-context.js'
import { bodyFragment, titleText } from './protocol-doc.js'

/**
 * Метка вида блока (ADR-0230): моноширинная строка цвета смысла — вопрос акцентом на
 * подложке, решение — успехом, поручение — акцентом, заметка — приглушённо. Предупреждающий
 * тон у поручения не используется: рядом шкала обстановки, и «жёлтое» читалось бы уровнем.
 */
const KIND_TEXT: Record<ProtocolBlockKind, string> = {
  agenda_item: 'rounded-sm bg-accent-subtle px-1.5 py-0.5 text-accent',
  decision: 'text-success',
  instruction: 'text-accent',
  note: 'text-fg-muted',
}

/** Заголовок блока: `Y.Text` — правки двух авторов сливаются посимвольно. */
function BlockTitle({
  block,
  label,
  prominent,
}: {
  block: CellMap
  label: string
  prominent: boolean
}) {
  const text = titleText(block)
  const { readOnly } = useProtocol()
  useYChanges(text as unknown as Y.AbstractType<unknown> | null)
  if (!text) return null
  return (
    <Input
      value={text.toString()}
      onChange={(event) => applyTextChange(text, event.target.value)}
      aria-label={label}
      placeholder={label}
      readOnly={readOnly}
      className={prominent ? 'text-md font-semibold' : 'font-medium'}
    />
  )
}

/** Исполнитель, контролёр и срок поручения — только участники встречи. */
function InstructionFields({ block }: { block: CellMap }) {
  const t = useT()
  const { readOnly, participants } = useProtocol()
  const assigneeId = useCellValue<string | null>(block, 'assigneeId') ?? null
  const controllerId = useCellValue<string | null>(block, 'controllerId') ?? null
  const dueAt = useCellValue<string | null>(block, 'dueAt') ?? null
  const taskId = useCellValue<string | null>(block, 'taskId') ?? null

  const person = (value: string | null, key: 'assigneeId' | 'controllerId') => (
    <Select
      value={value ?? 'none'}
      disabled={readOnly || Boolean(taskId)}
      onValueChange={(next) => block.set(key, next === 'none' ? null : next)}
    >
      <SelectTrigger
        aria-label={t(
          key === 'assigneeId' ? 'meetings.protocol.assignee' : 'meetings.protocol.controller',
        )}
      >
        <SelectValue placeholder={t('meetings.protocol.notChosen')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t('meetings.protocol.notChosen')}</SelectItem>
        {participants.map((user: UserRef) => (
          <SelectItem key={user.id} value={user.id}>
            {user.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Field label={t('meetings.protocol.assignee')}>{person(assigneeId, 'assigneeId')}</Field>
      <Field label={t('meetings.protocol.controller')}>
        {person(controllerId, 'controllerId')}
      </Field>
      <Field
        label={t('meetings.protocol.due')}
        // Срок не назван — при подтверждении поручению ставится 10 рабочих дней (N33)
        {...(dueAt || taskId
          ? {}
          : {
              hint: t('meetings.protocol.defaultDue', {
                days: PROTOCOL_DEFAULT_DUE_WORKING_DAYS,
              }),
            })}
      >
        <Input
          type="date"
          value={dueAt ?? ''}
          readOnly={readOnly || Boolean(taskId)}
          aria-label={t('meetings.protocol.due')}
          onChange={(event) => block.set('dueAt', event.target.value || null)}
        />
      </Field>
    </div>
  )
}

/**
 * Блок протокола (ADR-0230): вопрос повестки — карточкой с номером, решения и поручения —
 * под ним с отступом; заголовок, текст и — у поручения — исполнитель и срок.
 */
export function ProtocolBlockCard({
  block,
  kind,
  ordinal,
  onMove,
  onRemove,
}: {
  block: CellMap
  kind: ProtocolBlockKind
  /** Номер вопроса повестки по порядку документа. */
  ordinal?: number
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}) {
  const t = useT()
  const { readOnly, awareness, user } = useProtocol()
  const body = bodyFragment(block)
  const taskId = useCellValue<string | null>(block, 'taskId') ?? null
  const label = t(`meetings.protocol.kinds.${kind}`)
  const agenda = kind === 'agenda_item'

  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-line bg-surface transition-colors focus-within:border-accent',
        agenda ? 'mt-2 p-4 shadow-sm first:mt-0' : 'ml-6 p-3',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('font-mono text-xs tracking-wider uppercase', KIND_TEXT[kind])}>
          {ordinal ? `${label} ${ordinal}` : label}
        </span>
        {kind === 'instruction' && !taskId && !readOnly ? (
          <span className="text-xs text-fg-muted">{t('meetings.protocol.createdOnConfirm')}</span>
        ) : null}
        <div className="flex-1" />
        {readOnly ? null : (
          <>
            <IconButton
              label={t('meetings.protocol.moveUp')}
              size="sm"
              variant="ghost"
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="size-4" />
            </IconButton>
            <IconButton
              label={t('meetings.protocol.moveDown')}
              size="sm"
              variant="ghost"
              onClick={() => onMove(1)}
            >
              <ArrowDown className="size-4" />
            </IconButton>
            <IconButton
              label={t('meetings.protocol.removeBlock')}
              size="sm"
              variant="ghost"
              disabled={Boolean(taskId)}
              onClick={onRemove}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </>
        )}
      </div>
      <BlockTitle block={block} label={label} prominent={agenda} />
      {body ? (
        <RichTextEditor
          aria-label={t('meetings.protocol.body')}
          placeholder={t('meetings.protocol.bodyPlaceholder')}
          toolbar="focus"
          editable={!readOnly}
          collaboration={{ fragment: body, awareness, user }}
        />
      ) : null}
      {kind === 'instruction' ? <InstructionFields block={block} /> : null}
    </article>
  )
}

/** Кнопки «добавить блок»: повестка ведётся до встречи, решения — после. */
export function AddBlockButtons({ onAdd }: { onAdd: (kind: ProtocolBlockKind) => void }) {
  const t = useT()
  const kinds: ProtocolBlockKind[] = ['agenda_item', 'decision', 'instruction', 'note']
  return (
    <div
      role="toolbar"
      aria-label={t('meetings.protocol.addToolbar')}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line-strong p-2"
    >
      <span className="px-1.5 text-xs text-fg-muted">{t('meetings.protocol.addLabel')}</span>
      {kinds.map((kind) => (
        <Button key={kind} size="sm" variant="secondary" onClick={() => onAdd(kind)}>
          {t(`meetings.protocol.add.${kind}`)}
        </Button>
      ))}
    </div>
  )
}
