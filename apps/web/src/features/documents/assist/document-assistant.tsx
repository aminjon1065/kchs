import type { DocumentReplyDraft, DocumentSummaryDraft } from '@kchs/contracts'
import {
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
import { ApiError, http } from '~/shared/api/client.js'
import { documentKeys, documentQuery } from '../queries.js'
import { documentAssistQuery } from './queries.js'

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
