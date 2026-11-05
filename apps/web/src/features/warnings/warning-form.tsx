import {
  CAP_CATEGORIES,
  CAP_CERTAINTIES,
  CAP_RESPONSE_TYPES,
  CAP_SEVERITIES,
  CAP_STATUSES,
  CAP_URGENCIES,
  type Territory,
  WARNING_LANGUAGES,
  type WarningInfo,
  type WarningLanguage,
  type WarningRecord,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  cn,
  Field,
  fromLocalInput,
  HazardBadge,
  HazardMark,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  toLocalInput,
  useUiTimeZone,
} from '@kchs/ui'
import { useQueries, useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleDashed, Plus, X } from 'lucide-react'
import { type ReactNode, Suspense, useId, useState } from 'react'
import { type PickedUser, UserPicker } from '~/entities/people/user-picker.js'
import { territoryQuery } from '~/entities/territory/queries.js'
import { LazyAreasMap } from '~/features/gis/index.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { HAZARD_LEVEL } from './labels.js'
import { warningSettingsQuery, warningTerritoriesQuery } from './queries.js'
import {
  HEADLINE_LIMIT,
  languageFilled,
  populationOf,
  populationSourceOf,
  totalPopulation,
} from './warning-checks.js'

/** Содержание предупреждения, которое правит автор, — тело `PUT /warnings/:id`. */
export interface WarningDraft {
  capStatus: WarningRecord['capStatus']
  info: WarningRecord['info']
  categories: WarningRecord['categories']
  urgency: WarningRecord['urgency']
  severity: WarningRecord['severity']
  certainty: WarningRecord['certainty']
  responseTypes: WarningRecord['responseTypes']
  effective: string | null
  expires: string | null
  areas: Array<{
    territoryId: string | null
    description: string
    polygon: Array<[number, number]> | null
  }>
  signerId: string | null
}

export function draftOf(warning: WarningRecord): WarningDraft {
  return {
    capStatus: warning.capStatus,
    info: warning.info,
    categories: warning.categories,
    urgency: warning.urgency,
    severity: warning.severity,
    certainty: warning.certainty,
    responseTypes: warning.responseTypes,
    effective: warning.effective,
    expires: warning.expires,
    areas: warning.areas.map((area) => ({
      territoryId: area.territoryId,
      description: area.description,
      polygon: area.polygon as Array<[number, number]> | null,
    })),
    signerId: warning.signer?.id ?? null,
  }
}

const EMPTY_INFO: WarningInfo = { event: '', headline: '', description: '', instruction: '' }
const NO_TERRITORY = '-'
/** Пункт «другой сотрудник» в выборе подписывающего. */
const OTHER = '+'

const toggle = <T,>(list: readonly T[], value: T, on: boolean): T[] =>
  on ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value)

interface SectionProps {
  warning: WarningRecord
  draft: WarningDraft
  onChange: (next: WarningDraft) => void
  readOnly: boolean
  className?: string
}

/** Значение только для чтения: подпись над текстом, как в макете карточки. */
function ReadValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="text-sm text-fg">{children}</div>
    </div>
  )
}

/** Счётчик длины заголовка для SMS: ближе к лимиту — предупреждением. */
function HeadlineCount({ length }: { length: number }) {
  const t = useT()
  return (
    <span
      title={t('warnings.content.headlineCount', { count: length, limit: HEADLINE_LIMIT })}
      className={cn(
        'tabular font-mono text-2xs',
        length > HEADLINE_LIMIT
          ? 'text-danger'
          : length > HEADLINE_LIMIT - 20
            ? 'text-warning'
            : 'text-fg-muted',
      )}
    >
      <span aria-hidden>{`${length} / ${HEADLINE_LIMIT}`}</span>
      <span className="sr-only">
        {t('warnings.content.headlineCount', { count: length, limit: HEADLINE_LIMIT })}
      </span>
    </span>
  )
}

/**
 * Содержание на трёх языках (ADR-0202, ADR-0230): вкладки языков с отметкой
 * заполненности, явление, заголовок со счётчиком для SMS, описание и что делать.
 * Вне черновика — текстом, как его прочтёт руководство.
 */
export function WarningContentSection({
  draft,
  onChange,
  readOnly,
  readOnlyNote,
  language,
  onLanguage,
  className,
}: Omit<SectionProps, 'warning'> & {
  readOnlyNote: string | null
  language: WarningLanguage
  onLanguage: (language: WarningLanguage) => void
}) {
  const t = useT()
  const headlineId = useId()
  const info = draft.info[language] ?? EMPTY_INFO
  const setInfo = (patch: Partial<WarningInfo>) =>
    onChange({ ...draft, info: { ...draft.info, [language]: { ...info, ...patch } } })

  return (
    <section
      aria-label={t('warnings.card.content')}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-sm',
        className,
      )}
    >
      <Tabs value={language} onValueChange={(value) => onLanguage(value as WarningLanguage)}>
        <div className="flex items-end gap-2 border-b border-line px-3 pt-2">
          <TabsList aria-label={t('warnings.fields.language')} className="border-b-0">
            {WARNING_LANGUAGES.map((value) => {
              const filled = languageFilled(draft.info, value)
              return (
                <TabsTrigger key={value} value={value} className="h-9">
                  {filled ? (
                    <CircleCheck className="size-3.5 text-success" aria-hidden />
                  ) : (
                    <CircleDashed className="size-3.5 text-fg-muted" aria-hidden />
                  )}
                  {t(`warnings.languages.${value}`)}
                  <span className="sr-only">
                    {` · ${t(filled ? 'warnings.content.filled' : 'warnings.content.empty')}`}
                  </span>
                </TabsTrigger>
              )
            })}
          </TabsList>
          {readOnlyNote ? (
            <span className="mb-2 ml-auto truncate text-xs text-fg-muted">{readOnlyNote}</span>
          ) : null}
        </div>
      </Tabs>

      <div className="flex flex-col gap-3.5 px-4.5 py-4">
        {readOnly ? (
          <>
            <ReadValue label={t('warnings.info.event')}>
              <span className="font-semibold">{info.event || '—'}</span>
            </ReadValue>
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium text-fg-muted">
                  {t('warnings.info.headline')}
                </span>
                <HeadlineCount length={info.headline.length} />
              </div>
              <p className="text-base font-semibold text-pretty text-fg">{info.headline || '—'}</p>
            </div>
            <ReadValue label={t('warnings.info.description')}>
              <p className="whitespace-pre-line text-pretty">{info.description || '—'}</p>
            </ReadValue>
            <ReadValue label={t('warnings.info.instruction')}>
              <p className="whitespace-pre-line text-pretty">{info.instruction || '—'}</p>
            </ReadValue>
          </>
        ) : (
          <>
            <Field label={t('warnings.info.event')}>
              <Input
                value={info.event}
                maxLength={200}
                onChange={(event) => setInfo({ event: event.target.value })}
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={headlineId} className="text-xs font-medium text-fg-secondary">
                  {t('warnings.info.headline')}
                </label>
                <HeadlineCount length={info.headline.length} />
              </div>
              <Input
                id={headlineId}
                value={info.headline}
                maxLength={HEADLINE_LIMIT}
                onChange={(event) => setInfo({ headline: event.target.value })}
              />
              <p className="text-xs text-fg-muted">{t('warnings.info.headlineHint')}</p>
            </div>
            <Field label={t('warnings.info.description')}>
              <Textarea
                value={info.description}
                rows={4}
                onChange={(event) => setInfo({ description: event.target.value })}
              />
            </Field>
            <Field label={t('warnings.info.instruction')}>
              <Textarea
                value={info.instruction}
                rows={3}
                onChange={(event) => setInfo({ instruction: event.target.value })}
              />
            </Field>
          </>
        )}
      </div>
    </section>
  )
}

/**
 * Строка «подпись — значение» параметров CAP. `stacked` — подпись над значением: списки
 * флажков и пары полей в узкой колонке иначе не помещаются.
 */
function ParamRow({
  id,
  label,
  stacked,
  children,
}: {
  id: string
  label: string
  stacked?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'border-b border-line py-2.5 last:border-b-0',
        stacked
          ? 'flex flex-col gap-2'
          : 'grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-2.5',
      )}
    >
      <dt id={id} className="text-sm text-fg-muted">
        {label}
      </dt>
      <dd className="min-w-0 text-sm font-medium text-fg">{children}</dd>
    </div>
  )
}

/**
 * Параметры CAP (ADR-0202, ADR-0230): строгость знаком шкалы обстановки, срочность,
 * достоверность, категория, что делать, срок действия и подписывающий. В черновике —
 * те же строки с полями ввода.
 */
export function WarningParamsSection({
  warning,
  draft,
  onChange,
  readOnly,
  className,
}: SectionProps) {
  const t = useT()
  const locale = useLocale()
  const timeZone = useUiTimeZone()
  const ids = useId()
  const [otherSigner, setOtherSigner] = useState<PickedUser | null>(null)
  const { data: settings } = useQuery(warningSettingsQuery())
  const set = (patch: Partial<WarningDraft>) => onChange({ ...draft, ...patch })
  const signers = settings?.signers ?? []
  const signerKnown =
    draft.signerId === null || signers.some((person) => person.id === draft.signerId)
  const dateOf = (value: string) => formatDateTime(value, { locale })
  const labelId = (key: string) => `${ids}-${key}`

  const select = <T extends string>(
    key: string,
    value: T,
    values: readonly T[],
    group: string,
    onValue: (value: T) => void,
    render?: (value: T) => ReactNode,
  ) => (
    <Select value={value} onValueChange={(next) => onValue(next as T)}>
      <SelectTrigger aria-labelledby={labelId(key)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {values.map((item) => (
          <SelectItem key={item} value={item}>
            {render ? render(item) : t(`warnings.${group}.${item}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const effective = draft.effective ? dateOf(draft.effective) : t('warnings.params.fromPublication')
  const expires = draft.expires ? dateOf(draft.expires) : t('warnings.params.noExpiry')

  return (
    <Card title={t('warnings.params.title')} className={cn('min-w-0', className)} padded={false}>
      <dl className="flex flex-col px-4.5 py-1.5">
        <ParamRow id={labelId('severity')} label={t('warnings.fields.severity')}>
          {readOnly ? (
            <HazardBadge level={HAZARD_LEVEL[draft.severity]}>
              {t(`warnings.severity.${draft.severity}`)}
            </HazardBadge>
          ) : (
            select(
              'severity',
              draft.severity,
              CAP_SEVERITIES,
              'severity',
              (severity) => set({ severity }),
              (item) => (
                <span className="flex items-center gap-2">
                  <HazardMark level={HAZARD_LEVEL[item]} size="sm" />
                  {t(`warnings.severity.${item}`)}
                </span>
              ),
            )
          )}
        </ParamRow>
        <ParamRow id={labelId('urgency')} label={t('warnings.fields.urgency')}>
          {readOnly
            ? t(`warnings.urgency.${draft.urgency}`)
            : select('urgency', draft.urgency, CAP_URGENCIES, 'urgency', (urgency) =>
                set({ urgency }),
              )}
        </ParamRow>
        <ParamRow id={labelId('certainty')} label={t('warnings.fields.certainty')}>
          {readOnly
            ? t(`warnings.certainty.${draft.certainty}`)
            : select('certainty', draft.certainty, CAP_CERTAINTIES, 'certainty', (certainty) =>
                set({ certainty }),
              )}
        </ParamRow>
        {readOnly ? null : (
          <ParamRow id={labelId('capStatus')} label={t('warnings.fields.capStatus')}>
            {select('capStatus', draft.capStatus, CAP_STATUSES, 'capStatus', (capStatus) =>
              set({ capStatus }),
            )}
          </ParamRow>
        )}
        <ParamRow
          stacked={!readOnly}
          id={labelId('categories')}
          label={t('warnings.fields.categories')}
        >
          {readOnly ? (
            draft.categories.length > 0 ? (
              draft.categories.map((category) => t(`warnings.category.${category}`)).join(', ')
            ) : (
              '—'
            )
          ) : (
            <fieldset aria-labelledby={labelId('categories')} className="grid grid-cols-2 gap-1.5">
              {CAP_CATEGORIES.map((category) => (
                <Checkbox
                  key={category}
                  checked={draft.categories.includes(category)}
                  label={t(`warnings.category.${category}`)}
                  onCheckedChange={(on) =>
                    set({ categories: toggle(draft.categories, category, on === true) })
                  }
                />
              ))}
            </fieldset>
          )}
        </ParamRow>
        <ParamRow
          stacked={!readOnly}
          id={labelId('responseTypes')}
          label={t('warnings.fields.responseTypes')}
        >
          {readOnly ? (
            draft.responseTypes.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                {draft.responseTypes.map((type) => (
                  <Badge key={type} tone="neutral" size="sm">
                    {t(`warnings.responseType.${type}`)}
                  </Badge>
                ))}
              </span>
            ) : (
              '—'
            )
          ) : (
            <fieldset
              aria-labelledby={labelId('responseTypes')}
              className="grid grid-cols-2 gap-1.5"
            >
              {CAP_RESPONSE_TYPES.map((type) => (
                <Checkbox
                  key={type}
                  checked={draft.responseTypes.includes(type)}
                  label={t(`warnings.responseType.${type}`)}
                  onCheckedChange={(on) =>
                    set({ responseTypes: toggle(draft.responseTypes, type, on === true) })
                  }
                />
              ))}
            </fieldset>
          )}
        </ParamRow>
        <ParamRow stacked={!readOnly} id={labelId('effective')} label={t('warnings.params.period')}>
          {readOnly ? (
            <span className="tabular font-mono">
              {t('warnings.params.range', { from: effective, to: expires })}
            </span>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field
                label={t('warnings.fields.effective')}
                hint={t('warnings.fields.effectiveHint')}
              >
                <Input
                  type="datetime-local"
                  value={draft.effective ? toLocalInput(draft.effective, timeZone) : ''}
                  onChange={(event) =>
                    set({
                      effective: event.target.value
                        ? fromLocalInput(event.target.value, timeZone)
                        : null,
                    })
                  }
                />
              </Field>
              <Field label={t('warnings.fields.expires')}>
                <Input
                  type="datetime-local"
                  value={draft.expires ? toLocalInput(draft.expires, timeZone) : ''}
                  onChange={(event) =>
                    set({
                      expires: event.target.value
                        ? fromLocalInput(event.target.value, timeZone)
                        : null,
                    })
                  }
                />
              </Field>
            </div>
          )}
        </ParamRow>
        <ParamRow stacked={!readOnly} id={labelId('signer')} label={t('warnings.fields.signer')}>
          {readOnly ? (
            (warning.signer?.displayName ?? '—')
          ) : signers.length > 0 && otherSigner === null && signerKnown ? (
            <Select
              value={draft.signerId ?? ''}
              onValueChange={(value) => {
                if (value === OTHER) {
                  setOtherSigner({ id: '', title: '' })
                  return
                }
                set({ signerId: value })
              }}
            >
              <SelectTrigger aria-labelledby={labelId('signer')}>
                <SelectValue placeholder={t('warnings.card.signers')} />
              </SelectTrigger>
              <SelectContent>
                {signers.map((person) => (
                  <SelectItem key={person.id} value={person.id}>
                    {person.position
                      ? `${person.displayName} · ${person.position}`
                      : person.displayName}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER}>{t('warnings.card.otherSigner')}</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <UserPicker
              label={t('warnings.fields.signer')}
              value={
                otherSigner?.id
                  ? otherSigner
                  : draft.signerId && warning.signer?.id === draft.signerId
                    ? { id: warning.signer.id, title: warning.signer.displayName }
                    : null
              }
              onChange={(user) => {
                setOtherSigner(user)
                set({ signerId: user?.id ?? null })
              }}
            />
          )}
        </ParamRow>
      </dl>
    </Card>
  )
}

/** Территории областей с численностью населения — для таблицы, итога и проверки. */
export function useAreaTerritories(areas: WarningDraft['areas']) {
  const ids = [...new Set(areas.flatMap((area) => (area.territoryId ? [area.territoryId] : [])))]
  const details = useQueries({ queries: ids.map((id) => territoryQuery(id)) })
  const byId = new Map(
    details.flatMap((query) => (query.data ? [[query.data.id, query.data]] : [])),
  )
  const populations = areas.map((area) =>
    area.territoryId ? populationOf(byId.get(area.territoryId)?.attributes) : null,
  )
  const sources = [
    ...new Set(
      details.flatMap((query) => {
        const source = populationSourceOf(query.data?.attributes)
        return source ? [source] : []
      }),
    ),
  ]
  return {
    byId,
    populations,
    total: totalPopulation(populations),
    sources,
    loading: details.some((query) => query.isLoading),
  }
}

/**
 * Области (ADR-0202, ADR-0230): карта с заливкой цвета уровня и таблица территорий
 * справочника с кодом и населением, итог и источник численности. В черновике под
 * таблицей — правка состава.
 */
export function WarningAreasSection({
  draft,
  onChange,
  readOnly,
  className,
}: Omit<SectionProps, 'warning'>) {
  const t = useT()
  const locale = useLocale()
  const { data: territories = [] } = useQuery(warningTerritoriesQuery())
  const { byId, populations, total, sources, loading } = useAreaTerritories(draft.areas)
  const set = (patch: Partial<WarningDraft>) => onChange({ ...draft, ...patch })
  const nameOf = (item: { name: Territory['name'] }) =>
    (item.name as Record<string, string | undefined>)[locale] ?? item.name.ru
  const choices = territories
    .filter((item) => item.level !== 'settlement')
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  const number = (value: number) => value.toLocaleString(locale)
  const level = HAZARD_LEVEL[draft.severity]

  return (
    <section
      aria-label={t('warnings.fields.areas')}
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-sm @3xl:flex-row',
        className,
      )}
    >
      {draft.areas.length > 0 ? (
        <Suspense fallback={<Skeleton className="h-72 w-full @3xl:w-96" />}>
          <LazyAreasMap
            areas={draft.areas}
            level={level}
            label={t('warnings.areasTable.mapLabel')}
            className="h-72 w-full shrink-0 border-b border-line @3xl:h-auto @3xl:min-h-72 @3xl:w-96 @3xl:border-r @3xl:border-b-0"
          />
        </Suspense>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3 px-5 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-md font-semibold text-fg">{t('warnings.fields.areas')}</h2>
          <span className="text-xs text-fg-muted">{t('warnings.areasTable.reference')}</span>
        </div>

        {draft.areas.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('warnings.checks.areasMissing')}</p>
        ) : (
          <table className="w-full overflow-hidden rounded-md border border-line text-sm">
            <thead className="bg-surface-2 text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-3.5 py-2 text-left font-normal">
                  {t('warnings.areasTable.territory')}
                </th>
                <th scope="col" className="w-28 px-3.5 py-2 text-left font-normal">
                  {t('warnings.areasTable.code')}
                </th>
                <th scope="col" className="w-28 px-3.5 py-2 text-right font-normal">
                  {t('warnings.areasTable.population')}
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.areas.map((area, index) => {
                const territory = area.territoryId ? byId.get(area.territoryId) : undefined
                const population = populations[index]
                return (
                  <tr key={index} className="border-t border-line">
                    <td className="px-3.5 py-2.5">
                      <span className="flex items-center gap-2 font-medium">
                        <HazardMark level={level} size="sm" />
                        {territory
                          ? nameOf(territory)
                          : area.description || t('warnings.areasTable.own')}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5 font-mono text-xs text-fg-secondary">
                      {territory?.code ?? '—'}
                    </td>
                    <td className="tabular px-3.5 py-2.5 text-right font-mono">
                      {territory && loading
                        ? '…'
                        : typeof population === 'number'
                          ? number(population)
                          : '—'}
                    </td>
                  </tr>
                )
              })}
              <tr className="border-t border-line bg-surface-2">
                <th scope="row" className="px-3.5 py-2.5 text-left font-semibold">
                  {t('warnings.areasTable.total')}
                </th>
                <td />
                <td className="tabular px-3.5 py-2.5 text-right font-mono font-semibold">
                  {total !== null ? number(total) : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        )}

        <div className="flex flex-col gap-1 text-xs text-fg-muted">
          {sources.map((source) => (
            <p key={source}>{t('warnings.areasTable.source', { source })}</p>
          ))}
          <p>{t('warnings.areasTable.notice')}</p>
        </div>

        {readOnly ? null : (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            {draft.areas.map((area, index) => (
              <div
                key={index}
                className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface-2 p-2"
              >
                <Field label={t('warnings.area.territory')} className="min-w-56 flex-1">
                  <Select
                    value={area.territoryId ?? NO_TERRITORY}
                    onValueChange={(value) =>
                      set({
                        areas: draft.areas.map((item, position) =>
                          position === index
                            ? { ...item, territoryId: value === NO_TERRITORY ? null : value }
                            : item,
                        ),
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_TERRITORY}>{t('warnings.area.none')}</SelectItem>
                      {choices.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {nameOf(item)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('warnings.area.description')} className="min-w-56 flex-1">
                  <Input
                    value={area.description}
                    maxLength={500}
                    onChange={(event) =>
                      set({
                        areas: draft.areas.map((item, position) =>
                          position === index ? { ...item, description: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </Field>
                {area.polygon ? (
                  <span className="pb-2 text-xs text-fg-muted">
                    {t('warnings.area.polygon', { count: area.polygon.length })}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<X className="size-3.5" />}
                  onClick={() =>
                    set({ areas: draft.areas.filter((_, position) => position !== index) })
                  }
                >
                  {t('warnings.area.remove')}
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus className="size-3.5" />}
                onClick={() =>
                  set({
                    areas: [...draft.areas, { territoryId: null, description: '', polygon: null }],
                  })
                }
              >
                {t('warnings.area.add')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
