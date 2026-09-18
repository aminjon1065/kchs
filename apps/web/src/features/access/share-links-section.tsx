import type { ShareLink, ShareLinkCreated } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  IconButton,
  Input,
  PasswordInput,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, Lock, Plus, Unlink } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery, shareLinksQuery } from '~/shared/api/queries.js'

interface Draft {
  password: string
  expiresOn: string
  maxUses: string
  includeAttachments: boolean
}

const EMPTY: Draft = { password: '', expiresOn: '', maxUses: '', includeAttachments: false }

/** Дата поля «до» — действует до конца выбранного дня. */
const endOfDay = (date: string) => new Date(`${date}T23:59:59`).toISOString()
const today = () => new Date().toISOString().slice(0, 10)

/**
 * Гостевые ссылки объекта (03-access-model.md §Гостевые ссылки): просмотр одного
 * объекта без входа, с паролем, сроком и лимитом открытий. Токен хранится только
 * хешем — адрес показывается один раз, сразу после создания.
 */
export function ShareLinksSection({ objectId }: { objectId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const formId = useId()
  const { data: me } = useQuery(meQuery())
  const { data, isError } = useQuery(shareLinksQuery(objectId))
  const [draft, setDraft] = useState<Draft | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canCreate = me?.capabilities.includes('share_links.create') ?? false
  const refresh = () => void client.invalidateQueries({ queryKey: keys.shareLinks(objectId) })

  const create = useMutation({
    mutationFn: (input: Draft) =>
      http.post<ShareLinkCreated>(`/objects/${objectId}/share-links`, {
        level: 'view',
        password: input.password || null,
        expiresAt: input.expiresOn ? endOfDay(input.expiresOn) : null,
        maxUses: input.maxUses ? Number(input.maxUses) : null,
        includeAttachments: input.includeAttachments,
      }),
    onSuccess: (result) => {
      setDraft(null)
      setError(null)
      setCreated(result.url)
      refresh()
    },
    onError: (err) =>
      setError(
        err instanceof ApiError && err.code === 'policy_violation'
          ? t('access.share.linkDisabledByPolicy')
          : err instanceof ApiError
            ? err.message
            : t('errors.unknown'),
      ),
  })

  const revoke = useMutation({
    mutationFn: (linkId: string) => http.delete(`/objects/${objectId}/share-links/${linkId}`),
    onSuccess: () => {
      toast.show({ title: t('access.share.linkRevoked'), tone: 'success' })
      refresh()
    },
    onError: () => toast.error(t('errors.forbidden')),
  })

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url)
    toast.show({ title: t('access.share.linkCopied'), tone: 'success' })
  }

  // Без права «Управление» ссылок объекта не видно — раздел не показываем
  if (isError) return null
  const links = data?.items ?? []
  const allowed = data?.allowed ?? true

  const describe = (link: ShareLink) =>
    [
      link.hasPassword ? t('access.share.linkWithPassword') : null,
      link.expiresAt
        ? t('access.share.linkUntil', { date: formatDate(link.expiresAt, { locale }) })
        : t('access.share.linkNoExpiry'),
      link.maxUses
        ? t('access.share.linkUsesOf', { uses: link.uses, max: link.maxUses })
        : t('access.share.linkUses', { uses: link.uses }),
      link.includeAttachments ? t('access.share.linkWithAttachments') : null,
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <section
      aria-labelledby={`${formId}-title`}
      className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-3"
    >
      <div className="flex items-center gap-2">
        <Link2 className="size-4 text-fg-muted" aria-hidden />
        <h3 id={`${formId}-title`} className="text-sm font-medium text-fg">
          {t('access.share.linkSection')}
        </h3>
        <span className="ml-auto text-xs text-fg-muted">
          {links.length > 0 && allowed ? t('access.share.linkOn') : t('access.share.linkOff')}
        </span>
      </div>
      <p className="text-xs text-fg-muted">{t('access.share.guestLinkHint')}</p>

      {!allowed ? <Callout tone="warning">{t('access.share.linkDisabledByPolicy')}</Callout> : null}

      {created ? (
        <Callout tone="success">
          <div className="flex flex-col gap-2">
            <span>{t('access.share.linkCreated')}</span>
            <div className="flex items-center gap-1.5">
              <Input
                readOnly
                value={created}
                aria-label={t('access.share.linkAddress')}
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <IconButton label={t('common.actions.copyLink')} onClick={() => void copy(created)}>
                <Copy className="size-4" />
              </IconButton>
            </div>
          </div>
        </Callout>
      ) : null}

      {links.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-sm border border-line bg-surface">
          {links.map((link) => (
            <li key={link.id} className="flex items-center gap-2 px-2.5 py-2">
              {link.hasPassword ? (
                <Lock className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
              ) : (
                <Link2 className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
              )}
              <span className="min-w-0 flex-1 text-xs text-fg-secondary">{describe(link)}</span>
              {link.maxUses !== null && link.uses >= link.maxUses ? (
                <Badge size="sm">{t('access.share.linkExhausted')}</Badge>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                icon={<Unlink className="size-3.5" />}
                loading={revoke.isPending && revoke.variables === link.id}
                onClick={() => revoke.mutate(link.id)}
              >
                {t('access.share.linkRevoke')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {draft ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate(draft)
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label={t('access.share.linkPassword')}
              hint={t('access.share.linkPasswordHint')}
              htmlFor={`${formId}-password`}
            >
              <PasswordInput
                id={`${formId}-password`}
                autoComplete="new-password"
                value={draft.password}
                onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              />
            </Field>
            <Field label={t('access.share.linkExpires')} htmlFor={`${formId}-expires`}>
              <Input
                id={`${formId}-expires`}
                type="date"
                min={today()}
                value={draft.expiresOn}
                onChange={(event) => setDraft({ ...draft, expiresOn: event.target.value })}
              />
            </Field>
            <Field label={t('access.share.linkMaxUses')} htmlFor={`${formId}-uses`}>
              <Input
                id={`${formId}-uses`}
                type="number"
                inputMode="numeric"
                min={1}
                value={draft.maxUses}
                onChange={(event) => setDraft({ ...draft, maxUses: event.target.value })}
              />
            </Field>
          </div>
          <Checkbox
            id={`${formId}-attachments`}
            checked={draft.includeAttachments}
            onCheckedChange={(next) => setDraft({ ...draft, includeAttachments: next === true })}
            label={t('access.share.linkAttachments')}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={draft.password.length > 0 && draft.password.length < 4}
              loading={create.isPending}
            >
              {t('access.share.linkCreate')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      ) : canCreate && allowed ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() => {
              setCreated(null)
              setDraft(EMPTY)
            }}
          >
            {t('access.share.linkCreate')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
