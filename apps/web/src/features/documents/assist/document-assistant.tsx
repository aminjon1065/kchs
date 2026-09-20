import type {
  DocumentClassification,
  DocumentReplyDraft,
  DocumentSummaryDraft,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Copy, FileText, Reply, Sparkles } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { documentKeys, documentQuery } from '../queries.js'
import { confidenceTone, documentAssistQuery } from './queries.js'

/**
 * Ассистент документа в контекстной панели (13-search-knowledge-ai.md §5,
 * ADR-0088): краткое содержание (вставить в карточку — с правом правки) и
 * черновик ответа на входящее по указаниям исполнителя. Ответ модели — только
 * предложение: в документ он попадает нажатием пользователя.
 */
export function DocumentAssistant({ documentId }: { documentId: string }) {
  const t = useT()
  const status = useQuery(documentAssistQuery(documentId))
  const doc = useQuery(documentQuery(documentId))

  if (status.isLoading || doc.isLoading) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  const blocker = status.data?.blocker ?? null
  if (!status.data || blocker === 'ai_disabled') {
    return (
      <EmptyState
        compact
        icon={<Bot />}
        title={t('documentAssist.panel.disabled')}
        description={t('documentAssist.panel.disabledHint')}
      />
    )
  }
  if (blocker) {
    return (
      <div className="p-3">
        <Callout tone="info">
          <span className="flex items-center gap-2">
            {blocker === 'text_pending' ? (
              <Spinner className="size-3.5" label={t('documentAssist.blockers.text_pending')} />
            ) : null}
            {t(`documentAssist.blockers.${blocker}`)}
          </span>
        </Callout>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      <SummaryCard documentId={documentId} canEdit={doc.data?.can.edit ?? false} />
      {doc.data?.status === 'draft' ? (
        <ClassifyCard documentId={documentId} canEdit={doc.data?.can.edit ?? false} />
      ) : null}
      {doc.data?.type.direction === 'incoming' ? <ReplyCard documentId={documentId} /> : null}
    </div>
  )
}

async function copy(text: string, done: () => void, failed: () => void) {
  try {
    await navigator.clipboard.writeText(text)
    done()
  } catch {
    failed()
  }
}

/**
 * Вид документа по тексту скана (P5-E05): предложение с уверенностью и цитатой
 * и похожие документы — по ним видно, как такие бумаги вели раньше. Вид
 * применяет человек; до регистрации его ещё можно сменить.
 */
function ClassifyCard({ documentId, canEdit }: { documentId: string; canEdit: boolean }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const make = useMutation({
    mutationFn: () => http.post<DocumentClassification>(`/documents/${documentId}/assist/classify`),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const apply = useMutation({
    mutationFn: (typeId: string) => http.patch(`/documents/${documentId}`, { typeId }),
    onSuccess: () => {
      toast.show({ title: t('documentAssist.panel.typeApplied'), tone: 'success' })
      void client.invalidateQueries({ queryKey: documentKeys.document(documentId) })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const answer = make.data

  return (
    <Card title={t('documentAssist.panel.classifyTitle')} padded>
      <div className="flex flex-col gap-2">
        {answer ? (
          <>
            {answer.type ? (
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm text-fg">
                  {answer.type.name}
                  <Badge size="sm" tone={confidenceTone(answer.type.confidence)}>
                    {t(`documentAssist.confidence.${confidenceTone(answer.type.confidence)}`, {
                      percent: Math.round(answer.type.confidence * 100),
                    })}
                  </Badge>
                </span>
                {answer.type.journal ? (
                  <span className="text-xs text-fg-secondary">
                    {t('documentAssist.panel.journal', { name: answer.type.journal.name })}
                  </span>
                ) : null}
                {answer.type.quote ? (
                  <q className="text-xs text-fg-muted">{answer.type.quote}</q>
                ) : null}
                {canEdit ? (
                  <div>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={apply.isPending}
                      onClick={() => answer.type && apply.mutate(answer.type.id)}
                    >
                      {t('documentAssist.panel.applyType')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-fg-muted">{t('documentAssist.panel.typeUnknown')}</p>
            )}

            {answer.similar.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
                  {t('documentAssist.panel.similar')}
                </span>
                <ul className="flex flex-col gap-0.5">
                  {answer.similar.map((item) => (
                    <li key={item.objectId}>
                      <button
                        type="button"
                        className="w-full truncate text-left text-xs text-accent hover:underline"
                        onClick={() =>
                          openTab({
                            kind: 'object',
                            objectId: item.objectId,
                            objectType: 'document',
                            title: item.title,
                            mode: 'preview',
                          })
                        }
                      >
                        {item.number ? `№ ${item.number} · ` : ''}
                        {item.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-fg-muted">{t('documentAssist.panel.classifyHint')}</p>
        )}
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon={<Sparkles className="size-3.5" />}
            loading={make.isPending}
            onClick={() => make.mutate()}
          >
            {t('documentAssist.panel.classify')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function SummaryCard({ documentId, canEdit }: { documentId: string; canEdit: boolean }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const make = useMutation({
    mutationFn: () => http.post<DocumentSummaryDraft>(`/documents/${documentId}/assist/summary`),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const insert = useMutation({
    mutationFn: (summary: string) => http.patch(`/documents/${documentId}`, { summary }),
    onSuccess: () => {
      toast.show({ title: t('documentAssist.panel.inserted'), tone: 'success' })
      void client.invalidateQueries({ queryKey: documentKeys.document(documentId) })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const draft = make.data
  return (
    <Card title={t('documentAssist.panel.summaryTitle')} padded>
      <div className="flex flex-col gap-2">
        {draft ? (
          <>
            <p className="whitespace-pre-wrap text-sm text-fg">{draft.summary}</p>
            {draft.truncated ? (
              <p className="text-xs text-fg-muted">{t('documentAssist.truncated')}</p>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {canEdit ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<FileText className="size-3.5" />}
                  loading={insert.isPending}
                  onClick={() => insert.mutate(draft.summary)}
                >
                  {t('documentAssist.panel.insertSummary')}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-3.5" />}
                onClick={() =>
                  void copy(
                    draft.summary,
                    () => toast.show({ title: t('documentAssist.panel.copied'), tone: 'info' }),
                    () => toast.error(t('documentAssist.panel.copyFailed')),
                  )
                }
              >
                {t('documentAssist.panel.copy')}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-fg-muted">{t('documentAssist.panel.summaryHint')}</p>
        )}
        <div>
          <Button
            size="sm"
            variant={draft ? 'ghost' : 'secondary'}
            icon={<Sparkles className="size-3.5" />}
            loading={make.isPending}
            onClick={() => make.mutate()}
          >
            {draft ? t('documentAssist.panel.again') : t('documentAssist.panel.summarize')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function ReplyCard({ documentId }: { documentId: string }) {
  const t = useT()
  const toast = useToast()
  const instructionsId = useId()
  const [instructions, setInstructions] = useState('')
  const make = useMutation({
    mutationFn: () =>
      http.post<DocumentReplyDraft>(`/documents/${documentId}/assist/reply`, {
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const draft = make.data
  return (
    <Card title={t('documentAssist.panel.replyTitle')} padded>
      <div className="flex flex-col gap-2">
        <Field
          label={t('documentAssist.panel.instructions')}
          hint={t('documentAssist.panel.instructionsHint')}
          htmlFor={instructionsId}
        >
          <Textarea
            id={instructionsId}
            rows={2}
            value={instructions}
            maxLength={2000}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        <div>
          <Button
            size="sm"
            variant={draft ? 'ghost' : 'secondary'}
            icon={<Reply className="size-3.5" />}
            loading={make.isPending}
            onClick={() => make.mutate()}
          >
            {draft ? t('documentAssist.panel.again') : t('documentAssist.panel.draftReply')}
          </Button>
        </div>
        {draft ? (
          <article
            aria-label={t('documentAssist.panel.replyDraft')}
            className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-2.5"
          >
            <p className="text-sm font-medium text-fg">{draft.subject}</p>
            <p className="whitespace-pre-wrap text-sm text-fg-secondary">{draft.body}</p>
            {draft.truncated ? (
              <p className="text-xs text-fg-muted">{t('documentAssist.truncated')}</p>
            ) : null}
            <div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-3.5" />}
                onClick={() =>
                  void copy(
                    `${draft.subject}\n\n${draft.body}`,
                    () => toast.show({ title: t('documentAssist.panel.copied'), tone: 'info' }),
                    () => toast.error(t('documentAssist.panel.copyFailed')),
                  )
                }
              >
                {t('documentAssist.panel.copy')}
              </Button>
            </div>
          </article>
        ) : null}
      </div>
    </Card>
  )
}
