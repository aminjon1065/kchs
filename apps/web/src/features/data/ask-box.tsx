import type { AskDataResult } from '@kchs/contracts'
import { Button, Callout, Input } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/shared/i18n.js'
import { askError } from './ask-error.js'
import { aiStatusQuery, dataApi } from './queries.js'

/**
 * «Спросить данные» (P1-E09 S03, ADR-0061): вопрос на естественном языке →
 * план «Исследования» от модели, проверенный сервером. План применяется к
 * конструктору слева — там его видно и можно править; запрос показывается.
 */
export function AskBox({
  datasetId,
  onAnswer,
}: {
  datasetId: string
  onAnswer: (answer: AskDataResult) => void
}) {
  const t = useT()
  const client = useQueryClient()
  const { data: status } = useQuery(aiStatusQuery())
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<AskDataResult | null>(null)
  const [showQuery, setShowQuery] = useState(false)

  const ask = useMutation({
    mutationFn: (text: string) => dataApi.postDatasetsAsk(datasetId, { question: text }),
    onSuccess: (result) => {
      setAnswer(result)
      onAnswer(result)
    },
    // Счётчик суточного лимита меняется при любом исходе
    onSettled: () => void client.invalidateQueries({ queryKey: aiStatusQuery().queryKey }),
  })

  if (!status?.enabled) return null
  const trimmed = question.trim()
  const error = ask.error ? askError(ask.error, t) : null

  return (
    <section
      aria-label={t('data.ask.label')}
      className="flex shrink-0 flex-col gap-2 border-b border-line bg-surface px-3 py-2.5"
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed.length >= 3) ask.mutate(trimmed)
        }}
      >
        <Input
          aria-label={t('data.ask.label')}
          placeholder={t('data.ask.placeholder')}
          maxLength={500}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={<Sparkles className="size-3.5" />}
          loading={ask.isPending}
          disabled={trimmed.length < 3}
        >
          {t('data.ask.submit')}
        </Button>
      </form>
      <p className="text-2xs text-fg-muted tabular">
        {ask.isPending
          ? t('data.ask.thinking')
          : t('data.ask.usage', {
              used: status.limits.requestsUsed,
              limit: status.limits.requestsPerDay,
            })}
      </p>

      {error && !ask.isPending ? (
        <Callout tone="danger" title={error.title}>
          {error.detail}
        </Callout>
      ) : null}

      {answer && !error && !ask.isPending ? (
        <div className="flex flex-col gap-1.5 text-xs">
          <p className="text-fg-secondary">
            <span className="font-medium text-fg">{t('data.ask.understood')}: </span>
            {answer.explanation}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showQuery}
              onClick={() => setShowQuery((value) => !value)}
            >
              {showQuery ? t('data.ask.hideQuery') : t('data.ask.showQuery')}
            </Button>
            <span className="text-2xs text-fg-muted">{t('data.ask.editHint')}</span>
          </div>
          {showQuery ? (
            <pre className="max-h-56 overflow-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-2xs text-fg">
              {JSON.stringify(answer.spec, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
