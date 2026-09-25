import { BRAND_ACCENTS, BRAND_LOGO_MAX_BYTES, type Branding } from '@kchs/contracts'
import { Button, Callout, Card, cn, Field, Input, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { brandingQuery } from '~/shared/api/branding.js'
import { ApiError, http } from '~/shared/api/client.js'
import { HelpCard } from './help-card.js'

/** Типы, которые принимает настройка логотипа (контракт `Branding`). */
const LOGO_TYPES = 'image/png,image/jpeg,image/webp,image/svg+xml'

/**
 * Брендирование (15-admin-operations.md §1): название, короткое название,
 * логотип, акцентный цвет и приписка на экране входа. Логотип хранится
 * значением настройки — он нужен и до входа, когда файлы ещё недоступны.
 */
export function BrandingSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const { data } = useQuery(brandingQuery())
  const [draft, setDraft] = useState<Branding | null>(null)
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: (next: Branding) => http.patch<Branding>('/admin/branding', next),
    onSuccess: (saved) => {
      client.setQueryData(brandingQuery().queryKey, saved)
      setDraft(null)
      toast.show({ title: t('admin.branding.saved'), tone: 'success' })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const value = draft ?? data
  if (!value) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
        <Skeleton className="h-48" />
      </div>
    )
  }

  const update = (patch: Partial<Branding>) => setDraft({ ...value, ...patch })

  const pickLogo = async (file: File) => {
    setError('')
    const logo = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    if (logo.length > BRAND_LOGO_MAX_BYTES) {
      setError(t('admin.branding.logoTooBig'))
      return
    }
    update({ logo })
  }

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
      <Card title={t('admin.branding.title')}>
        <p className="text-xs text-fg-secondary">{t('admin.branding.hint')}</p>
        <div className="mt-3 flex flex-col gap-3">
          <Field label={t('admin.branding.name')} hint={t('admin.branding.nameHint')}>
            <Input
              value={value.name}
              maxLength={120}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field label={t('admin.branding.shortName')} hint={t('admin.branding.shortNameHint')}>
            <Input
              value={value.shortName}
              maxLength={40}
              onChange={(event) => update({ shortName: event.target.value })}
            />
          </Field>
          <Field label={t('admin.branding.loginNote')} hint={t('admin.branding.loginNoteHint')}>
            <Input
              value={value.loginNote}
              maxLength={400}
              onChange={(event) => update({ loginNote: event.target.value })}
            />
          </Field>
        </div>
      </Card>

      <Card title={t('admin.branding.logo')}>
        <p className="text-xs text-fg-secondary">{t('admin.branding.logoHint')}</p>
        {error ? (
          <Callout tone="danger" className="mt-2">
            {error}
          </Callout>
        ) : null}
        <div className="mt-3 flex items-center gap-3">
          <div className="flex size-14 items-center justify-center overflow-hidden rounded-md border border-line bg-surface-2">
            {value.logo ? (
              <img src={value.logo} alt="" className="size-full object-contain" />
            ) : (
              <span className="text-2xs text-fg-muted">{t('admin.branding.noLogo')}</span>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
            {t('admin.branding.pickLogo')}
          </Button>
          {value.logo ? (
            <Button size="sm" variant="ghost" onClick={() => update({ logo: null })}>
              {t('admin.branding.removeLogo')}
            </Button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept={LOGO_TYPES}
            className="hidden"
            aria-label={t('admin.branding.pickLogo')}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void pickLogo(file)
            }}
          />
        </div>
      </Card>

      <Card title={t('admin.branding.accent')}>
        <p className="text-xs text-fg-secondary">{t('admin.branding.accentHint')}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {BRAND_ACCENTS.map((accent) => (
            <button
              key={accent}
              type="button"
              data-accent={accent === 'blue' ? undefined : accent}
              aria-pressed={value.accent === accent}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                value.accent === accent
                  ? 'border-accent bg-accent-subtle text-fg'
                  : 'border-line text-fg-secondary hover:bg-surface-2',
              )}
              onClick={() => update({ accent })}
            >
              <span className="size-3.5 rounded-full bg-accent" aria-hidden />
              {t(`admin.branding.accents.${accent}`)}
            </button>
          ))}
        </div>
      </Card>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          disabled={!draft}
          loading={save.isPending}
          onClick={() => draft && save.mutate(draft)}
        >
          {t('common.actions.save')}
        </Button>
        {draft ? (
          <Button variant="ghost" onClick={() => setDraft(null)}>
            {t('common.actions.cancel')}
          </Button>
        ) : null}
      </div>

      <HelpCard />
    </div>
  )
}
