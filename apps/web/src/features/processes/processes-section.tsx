import { formatRelativeTime } from '@kchs/fields'
import { localizedText } from '@kchs/i18n'
import type { ProcessDefinitionSummary, ProcessDraftSaved } from '@kchs/process'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
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
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Route } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { blankDefinition, type Definition, insertAfter } from './model.js'
import { processCatalogQuery, processDefinitionsQuery, processKeys } from './queries.js'

/** Кириллица → латиница для подсказки ключа маршрута. */
const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ғ: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  ӣ: 'i',
  й: 'y',
  к: 'k',
  қ: 'q',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ӯ: 'u',
  ф: 'f',
  х: 'h',
  ҳ: 'h',
  ц: 'ts',
  ч: 'ch',
  ҷ: 'j',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

/** Ключ маршрута из названия: `a–z`, цифры и `_`, с буквы, до 64 символов. */
export function routeKeyFrom(name: string): string {
  const latin = [...name.toLowerCase()].map((char) => TRANSLIT[char] ?? char).join('')
  const key = latin
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return /^[a-z]/.test(key) ? key : `route_${key}`.replace(/_+$/, '')
}

const TEMPLATES = ['blank', 'approvalSign'] as const
type Template = (typeof TEMPLATES)[number]

/** Стартовое определение: согласование и завершение или согласование → подпись → регистрация. */
function templateDefinition(
  template: Template,
  base: Parameters<typeof blankDefinition>[0],
): Definition {
  const blank = blankDefinition(base)
  if (template === 'blank') return blank
  const signed = insertAfter(blank, 'approval_1', 'sign')
  return insertAfter(signed.definition, signed.key, 'register').definition
}

/**
 * «Маршруты процессов» в консоли (08-documents.md §4, ADR-0079, ADR-0087):
 * список маршрутов с версиями и числом идущих, создание — и конструктор во
 * вкладке. Доступно со способностью `processes.manage`.
 */
export function ProcessesSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const [creating, setCreating] = useState(false)
  const { data = [], isLoading } = useQuery(processDefinitionsQuery())

  const open = (key: string, name: string) =>
    openTab({
      kind: 'screen',
      screen: 'process-designer',
      params: { key },
      title: name,
      icon: 'route',
      mode: 'permanent',
    })

  const columns: Array<DataTableColumn<ProcessDefinitionSummary>> = [
    {
      key: 'name',
      header: t('processDesigner.section.columns.name'),
      width: 240,
      cell: (row) => (
        <span className="truncate font-medium">{localizedText(row.name, locale)}</span>
      ),
    },
    {
      key: 'key',
      header: t('processDesigner.section.columns.key'),
      width: 190,
      cell: (row) => <code className="font-mono text-xs">{row.key}</code>,
    },
    {
      key: 'objectType',
      header: t('processDesigner.section.columns.objectType'),
      width: 110,
      cell: (row) => t(`objects.types.${row.objectType}`),
    },
    {
      key: 'published',
      header: t('processDesigner.section.columns.published'),
      width: 120,
      cell: (row) =>
        row.publishedVersion ? (
          <Badge tone="success">
            {t('processDesigner.section.version', { version: row.publishedVersion })}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'draft',
      header: t('processDesigner.section.columns.draft'),
      width: 110,
      cell: (row) =>
        row.draftVersion ? (
          <Badge tone="warning">
            {t('processDesigner.section.version', { version: row.draftVersion })}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'running',
      header: t('processDesigner.section.columns.running'),
      width: 70,
      align: 'end',
      cell: (row) => row.running,
    },
    {
      key: 'updated',
      header: t('processDesigner.section.columns.updated'),
      width: 130,
      cell: (row) => formatRelativeTime(row.updatedAt, { locale }),
    },
  ]

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-fg">{t('processDesigner.section.title')}</h2>
          <p className="text-sm text-fg-secondary">{t('processDesigner.section.hint')}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t('processDesigner.section.create')}
        </Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data.length === 0 ? (
        <EmptyState
          icon={<Route className="size-5" />}
          title={t('processDesigner.section.empty')}
          description={t('processDesigner.section.emptyHint')}
        />
      ) : (
        <div className="h-[28rem] min-h-0">
          <DataTable
            rows={data}
            getRowId={(row) => row.key}
            columns={columns}
            onRowOpen={(row) => open(row.key, localizedText(row.name, locale))}
            onRowClick={(row) => open(row.key, localizedText(row.name, locale))}
          />
        </div>
      )}
      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(key, name) => {
          setCreating(false)
          open(key, name)
        }}
      />
    </div>
  )
}

function CreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (key: string, name: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const nameId = useId()
  const keyId = useId()
  const typeId = useId()
  const templateId = useId()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [objectType, setObjectType] = useState('document')
  const [template, setTemplate] = useState<Template>('approvalSign')
  const catalog = useQuery({ ...processCatalogQuery(), enabled: open })
  const types = [
    ...new Set([...(catalog.data?.objectTypes.map((item) => item.type) ?? []), 'document']),
  ]
  const effectiveKey = keyTouched ? key : routeKeyFrom(name)
  const keyValid = /^[a-z][a-z0-9_]{1,63}$/.test(effectiveKey)

  const create = useMutation({
    mutationFn: () =>
      http.post<ProcessDraftSaved>('/process-definitions', {
        definition: templateDefinition(template, {
          key: effectiveKey,
          objectType,
          name: { ru: name.trim() },
        }),
      }),
    onSuccess: () => {
      toast.show({ title: t('processDesigner.create.created'), tone: 'success' })
      void client.invalidateQueries({ queryKey: processKeys.all })
      onCreated(effectiveKey, name.trim())
      setName('')
      setKey('')
      setKeyTouched(false)
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('processDesigner.create.title')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim() || !keyValid}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('processDesigner.create.submit')}
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim() && keyValid) create.mutate()
          }}
        >
          <Field label={t('processDesigner.create.name')} htmlFor={nameId} required>
            <Input
              id={nameId}
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label={t('processDesigner.create.key')}
            hint={t('processDesigner.create.keyHint')}
            htmlFor={keyId}
            error={effectiveKey && !keyValid ? t('processDesigner.create.keyInvalid') : undefined}
          >
            <Input
              id={keyId}
              value={effectiveKey}
              className="font-mono text-xs"
              onChange={(event) => {
                setKeyTouched(true)
                setKey(event.target.value)
              }}
            />
          </Field>
          <Field label={t('processDesigner.create.objectType')} htmlFor={typeId}>
            <Select value={objectType} onValueChange={setObjectType}>
              <SelectTrigger id={typeId} aria-label={t('processDesigner.create.objectType')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`objects.types.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('processDesigner.create.template')} htmlFor={templateId}>
            <Select value={template} onValueChange={(next) => setTemplate(next as Template)}>
              <SelectTrigger id={templateId} aria-label={t('processDesigner.create.template')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`processDesigner.create.templates.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      </DialogContent>
    </Dialog>
  )
}
