import type { ServiceLayerKind, ServiceLayerParams, ServiceLayerRecord } from '@kchs/contracts'
import { SERVICE_LAYER_KINDS } from '@kchs/contracts'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  PasswordInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Globe2, MoreHorizontal, Pencil, Plug, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import {
  serviceLayerApi,
  serviceLayerKeys,
  serviceLayersQuery,
} from '~/features/gis/service-layers.js'
import { ApiError } from '~/shared/api/client.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'

const KIND_TONES: Record<ServiceLayerKind, 'accent' | 'purple' | 'warning'> = {
  xyz: 'purple',
  wms: 'warning',
  wmts: 'warning',
  wfs: 'accent',
  arcgis: 'accent',
}

const VECTOR_KINDS = new Set<ServiceLayerKind>(['wfs', 'arcgis'])

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
}

/**
 * «Внешние ГИС-службы» (07-gis-engine.md §5, §8; ADR-0108): реестр слоёв-ссылок
 * установки. Растровые службы рисуются на карте тайлами через прокси, векторные
 * отдают объекты и разово выгружаются в файл для обычного геоимпорта. Ключ
 * доступа после сохранения не показывается.
 */
export function GisServicesSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const { data, isLoading } = useQuery(serviceLayersQuery())
  const items = data?.items ?? []
  const [editing, setEditing] = useState<ServiceLayerRecord | 'new' | null>(null)
  const [removing, setRemoving] = useState<ServiceLayerRecord | null>(null)
  const [importing, setImporting] = useState<ServiceLayerRecord | null>(null)

  const refresh = () => void client.invalidateQueries({ queryKey: serviceLayerKeys.all })
  const failed = (err: unknown) => toast.error(problemMessage(err, t('errors.unknown')))

  const check = useMutation({
    mutationFn: (id: string) => serviceLayerApi.check(id),
    onSuccess: (result) => {
      toast.show({
        title: result.ok ? t('admin.gisServices.checkOk') : t('admin.gisServices.checkFailed'),
        description: result.message,
        tone: result.ok ? 'success' : 'danger',
      })
      refresh()
    },
    onError: failed,
  })

  const remove = useMutation({
    mutationFn: (id: string) => serviceLayerApi.remove(id),
    onSuccess: () => {
      toast.show({ title: t('admin.gisServices.removed'), tone: 'info' })
      setRemoving(null)
      refresh()
    },
    onError: (err) => {
      setRemoving(null)
      failed(err)
    },
  })

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-secondary">{t('admin.gisServices.hint')}</p>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => setEditing('new')}
        >
          {t('admin.gisServices.add')}
        </Button>
      </div>
      <Card padded={false}>
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={<Globe2 />} title={t('admin.gisServices.empty')} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((service) => (
              <li key={service.id} className="flex items-start gap-3 px-4 py-3">
                <Globe2 className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{service.name}</span>
                    <Badge tone={KIND_TONES[service.kind]} size="sm">
                      {t(`admin.gisServices.kinds.${service.kind}`)}
                    </Badge>
                    {service.status !== 'unknown' ? (
                      <Badge tone={service.status === 'ok' ? 'success' : 'danger'} size="sm" dot>
                        {t(`admin.gisServices.status.${service.status}`)}
                      </Badge>
                    ) : null}
                    {service.hasKey ? (
                      <Badge tone="neutral" size="sm">
                        {t('admin.gisServices.keySet')}
                      </Badge>
                    ) : null}
                  </div>
                  {service.url ? (
                    <p className="mt-1 truncate font-mono text-xs text-fg-muted">{service.url}</p>
                  ) : null}
                  {service.statusMessage ? (
                    <p className="mt-1 text-xs text-fg-secondary">{service.statusMessage}</p>
                  ) : null}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      size="sm"
                      label={t('admin.gisServices.actions', { name: service.name })}
                    >
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      icon={<Plug className="size-4" />}
                      onSelect={() => check.mutate(service.id)}
                    >
                      {t('admin.gisServices.check')}
                    </DropdownMenuItem>
                    {VECTOR_KINDS.has(service.kind) ? (
                      <DropdownMenuItem
                        icon={<Download className="size-4" />}
                        onSelect={() => setImporting(service)}
                      >
                        {t('admin.gisServices.import')}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      icon={<Pencil className="size-4" />}
                      onSelect={() => setEditing(service)}
                    >
                      {t('common.actions.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      danger
                      icon={<Trash2 className="size-4" />}
                      onSelect={() => setRemoving(service)}
                    >
                      {t('common.actions.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ServiceDialog
        service={editing}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        onSaved={(created) => {
          toast.show({
            title: created ? t('admin.gisServices.created') : t('admin.gisServices.saved'),
            tone: 'success',
          })
          refresh()
        }}
      />
      <ImportDialog
        service={importing}
        onOpenChange={(open) => (open ? undefined : setImporting(null))}
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => (next ? undefined : setRemoving(null))}
        title={t('admin.gisServices.removeTitle', { name: removing?.name ?? '' })}
        description={t('admin.gisServices.removeHint')}
        confirmLabel={t('common.actions.delete')}
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
        }}
      />
    </div>
  )
}

interface Form {
  name: string
  kind: ServiceLayerKind
  url: string
  apiKey: string
  clearKey: boolean
  attribution: string
  minZoom: string
  maxZoom: string
  /** WMS. */
  layers: string
  /** WMTS. */
  layer: string
  tileMatrixSet: string
  tileMatrix: string
  /** WFS. */
  typeName: string
  /** ArcGIS REST. */
  arcgisLayer: string
  where: string
}

function initial(service: ServiceLayerRecord | null): Form {
  const params = service?.params
  return {
    name: service?.name ?? '',
    kind: service?.kind ?? 'wms',
    url: service?.url ?? '',
    apiKey: '',
    clearKey: false,
    attribution: service?.attribution ?? '',
    minZoom: String(service?.minZoom ?? 0),
    maxZoom: String(service?.maxZoom ?? 19),
    layers: params?.kind === 'wms' ? params.layers : '',
    layer: params?.kind === 'wmts' ? params.layer : '',
    tileMatrixSet: params?.kind === 'wmts' ? params.tileMatrixSet : 'GoogleMapsCompatible',
    tileMatrix: params?.kind === 'wmts' ? params.tileMatrix : '{z}',
    typeName: params?.kind === 'wfs' ? params.typeName : '',
    arcgisLayer: params?.kind === 'arcgis' ? String(params.layer) : '0',
    where: params?.kind === 'arcgis' ? params.where : '1=1',
  }
}

function paramsOf(form: Form): ServiceLayerParams {
  switch (form.kind) {
    case 'wms':
      return {
        kind: 'wms',
        layers: form.layers.trim(),
        version: '1.3.0',
        format: 'image/png',
        styles: '',
        transparent: true,
      }
    case 'wmts':
      return {
        kind: 'wmts',
        layer: form.layer.trim(),
        tileMatrixSet: form.tileMatrixSet.trim() || 'GoogleMapsCompatible',
        style: 'default',
        format: 'image/png',
        tileMatrix: form.tileMatrix.trim() || '{z}',
      }
    case 'wfs':
      return { kind: 'wfs', typeName: form.typeName.trim(), version: '2.0.0', cql: '' }
    case 'arcgis':
      return {
        kind: 'arcgis',
        layer: Number(form.arcgisLayer) || 0,
        where: form.where.trim() || '1=1',
        outFields: '*',
      }
    default:
      return { kind: 'xyz' }
  }
}

/** Добавление и правка слоя-ссылки: поля зависят от вида службы. */
function ServiceDialog({
  service,
  onOpenChange,
  onSaved,
}: {
  service: ServiceLayerRecord | 'new' | null
  onOpenChange: (open: boolean) => void
  onSaved: (created: boolean) => void
}) {
  const t = useT()
  const formId = useId()
  const current = service === 'new' ? null : service
  const [form, setForm] = useState<Form>(() => initial(current))
  const [opened, setOpened] = useState<ServiceLayerRecord | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (service !== opened) {
    setOpened(service)
    setForm(initial(current))
    setError(null)
  }
  const set = (patch: Partial<Form>) => setForm((value) => ({ ...value, ...patch }))

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        name: form.name.trim(),
        kind: form.kind,
        url: form.url.trim(),
        params: paramsOf(form),
        attribution: form.attribution.trim() || null,
        minZoom: Number(form.minZoom),
        maxZoom: Number(form.maxZoom),
      }
      if (!current) {
        await serviceLayerApi.create({
          ...common,
          opacity: 1,
          tileSize: 256,
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        })
        return true
      }
      await serviceLayerApi.update(current.id, {
        ...common,
        ...(form.clearKey
          ? { apiKey: null }
          : form.apiKey.trim()
            ? { apiKey: form.apiKey.trim() }
            : {}),
      })
      return false
    },
    onSuccess: (created) => {
      onSaved(created)
      onOpenChange(false)
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  const valid =
    form.name.trim().length > 0 &&
    form.url.trim().length > 0 &&
    (form.kind !== 'wms' || form.layers.trim().length > 0) &&
    (form.kind !== 'wmts' || form.layer.trim().length > 0) &&
    (form.kind !== 'wfs' || form.typeName.trim().length > 0)

  return (
    <Dialog open={service !== null} onOpenChange={onOpenChange}>
      <DialogContent
        title={
          current
            ? t('admin.gisServices.editTitle', { name: current.name })
            : t('admin.gisServices.add')
        }
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!valid}
              loading={save.isPending}
            >
              {current ? t('common.actions.save') : t('admin.gisServices.add')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) save.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('admin.gisServices.fields.name')} htmlFor={`${formId}-name`} required>
            <Input
              id={`${formId}-name`}
              maxLength={200}
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          </Field>
          {!current ? (
            <Field label={t('admin.gisServices.fields.kind')} htmlFor={`${formId}-kind`}>
              <Select
                value={form.kind}
                onValueChange={(value) => set({ kind: value as ServiceLayerKind })}
              >
                <SelectTrigger id={`${formId}-kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVICE_LAYER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`admin.gisServices.kinds.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field
            label={t('admin.gisServices.fields.url')}
            htmlFor={`${formId}-url`}
            hint={
              form.kind === 'xyz'
                ? t('admin.basemaps.fields.urlHint')
                : t('admin.gisServices.fields.urlHint')
            }
            required
          >
            <Input
              id={`${formId}-url`}
              className="font-mono"
              maxLength={2000}
              value={form.url}
              onChange={(event) => set({ url: event.target.value })}
            />
          </Field>
          {form.kind === 'wms' ? (
            <Field label={t('admin.basemaps.fields.layers')} htmlFor={`${formId}-layers`} required>
              <Input
                id={`${formId}-layers`}
                className="font-mono"
                maxLength={500}
                value={form.layers}
                onChange={(event) => set({ layers: event.target.value })}
              />
            </Field>
          ) : null}
          {form.kind === 'wmts' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('admin.basemaps.fields.layer')} htmlFor={`${formId}-layer`} required>
                <Input
                  id={`${formId}-layer`}
                  className="font-mono"
                  maxLength={300}
                  value={form.layer}
                  onChange={(event) => set({ layer: event.target.value })}
                />
              </Field>
              <Field label={t('admin.basemaps.fields.matrixSet')} htmlFor={`${formId}-tms`}>
                <Input
                  id={`${formId}-tms`}
                  className="font-mono"
                  maxLength={200}
                  value={form.tileMatrixSet}
                  onChange={(event) => set({ tileMatrixSet: event.target.value })}
                />
              </Field>
            </div>
          ) : null}
          {form.kind === 'wfs' ? (
            <Field
              label={t('admin.gisServices.fields.typeName')}
              htmlFor={`${formId}-type`}
              required
            >
              <Input
                id={`${formId}-type`}
                className="font-mono"
                maxLength={300}
                value={form.typeName}
                onChange={(event) => set({ typeName: event.target.value })}
              />
            </Field>
          ) : null}
          {form.kind === 'arcgis' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('admin.gisServices.fields.arcgisLayer')} htmlFor={`${formId}-alayer`}>
                <Input
                  id={`${formId}-alayer`}
                  type="number"
                  min={0}
                  value={form.arcgisLayer}
                  onChange={(event) => set({ arcgisLayer: event.target.value })}
                />
              </Field>
              <Field label={t('admin.gisServices.fields.where')} htmlFor={`${formId}-where`}>
                <Input
                  id={`${formId}-where`}
                  className="font-mono"
                  maxLength={2000}
                  value={form.where}
                  onChange={(event) => set({ where: event.target.value })}
                />
              </Field>
            </div>
          ) : null}
          <Field
            label={t('admin.basemaps.fields.apiKey')}
            htmlFor={`${formId}-key`}
            hint={
              current?.hasKey
                ? t('admin.basemaps.fields.apiKeyKeep')
                : t('admin.gisServices.fields.apiKeyHint')
            }
          >
            <PasswordInput
              id={`${formId}-key`}
              autoComplete="off"
              maxLength={500}
              disabled={form.clearKey}
              value={form.apiKey}
              onChange={(event) => set({ apiKey: event.target.value })}
            />
          </Field>
          {current?.hasKey ? (
            <Checkbox
              label={t('admin.basemaps.fields.clearKey')}
              checked={form.clearKey}
              onCheckedChange={(checked) => set({ clearKey: checked === true, apiKey: '' })}
            />
          ) : null}
          <Field label={t('admin.basemaps.fields.attribution')} htmlFor={`${formId}-attr`}>
            <Input
              id={`${formId}-attr`}
              maxLength={500}
              value={form.attribution}
              onChange={(event) => set({ attribution: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('admin.basemaps.fields.minZoom')} htmlFor={`${formId}-min`}>
              <Input
                id={`${formId}-min`}
                type="number"
                min={0}
                max={24}
                value={form.minZoom}
                onChange={(event) => set({ minZoom: event.target.value })}
              />
            </Field>
            <Field label={t('admin.basemaps.fields.maxZoom')} htmlFor={`${formId}-max`}>
              <Input
                id={`${formId}-max`}
                type="number"
                min={0}
                max={24}
                value={form.maxZoom}
                onChange={(event) => set({ maxZoom: event.target.value })}
              />
            </Field>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Разовая выгрузка объектов службы в файл: дальше — обычный мастер импорта. */
function ImportDialog({
  service,
  onOpenChange,
}: {
  service: ServiceLayerRecord | null
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const toast = useToast()
  const [limit, setLimit] = useState('50000')
  const [spaceId, setSpaceId] = useState('')
  const { data: spaces = [] } = useQuery(spacesQuery())
  const available = orderSpaces(spaces)
  const target = spaceId || available[0]?.id || ''

  const start = useMutation({
    mutationFn: (id: string) =>
      serviceLayerApi.startImport(id, { spaceId: target, limit: Number(limit) }),
    onSuccess: () => {
      toast.show({ title: t('admin.gisServices.importStarted'), tone: 'success' })
      onOpenChange(false)
    },
    onError: (err) => toast.error(problemMessage(err, t('errors.unknown'))),
  })

  return (
    <Dialog open={service !== null} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('admin.gisServices.importTitle', { name: service?.name ?? '' })}
        description={t('admin.gisServices.importHint')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!target}
              loading={start.isPending}
              onClick={() => {
                if (service) start.mutate(service.id)
              }}
            >
              {t('admin.gisServices.importStart')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t('admin.gisServices.fields.space')} htmlFor="gis-import-space">
            <Select value={target} onValueChange={setSpaceId}>
              <SelectTrigger id="gis-import-space">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {available.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('admin.gisServices.fields.limit')} htmlFor="gis-import-limit">
            <Input
              id="gis-import-limit"
              type="number"
              min={1}
              max={200000}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
