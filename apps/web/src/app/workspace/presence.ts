import { useEffect } from 'react'
import { reportPresence, useRealtimeStatus } from '~/shared/realtime/client.js'
import { useWorkspace } from './store.js'

const BEAT_MS = 30_000

/**
 * Присутствие (16-api-and-events.md §3): объекты видимых вкладок — активных в
 * каждой панели — отмечаются раз в 30 с, пока страница на экране. Ушла
 * вкладка из вида, закрыта или страница спрятана — «ушёл» сразу.
 */
export function usePresenceHeartbeat(): void {
  const status = useRealtimeStatus()
  const visible = useWorkspace((s) =>
    s.panes
      .map((pane) => (pane.activeTabId ? s.tabs[pane.activeTabId] : undefined))
      .filter((tab) => tab?.kind === 'object' && tab.objectId)
      .map((tab) => tab?.objectId as string)
      .sort()
      .join(','),
  )

  useEffect(() => {
    const ids = visible ? [...new Set(visible.split(','))] : []
    if (status !== 'connected' || ids.length === 0) return
    const beat = () => {
      if (document.visibilityState !== 'visible') return
      for (const id of ids) reportPresence(id, 'view')
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') beat()
      else for (const id of ids) reportPresence(id, 'leave')
    }
    beat()
    const timer = window.setInterval(beat, BEAT_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      for (const id of ids) reportPresence(id, 'leave')
    }
  }, [visible, status])
}
