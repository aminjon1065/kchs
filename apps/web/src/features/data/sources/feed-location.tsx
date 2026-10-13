import type { DatasetField, FeedPathInfo } from '@kchs/contracts'
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kchs/ui'
import { useId } from 'react'
import { useT } from '~/shared/i18n.js'
import { type FeedDraft, type GeometrySource, TAJIKISTAN_BBOX } from './feed-form.js'
import { NONE, PathSelect } from './feed-shared.js'

/** Геометрия записи, поле для неё и район, область отбора и «только внутри территорий». */
export function LocationSection({
  draft,
  paths,
  onChange,
  geometryFields,
  territoryFields,
  locate,
  onLocateChange,
}: {
  draft: FeedDraft
  paths: readonly FeedPathInfo[]
  onChange: (next: Partial<FeedDraft>) => void
  /** Поля существующего датасета; null — новый датасет, поля заводятся сами. */
  geometryFields: DatasetField[] | null
  territoryFields: DatasetField[] | null
  locate: boolean
  onLocateChange: (value: boolean) => void
}) {
  const t = useT()
  const id = useId()
  const located = draft.geometry !== 'none'
  const bbox = draft.bbox ?? ['', '', '', '']
  const setBbox = (index: number, value: string) => {
    const next = [...bbox] as [string, string, string, string]
    next[index] = value
    onChange({ bbox: next.every((item) => item === '') ? null : next })
  }
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <Field label={t('admin.dataSources.feed.geometry')}>
          <SegmentedControl
            value={draft.geometry}
            onValueChange={(value) => onChange({ geometry: value as GeometrySource })}
            options={(['none', 'feature', 'latlon'] as const).map((value) => ({
              value,
              label: t(`admin.dataSources.feed.geometrySources.${value}`),
            }))}
            aria-label={t('admin.dataSources.feed.geometry')}
          />
        </Field>
        {draft.geometry === 'latlon' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('admin.dataSources.feed.lat')}>
              <PathSelect
                value={draft.lat}
                onChange={(lat) => onChange({ lat })}
                paths={paths}
                label={t('admin.dataSources.feed.lat')}
                className="h-8 text-sm"
              />
            </Field>
            <Field label={t('admin.dataSources.feed.lon')}>
              <PathSelect
                value={draft.lon}
                onChange={(lon) => onChange({ lon })}
                paths={paths}
                label={t('admin.dataSources.feed.lon')}
                className="h-8 text-sm"
              />
            </Field>
          </div>
        ) : null}
        {located ? (
          <>
            {geometryFields && territoryFields ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('admin.dataSources.feed.geometryField')} htmlFor={`${id}-geometry`}>
                  <Select
                    value={draft.geometryField || NONE}
                    onValueChange={(value) =>
                      onChange({ geometryField: value === NONE ? '' : value })
                    }
                  >
                    <SelectTrigger id={`${id}-geometry`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('admin.dataSources.feed.noField')}</SelectItem>
                      {geometryFields.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label.ru}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label={t('admin.dataSources.feed.territoryField')}
                  htmlFor={`${id}-territory`}
                  hint={t('admin.dataSources.feed.territoryHint')}
                >
                  <Select
                    value={draft.territoryField || NONE}
                    onValueChange={(value) =>
                      onChange({ territoryField: value === NONE ? '' : value })
                    }
                  >
                    <SelectTrigger id={`${id}-territory`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t('admin.dataSources.feed.noField')}</SelectItem>
                      {territoryFields.map((field) => (
                        <SelectItem key={field.key} value={field.key}>
                          {field.label.ru}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            ) : (
              <Checkbox
                label={t('admin.dataSources.feed.locate')}
                checked={locate}
                onCheckedChange={(checked) => onLocateChange(checked === true)}
              />
            )}
            <Checkbox
              label={t('admin.dataSources.feed.withinTerritory')}
              checked={draft.withinTerritory}
              onCheckedChange={(checked) => onChange({ withinTerritory: checked === true })}
            />
            <Field
              label={t('admin.dataSources.feed.bbox')}
              hint={t('admin.dataSources.feed.bboxHint')}
            >
              <div className="flex flex-wrap items-center gap-2">
                {(['west', 'south', 'east', 'north'] as const).map((side, index) => (
                  <Input
                    key={side}
                    aria-label={t(`admin.dataSources.feed.bboxSides.${side}`)}
                    placeholder={t(`admin.dataSources.feed.bboxSides.${side}`)}
                    inputMode="decimal"
                    className="h-7 w-24 text-xs"
                    value={bbox[index]}
                    onChange={(event) => setBbox(index, event.target.value)}
                  />
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange({
                      bbox: TAJIKISTAN_BBOX.map(String) as [string, string, string, string],
                    })
                  }
                >
                  {t('admin.dataSources.feed.bboxCountry')}
                </Button>
              </div>
            </Field>
          </>
        ) : null}
      </div>
    </Card>
  )
}
