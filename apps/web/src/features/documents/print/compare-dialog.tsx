import type { DocumentVersionRecord, VersionCompareResult } from '@kchs/contracts'
import {
  Callout,
  Dialog,
  DialogContent,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { ScanViewer } from '../scan-viewer.js'
import { renderKeys } from './renders.js'

/**
 * Сравнение версий документа (08-documents.md §8, ADR-0085): «Текст» — по
 * словам из извлечённого текста (добавленное подчёркнуто, удалённое
 * зачёркнуто), «Рядом» — PDF-представления двух версий бок о бок.
 */
export function CompareDialog({
  documentId,
  versions,
  onClose,
}: {
  documentId: string
  versions: DocumentVersionRecord[]
  onClose: () => void
}) {
  const t = useT()
  // Версии — от новой к старой: по умолчанию предыдущая против текущей
  const [toId, setToId] = useState(versions[0]?.id ?? '')
  const [fromId, setFromId] = useState(versions[1]?.id ?? versions[0]?.id ?? '')
  const from = versions.find((version) => version.id === fromId) ?? null
  const to = versions.find((version) => version.id === toId) ?? null

  const picker = (label: string, value: string, onChange: (value: string) => void) => (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions.map((version) => (
            <SelectItem key={version.id} value={version.id}>
              {t('documents.versions.number', { number: version.number })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent title={t('documents.compare.title')} size="xl">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            {picker(t('documents.compare.from'), fromId, setFromId)}
            {picker(t('documents.compare.to'), toId, setToId)}
          </div>
          <Tabs defaultValue="text" className="flex flex-col gap-3">
            <TabsList aria-label={t('documents.compare.modes')}>
              <TabsTrigger value="text">{t('documents.compare.text')}</TabsTrigger>
              <TabsTrigger value="visual">{t('documents.compare.visual')}</TabsTrigger>
            </TabsList>
            <TabsContent value="text">
              {fromId === toId ? (
                <Callout tone="info">{t('documents.compare.same')}</Callout>
              ) : (
                <TextDiff documentId={documentId} fromId={fromId} toId={toId} />
              )}
            </TabsContent>
            <TabsContent value="visual">
              <div className="grid h-[65vh] grid-cols-2 gap-3">
                {[from, to].map((version, index) => (
                  <div
                    key={`${index}-${version?.id ?? 'none'}`}
                    className="flex min-h-0 flex-col overflow-hidden rounded-md border border-line"
                  >
                    <p className="border-b border-line px-3 py-1.5 text-xs font-medium text-fg-secondary">
                      {version ? t('documents.versions.number', { number: version.number }) : '—'}
                    </p>
                    <ScanViewer
                      fileId={version?.pdfFile?.id ?? version?.mainFile?.id ?? null}
                      className="min-h-0 flex-1"
                    />
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TextDiff({
  documentId,
  fromId,
  toId,
}: {
  documentId: string
  fromId: string
  toId: string
}) {
  const t = useT()
  const { data, isLoading } = useQuery({
    queryKey: renderKeys.compare(documentId, fromId, toId),
    queryFn: () =>
      http.get<VersionCompareResult>(`/documents/${documentId}/versions/compare`, {
        query: { from: fromId, to: toId },
      }),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 4000 : false),
  })
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />
  if (data.status === 'pending') {
    return (
      <p className="flex items-center gap-2 text-sm text-fg-secondary">
        <Spinner className="size-4" />
        {t('documents.compare.pending')}
      </p>
    )
  }
  if (data.status === 'unavailable') {
    return <Callout tone="warning">{t('documents.compare.unavailable')}</Callout>
  }
  const changed = data.stats.inserted + data.stats.deleted > 0
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-fg-secondary" aria-live="polite">
        {changed
          ? t('documents.compare.stats', {
              inserted: data.stats.inserted,
              deleted: data.stats.deleted,
            })
          : t('documents.compare.identical')}
        {data.truncated ? ` ${t('documents.compare.truncated')}` : ''}
      </p>
      <section
        className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface p-4 text-sm leading-relaxed text-fg"
        aria-label={t('documents.compare.text')}
      >
        {data.segments.map((segment, index) =>
          segment.op === 'insert' ? (
            <ins
              key={index}
              className="rounded-xs bg-success-subtle text-success underline underline-offset-2"
            >
              {segment.text}
            </ins>
          ) : segment.op === 'delete' ? (
            <del key={index} className="rounded-xs bg-danger-subtle text-danger line-through">
              {segment.text}
            </del>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </section>
    </div>
  )
}
