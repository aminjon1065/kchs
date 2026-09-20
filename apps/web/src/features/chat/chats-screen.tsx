import type { ChatListItem, ChatSection } from '@kchs/contracts'
import { Button, EmptyState, useMediaQuery } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { subscribeRooms, unsubscribeRooms } from '~/shared/realtime/client.js'
import { NewChatDialog, PresenceDialog } from './chat-dialogs.js'
import { ConversationList } from './conversation-list.js'
import { MessageFeed } from './message-feed.js'
import { chatKeys, conversationQuery, myPresenceQuery } from './queries.js'

export interface ChatsScreenState {
  section?: ChatSection
  conversationId?: string | null
  threadRootId?: string | null
}

/**
 * Экран «Чаты» (P4-E01): список бесед, лента и тред. Состояние вкладки
 * (раздел, выбранная беседа, открытый тред) сохраняется в рабочем пространстве.
 * На мобильном вебе панель одна (01-ux-concept.md, адаптив): виден либо список,
 * либо беседа с кнопкой возврата.
 */
export function ChatsScreen({
  tabId,
  savedState,
  initialConversationId,
}: {
  tabId: string
  savedState?: ChatsScreenState
  initialConversationId?: string
}) {
  const t = useT()
  const client = useQueryClient()
  const setTabState = useWorkspace((s) => s.setTabState)
  const openTab = useWorkspace((s) => s.openTab)
  const [section, setSection] = useState<ChatSection>(savedState?.section ?? 'all')
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConversationId ?? savedState?.conversationId ?? null,
  )
  const [threadRootId, setThreadRootId] = useState<string | null>(savedState?.threadRootId ?? null)
  const [creating, setCreating] = useState(false)
  const wide = useMediaQuery('(min-width: 768px)')
  const [presenceOpen, setPresenceOpen] = useState(false)

  const { data: conversation } = useQuery(conversationQuery(selectedId))
  const { data: presence } = useQuery(myPresenceQuery())

  useEffect(() => {
    setTabState(tabId, { section, conversationId: selectedId, threadRootId })
  }, [tabId, section, selectedId, threadRootId, setTabState])

  // Комната беседы: новые сообщения приходят сразу, список перечитывается
  useEffect(() => {
    if (!selectedId) return
    const rooms = [`conversation:${selectedId}`]
    subscribeRooms(rooms)
    return () => unsubscribeRooms(rooms)
  }, [selectedId])

  const select = (item: ChatListItem) => {
    setSelectedId(item.id)
    setThreadRootId(null)
    void client.invalidateQueries({ queryKey: chatKeys.conversation(item.id) })
  }

  const showList = wide || !conversation
  const showFeed = wide || Boolean(conversation)
  // Статус присутствия виден всегда: на узком экране — над списком бесед
  const presenceButton = (
    <div className="flex shrink-0 items-center justify-end gap-2 border-b border-line px-3 py-1.5">
      <Button size="sm" variant="ghost" onClick={() => setPresenceOpen(true)}>
        {t(`chats.presence.${presence?.status ?? 'online'}`)}
      </Button>
    </div>
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {wide || !showList ? null : presenceButton}

      <div className="flex min-h-0 flex-1">
        {showList ? (
          <ConversationList
            section={section}
            onSection={setSection}
            selectedId={selectedId}
            onSelect={select}
            onCreate={() => setCreating(true)}
            full={!wide}
          />
        ) : null}

        {showFeed ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {wide ? presenceButton : null}
            {conversation ? (
              <MessageFeed
                key={conversation.id}
                conversation={conversation}
                threadRootId={threadRootId}
                onThread={setThreadRootId}
                onBack={wide ? undefined : () => setSelectedId(null)}
                onOpenMeeting={(meetingId) =>
                  openTab({
                    kind: 'object',
                    objectId: meetingId,
                    objectType: 'meeting',
                    title: conversation.title,
                    mode: 'permanent',
                  })
                }
              />
            ) : (
              <EmptyState
                icon={<MessageSquare className="size-6" />}
                title={t('chats.pick')}
                description={t('chats.pickHint')}
              />
            )}
          </div>
        ) : null}
      </div>

      {creating ? (
        <NewChatDialog
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            setSelectedId(item.id)
            setThreadRootId(null)
          }}
        />
      ) : null}
      {presenceOpen ? <PresenceDialog onClose={() => setPresenceOpen(false)} /> : null}
    </div>
  )
}
