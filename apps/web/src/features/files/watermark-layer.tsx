import { cn } from '@kchs/ui'

/**
 * Водяной знак поверх страниц (08-documents.md §13, ADR-0085): строки — гриф,
 * кто смотрит, когда (их выдаёт сервер вместе с превью файла с грифом) или
 * метка гостевой ссылки. Плитка по всей области, клики проходят насквозь.
 */
export function WatermarkLayer({
  lines,
  tone = 'muted',
}: {
  lines: string[]
  /** `danger` — гриф документа, `muted` — гостевая ссылка. */
  tone?: 'muted' | 'danger'
}) {
  return (
    <div
      aria-hidden
      data-watermark={lines.join(' · ')}
      className={cn(
        'pointer-events-none absolute inset-0 flex select-none flex-wrap content-center justify-center gap-x-12 gap-y-20 overflow-hidden -rotate-12 font-medium',
        tone === 'danger' ? 'text-sm text-danger/20' : 'text-sm text-fg/10',
      )}
    >
      {Array.from({ length: 24 }, (_, index) => (
        <span key={index} className="flex flex-col items-center text-center leading-tight">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      ))}
    </div>
  )
}
