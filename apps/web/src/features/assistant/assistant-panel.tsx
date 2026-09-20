import type { AssistantMessage, AssistantThread } from '@kchs/contracts'
import {
  Button,
  Callout,
  EmptyState,
  IconButton,
  ObjectIcon,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Eraser, Send, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { aiStatusQuery } from '~/features/data/queries.js'
import { CreateTaskDialog } from '~/features/tasks/task-dialogs.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Ассистент в контекстной панели (13-search-knowledge-ai.md §5, ADR-0100):
 * диалог по открытому объекту. Ассистент ищет и читает от имени пользователя,
 * а поручения и документы только предлагает — создаёт их человек.
 */
export function AssistantPanel({ objectId }: { objectId: string | null }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [question, setQuestion] = useState('')
  const [taskDraft, setTaskDraft] = useState<{ title: string; description: string } | null>(null)

  const status = useQuery(aiStatusQuery())
  const key = ['assistant', 'thread', objectId ?? 'global'] as const
  const { data: thread, isLoading } = useQuery({
    queryKey: key,
    queryFn: () =>
      http.get<AssistantThread>('/assistant/thread', {
        query: objectId ? { objectId } : {},
      }),
    enabled: status.data?.enabled ?? false,
  })

  const ask = useMutation({
    mutationFn: (text: string) =>
      http.post<AssistantMessage>('/assistant/ask', { objectId, question: text }),
    onSuccess: () => {
      setQuestion('')
      void client.invalidateQueries({ queryKey: key })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const clear = useMutation({
    mutationFn: (threadId: string) => http.delete(`/assistant/threads/${threadId}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: key }),
  })

  if (status.isLoading) return <Skeleton className="m-3 h-24" />
  if (!status.data?.enabled) {
    return (
      <EmptyState
        compact
        icon={<Bot />}
        title={t('assistant.disabled')}
        description={t('assistant.disabledHint')}
      />
    )
  }

  const messages = thread?.messages ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {isLoading ? <Skeleton className="h-20" /> : null}
        {!isLoading && messages.length === 0 ? (
          <Callout tone="info">{t('assistant.hint')}</Callout>
        ) : null}

        {messages.map((message) => (
          <div key={message.id} className="flex flex-col gap-1.5">
            <div className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
              {t(`assistant.roles.${message.role}`)}
            </div>
            <p className="whitespace-pre-wrap text-sm text-fg">{message.text}</p>

            {message.steps.length > 0 ? (
              <ul className="flex flex-col gap-0.5" aria-label={t('assistant.steps')}>
                {message.steps.map((step, index) => (
                  <li
                    key={`${message.id}-${index}`}
                    className="flex items-center gap-1.5 text-2xs text-fg-muted"
                  >
                    <Sparkles className="size-3 shrink-0" aria-hidden />
                    {step.summary} · {t('assistant.found', { count: step.found })}
                  </li>
                ))}
              </ul>
            ) : null}

            {message.citations.length > 0 ? (
              <ul className="flex flex-wrap gap-1" aria-label={t('assistant.citations')}>
                {message.citations.map((citation) => (
                  <li key={citation.objectId}>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-2xs text-fg-secondary hover:bg-surface-2"
                      onClick={() =>
                        openTab({
                          kind: 'object',
                          objectId: citation.objectId,
                          objectType: citation.type,
                          title: citation.title,
                          mode: 'preview',
                        })
                      }
                    >
                      <ObjectIcon type={citation.type} className="size-3" />
                      <span className="max-w-[160px] truncate">{citation.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {message.proposals.map((proposal, index) => (
              <div
                key={`${message.id}-proposal-${index}`}
                className="flex items-center gap-2 rounded-md border border-line bg-surface-2 p-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-fg">
                  {proposal.kind === 'task' ? proposal.title : proposal.subject}
                </span>
                {proposal.kind === 'task' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setTaskDraft({ title: proposal.title, description: proposal.description })
                    }
                  >
                    {t('assistant.createTask')}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2">
        <Textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          aria-label={t('assistant.question')}
          placeholder={t('assistant.placeholder')}
          rows={2}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && question.trim()) {
              ask.mutate(question.trim())
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            icon={<Send className="size-3.5" />}
            loading={ask.isPending}
            disabled={question.trim().length < 2}
            onClick={() => ask.mutate(question.trim())}
          >
            {t('assistant.send')}
          </Button>
          {thread && messages.length > 0 ? (
            <IconButton
              size="sm"
              label={t('assistant.clear')}
              onClick={() => clear.mutate(thread.id)}
            >
              <Eraser className="size-3.5" />
            </IconButton>
          ) : null}
        </div>
      </div>

      {taskDraft ? (
        <CreateTaskDialog
          draft={{
            kind: 'instruction',
            title: taskDraft.title,
            description: taskDraft.description,
          }}
          onClose={() => setTaskDraft(null)}
          onCreated={() => setTaskDraft(null)}
        />
      ) : null}
    </div>
  )
}
