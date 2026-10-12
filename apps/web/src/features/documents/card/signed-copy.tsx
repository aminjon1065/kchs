import type { DocumentSignature } from '@kchs/contracts'
import { Badge, Button, Callout, Dialog, DialogContent, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, MapPin } from 'lucide-react'
import { type MouseEvent, useState } from 'react'
import { useFileDownload } from '~/features/files/index.js'
import { useT } from '~/shared/i18n.js'
import { documentKeys, pdfPagesQuery, placeSignature } from '../queries.js'
import { useDocument } from './document-context.js'

/** Адрес страницы проверки подписи — тот же, что в QR штампа (ADR-0198). */
export function verifyHref(signatureId: string): string {
  return `/api/v1/verify/${signatureId}`
}

/**
 * Подписанный экземпляр текущей версии (ADR-0198): PDF с факсимиле и штампом
 * электронной подписи. Пока движок его строит — «готовится».
 */
export function SignedCopyRow({ signed }: { signed: boolean }) {
  const t = useT()
  const download = useFileDownload()
  const { document } = useDocument()
  const copy = document.currentVersion?.signedCopy ?? null
  if (!signed) return null
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate text-fg">
        {copy ? t('documents.signatures.signedCopy') : t('documents.signatures.signedCopyPending')}
      </span>
      {copy ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<Download className="size-3.5" />}
          onClick={() =>
            download.mutate({ fileId: copy.id, versionId: copy.versionId ?? undefined })
          }
        >
          {t('common.actions.download')}
        </Button>
      ) : null}
    </div>
  )
}

/** Отметки подписи как реквизита: факсимиле, его место, ссылка проверки. */
export function SignatureRequisites({ signature }: { signature: DocumentSignature }) {
  const t = useT()
  const { document } = useDocument()
  const [placing, setPlacing] = useState(false)
  const pdf = document.currentVersion?.pdfFile ?? null
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {signature.facsimile ? (
        <Badge size="sm" tone="neutral">
          {t('documents.signatures.facsimile')}
        </Badge>
      ) : null}
      {signature.canPlace && signature.current && pdf ? (
        <Button
          variant="ghost"
          size="sm"
          icon={<MapPin className="size-3.5" />}
          onClick={() => setPlacing(true)}
        >
          {t('documents.signatures.place')}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        icon={<ExternalLink className="size-3.5" />}
        onClick={() => window.open(verifyHref(signature.id), '_blank', 'noopener')}
      >
        {t('documents.signatures.verify')}
      </Button>
      {placing && pdf ? (
        <PlacementDialog
          signature={signature}
          pdfFileId={pdf.id}
          onClose={() => setPlacing(false)}
        />
      ) : null}
    </span>
  )
}

/**
 * Место факсимиле (ADR-0198): лист PDF-представления, щелчок — центр факсимиле.
 * Сервер сохраняет место и строит экземпляр заново.
 */
function PlacementDialog({
  signature,
  pdfFileId,
  onClose,
}: {
  signature: DocumentSignature
  pdfFileId: string
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { document, refresh } = useDocument()
  const previews = useQuery(pdfPagesQuery(pdfFileId))
  const pages = (previews.data?.items ?? []).filter((item) => item.kind === 'page')
  const [page, setPage] = useState<number | null>(signature.placement?.page ?? null)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(
    signature.placement ? { x: signature.placement.x, y: signature.placement.y } : null,
  )
  const current = page ?? pages.length
  const image = pages.find((item) => (item.page ?? 0) === current) ?? pages.at(-1) ?? null

  const save = useMutation({
    mutationFn: () => {
      if (!point) throw new Error(t('documents.signatures.placeHint'))
      return placeSignature(document.id, signature.id, { page: current, x: point.x, y: point.y })
    },
    onSuccess: () => {
      toast.show({ title: t('documents.signatures.placed'), tone: 'success' })
      void client.invalidateQueries({ queryKey: documentKeys.signatures(document.id) })
      void client.invalidateQueries({ queryKey: documentKeys.versions(document.id) })
      refresh()
      onClose()
    },
    onError: (error) =>
      toast.error(error instanceof Error && error.message ? error.message : t('errors.unknown')),
  })

  const pick = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const clamp = (value: number) => Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000))
    setPoint({
      x: clamp((event.clientX - box.left) / box.width),
      y: clamp((event.clientY - box.top) / box.height),
    })
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={t('documents.signatures.placeTitle')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!point}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Callout tone="info">{t('documents.signatures.placeHint')}</Callout>
          {pages.length > 1 ? (
            <div className="flex flex-wrap gap-1">
              {pages.map((item) => {
                const number = item.page ?? 0
                return (
                  <Button
                    key={number}
                    size="sm"
                    variant={number === current ? 'primary' : 'ghost'}
                    aria-pressed={number === current}
                    onClick={() => {
                      setPage(number)
                      setPoint(null)
                    }}
                  >
                    {t('documents.signatures.page', { page: number })}
                  </Button>
                )
              })}
            </div>
          ) : null}
          {previews.isLoading ? (
            <Skeleton className="mx-auto h-[60vh] w-full max-w-[520px]" />
          ) : image ? (
            <button
              type="button"
              onClick={pick}
              aria-label={t('documents.signatures.placeOnPage')}
              className="relative mx-auto block w-full max-w-[520px] cursor-crosshair border border-line"
            >
              <img src={image.url} alt="" className="block w-full" draggable={false} />
              {point ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-accent-subtle"
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                />
              ) : null}
            </button>
          ) : (
            <p className="text-sm text-fg-muted">{t('documents.viewer.empty')}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
