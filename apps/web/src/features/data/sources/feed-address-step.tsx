import { FEED_FORMATS, type FeedFormat, type FeedPreview } from '@kchs/contracts'
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { useId } from 'react'
import { useT } from '~/shared/i18n.js'
import type { FeedDraft } from './feed-form.js'
import { NONE, sample } from './feed-shared.js'

/** Столько записей предпросмотра показывается таблицей. */
const PREVIEW_ROWS = 5
const PREVIEW_COLUMNS = 6
/** Ссылка на секрет интеграции в адресе — образец для подсказки. */
const SECRET_EXAMPLE = '{secret:mapKey}'

/** Шаг «Адрес»: URL, формат, путь к массиву, интеграция с секретами и проверка ответа. */
export function AddressStep({
  draft,
  onChange,
  integrations,
  preview,
  checking,
  onCheck,
}: {
  draft: FeedDraft
  onChange: (next: Partial<FeedDraft>) => void
  integrations: Array<{ id: string; name: string }>
  preview: FeedPreview | null
  checking: boolean
  onCheck: () => void
}) {
  const t = useT()
  const id = useId()
  const columns = (preview?.paths ?? []).slice(0, PREVIEW_COLUMNS)
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={t('admin.dataSources.feed.url')}
        htmlFor={`${id}-url`}
        hint={t('admin.dataSources.feed.urlHint', { example: SECRET_EXAMPLE })}
        required
      >
        <Input
          id={`${id}-url`}
          className="font-mono"
          placeholder="https://"
          value={draft.url}
          onChange={(event) => onChange({ url: event.target.value })}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('admin.dataSources.feed.format')} htmlFor={`${id}-format`}>
          <Select
            value={draft.format}
            onValueChange={(value) => onChange({ format: value as FeedFormat })}
          >
            <SelectTrigger id={`${id}-format`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FEED_FORMATS.map((format) => (
                <SelectItem key={format} value={format}>
                  {t(`admin.dataSources.feed.formats.${format}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {draft.format === 'cap' ? (
          <p className="text-xs text-fg-muted sm:col-span-2">
            {t('admin.dataSources.feed.capHint')}
          </p>
        ) : null}
        {draft.format === 'json' ? (
          <Field
            label={t('admin.dataSources.feed.itemsPath')}
            htmlFor={`${id}-items`}
            hint={t('admin.dataSources.feed.itemsPathHint')}
          >
            <Input
              id={`${id}-items`}
              className="font-mono"
              value={draft.itemsPath}
              onChange={(event) => onChange({ itemsPath: event.target.value })}
            />
          </Field>
        ) : null}
        <Field
          label={t('admin.dataSources.feed.integration')}
          htmlFor={`${id}-integration`}
          hint={t('admin.dataSources.feed.integrationHint')}
        >
          <Select
            value={draft.integrationId || NONE}
            onValueChange={(value) => onChange({ integrationId: value === NONE ? '' : value })}
          >
            <SelectTrigger id={`${id}-integration`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('admin.dataSources.feed.noIntegration')}</SelectItem>
              {integrations.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={checking}
          disabled={!/^https?:\/\/\S+$/i.test(draft.url.trim())}
          onClick={onCheck}
        >
          {t('admin.dataSources.feed.check')}
        </Button>
        {preview ? (
          <Badge tone="success" size="sm" dot>
            {t('admin.dataSources.feed.found', {
              records: String(preview.total),
              paths: String(preview.paths.length),
            })}
          </Badge>
        ) : null}
      </div>
      {preview && preview.items.length > 0 ? (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-xs">
              <thead>
                <tr className="border-b border-line text-left text-fg-secondary">
                  {columns.map((column) => (
                    <th key={column.path} className="px-2 py-1.5 font-medium">
                      <span className="font-mono">{column.path}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.items.slice(0, PREVIEW_ROWS).map((item, index) => (
                  <tr key={index} className="border-b border-line last:border-0">
                    {columns.map((column) => (
                      <td key={column.path} className="max-w-[16rem] truncate px-2 py-1.5 text-fg">
                        {sample(item[column.path])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
