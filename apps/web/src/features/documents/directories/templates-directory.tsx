import {
  type DocumentTemplateRecord,
  type DocumentTemplateUpdateInput,
  templatePlaceholders,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  FileDropzone,
  IconButton,
  Input,
  PanelToolbar,
  ProgressBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, LayoutTemplate, Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { uploadFile } from '~/features/files/upload.js'
import { useFileDownload } from '~/features/files/use-file-download.js'
import { http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { templatesQuery } from '../print/renders.js'
import { documentKeys, documentTypesQuery } from '../queries.js'
import { errorText } from '../status.js'

const ANY_TYPE = '__any__'
const DOCX = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Справочник шаблонов документов (08-documents.md §8, ADR-0085): файл DOCX с
 * плейсхолдерами (`{{ doc.subject }}`, `{{ doc.fields.addressee }}`), тип
 * документа, карточка по умолчанию. Движок разбирает шаблон: найденные
 * плейсхолдеры и неизвестные контексту видны до первого использования.
 */
export function TemplatesDirectory({ selectedId }: { selectedId: string | null }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: me } = useQuery(meQuery())
  const { data: templates = [], isLoading } = useQuery({
    ...templatesQuery(null, true),
    refetchInterval: (query) =>
      query.state.data?.some((template) => template.inspectStatus === 'pending') ? 3000 : false,
  })
  const [selected, setSelected] = useState<string | null>(selectedId)
  const [creating, setCreating] = useState(false)
  const current = templates.find((template) => template.id === selected) ?? null
  const canCreate = me?.capabilities.includes('documents.journals.manage') ?? false

  const columns: Array<DataTableColumn<DocumentTemplateRecord>> = [
    {
      key: 'name',
      header: t('documents.templates.name'),
      minWidth: 220,
      cell: (template) => (
        <span className="flex items-center gap-2">
          <span className="truncate">{template.name}</span>
          {template.isActive ? null : <Badge size="sm">{t('documents.types.inactive')}</Badge>}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('documents.fields.type'),
      width: 190,
      cell: (template) =>
        template.type ? (
          (template.type.name[locale] ?? template.type.name.ru)
        ) : (
          <span className="text-fg-muted">{t('documents.templates.anyType')}</span>
        ),
    },
    {
      key: 'status',
      header: t('documents.templates.status'),
      width: 170,
      cell: (template) => <InspectBadge template={template} />,
    },
  ]

  return (
    <section aria-label={t('documents.templates.title')} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={<h1 className="text-sm font-semibold text-fg">{t('documents.templates.title')}</h1>}
        right={
          canCreate ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setCreating(true)}
            >
              {t('documents.templates.create')}
            </Button>
          ) : null
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="min-h-0">
          {!isLoading && templates.length === 0 ? (
            <EmptyState
              icon={<LayoutTemplate />}
              title={t('documents.templates.empty')}
              description={t('documents.templates.emptyHint')}
            />
          ) : (
            <DataTable
              aria-label={t('documents.templates.title')}
              rows={templates}
              getRowId={(template) => template.id}
              columns={columns}
              loading={isLoading}
              onRowClick={(template) => setSelected(template.id)}
              onRowOpen={(template) => setSelected(template.id)}
            />
          )}
        </div>
        <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface-2">
          {current ? (
            <TemplatePanel key={current.id} template={current} onClose={() => setSelected(null)} />
          ) : (
            <EmptyState compact icon={<LayoutTemplate />} title={t('documents.templates.pick')} />
          )}
        </aside>
      </div>
      {creating ? (
        <CreateTemplateDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            setSelected(id)
          }}
        />
      ) : null}
    </section>
  )
}

function InspectBadge({ template }: { template: DocumentTemplateRecord }) {
  const t = useT()
  if (!template.file) return <Badge size="sm">{t('documents.templates.noFile')}</Badge>
  switch (template.inspectStatus) {
    case 'pending':
      return (
        <span className="flex items-center gap-1.5 text-xs text-fg-secondary">
          <Spinner className="size-3.5" />
          {t('documents.templates.inspecting')}
        </span>
      )
    case 'failed':
      return (
        <Badge size="sm" tone="danger">
          {t('documents.templates.inspectFailed')}
        </Badge>
      )
    case 'ready':
      return template.unknownPlaceholders.length > 0 ? (
        <Badge size="sm" tone="warning">
          {t('documents.templates.unknownCount', { count: template.unknownPlaceholders.length })}
        </Badge>
      ) : (
        <Badge size="sm" tone="success">
          {t('documents.templates.ready')}
        </Badge>
      )
    default:
      return <Badge size="sm">{t('documents.templates.noFile')}</Badge>
  }
}

function TypeSelect({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: types = [] } = useQuery(documentTypesQuery())
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={t('documents.fields.type')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY_TYPE}>{t('documents.templates.anyType')}</SelectItem>
        {types.map((type) => (
          <SelectItem key={type.id} value={type.id}>
            {type.name[locale] ?? type.name.ru}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function TemplatePanel({
  template,
  onClose,
}: {
  template: DocumentTemplateRecord
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const download = useFileDownload()
  const editable = template.canManage
  const initial = {
    name: template.name,
    description: template.description ?? '',
    typeId: template.type?.id ?? ANY_TYPE,
    subject: template.defaults.subject ?? '',
    active: template.isActive,
  }
  const [form, setForm] = useState(initial)
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }))
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const [progress, setProgress] = useState<number | null>(null)
  const refresh = () => void client.invalidateQueries({ queryKey: ['documents', 'templates'] })

  const save = useMutation({
    mutationFn: () => {
      const body: DocumentTemplateUpdateInput = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        typeId: form.typeId === ANY_TYPE ? null : form.typeId,
        defaults: { ...template.defaults, subject: form.subject.trim() || undefined },
        isActive: form.active,
      }
      return http.patch(`/document-templates/${template.id}`, body)
    },
    onSuccess: () => {
      toast.show({ title: t('documents.templates.saved'), tone: 'success' })
      refresh()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const record = await uploadFile({
        file,
        spaceId: template.spaceId,
        attachToObjectId: template.id,
        onProgress: setProgress,
      })
      await http.post(`/document-templates/${template.id}/file`, { fileId: record.id })
    },
    onSuccess: () => {
      setProgress(null)
      toast.show({ title: t('documents.templates.uploaded'), tone: 'success' })
      refresh()
    },
    onError: (error) => {
      setProgress(null)
      toast.error(errorText(error, t('errors.unknown')))
    },
  })

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{template.name}</h2>
        <IconButton size="sm" label={t('common.actions.close')} onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <Field label={t('documents.templates.name')} htmlFor={`${formId}-name`} required>
        <Input
          id={`${formId}-name`}
          value={form.name}
          maxLength={200}
          disabled={!editable}
          onChange={(event) => set({ name: event.target.value })}
        />
      </Field>
      <Field label={t('documents.fields.type')} hint={t('documents.templates.typeHint')}>
        <TypeSelect
          value={form.typeId}
          onChange={(typeId) => set({ typeId })}
          disabled={!editable}
        />
      </Field>
      <Field label={t('documents.templates.description')} htmlFor={`${formId}-description`}>
        <Textarea
          id={`${formId}-description`}
          rows={2}
          maxLength={2000}
          value={form.description}
          disabled={!editable}
          onChange={(event) => set({ description: event.target.value })}
        />
      </Field>
      <Field
        label={t('documents.templates.defaultSubject')}
        htmlFor={`${formId}-subject`}
        hint={t('documents.templates.defaultSubjectHint')}
      >
        <Input
          id={`${formId}-subject`}
          value={form.subject}
          maxLength={1000}
          disabled={!editable}
          onChange={(event) => set({ subject: event.target.value })}
        />
      </Field>
      <Switch
        label={t('documents.templates.active')}
        checked={form.active}
        disabled={!editable}
        onCheckedChange={(active) => set({ active })}
      />
      {editable ? (
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || !form.name.trim()}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('common.actions.save')}
        </Button>
      ) : null}

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {t('documents.templates.file')}
        </h3>
        {template.file ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-fg" title={template.file.name}>
              {template.file.name}
            </span>
            <InspectBadge template={template} />
            <IconButton
              size="sm"
              label={t('common.actions.download')}
              onClick={() => template.file && download.mutate({ fileId: template.file.id })}
            >
              <Download className="size-3.5" />
            </IconButton>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">{t('documents.templates.noFileHint')}</p>
        )}
        {template.inspectStatus === 'failed' && template.inspectError ? (
          <Callout tone="danger">{template.inspectError}</Callout>
        ) : null}
        {editable ? (
          <FileDropzone
            compact
            multiple={false}
            accept={DOCX}
            onFiles={(files) => {
              const file = files[0]
              if (file) upload.mutate(file)
            }}
            label={
              template.file
                ? t('documents.templates.replaceFile')
                : t('documents.templates.dropFile')
            }
          />
        ) : null}
        {progress !== null ? (
          <ProgressBar value={progress} label={t('documents.versions.uploading')} />
        ) : null}
      </section>

      {template.placeholders.length > 0 ? (
        <section className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {t('documents.templates.placeholders')}
          </h3>
          {template.unknownPlaceholders.length > 0 ? (
            <Callout tone="warning">{t('documents.templates.unknownHint')}</Callout>
          ) : null}
          <ul className="flex flex-wrap gap-1.5" aria-label={t('documents.templates.placeholders')}>
            {template.placeholders.map((path) => (
              <li key={path}>
                <Badge
                  size="sm"
                  tone={template.unknownPlaceholders.includes(path) ? 'warning' : 'neutral'}
                  className="font-mono"
                >
                  {path}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <AvailablePlaceholders />
    </div>
  )
}

/** Шпаргалка автора шаблона: пути контекста заполнения. */
function AvailablePlaceholders() {
  const t = useT()
  return (
    <Collapsible className="border-t border-line pt-4">
      <CollapsibleTrigger className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.templates.available')}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-2 text-xs text-fg-secondary">{t('documents.templates.availableHint')}</p>
        <ul className="mt-2 flex flex-col gap-0.5 font-mono text-2xs text-fg-secondary">
          {templatePlaceholders().map((path) => (
            <li key={path}>{`{{ ${path} }}`}</li>
          ))}
          <li>{'{{ doc.fields.<key> }}'}</li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function CreateTemplateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const t = useT()
  const client = useQueryClient()
  const formId = useId()
  const [name, setName] = useState('')
  const [typeId, setTypeId] = useState(ANY_TYPE)
  const [failure, setFailure] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () =>
      http.post<DocumentTemplateRecord>('/document-templates', {
        name: name.trim(),
        typeId: typeId === ANY_TYPE ? null : typeId,
      }),
    onSuccess: (record) => {
      void client.invalidateQueries({ queryKey: ['documents', 'templates'] })
      void client.invalidateQueries({ queryKey: documentKeys.all })
      onCreated(record.id)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.templates.create')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('documents.templates.name')} htmlFor={`${formId}-name`} required>
            <Input
              id={`${formId}-name`}
              autoFocus
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('documents.fields.type')} hint={t('documents.templates.typeHint')}>
            <TypeSelect value={typeId} onChange={setTypeId} />
          </Field>
          <p className="text-xs text-fg-muted">{t('documents.templates.createHint')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
