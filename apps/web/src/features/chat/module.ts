import { useQuery } from '@tanstack/react-query'
import { MessageSquare } from 'lucide-react'
import type { ModuleDefinition } from '~/shared/workspace/registry.js'
import { chatListQuery } from './queries.js'

/** Непрочитанные сообщения — значок на пункте «Чаты» (ADR-0090). */
function useUnreadChats(): number | undefined {
  return useQuery(chatListQuery('all')).data?.totalUnread
}

/** Что модуль «Чаты» даёт оболочке (ADR-0183). */
export const chatModule: ModuleDefinition = {
  key: 'chat',
  nav: [
    {
      key: 'chats',
      icon: MessageSquare,
      labelKey: 'shell.rail.chats',
      tabIcon: 'chats',
      shortcut: 'G C',
      order: 70,
      useBadge: useUnreadChats,
    },
  ],
}
