import type { ChatKind, ChatListItem } from '@kchs/contracts'
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
import { type PickedUser, UserPicker, UsersPicker } from '~/entities/people/user-picker.js'
import { objectListQuery, spacesQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import { chatApi, chatKeys } from './queries.js'
import { useReport } from './use-report.js'

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
      chatApi.create({
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
      chatApi.postChatsInvite(conversationId, { userIds: members.map((item) => item.id) }),
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
    mutationFn: () => chatApi.patchChats(conversation.id, { title: title.trim() }),
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
/** Пересылка одного или нескольких сообщений: цитаты уходят в порядке ленты. */
export function ForwardDialog({
  messageIds,
  onClose,
  onDone,
}: {
  messageIds: string[]
  onClose: () => void
  onDone?: () => void
}) {
  const t = useT()
  const report = useReport()
  const toast = useToast()
  const client = useQueryClient()
  const [target, setTarget] = useState('')
  const { data } = useQuery({
    queryKey: chatKeys.list('all'),
    queryFn: () => chatApi.getChats(),
  })
  const options = (data?.items ?? []).filter((item) => item.can.post)
  const forward = useMutation({
    mutationFn: () => chatApi.postChatsForward({ messageIds, toConversationIds: [target] }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: chatKeys.all })
      toast.show({ title: t('chats.forwarded') })
      onDone?.()
      onClose()
    },
    onError: report,
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('chats.forwardTitle')}
        description={
          messageIds.length > 1 ? t('chats.selected', { count: messageIds.length }) : undefined
        }
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
      chatApi.postChatsMessagesTask(messageId, {
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
    mutationFn: () => chatApi.postChatsMessagesAttach(messageId, { objectId }),
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
