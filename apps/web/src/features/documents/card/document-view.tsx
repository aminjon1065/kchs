import type { DocumentRecord } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  NoAccessState,
  ObjectIcon,
  PanelToolbar,
  Skeleton,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { PanelRightOpen, Share2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useObjectActions } from '~/app/workspace/object-actions.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError } from '~/shared/api/client.js'
import { documentQuery } from '../queries.js'
import { CONFIDENTIALITY_TONE, DOCUMENT_STATUS_TONE, errorText } from '../status.js'
import { AcknowledgmentsTab } from './acknowledgments-tab.js'
import { CardTab } from './card-tab.js'
import {
  DOCUMENT_SECTIONS,
  DocumentProvider,
  type DocumentSection,
  useDocument,
} from './document-context.js'
import { FilesTab } from './files-tab.js'
import { HistoryTab } from './history-tab.js'
import { LinksTab } from './links-tab.js'
import { DocumentOfficeActions } from './office-actions.js'
import { ResolutionsTab } from './resolutions-tab.js'
import { DocumentRouteIndicator, RouteTab } from './route-tab.js'
import { DocumentStepActions, useAwaitsMe } from './step-actions.js'

/** Состояние вкладки оболочки: открытая секция карточки. */
interface DocumentTabState {
  section?: DocumentSection
}

/** Действие дела Входящих с формой в карточке — на какой вкладке его форма (ADR-0084). */
const ACTION_SECTIONS: Partial<Record<string, DocumentSection>> = { resolve: 'resolutions' }

/**
 * Карточка документа (03-screens.md §12, 08-documents.md §15): шапка — тип,
 * номер и дата, статус, гриф, срок, контроль, ответственный; вкладки
 * «Карточка», «Файлы и версии», «Маршрут», «Резолюции и поручения», «Связи»,
 * «Ознакомление», «История». Вкладки второй волны — файлы-слоты с общим
 * контекстом `useDocument()`.
 */
export function DocumentView({
  objectId,
  tabId,
  savedState,
}: {
  objectId: string
  tabId: string
  savedState?: DocumentTabState
}) {
  const t = useT()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const setTabState = useWorkspace((s) => s.setTabState)
  const [section, setSection] = useState<DocumentSection>(savedState?.section ?? 'card')
  const { data: document, error, isLoading, refetch } = useQuery(documentQuery(objectId))

  useEffect(() => setTabState(tabId, { section }), [tabId, section, setTabState])
  useEffect(() => {
    if (document) setTabTitle(tabId, titleOf(document, t('documents.draft')))
  }, [document, tabId, setTabTitle, t])
  const openSection = useCallback((next: DocumentSection) => setSection(next), [])
  // Намерение из Входящих: вкладка с формой; саму форму открывает её слот
  const pendingAction = useObjectActions((s) => s.pending[objectId] ?? null)
  useEffect(() => {
    const target = pendingAction ? ACTION_SECTIONS[pendingAction] : undefined
    if (target) setSection(target)
  }, [pendingAction])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return <NoAccessState />
    }
    return (
      <ErrorState description={errorText(error, t('errors.unknown'))} onRetry={() => refetch()} />
    )
  }
  if (!document) return <EmptyState title={t('common.states.notFound')} />

  return (
    <DocumentProvider document={document} tabId={tabId} openSection={openSection}>
      <div className="flex h-full min-h-0 flex-col">
        <DocumentHeader />
        <Tabs
          value={section}
          onValueChange={(value) => setSection(value as DocumentSection)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="shrink-0 px-2.5" aria-label={t('documents.card.sections')}>
            {DOCUMENT_SECTIONS.map((key) => (
              <TabsTrigger
                key={key}
                value={key}
                count={key === 'files' ? document.versionCount : undefined}
              >
                {t(`documents.card.tabs.${key}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="card" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <CardTab />
          </TabsContent>
          <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden bg-canvas">
            <FilesTab />
          </TabsContent>
          <TabsContent value="route" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <RouteTab />
          </TabsContent>
          <TabsContent value="resolutions" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <ResolutionsTab />
          </TabsContent>
          <TabsContent value="links" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <LinksTab />
          </TabsContent>
          <TabsContent value="acknowledgments" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <AcknowledgmentsTab />
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto bg-canvas">
            <HistoryTab />
          </TabsContent>
        </Tabs>
      </div>
    </DocumentProvider>
  )
}

/** Заголовок вкладки: номер и тема; черновик — тема или «Черновик». */
export function titleOf(document: DocumentRecord, draft: string): string {
  const subject = document.subject.trim() || draft
  return document.regNumber ? `${document.regNumber} · ${subject}` : subject
}

function DocumentHeader() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const contextOpen = useWorkspace((s) => s.contextOpen)
  const contextTab = useWorkspace((s) => s.contextTab)
  const setContextTab = useWorkspace((s) => s.setContextTab)
  const [shareOpen, setShareOpen] = useState(false)
  const { document } = useDocument()
  const awaitsMe = useAwaitsMe(document)
  // Действия шага живут в контекст-панели; когда она скрыта или на другой вкладке — кнопка к ним
  const hasActions =
    document.can.register ||
    document.can.cancel ||
    document.can.startRoute ||
    awaitsMe ||
    document.can.reply ||
    document.can.dispatch ||
    document.can.file
  const actionsHidden = hasActions && (!contextOpen || contextTab !== 'info')
  const typeName = document.type.name[locale] ?? document.type.name.ru
  return (
    <>
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="document" className="size-4 shrink-0 text-fg-muted" />
            <span className="shrink-0 text-xs text-fg-muted">{typeName}</span>
            {document.regNumber ? (
              <span className="shrink-0 font-mono text-xs tabular text-fg-secondary">
                {t('documents.header.number', {
                  number: document.regNumber,
                  date: document.regDate ? formatDate(document.regDate, { locale }) : '',
                })}
              </span>
            ) : null}
            <h1 className="min-w-0 truncate text-sm font-semibold text-fg" title={document.subject}>
              {document.subject || t('documents.draft')}
            </h1>
            <StatusBadge
              status={DOCUMENT_STATUS_TONE[document.status]}
              label={t(`documents.statuses.${document.status}`)}
            />
            {document.confidentiality !== 'public' ? (
              <Badge
                size="sm"
                tone={CONFIDENTIALITY_TONE[document.confidentiality]}
                title={t(`access.confidentiality.${document.confidentiality}`)}
              >
                {t(`access.confidentialityShort.${document.confidentiality}`)}
              </Badge>
            ) : null}
          </>
        }
        right={
          <>
            <DocumentRouteIndicator />
            {document.deadline ? (
              <span
                className={document.overdue ? 'text-xs text-danger' : 'text-xs text-fg-secondary'}
              >
                {t('documents.header.deadline', {
                  date: formatDate(document.deadline, { locale }),
                })}
              </span>
            ) : null}
            {document.control === 'on' ? (
              <Badge tone="purple" size="sm">
                {t('documents.controls.on')}
              </Badge>
            ) : null}
            {document.responsible ? (
              <Tooltip
                content={t('documents.header.responsible', {
                  name: document.responsible.displayName,
                })}
              >
                <span>
                  <Avatar
                    name={document.responsible.displayName}
                    src={document.responsible.avatarUrl}
                    size="sm"
                  />
                </span>
              </Tooltip>
            ) : null}
            <PresenceAvatars objectId={document.id} />
            {actionsHidden ? (
              <Button
                variant="subtle"
                size="sm"
                icon={<PanelRightOpen className="size-3.5" />}
                onClick={() => setContextTab('info')}
              >
                {t('documents.actions.title')}
              </Button>
            ) : null}
            {document.can.share ? (
              <Button
                variant="ghost"
                size="sm"
                icon={<Share2 className="size-3.5" />}
                onClick={() => setShareOpen(true)}
              >
                {t('common.actions.share')}
              </Button>
            ) : null}
          </>
        }
      />
      <ShareDialog
        objectId={document.id}
        title={document.subject || t('documents.draft')}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </>
  )
}

/**
 * Секция контекст-панели оболочки для документа: действия шага (слот второй
 * волны) над тем же кэшем карточки.
 */
export function DocumentContextSection({ objectId }: { objectId: string }) {
  const { data: document } = useQuery(documentQuery(objectId))
  if (!document) return null
  return (
    <DocumentProvider document={document} tabId={null}>
      <DocumentStepActions />
      <DocumentOfficeActions />
    </DocumentProvider>
  )
}
