import type { DocumentRecord } from '@kchs/contracts'
import {
  EmptyState,
  ErrorState,
  NoAccessState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '~/shared/api/errors.js'
import { useT } from '~/shared/i18n.js'
import { useObjectActions } from '~/shared/workspace/object-actions.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { documentQuery } from '../queries.js'
import { errorText } from '../status.js'
import { AcknowledgmentsTab } from './acknowledgments-tab.js'
import { CardTab } from './card-tab.js'
import { DOCUMENT_SECTIONS, DocumentProvider, type DocumentSection } from './document-context.js'
import { DocumentHeader } from './document-header.js'
import { FilesTab } from './files-tab.js'
import { HistoryTab } from './history-tab.js'
import { useDocumentLinks } from './links-block.js'
import { LinksTab } from './links-tab.js'
import { DocumentOfficeActions } from './office-actions.js'
import { ResolutionComposer } from './resolution-composer.js'
import { ResolutionsTab } from './resolutions-tab.js'
import { RouteTab } from './route-tab.js'
import { DocumentStepActions } from './step-actions.js'

/** Состояние вкладки оболочки: открытая секция карточки. */
interface DocumentTabState {
  section?: DocumentSection
}

/** Действие дела Входящих с формой в карточке — на какой вкладке его форма (ADR-0084). */
const ACTION_SECTIONS: Partial<Record<string, DocumentSection>> = { resolve: 'resolutions' }

/**
 * Карточка документа (03-screens.md §12, 08-documents.md §15, ADR-0230): шапка — чипы
 * вида, маршрута, состояния и грифа, тема, строка реквизитов (номер и дата, отправитель,
 * кто зарегистрировал, срок, контроль); вкладки «Карточка», «Файлы и версии», «Маршрут»,
 * «Резолюции и поручения», «Связи», «Ознакомление», «История»; внизу — резолюция, если
 * она ждёт смотрящего. Вкладки второй волны — файлы-слоты с общим контекстом `useDocument()`.
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
    <DocumentScreen document={document} tabId={tabId} section={section} setSection={setSection} />
  )
}

function DocumentScreen({
  document,
  tabId,
  section,
  setSection,
}: {
  document: DocumentRecord
  tabId: string
  section: DocumentSection
  setSection: (section: DocumentSection) => void
}) {
  const t = useT()
  const links = useDocumentLinks(document.id)
  const openSection = useCallback((next: DocumentSection) => setSection(next), [setSection])
  return (
    <DocumentProvider document={document} tabId={tabId} openSection={openSection}>
      <div className="flex h-full min-h-0 flex-col">
        <DocumentHeader />
        <Tabs
          value={section}
          onValueChange={(value) => setSection(value as DocumentSection)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="shrink-0 px-4" aria-label={t('documents.card.sections')}>
            {DOCUMENT_SECTIONS.map((key) => (
              <TabsTrigger
                key={key}
                value={key}
                count={
                  key === 'files'
                    ? document.versionCount
                    : key === 'links' && links.length > 0
                      ? links.length
                      : undefined
                }
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
        <ResolutionComposer />
      </div>
    </DocumentProvider>
  )
}

/** Заголовок вкладки: номер и тема; черновик — тема или «Черновик». */
export function titleOf(document: DocumentRecord, draft: string): string {
  const subject = document.subject.trim() || draft
  return document.regNumber ? `${document.regNumber} · ${subject}` : subject
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
