import type {
  ObjectAcknowledgments,
  ProtocolBlockKind,
  ProtocolDraft,
  ProtocolRecord,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  EmptyState,
  PanelToolbar,
  personTone,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, FileText, Sparkles, UserCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { documentTypesQuery } from '~/features/documents/queries.js'
import { useCollabDocument } from '~/features/notebooks/collab.js'
import {
  cellIds,
  cellsOf,
  insertCell,
  moveCell,
  orderOf,
  removeCell,
  useYChanges,
} from '~/features/notebooks/notebook-doc.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { AddBlockButtons, ProtocolBlockCard } from './protocol-blocks.js'
import { ProtocolProvider } from './protocol-context.js'
import { createProtocolBlock, readSummary } from './protocol-doc.js'
import { meetingProtocolQuery, meetingQuery, protocolKeys, protocolQuery } from './queries.js'

/**
 * Вкладка «Протокол» карточки встречи (11-communications-meetings.md §4,
 * ADR-0093): повестка и протокол — один совместный документ; кнопки
 * «ИИ-черновик», «Подтвердить», «Зарегистрировать документом» и «На
 * ознакомление» ведёт организатор. Поручения протокола видны со статусами.
 */
export function ProtocolPanel({ meetingId }: { meetingId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { data: protocol, isLoading } = useQuery(meetingProtocolQuery(meetingId))

  const create = useMutation({
    mutationFn: () => http.post<ProtocolRecord>(`/meetings/${meetingId}/protocol`, {}),
    onSuccess: () => void client.invalidateQueries({ queryKey: protocolKeys.ofMeeting(meetingId) }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (isLoading) return <Skeleton className="m-4 h-40" />
  if (!protocol) {
    return (
      <EmptyState
        title={t('meetings.protocol.emptyTitle')}
        description={t('meetings.protocol.emptyHint')}
        action={
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {t('meetings.protocol.create')}
          </Button>
        }
      />
    )
  }
  return <ProtocolBody protocolId={protocol.id} meetingId={meetingId} />
}

/** Протокол с открытым совместным документом: блоки, итоги и действия. */
export function ProtocolBody({ protocolId, meetingId }: { protocolId: string; meetingId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: protocol } = useQuery(protocolQuery(protocolId))
  const { data: meeting } = useQuery(meetingQuery(meetingId))
  const { data: me } = useQuery(meQuery())
  const collab = useCollabDocument(protocolId)
  const [registerOpen, setRegisterOpen] = useState(false)

  const name = me?.user.displayName ?? ''
  const user = useMemo(() => ({ name, tone: personTone(name) }), [name])
  const participants = useMemo(
    () => (meeting?.participants ?? []).map((item) => item.user),
    [meeting],
  )

  const refresh = () => {
    void client.invalidateQueries({ queryKey: protocolKeys.protocol(protocolId) })
    void client.invalidateQueries({ queryKey: protocolKeys.ofMeeting(meetingId) })
  }
  const failed = (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))

  const draft = useMutation({
    mutationFn: () => http.post<ProtocolDraft>(`/protocols/${protocolId}/draft`, {}),
    onSuccess: (result) => {
      toast.show({
        title: t('meetings.protocol.draftDone', { count: result.added.length }),
        tone: 'success',
      })
      refresh()
    },
    onError: failed,
  })
  const confirm = useMutation({
    mutationFn: () => http.post<ProtocolRecord>(`/protocols/${protocolId}/confirm`, {}),
    onSuccess: (result) => {
      toast.show({
        title: t('meetings.protocol.confirmed', { count: result.instructions.length }),
        tone: 'success',
      })
      refresh()
    },
    onError: failed,
  })
  const acknowledge = useMutation({
    mutationFn: () =>
      http.post<{ requested: number }>(`/protocols/${protocolId}/acknowledgments`, {}),
    onSuccess: (result) => {
      toast.show({
        title: t('meetings.protocol.ackSent', { count: result.requested }),
        tone: 'success',
      })
      refresh()
    },
    onError: failed,
  })
  const register = useMutation({
    mutationFn: (typeId: string) =>
      http.post<{ documentId: string }>(`/protocols/${protocolId}/register`, { typeId }),
    onSuccess: (result) => {
      setRegisterOpen(false)
      refresh()
      openTab({ kind: 'object', objectId: result.documentId, title: t('objects.types.document') })
    },
    onError: failed,
  })

  if (!protocol) return <Skeleton className="m-4 h-40" />
  if (collab?.status === 'denied') {
    return (
      <EmptyState
        title={t('meetings.protocol.denied')}
        description={t('meetings.protocol.deniedHint')}
      />
    )
  }
  const readOnly = Boolean(collab?.readOnly) || protocol.status === 'confirmed'

  return (
    <ProtocolProvider
      value={{ readOnly, awareness: collab?.awareness ?? null, user, participants }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <PanelToolbar
          left={
            <Badge tone={protocol.status === 'confirmed' ? 'success' : 'neutral'}>
              {t(`meetings.protocol.statuses.${protocol.status}`)}
            </Badge>
          }
          right={
            <>
              {protocol.can.draft ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => draft.mutate()}
                  disabled={draft.isPending}
                >
                  <Sparkles className="size-4" />
                  {t('meetings.protocol.draft')}
                </Button>
              ) : null}
              {protocol.can.confirm ? (
                <Button size="sm" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
                  <BadgeCheck className="size-4" />
                  {t('meetings.protocol.confirm')}
                </Button>
              ) : null}
              {protocol.can.register ? (
                <Button size="sm" variant="secondary" onClick={() => setRegisterOpen(true)}>
                  <FileText className="size-4" />
                  {t('meetings.protocol.register')}
                </Button>
              ) : null}
              {protocol.can.requestAcknowledgment ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => acknowledge.mutate()}
                  disabled={acknowledge.isPending}
                >
                  <UserCheck className="size-4" />
                  {t('meetings.protocol.acknowledge')}
                </Button>
              ) : null}
            </>
          }
        />

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {protocol.status === 'confirmed' ? (
            <Callout tone="info" title={t('meetings.protocol.confirmedTitle')}>
              {t('meetings.protocol.confirmedHint')}
            </Callout>
          ) : null}
          {collab?.doc && collab.synced ? (
            <ProtocolBlocks doc={collab.doc} readOnly={readOnly} />
          ) : (
            <Skeleton className="h-40" />
          )}
          <ProtocolAcknowledgments protocol={protocol} />
          <ProtocolInstructions protocol={protocol} />
        </div>
      </div>

      <RegisterDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        pending={register.isPending}
        onRegister={(typeId) => register.mutate(typeId)}
      />
    </ProtocolProvider>
  )
}

/** Блоки протокола по порядку документа: правки соавторов видны сразу. */
function ProtocolBlocks({ doc, readOnly }: { doc: Y.Doc; readOnly: boolean }) {
  const t = useT()
  const orderVersion = useYChanges(orderOf(doc) as unknown as Y.AbstractType<unknown>)
  const blocksVersion = useYChanges(cellsOf(doc) as unknown as Y.AbstractType<unknown>)
  const metaVersion = useYChanges(doc.getMap('meta') as unknown as Y.AbstractType<unknown>)
  // biome-ignore lint/correctness/useExhaustiveDependencies: версии документа — сигнал пересчёта
  const ids = useMemo(() => cellIds(doc), [doc, orderVersion, blocksVersion])
  // biome-ignore lint/correctness/useExhaustiveDependencies: версия документа — сигнал пересчёта
  const summary = useMemo(() => readSummary(doc), [doc, metaVersion])
  const blocks = cellsOf(doc)

  const add = (kind: ProtocolBlockKind) => {
    insertCell(doc, createProtocolBlock(kind), ids.length)
  }

  return (
    <section className="flex flex-col gap-3" aria-label={t('meetings.protocol.tab')}>
      {summary ? (
        <Callout tone="neutral" title={t('meetings.protocol.summary')}>
          {summary}
        </Callout>
      ) : null}
      {ids.length === 0 ? (
        <EmptyState
          title={t('meetings.protocol.noBlocks')}
          description={t('meetings.protocol.noBlocksHint')}
        />
      ) : null}
      {ids.map((id) => {
        const block = blocks.get(id)
        if (!block) return null
        const kind = block.get('kind')
        if (typeof kind !== 'string') return null
        return (
          <ProtocolBlockCard
            key={id}
            block={block}
            kind={kind as ProtocolBlockKind}
            onMove={(delta) => moveCell(doc, id, delta)}
            onRemove={() => removeCell(doc, id)}
          />
        )
      })}
      {readOnly ? null : <AddBlockButtons onAdd={add} />}
    </section>
  )
}

/** Поручения протокола со статусами: их ведёт модуль задач. */
/**
 * Ознакомление с протоколом (ADR-0084, ADR-0093): участнику — просьба и
 * отметка, организатору — сколько человек уже ознакомились. Учёт ведёт ядро,
 * поэтому здесь только его сводка по объекту протокола.
 */
function ProtocolAcknowledgments({ protocol }: { protocol: ProtocolRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { data } = useQuery({
    queryKey: protocolKeys.acknowledgments(protocol.id),
    queryFn: () => http.get<ObjectAcknowledgments>(`/objects/${protocol.id}/acknowledgments`),
    enabled: protocol.status === 'confirmed',
  })

  const acknowledge = useMutation({
    mutationFn: () =>
      http.post<ObjectAcknowledgments>(`/objects/${protocol.id}/acknowledgments/acknowledge`, {}),
    onSuccess: (next) => {
      client.setQueryData(protocolKeys.acknowledgments(protocol.id), next)
      void client.invalidateQueries({ queryKey: ['inbox'] })
      toast.show({ title: t('meetings.protocol.ack.done'), tone: 'success' })
    },
    onError: (failure) =>
      toast.error(failure instanceof ApiError ? failure.message : t('errors.unknown')),
  })

  if (!data || data.summary.total === 0) return null

  return data.mine.pending ? (
    <Callout
      tone="info"
      title={t('meetings.protocol.ack.mine')}
      action={
        <Button size="sm" onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}>
          <UserCheck className="size-4" />
          {t('meetings.protocol.ack.mark')}
        </Button>
      }
    >
      {t('meetings.protocol.ack.mineHint')}
    </Callout>
  ) : (
    <p className="text-xs text-fg-muted" data-testid="protocol-ack-summary">
      {t('meetings.protocol.ack.summary', {
        acknowledged: data.summary.acknowledged,
        total: data.summary.total,
      })}
    </p>
  )
}

function ProtocolInstructions({ protocol }: { protocol: ProtocolRecord }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  if (protocol.instructions.length === 0) return null
  return (
    <section className="flex flex-col gap-2" aria-label={t('meetings.protocol.instructions')}>
      <h3 className="text-sm font-medium text-fg">{t('meetings.protocol.instructions')}</h3>
      <ul className="flex flex-col gap-1">
        {protocol.instructions.map((item) => (
          <li
            key={item.blockId}
            className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2"
          >
            <StatusBadge
              status={item.status}
              label={
                item.status === 'unknown'
                  ? t('meetings.protocol.unknownStatus')
                  : t(`tasks.statuses.${item.status}`)
              }
            />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-sm text-fg hover:underline"
              disabled={!item.accessible}
              onClick={() => openTab({ kind: 'object', objectId: item.taskId, title: item.title })}
            >
              {item.accessible ? item.title : t('meetings.protocol.hiddenInstruction')}
            </button>
            <span className="text-xs text-fg-muted">{item.key}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Выбор типа документа для регистрации протокола. */
function RegisterDialog({
  open,
  onOpenChange,
  pending,
  onRegister,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onRegister: (typeId: string) => void
}) {
  const t = useT()
  const { data: types = [] } = useQuery({ ...documentTypesQuery(), enabled: open })
  const [typeId, setTypeId] = useState('')
  const chosen = typeId || types.find((type) => type.key === 'protocol')?.id || types[0]?.id || ''
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('meetings.protocol.registerTitle')}
        description={t('meetings.protocol.registerHint')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button onClick={() => onRegister(chosen)} disabled={pending || !chosen}>
              {t('meetings.protocol.register')}
            </Button>
          </>
        }
      >
        <Select value={chosen} onValueChange={setTypeId}>
          <SelectTrigger aria-label={t('meetings.protocol.documentType')}>
            <SelectValue placeholder={t('meetings.protocol.documentType')} />
          </SelectTrigger>
          <SelectContent>
            {types.map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name.ru}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </DialogContent>
    </Dialog>
  )
}
