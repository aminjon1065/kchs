import type { PageBlockKind } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  PanelToolbar,
  personTone,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type * as Y from 'yjs'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { PrintMenu } from '~/features/documents/print/print-menu.js'
import { useCollabDocument } from '~/features/notebooks/collab.js'
import {
  cellIds,
  cellsOf,
  duplicateCell,
  insertCell,
  moveCell,
  orderOf,
  removeCell,
  useYChanges,
} from '~/features/notebooks/notebook-doc.js'
import { meQuery } from '~/shared/api/queries.js'
import { AddBlockButtons, PageBlockCard } from './page-blocks.js'
import { PageProvider } from './page-context.js'
import { createPageBlock, PAGE_KEYS } from './page-doc.js'
import { PageOutline } from './page-outline.js'
import { PageReview, PublishDialog } from './page-panels.js'
import { PageVersions } from './page-versions.js'
import { pageQuery } from './queries.js'

const STATUS_TONE = { draft: 'neutral', published: 'success', review: 'warning' } as const

/**
 * Карточка страницы базы знаний (03-screens.md §18, ADR-0095): редактор блоков
 * совместного документа, оглавление справа, шапка с состоянием, владельцем и
 * сроком пересмотра, вкладки версий и пересмотра, печать формой реестра.
 */
export default function PageView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const setContextTab = useWorkspace((s) => s.setContextTab)
  const { data: page } = useQuery(pageQuery(objectId))
  const { data: me } = useQuery(meQuery())
  const collab = useCollabDocument(objectId)
  const [publishOpen, setPublishOpen] = useState(false)

  const name = me?.user.displayName ?? ''
  const user = useMemo(() => ({ name, tone: personTone(name) }), [name])

  useEffect(() => {
    if (page?.title) setTabTitle(tabId, page.title)
  }, [page?.title, setTabTitle, tabId])

  // Снимок страницы перечитывается после правок: от него живут оглавление и версии
  useEffect(() => {
    if (!collab?.synced) return
    const timer = setInterval(() => {
      void client.invalidateQueries({ queryKey: ['object', objectId, 'page'] })
    }, 30_000)
    return () => clearInterval(timer)
  }, [collab?.synced, client, objectId])

  if (!page) return <Skeleton className="m-4 h-40" />
  if (collab?.status === 'denied') {
    return <EmptyState title={t('knowledge.readOnly')} description={collab.reason ?? ''} />
  }
  const readOnly = Boolean(collab?.readOnly) || !page.can.edit

  // Комментарий к фрагменту: контекстная панель открывается на обсуждении
  // этого блока — якорь ведёт ядро (ADR-0095)
  const comment = (blockId: string) => setContextTab('discussion', blockId)

  return (
    <PageProvider
      value={{
        pageId: page.id,
        spaceId: page.spaceId,
        readOnly,
        awareness: collab?.awareness ?? null,
        user,
        onComment: comment,
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <PanelToolbar
          left={
            <>
              <Badge tone={STATUS_TONE[page.status]}>{t(`knowledge.status.${page.status}`)}</Badge>
              {page.reviewAt ? (
                <span className="text-2xs text-fg-muted">
                  {t('knowledge.review.due', { date: formatDate(page.reviewAt, { locale }) })}
                </span>
              ) : null}
            </>
          }
          right={
            <>
              <PrintMenu subjectId={page.id} />
              {page.can.publish ? (
                <Button size="sm" onClick={() => setPublishOpen(true)}>
                  <BookCheck className="size-4" />
                  {page.status === 'published'
                    ? t('knowledge.publish.republish')
                    : t('knowledge.publish.action')}
                </Button>
              ) : null}
            </>
          }
        />

        <Tabs defaultValue="text" className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label={t('knowledge.title')} className="px-4 pt-2">
            <TabsTrigger value="text">{t('objects.types.page')}</TabsTrigger>
            <TabsTrigger value="versions">{t('knowledge.versions.tab')}</TabsTrigger>
            <TabsTrigger value="review">{t('knowledge.review.title')}</TabsTrigger>
          </TabsList>

          <TabsContent value="text" className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              {page.reviewStale && page.reviewAt ? (
                // Срок пересмотра прошёл больше месяца назад — текст мог устареть (N35)
                <Callout tone="warning">
                  {t('knowledge.review.stale', {
                    date: formatDate(page.reviewAt, { locale }),
                    owner: page.owner?.displayName ?? t('knowledge.review.ownerNone'),
                  })}
                </Callout>
              ) : null}
              {readOnly ? <Callout tone="neutral">{t('knowledge.readOnly')}</Callout> : null}
              {collab?.doc && collab.synced ? (
                <PageBlocks doc={collab.doc} readOnly={readOnly} />
              ) : (
                <Skeleton className="h-64" />
              )}
            </div>
            <aside className="hidden w-56 shrink-0 overflow-y-auto lg:block">
              <h2 className="mb-2 text-2xs font-medium uppercase text-fg-muted">
                {t('knowledge.outline.title')}
              </h2>
              <PageOutline items={page.outline} />
            </aside>
          </TabsContent>

          <TabsContent value="versions" className="min-h-0 flex-1 overflow-y-auto p-4">
            <PageVersions pageId={page.id} canEdit={page.can.edit} canManage={page.can.manage} />
          </TabsContent>

          <TabsContent value="review" className="min-h-0 flex-1 overflow-y-auto p-4">
            <PageReview page={page} />
          </TabsContent>
        </Tabs>
      </div>

      {publishOpen ? <PublishDialog page={page} onClose={() => setPublishOpen(false)} /> : null}
    </PageProvider>
  )
}

/** Блоки страницы по порядку документа: правки соавторов видны сразу. */
function PageBlocks({ doc, readOnly }: { doc: Y.Doc; readOnly: boolean }) {
  const t = useT()
  const orderVersion = useYChanges(orderOf(doc, PAGE_KEYS) as unknown as Y.AbstractType<unknown>)
  const blocksVersion = useYChanges(cellsOf(doc, PAGE_KEYS) as unknown as Y.AbstractType<unknown>)
  // biome-ignore lint/correctness/useExhaustiveDependencies: версии документа — сигнал пересчёта
  const ids = useMemo(() => cellIds(doc, PAGE_KEYS), [doc, orderVersion, blocksVersion])
  const blocks = cellsOf(doc, PAGE_KEYS)

  const add = (kind: PageBlockKind) => {
    insertCell(doc, createPageBlock(kind), ids.length, PAGE_KEYS)
  }

  return (
    <section className="flex flex-col gap-3" aria-label={t('knowledge.title')}>
      {ids.length === 0 ? (
        <EmptyState
          title={t('knowledge.blocks.empty')}
          description={t('knowledge.blocks.emptyHint')}
        />
      ) : null}
      {ids.map((id) => {
        const block = blocks.get(id)
        if (!block) return null
        const kind = block.get('kind')
        if (typeof kind !== 'string') return null
        return (
          <PageBlockCard
            key={id}
            id={id}
            block={block}
            kind={kind as PageBlockKind}
            onMove={(delta) => moveCell(doc, id, delta, PAGE_KEYS)}
            onRemove={() => removeCell(doc, id, PAGE_KEYS)}
            onDuplicate={() => duplicateCell(doc, id, PAGE_KEYS)}
          />
        )
      })}
      {readOnly ? null : <AddBlockButtons onAdd={add} />}
    </section>
  )
}
