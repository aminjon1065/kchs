import type { ChatKind, ChatListItem, PresenceState } from '@kchs/contracts'
import {
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { type PickedUser, UserPicker, UsersPicker } from '~/features/tasks/user-picker.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectListQuery, spacesQuery } from '~/shared/api/queries.js'
import { chatKeys } from './queries.js'

const useReport = () => {
  const t = useT()
  const toast = useToast()
  return (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
}

/** Создание беседы: личная, группа или канал пространства (P4-E01 S01). */
export function NewChatDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (item: ChatListItem) => void
}) {
  const t = useT()
  const report = useReport()
  const client = useQueryClient()
  const [kind, setKind] = useState<ChatKind>('direct')
  const [title, setTitle] = useState('')
  const [peer, setPeer] = useState<PickedUser | null>(null)
  const [members, setMembers] = useState<PickedUser[]>([])
  const [spaceId, setSpaceId] = useState<string>('')
  const [privacy, setPrivacy] = useState<'open' | 'closed'>('open')
  const { data: spaces = [] } = useQuery(spacesQuery())

  const create = useMutation({
    mutationFn: () =>
      http.post<ChatListItem>('/chats', {
        kind,
        ...(kind === 'direct' ? {} : { title: title.trim() }),
        memberIds: kind === 'direct' ? (peer ? [peer.id] : []) : members.map((member) => member.id),
        ...(kind === 'channel' ? { spaceId, privacy } : {}),
      }),
    onSuccess: (item) => {
      void client.invalidateQueries({ queryKey: chatKeys.all })
      onCreated(item)
      onClose()
    },
    onError: report,
  })

  const ready =
    kind === 'direct'
      ? peer !== null
      : title.trim().length > 0 && (kind === 'group' || spaceId.length > 0)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.new.title')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('chats.new.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <Field label={t('chats.new.kind')}>
            <SegmentedControl
              value={kind}
              onValueChange={(next) => setKind(next as ChatKind)}
              options={[
                { value: 'direct', label: t('chats.new.direct') },
                { value: 'group', label: t('chats.new.group') },
                { value: 'channel', label: t('chats.new.channel') },
              ]}
            />
          </Field>

          {kind === 'direct' ? (
            <UserPicker value={peer} onChange={setPeer} label={t('chats.new.peer')} />
          ) : (
            <>
              <Field label={t('chats.new.name')}>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  aria-label={t('chats.new.name')}
                  maxLength={200}
                />
              </Field>
              {kind === 'channel' ? (
                <>
                  <Field label={t('chats.new.space')}>
                    <Select value={spaceId} onValueChange={setSpaceId}>
                      <SelectTrigger aria-label={t('chats.new.space')}>
                        <SelectValue placeholder={t('chats.new.space')} />
                      </SelectTrigger>
                      <SelectContent>
                        {spaces.map((space) => (
                          <SelectItem key={space.id} value={space.id}>
                            {space.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t('chats.new.privacy')}>
                    <SegmentedControl
                      value={privacy}
                      onValueChange={(next) => setPrivacy(next as 'open' | 'closed')}
                      options={[
                        { value: 'open', label: t('chats.new.open') },
                        { value: 'closed', label: t('chats.new.closed') },
                      ]}
                    />
                  </Field>
                </>
              ) : null}
              <Field label={t('chats.new.members')}>
                <UsersPicker
                  value={members}
                  onChange={setMembers}
                  label={t('chats.new.members')}
                  addLabel={t('chats.new.findPeople')}
                />
              </Field>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Приглашение участников в группу или закрытый канал. */
export function InviteDialog({
  conversationId,
  onClose,
}: {
  conversationId: string
  onClose: () => void
}) {
  const t = useT()
  const report = useReport()
  const client = useQueryClient()
  const [members, setMembers] = useState<PickedUser[]>([])
  const invite = useMutation({
    mutationFn: () =>
      http.post(`/chats/${conversationId}/invite`, { userIds: members.map((item) => item.id) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: chatKeys.all })
      onClose()
    },
    onError: report,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.inviteTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={members.length === 0}
              loading={invite.isPending}
              onClick={() => invite.mutate()}
            >
              {t('chats.invite')}
            </Button>
          </>
        }
      >
        <div className="p-4">
          <UsersPicker
            value={members}
            onChange={setMembers}
            label={t('chats.inviteTitle')}
            addLabel={t('chats.new.findPeople')}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Переименование беседы. */
export function RenameDialog({
  conversation,
  onClose,
}: {
  conversation: ChatListItem
  onClose: () => void
}) {
  const t = useT()
  const report = useReport()
  const client = useQueryClient()
  const [title, setTitle] = useState(conversation.title)
  const rename = useMutation({
    mutationFn: () => http.patch(`/chats/${conversation.id}`, { title: title.trim() }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: chatKeys.all })
      onClose()
    },
    onError: report,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.rename')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={title.trim().length === 0}
              loading={rename.isPending}
              onClick={() => rename.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="p-4">
          <Field label={t('chats.renameTitle')}>
            <Input
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              aria-label={t('chats.renameTitle')}
              maxLength={200}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Пересылка сообщения в другую беседу. */
export function ForwardDialog({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const t = useT()
  const report = useReport()
  const toast = useToast()
  const client = useQueryClient()
  const [target, setTarget] = useState('')
  const { data } = useQuery({
    queryKey: chatKeys.list('all'),
    queryFn: () => http.get<{ items: ChatListItem[] }>('/chats', { query: { section: 'all' } }),
  })
  const options = (data?.items ?? []).filter((item) => item.can.post)
  const forward = useMutation({
    mutationFn: () =>
      http.post('/chats/forward', { messageIds: [messageId], toConversationIds: [target] }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: chatKeys.all })
      toast.show({ title: t('chats.forwarded') })
      onClose()
    },
    onError: report,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.forwardTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!target}
              loading={forward.isPending}
              onClick={() => forward.mutate()}
            >
              {t('chats.forward')}
            </Button>
          </>
        }
      >
        <div className="p-4">
          <Field label={t('chats.forwardTitle')}>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger aria-label={t('chats.forwardTitle')}>
                <SelectValue placeholder={t('chats.forwardTitle')} />
              </SelectTrigger>
              <SelectContent>
                {options.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Поручение по сообщению: цитата уходит в описание, связь — с источником. */
export function MessageTaskDialog({
  messageId,
  initialTitle,
  onClose,
}: {
  messageId: string
  initialTitle: string
  onClose: () => void
}) {
  const t = useT()
  const report = useReport()
  const toast = useToast()
  const client = useQueryClient()
  const [title, setTitle] = useState(initialTitle.slice(0, 200))
  const [assignee, setAssignee] = useState<PickedUser | null>(null)
  const [days, setDays] = useState(3)
  const create = useMutation({
    mutationFn: () =>
      http.post<{ taskId: string; key: string }>(`/chats/messages/${messageId}/task`, {
        title: title.trim(),
        ...(assignee ? { assigneeId: assignee.id } : {}),
        dueWorkingDays: days,
      }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: chatKeys.all })
      void client.invalidateQueries({ queryKey: ['object'] })
      toast.show({ title: t('chats.task.created', { key: result.key }) })
      onClose()
    },
    onError: report,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.task.title')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={title.trim().length === 0}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('chats.task.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <Field label={t('chats.task.name')}>
            <Input
              value={title}
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
              aria-label={t('chats.task.name')}
              maxLength={300}
            />
          </Field>
          <Field label={t('chats.task.assignee')}>
            <UserPicker value={assignee} onChange={setAssignee} label={t('chats.task.assignee')} />
          </Field>
          <Field label={t('chats.task.days')}>
            <Input
              type="number"
              min={1}
              max={60}
              value={String(days)}
              onChange={(event) => setDays(Math.max(1, Number(event.target.value) || 1))}
              aria-label={t('chats.task.days')}
              className="w-24"
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Прикрепление сообщения к документу или другому объекту — связь ядра. */
export function AttachDialog({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const t = useT()
  const report = useReport()
  const toast = useToast()
  const client = useQueryClient()
  const [objectId, setObjectId] = useState('')
  const { data } = useQuery(objectListQuery({ types: 'document', limit: 50 }))
  const attach = useMutation({
    mutationFn: () => http.post(`/chats/messages/${messageId}/attach`, { objectId }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['object'] })
      toast.show({ title: t('chats.attach.done') })
      onClose()
    },
    onError: report,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.attach.title')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!objectId}
              loading={attach.isPending}
              onClick={() => attach.mutate()}
            >
              {t('chats.attach.submit')}
            </Button>
          </>
        }
      >
        <div className="p-4">
          <Field label={t('chats.attach.object')}>
            <Select value={objectId} onValueChange={setObjectId}>
              <SelectTrigger aria-label={t('chats.attach.object')}>
                <SelectValue placeholder={t('chats.attach.object')} />
              </SelectTrigger>
              <SelectContent>
                {(data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Мой статус: «в сети / отошёл / не беспокоить» и тихие часы (P4-E01 S03). */
export function PresenceDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const report = useReport()
  const client = useQueryClient()
  const { data } = useQuery({
    queryKey: chatKeys.presence,
    queryFn: () => http.get<PresenceState>('/me/presence'),
  })
  const [status, setStatus] = useState<'online' | 'away' | 'dnd'>(data?.chosen ?? 'online')
  const [forHour, setForHour] = useState(false)
  const [quiet, setQuiet] = useState(
    data?.quietHours ?? { enabled: false, from: '21:00', to: '08:00' },
  )
  const save = useMutation({
    mutationFn: () =>
      http.put<PresenceState>('/me/presence', {
        status,
        untilMinutes: forHour ? 60 : null,
        quietHours: quiet,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: chatKeys.presence })
      onClose()
    },
    onError: report,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.presence.title')}
        description={t('chats.presence.hint')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {t('chats.presence.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-4">
          <SegmentedControl
            value={status}
            onValueChange={(next) => setStatus(next as 'online' | 'away' | 'dnd')}
            options={[
              { value: 'online', label: t('chats.presence.online') },
              { value: 'away', label: t('chats.presence.away') },
              { value: 'dnd', label: t('chats.presence.dnd') },
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={forHour}
              onChange={(event) => setForHour(event.target.checked)}
            />
            {t('chats.presence.forHour')}
          </label>
          <label className="flex items-center gap-2 text-sm text-fg-secondary">
            <input
              type="checkbox"
              checked={quiet.enabled}
              onChange={(event) => setQuiet({ ...quiet, enabled: event.target.checked })}
            />
            {t('chats.presence.quietHours')}
          </label>
          <div className="flex items-end gap-2">
            <Field label={t('chats.presence.quietFrom')}>
              <Input
                type="time"
                value={quiet.from}
                aria-label={t('chats.presence.quietFrom')}
                onChange={(event) => setQuiet({ ...quiet, from: event.target.value })}
                className="w-28"
              />
            </Field>
            <Field label={t('chats.presence.quietTo')}>
              <Input
                type="time"
                value={quiet.to}
                aria-label={t('chats.presence.quietTo')}
                onChange={(event) => setQuiet({ ...quiet, to: event.target.value })}
                className="w-28"
              />
            </Field>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
