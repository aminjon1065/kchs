import type { Basemap, BasemapKind } from '@kchs/contracts'
import { formatFileSize, formatNumber } from '@kchs/fields'
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
import { Layers, Map as MapIcon, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { basemapKeys, basemapsQuery } from '~/features/gis/basemaps.js'
import { ApiError, http } from '~/shared/api/client.js'

const KIND_TONES: Record<BasemapKind, 'accent' | 'neutral' | 'purple'> = {
  vector: 'accent',
  raster: 'purple',
  none: 'neutral',
}

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
}

/**
 * «Базовые карты» (07-gis-engine.md §5, ADR-0066): реестр подложек установки.
 * Векторные приходят из сборки PMTiles (`kchs basemaps upload`), растровые XYZ
 * добавляет администратор ГИС; ключ сервера после сохранения не показывается.
 * Предпросмотр — в карте-студии.
 */
export function BasemapsSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const { data: items = [], isLoading } = useQuery(basemapsQuery())
  const [editing, setEditing] = useState<Basemap | 'new' | null>(null)
  const [removing, setRemoving] = useState<Basemap | null>(null)

  const refresh = () => void client.invalidateQueries({ queryKey: basemapKeys.all })
  const failed = (err: unknown) => toast.error(problemMessage(err, t('errors.unknown')))

  const makeDefault = useMutation({
    mutationFn: (id: string) => http.post(`/gis/basemaps/${id}/default`),
    onSuccess: () => {
      toast.show({ title: t('admin.basemaps.defaultSet'), tone: 'success' })
      refresh()
    },
    onError: failed,
  })

  const remove = useMutation({
    mutationFn: (id: string) => http.delete(`/gis/basemaps/${id}`),
    onSuccess: () => {
      toast.show({ title: t('admin.basemaps.removed'), tone: 'info' })
      setRemoving(null)
      refresh()
    },
    onError: (err) => {
      setRemoving(null)
      failed(err)
    },
  })

  const name = (basemap: Basemap) =>
    basemap.key === 'none' ? t('admin.basemaps.noneName') : basemap.name

  const details = (basemap: Basemap): string => {
    if (basemap.kind === 'vector' && basemap.build) {
      return t('admin.basemaps.build', {
        version: basemap.build.version,
        size: formatFileSize(basemap.build.bytes, { locale }),
        tiles: formatNumber(basemap.build.tiles, {}, { locale }),
      })
    }
    if (basemap.kind === 'raster') {
      return [
        t('admin.basemaps.zooms', { min: basemap.minZoom, max: basemap.maxZoom }),
        t('admin.basemaps.tileSizeValue', { size: basemap.tileSize ?? 256 }),
        basemap.hasKey ? t('admin.basemaps.keySet') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    }
    return t('admin.basemaps.noneHint')
  }

  const hasVector = items.some((item) => item.kind === 'vector')

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-secondary">{t('admin.basemaps.hint')}</p>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => setEditing('new')}
        >
          {t('admin.basemaps.addRaster')}
        </Button>
      </div>
      {!isLoading && !hasVector ? (
        <Callout tone="info">{t('admin.basemaps.noVector')}</Callout>
      ) : null}
      <Card padded={false}>
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={<MapIcon />} title={t('admin.basemaps.empty')} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((basemap) => (
              <li key={basemap.id} className="flex items-start gap-3 px-4 py-3">
                <Layers className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{name(basemap)}</span>
                    <Badge tone={KIND_TONES[basemap.kind]} size="sm">
                      {t(`admin.basemaps.kinds.${basemap.kind}`)}
                    </Badge>
                    {basemap.isDefault ? (
                      <Badge tone="success" size="sm" dot>
                        {t('admin.basemaps.default')}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="tabular mt-1 text-xs text-fg-secondary">{details(basemap)}</p>
                  {basemap.url ? (
                    <p className="mt-1 truncate font-mono text-xs text-fg-muted">{basemap.url}</p>
                  ) : null}
                  {basemap.attribution ? (
                    <p className="mt-1 text-xs text-fg-muted">{basemap.attribution}</p>
                  ) : null}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      size="sm"
                      label={t('admin.basemaps.actions', { name: name(basemap) })}
                    >
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!basemap.isDefault ? (
                      <DropdownMenuItem
                        icon={<Star className="size-4" />}
                        onSelect={() => makeDefault.mutate(basemap.id)}
                      >
                        {t('admin.basemaps.makeDefault')}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      icon={<Pencil className="size-4" />}
                      onSelect={() => setEditing(basemap)}
                    >
                      {basemap.kind === 'raster'
                        ? t('common.actions.edit')
                        : t('admin.basemaps.rename')}
                    </DropdownMenuItem>
                    {basemap.key !== 'none' && !basemap.isDefault ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          danger
                          icon={<Trash2 className="size-4" />}
                          onSelect={() => setRemoving(basemap)}
                        >
                          {t('common.actions.delete')}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <BasemapDialog
        basemap={editing}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        onSaved={(created) => {
          toast.show({
            title: created ? t('admin.basemaps.created') : t('admin.basemaps.saved'),
            tone: 'success',
          })
          refresh()
        }}
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => (next ? undefined : setRemoving(null))}
        title={t('admin.basemaps.removeTitle', { name: removing ? name(removing) : '' })}
        description={
          removing?.kind === 'vector'
            ? t('admin.basemaps.removeVectorHint')
            : t('admin.basemaps.removeHint')
        }
        confirmLabel={t('common.actions.delete')}
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
        }}
      />
    </div>
  )
}

const TILE_SIZES = ['256', '512'] as const

interface Form {
  name: string
  url: string
  apiKey: string
  clearKey: boolean
  attribution: string
  minZoom: string
  maxZoom: string
  tileSize: (typeof TILE_SIZES)[number]
  isDefault: boolean
}

function initial(basemap: Basemap | null): Form {
  return {
    name: basemap?.name ?? '',
    url: basemap?.url ?? '',
    apiKey: '',
    clearKey: false,
    attribution: basemap?.attribution ?? '',
    minZoom: String(basemap?.minZoom ?? 0),
    maxZoom: String(basemap?.maxZoom ?? 19),
    tileSize: basemap?.tileSize === 512 ? '512' : '256',
    isDefault: false,
  }
}

/** Добавление растровой XYZ и правка: у векторной и «без подложки» — только название. */
function BasemapDialog({
  basemap,
  onOpenChange,
  onSaved,
}: {
  basemap: Basemap | 'new' | null
  onOpenChange: (open: boolean) => void
  onSaved: (created: boolean) => void
}) {
  const t = useT()
  const formId = useId()
  const current = basemap === 'new' ? null : basemap
  const raster = basemap === 'new' || current?.kind === 'raster'
  const [form, setForm] = useState<Form>(() => initial(current))
  const [opened, setOpened] = useState<Basemap | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Новое открытие — форма с данными выбранной подложки
  if (basemap !== opened) {
    setOpened(basemap)
    setForm(initial(current))
    setError(null)
  }
  const set = (patch: Partial<Form>) => setForm((value) => ({ ...value, ...patch }))

  const save = useMutation({
    mutationFn: async () => {
      const zooms = { minZoom: Number(form.minZoom), maxZoom: Number(form.maxZoom) }
      const attribution = form.attribution.trim() || null
      if (!current) {
        await http.post('/gis/basemaps', {
          name: form.name.trim(),
          url: form.url.trim(),
          ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
          attribution,
          ...zooms,
          tileSize: Number(form.tileSize),
          isDefault: form.isDefault,
        })
        return true
      }
      await http.patch(
        `/gis/basemaps/${current.id}`,
        raster
          ? {
              name: form.name.trim(),
              url: form.url.trim(),
              ...(form.clearKey
                ? { apiKey: null }
                : form.apiKey.trim()
                  ? { apiKey: form.apiKey.trim() }
                  : {}),
              attribution,
              ...zooms,
              tileSize: Number(form.tileSize),
            }
          : { name: form.name.trim() },
      )
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
    (!raster || (form.url.trim().length > 0 && form.minZoom !== '' && form.maxZoom !== ''))

  return (
    <Dialog open={basemap !== null} onOpenChange={onOpenChange}>
      <DialogContent
        title={
          current
            ? t('admin.basemaps.editTitle', { name: current.name })
            : t('admin.basemaps.addRaster')
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
              {current ? t('common.actions.save') : t('admin.basemaps.add')}
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
          <Field label={t('admin.basemaps.fields.name')} htmlFor={`${formId}-name`} required>
            <Input
              id={`${formId}-name`}
              maxLength={200}
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          </Field>
          {raster ? (
            <>
              <Field
                label={t('admin.basemaps.fields.url')}
                htmlFor={`${formId}-url`}
                hint={t('admin.basemaps.fields.urlHint')}
                required
              >
                <Input
                  id={`${formId}-url`}
                  className="font-mono"
                  maxLength={2000}
                  placeholder="https://tiles.example.org/{z}/{x}/{y}.png?key={key}"
                  value={form.url}
                  onChange={(event) => set({ url: event.target.value })}
                />
              </Field>
              <Field
                label={t('admin.basemaps.fields.apiKey')}
                htmlFor={`${formId}-key`}
                hint={
                  current?.hasKey
                    ? t('admin.basemaps.fields.apiKeyKeep')
                    : t('admin.basemaps.fields.apiKeyHint')
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
              <div className="grid grid-cols-3 gap-3">
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
                <Field label={t('admin.basemaps.fields.tileSize')} htmlFor={`${formId}-size`}>
                  <Select
                    value={form.tileSize}
                    onValueChange={(value) => set({ tileSize: value as Form['tileSize'] })}
                  >
                    <SelectTrigger id={`${formId}-size`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TILE_SIZES.map((size) => (
                        <SelectItem key={size} value={size}>
                          {t('admin.basemaps.tileSizeValue', { size })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {!current ? (
                <Checkbox
                  label={t('admin.basemaps.fields.isDefault')}
                  checked={form.isDefault}
                  onCheckedChange={(checked) => set({ isDefault: checked === true })}
                />
              ) : null}
            </>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  )
}
