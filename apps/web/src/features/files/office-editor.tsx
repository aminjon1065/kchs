import { Badge, Button, EmptyState, PanelToolbar, Skeleton, Spinner } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Download, FileWarning } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError } from '~/shared/api/client.js'
import { fileQuery } from '~/shared/api/queries.js'
import { openOfficeSession } from './office.js'
import { useFileDownload } from './use-file-download.js'

/**
 * Вкладка редактирования офисного файла (09-files.md §7, ADR-0112).
 *
 * Сам редактор живёт на отдельной странице, которую отдаёт api со своей
 * политикой CSP; здесь она вставляется кадром. Кадр рассказывает о себе
 * сообщениями (`ready`, `dirty`, `saved`, `error`): по ним вкладка показывает
 * состояние и точку несохранённого, а не гадает о происходящем внутри.
 *
 * Если сервер документов недоступен — вместо пустого кадра понятное сообщение
 * и обычная загрузка файла.
 */
export function OfficeEditorScreen({ fileId, tabId }: { fileId: string; tabId: string }) {
  const t = useT()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const setTabDirty = useWorkspace((s) => s.setTabDirty)
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const download = useFileDownload()
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [failure, setFailure] = useState<string | null>(null)

  const { data: file } = useQuery(fileQuery(fileId))
  const session = useQuery({
    queryKey: ['files', 'office', 'session', fileId],
    queryFn: () => openOfficeSession(fileId),
    retry: false,
    // Сессия живёт часами, но вкладку открывают заново — тогда и спрашиваем
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (file?.name) setTabTitle(tabId, file.name)
  }, [file?.name, setTabTitle, tabId])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { source?: string; kind?: string; detail?: string | null }
      if (data?.source !== 'kchs-office') return
      if (data.kind === 'ready') setState('ready')
      if (data.kind === 'dirty') setTabDirty(tabId, true)
      if (data.kind === 'saved') setTabDirty(tabId, false)
      if (data.kind === 'unavailable' || data.kind === 'error') {
        setState('failed')
        setFailure(data.detail ?? null)
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      setTabDirty(tabId, false)
    }
  }, [setTabDirty, tabId])

  const saveLocally = (
    <Button
      variant="secondary"
      size="sm"
      icon={<Download className="size-3.5" />}
      onClick={() => download.mutate({ fileId })}
    >
      {t('common.actions.download')}
    </Button>
  )

  if (session.isError) {
    const problem = session.error instanceof ApiError ? session.error : null
    return (
      <EmptyState
        icon={<FileWarning />}
        title={t('files.office.unavailable')}
        description={problem?.message ?? t('errors.unknown')}
        action={saveLocally}
      />
    )
  }

  if (session.isLoading || !session.data) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-[70vh] w-full" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <span className="truncate text-sm font-semibold text-fg">{session.data.name}</span>
            <Badge size="sm" tone={session.data.mode === 'edit' ? 'accent' : undefined}>
              {session.data.mode === 'edit'
                ? t('files.office.modeEdit')
                : t('files.office.modeView')}
            </Badge>
            {state === 'loading' ? <Spinner className="size-3.5" /> : null}
          </>
        }
        right={saveLocally}
      />
      {state === 'failed' ? (
        <EmptyState
          icon={<FileWarning />}
          title={t('files.office.failed')}
          description={failure ?? t('files.office.failedHint')}
          action={saveLocally}
        />
      ) : (
        <iframe
          ref={frameRef}
          title={session.data.name}
          src={session.data.editorUrl}
          // Посторонний скрипт редактора не уводит вкладку и не открывает окон;
          // происхождение кадра нужно самому редактору (ADR-0112)
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
          className="min-h-0 w-full flex-1 border-0 bg-canvas"
        />
      )}
    </div>
  )
}
