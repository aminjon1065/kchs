import {
  INTEGRATION_KINDS,
  type Integration,
  type IntegrationCheckResult,
  type IntegrationKind,
  type Webhook,
  type WebhookStatus,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cable, Plus, Webhook as WebhookIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import {
  integrationsQuery,
  keys,
  webhookDeliveriesQuery,
  webhooksQuery,
} from '~/shared/api/queries.js'

const STATUS_TONES: Record<Integration['status'], 'success' | 'danger' | 'neutral'> = {
  ok: 'success',
  error: 'danger',
  unknown: 'neutral',
  disabled: 'neutral',
}

const HOOK_TONES: Record<WebhookStatus, 'success' | 'warning' | 'danger'> = {
  active: 'success',
  paused: 'warning',
  disabled: 'danger',
}

/**
 * «Интеграции» в администрировании (14-automation-integrations.md §4–§5,
 * ADR-0097): интеграции установки с проверкой соединения и входящим вебхуком,
 * исходящие вебхуки с журналом доставок и ручным повтором.
 */
export function IntegrationsSection() {
  const t = useT()
  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-4 p-5">
      <p className="text-sm text-fg-secondary">{t('admin.integrations.hint')}</p>
      <IntegrationsList />
      <WebhooksList />
    </div>
  )
}

function IntegrationsList() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data: items = [], isLoading } = useQuery(integrationsQuery())
  const [creating, setCreating] = useState(false)
  const [inbound, setInbound] = useState<{ url: string } | null>(null)

  const refresh = () => void client.invalidateQueries({ queryKey: keys.integrations })

  const check = useMutation({
    mutationFn: (item: Integration) =>
      item.source === 'env'
        ? http.post<IntegrationCheckResult>(`/integrations/builtin/${item.key}/check`)
        : http.post<IntegrationCheckResult>(`/integrations/${item.id}/check`),
    onSuccess: (result) =>
      toast.show({ title: result.message, tone: result.ok ? 'success' : 'danger' }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
    onSettled: refresh,
  })

  const issueInbound = useMutation({
    mutationFn: (id: string) =>
      http.post<{ url: string; secret: string }>(`/integrations/${id}/inbound-secret`),
    onSuccess: (result) => {
      setInbound({ url: result.url })
      refresh()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Card
      title={t('admin.integrations.title')}
      padded={false}
      action={
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => setCreating(true)}
        >
          {t('admin.integrations.create')}
        </Button>
      }
    >
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState compact icon={<Cable />} title={t('admin.integrations.empty')} />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{item.name}</span>
                  <Badge tone={STATUS_TONES[item.status]} size="sm" dot>
                    {t(`admin.integrations.statuses.${item.status}`)}
                  </Badge>
                  <Badge tone="neutral" size="sm">
                    {t(`admin.integrations.kinds.${item.kind}`)}
                  </Badge>
                  {item.source === 'env' ? (
                    <Badge tone="accent" size="sm">
                      {t('admin.integrations.builtin')}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-fg-secondary">{item.description ?? ''}</p>
                <p className="mt-1 text-xs text-fg-muted">
                  <code>{item.key}</code>
                  {item.secretKeys.length > 0
                    ? ` · ${t('admin.integrations.secrets', { names: item.secretKeys.join(', ') })}`
                    : ''}
                  {item.lastCheckAt
                    ? ` · ${t('admin.integrations.checkedAt', {
                        date: formatDateTime(item.lastCheckAt, { locale }),
                      })}`
                    : ''}
                </p>
                {item.statusMessage ? (
                  <p className="mt-1 text-xs text-fg-muted">{item.statusMessage}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={check.isPending && check.variables?.id === item.id}
                  onClick={() => check.mutate(item)}
                >
                  {t('admin.integrations.check')}
                </Button>
                {item.source === 'object' ? (
                  <Button variant="ghost" size="sm" onClick={() => issueInbound.mutate(item.id)}>
                    {t('admin.integrations.inbound')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <CreateIntegrationDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          setCreating(false)
          toast.show({ title: t('admin.integrations.created'), tone: 'success' })
          refresh()
        }}
      />

      <Dialog
        open={inbound !== null}
        onOpenChange={(next) => (next ? undefined : setInbound(null))}
      >
        <DialogContent
          title={t('admin.integrations.inboundTitle')}
          size="md"
          footer={
            <Button variant="primary" onClick={() => setInbound(null)}>
              {t('common.actions.close')}
            </Button>
          }
        >
          <Callout tone="warning">{t('admin.integrations.inboundHint')}</Callout>
          <code className="mt-3 block rounded-md bg-surface-sunken px-3 py-2 text-xs break-all">
            {inbound?.url}
          </code>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function CreateIntegrationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const t = useT()
  const formId = useId()
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<IntegrationKind>('http')
  const [config, setConfig] = useState('{\n  "url": "https://"\n}')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(config) as Record<string, unknown>
      } catch {
        throw new Error(t('admin.integrations.badJson'))
      }
      return http.post<Integration>('/integrations', { key, kind, name, config: parsed })
    },
    onSuccess: () => {
      setKey('')
      setName('')
      setError(null)
      onCreated()
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : (err as Error).message || t('errors.unknown'),
      ),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('admin.integrations.create')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              loading={create.isPending}
              disabled={key.trim().length === 0 || name.trim().length === 0}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('admin.integrations.fields.key')} hint={t('admin.integrations.keyHint')}>
            <Input value={key} onChange={(event) => setKey(event.target.value)} maxLength={64} />
          </Field>
          <Field label={t('admin.integrations.fields.name')} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} />
          </Field>
          <Field label={t('admin.integrations.fields.kind')}>
            <Select value={kind} onValueChange={(next) => setKind(next as IntegrationKind)}>
              <SelectTrigger aria-label={t('admin.integrations.fields.kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTEGRATION_KINDS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`admin.integrations.kinds.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={t('admin.integrations.fields.config')}
            hint={t('admin.integrations.configHint')}
          >
            <Textarea value={config} onChange={(event) => setConfig(event.target.value)} rows={5} />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function WebhooksList() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data: items = [], isLoading } = useQuery(webhooksQuery())
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [opened, setOpened] = useState<Webhook | null>(null)
  const [removing, setRemoving] = useState<Webhook | null>(null)

  const refresh = () => void client.invalidateQueries({ queryKey: keys.webhooks })

  const toggle = useMutation({
    mutationFn: (item: Webhook) =>
      http.patch<Webhook>(`/webhooks/${item.id}`, {
        status: item.status === 'active' ? 'paused' : 'active',
      }),
    onSuccess: refresh,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const remove = useMutation({
    mutationFn: (id: string) => http.delete(`/webhooks/${id}`),
    onSuccess: () => {
      setRemoving(null)
      refresh()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Card
      title={t('admin.webhooks.title')}
      padded={false}
      action={
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => setCreating(true)}
        >
          {t('admin.webhooks.create')}
        </Button>
      }
    >
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState compact icon={<WebhookIcon />} title={t('admin.webhooks.empty')} />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{item.name}</span>
                  <Badge tone={HOOK_TONES[item.status]} size="sm" dot>
                    {t(`admin.webhooks.statuses.${item.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-fg-muted break-all">{item.url}</p>
                <p className="mt-1 text-xs text-fg-muted">
                  {item.eventTypes.join(', ')}
                  {item.lastDeliveryAt
                    ? ` · ${t('admin.webhooks.lastDelivery', {
                        date: formatDateTime(item.lastDeliveryAt, { locale }),
                      })}`
                    : ''}
                  {item.failureStreak > 0
                    ? ` · ${t('admin.webhooks.failures', { count: item.failureStreak })}`
                    : ''}
                </p>
                {item.disabledReason ? (
                  <p className="mt-1 text-xs text-fg-muted">{t('admin.webhooks.disabledReason')}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setOpened(item)}>
                  {t('admin.webhooks.deliveries')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => toggle.mutate(item)}>
                  {item.status === 'active'
                    ? t('admin.webhooks.pause')
                    : t('admin.webhooks.resume')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(item)}>
                  {t('common.actions.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CreateWebhookDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(value) => {
          setCreating(false)
          setSecret(value)
          refresh()
        }}
      />

      <Dialog open={secret !== null} onOpenChange={(next) => (next ? undefined : setSecret(null))}>
        <DialogContent
          title={t('admin.webhooks.secretTitle')}
          size="md"
          footer={
            <Button variant="primary" onClick={() => setSecret(null)}>
              {t('common.actions.close')}
            </Button>
          }
        >
          <Callout tone="warning">{t('admin.webhooks.secretHint')}</Callout>
          <code className="mt-3 block rounded-md bg-surface-sunken px-3 py-2 text-xs break-all">
            {secret}
          </code>
        </DialogContent>
      </Dialog>

      <DeliveriesDialog webhook={opened} onClose={() => setOpened(null)} />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => (next ? undefined : setRemoving(null))}
        title={t('admin.webhooks.deleteTitle', { name: removing?.name ?? '' })}
        description={t('admin.webhooks.deleteHint')}
        confirmLabel={t('common.actions.delete')}
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
        }}
      />
    </Card>
  )
}

function CreateWebhookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (secret: string) => void
}) {
  const t = useT()
  const formId = useId()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('https://')
  const [types, setTypes] = useState('document.*, task.*')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      http.post<{ webhook: Webhook; secret: string }>('/webhooks', {
        name,
        url,
        eventTypes: types
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      }),
    onSuccess: (result) => {
      setName('')
      setError(null)
      onCreated(result.secret)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('admin.webhooks.create')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              loading={create.isPending}
              disabled={name.trim().length === 0}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('admin.webhooks.fields.name')} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} />
          </Field>
          <Field label={t('admin.webhooks.fields.url')} hint={t('admin.webhooks.urlHint')}>
            <Input value={url} onChange={(event) => setUrl(event.target.value)} />
          </Field>
          <Field label={t('admin.webhooks.fields.events')} hint={t('admin.webhooks.eventsHint')}>
            <Input value={types} onChange={(event) => setTypes(event.target.value)} />
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeliveriesDialog({ webhook, onClose }: { webhook: Webhook | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data: items = [], isLoading } = useQuery({
    ...webhookDeliveriesQuery(webhook?.id ?? ''),
    enabled: webhook !== null,
  })

  const retry = useMutation({
    mutationFn: (deliveryId: string) =>
      http.post(`/webhooks/${webhook?.id}/deliveries/${deliveryId}/retry`),
    onSuccess: () => {
      toast.show({ title: t('admin.webhooks.retried'), tone: 'info' })
      if (webhook) {
        void client.invalidateQueries({ queryKey: keys.webhookDeliveries(webhook.id) })
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Dialog open={webhook !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        title={t('admin.webhooks.deliveriesTitle', { name: webhook?.name ?? '' })}
        size="lg"
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('common.actions.close')}
          </Button>
        }
      >
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : items.length === 0 ? (
          <EmptyState compact icon={<WebhookIcon />} title={t('admin.webhooks.noDeliveries')} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs">{item.eventType}</code>
                    <Badge
                      tone={
                        item.status === 'delivered'
                          ? 'success'
                          : item.status === 'pending'
                            ? 'warning'
                            : 'danger'
                      }
                      size="sm"
                    >
                      {t(`admin.webhooks.deliveryStatuses.${item.status}`)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    {formatDateTime(item.createdAt, { locale })}
                    {` · ${t('admin.webhooks.attempts', { count: item.attempts })}`}
                    {item.responseStatus !== null ? ` · ${item.responseStatus}` : ''}
                    {item.error ? ` · ${item.error}` : ''}
                  </p>
                </div>
                {item.status !== 'delivered' ? (
                  <Button variant="ghost" size="sm" onClick={() => retry.mutate(item.id)}>
                    {t('admin.webhooks.retry')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
