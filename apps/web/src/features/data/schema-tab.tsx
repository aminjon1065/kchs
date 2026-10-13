import type { DatasetField, DatasetRecord } from '@kchs/contracts'
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  cn,
  IconButton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { Plus, Settings2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { AddFieldDialog, ConvertTypeDialog, TableSettingsDialog } from './schema-dialogs.js'
import { FieldPropertiesForm } from './schema-field-form.js'
import { FieldProfileView } from './schema-field-profile.js'
import { errorText, schemaApi } from './schema-queries.js'
import { labelOf, useSchemaRefresh } from './schema-shared.js'

/**
 * Вкладка «Схема» (03-screens.md §5): список полей и панель выбранного поля —
 * профиль и свойства; управляющий добавляет поля, меняет тип и настройки таблицы.
 */
export function SchemaTab({ dataset, canManage }: { dataset: DatasetRecord; canManage: boolean }) {
  const t = useT()
  const locale = useLocale()
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [settings, setSettings] = useState(false)
  const field = dataset.fields.find((item) => item.key === selected)

  return (
    <div className="mx-auto grid max-w-[1240px] gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-3">
        {canManage ? (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setAdding(true)}
            >
              {t('data.dataset.editor.addField')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Settings2 className="size-3.5" />}
              onClick={() => setSettings(true)}
            >
              {t('data.dataset.editor.settings')}
            </Button>
          </div>
        ) : null}
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead className="bg-surface-2 text-xs text-fg-secondary">
                <tr>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.field')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.key')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.type')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.semantic')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-left font-medium">
                    {t('data.dataset.schema.flags')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {dataset.fields.map((item) => (
                  <tr
                    key={item.id}
                    className={cn(
                      'border-t border-line',
                      item.key === selected && 'bg-accent-subtle',
                    )}
                  >
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        aria-pressed={item.key === selected}
                        onClick={() => setSelected(item.key)}
                        className="rounded-xs text-left text-fg hover:text-accent"
                      >
                        {labelOf(item, locale)}
                      </button>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-fg-secondary">{item.key}</td>
                    <td className="px-4 py-2 text-fg-secondary">{t(`data.types.${item.type}`)}</td>
                    <td className="px-4 py-2 text-fg-secondary">
                      {t(`data.semantics.${item.semantic}`)}
                    </td>
                    <td className="px-4 py-2">
                      <span className="flex flex-wrap gap-1">
                        {dataset.primaryKey.includes(item.key) ? (
                          <Badge size="sm" tone="accent">
                            {t('data.dataset.schema.primaryKey')}
                          </Badge>
                        ) : null}
                        {dataset.timeField === item.key ? (
                          <Badge size="sm">{t('data.dataset.schema.time')}</Badge>
                        ) : null}
                        {item.required ? (
                          <Badge size="sm">{t('data.dataset.schema.required')}</Badge>
                        ) : null}
                        {item.indexed ? (
                          <Badge size="sm" tone="outline">
                            {t('data.dataset.schema.indexed')}
                          </Badge>
                        ) : null}
                        {item.sensitive ? (
                          <Badge size="sm" tone="warning">
                            {t('data.dataset.schema.sensitive')}
                          </Badge>
                        ) : null}
                        {item.lookup ? (
                          <Badge size="sm" tone="purple">
                            {t('data.dataset.editor.lookup.title')}
                          </Badge>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="min-w-0">
        {field ? (
          <FieldPanel
            key={field.key}
            dataset={dataset}
            field={field}
            canManage={canManage}
            onRemoved={() => setSelected(null)}
          />
        ) : (
          <p className="py-6 text-center text-xs text-fg-muted">{t('data.dataset.profile.pick')}</p>
        )}
      </div>

      {adding ? (
        <AddFieldDialog
          dataset={dataset}
          onClose={() => setAdding(false)}
          onAdded={(key) => {
            setAdding(false)
            setSelected(key)
          }}
        />
      ) : null}
      {settings ? (
        <TableSettingsDialog dataset={dataset} onClose={() => setSettings(false)} />
      ) : null}
    </div>
  )
}

// ─── Панель поля ─────────────────────────────────────────────────────────────

function FieldPanel({
  dataset,
  field,
  canManage,
  onRemoved,
}: {
  dataset: DatasetRecord
  field: DatasetField
  canManage: boolean
  onRemoved: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const refresh = useSchemaRefresh(dataset.id)
  const [converting, setConverting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const label = labelOf(field, locale)

  const remove = useMutation({
    mutationFn: () => schemaApi.removeField(dataset.id, field.key),
    onSuccess: () => {
      toast.show({ title: t('data.dataset.editor.removed'), tone: 'success' })
      refresh()
      onRemoved()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {label}
          <Badge size="sm">{t(`data.types.${field.type}`)}</Badge>
        </span>
      }
      action={
        canManage ? (
          <span className="flex items-center gap-1">
            {field.type !== 'geometry' ? (
              <Button variant="ghost" size="sm" onClick={() => setConverting(true)}>
                {t('data.dataset.editor.convert.action')}
              </Button>
            ) : null}
            <IconButton
              label={t('data.dataset.editor.remove')}
              size="sm"
              variant="danger"
              onClick={() => setRemoving(true)}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </span>
        ) : null
      }
    >
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">{t('data.dataset.editor.tabs.profile')}</TabsTrigger>
          <TabsTrigger value="properties">{t('data.dataset.editor.tabs.properties')}</TabsTrigger>
        </TabsList>
        <TabsContent value="profile" className="pt-3">
          <FieldProfileView datasetId={dataset.id} field={field} />
        </TabsContent>
        <TabsContent value="properties" className="pt-3">
          <FieldPropertiesForm dataset={dataset} field={field} canManage={canManage} />
        </TabsContent>
      </Tabs>

      {converting ? (
        <ConvertTypeDialog dataset={dataset} field={field} onClose={() => setConverting(false)} />
      ) : null}
      <AlertDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('data.dataset.editor.removeConfirm', { field: label })}
        description={t('data.dataset.editor.removeConsequences')}
        confirmLabel={t('data.dataset.editor.remove')}
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          remove.mutate()
          setRemoving(false)
        }}
      />
    </Card>
  )
}
