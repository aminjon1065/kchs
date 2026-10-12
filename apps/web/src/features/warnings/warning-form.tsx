import {
  CAP_CATEGORIES,
  CAP_CERTAINTIES,
  CAP_RESPONSE_TYPES,
  CAP_SEVERITIES,
  CAP_STATUSES,
  CAP_URGENCIES,
  type WarningInfo,
  type WarningLanguage,
  type WarningRecord,
} from '@kchs/contracts'
import {
  Button,
  Checkbox,
  Field,
  fromLocalInput,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toLocalInput,
  useUiTimeZone,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { type PickedUser, UserPicker } from '~/entities/people/user-picker.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { warningSettingsQuery, warningTerritoriesQuery } from './queries.js'

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

/**
 * Содержание предупреждения (ADR-0202): блоки на трёх языках, оценка CAP,
 * категории и что делать, срок действия, области и подписывающий. Вне черновика —
 * только чтение.
 */
export function WarningForm({
  warning,
  draft,
  onChange,
  readOnly,
}: {
  warning: WarningRecord
  draft: WarningDraft
  onChange: (next: WarningDraft) => void
  readOnly: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const timeZone = useUiTimeZone()
  const [language, setLanguage] = useState<WarningLanguage>('tg')
  const [otherSigner, setOtherSigner] = useState<PickedUser | null>(null)
  const { data: settings } = useQuery(warningSettingsQuery())
  const { data: territories = [] } = useQuery(warningTerritoriesQuery())
  const info = draft.info[language] ?? EMPTY_INFO
  const set = (patch: Partial<WarningDraft>) => onChange({ ...draft, ...patch })
  const setInfo = (patch: Partial<WarningInfo>) =>
    set({ info: { ...draft.info, [language]: { ...info, ...patch } } })
  const nameOf = (item: { name: Record<string, string | undefined> & { ru: string } }) =>
    item.name[locale] ?? item.name.ru
  const choices = territories
    .filter((item) => item.level !== 'settlement')
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  const signers = settings?.signers ?? []
  const signerKnown =
    draft.signerId === null || signers.some((person) => person.id === draft.signerId)

  const select = <T extends string>(
    label: string,
    value: T,
    values: readonly T[],
    group: string,
    onValue: (value: T) => void,
  ) => (
    <Field label={label}>
      <Select value={value} onValueChange={(next) => onValue(next as T)} disabled={readOnly}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {t(`warnings.${group}.${item}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <SegmentedControl
          aria-label={t('warnings.fields.language')}
          value={language}
          onValueChange={(value) => setLanguage(value as WarningLanguage)}
          options={(['tg', 'ru', 'en'] as const).map((value) => ({
            value,
            label: t(`warnings.languages.${value}`),
          }))}
        />
        <Field label={t('warnings.info.event')}>
          <Input
            value={info.event}
            readOnly={readOnly}
            maxLength={200}
            onChange={(event) => setInfo({ event: event.target.value })}
          />
        </Field>
        <Field label={t('warnings.info.headline')} hint={t('warnings.info.headlineHint')}>
          <Input
            value={info.headline}
            readOnly={readOnly}
            maxLength={160}
            onChange={(event) => setInfo({ headline: event.target.value })}
          />
        </Field>
        <Field label={t('warnings.info.description')}>
          <Textarea
            value={info.description}
            readOnly={readOnly}
            rows={4}
            onChange={(event) => setInfo({ description: event.target.value })}
          />
        </Field>
        <Field label={t('warnings.info.instruction')}>
          <Textarea
            value={info.instruction}
            readOnly={readOnly}
            rows={3}
            onChange={(event) => setInfo({ instruction: event.target.value })}
          />
        </Field>
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {select(t('warnings.fields.urgency'), draft.urgency, CAP_URGENCIES, 'urgency', (urgency) =>
          set({ urgency }),
        )}
        {select(
          t('warnings.fields.severity'),
          draft.severity,
          CAP_SEVERITIES,
          'severity',
          (severity) => set({ severity }),
        )}
        {select(
          t('warnings.fields.certainty'),
          draft.certainty,
          CAP_CERTAINTIES,
          'certainty',
          (certainty) => set({ certainty }),
        )}
        {select(
          t('warnings.fields.capStatus'),
          draft.capStatus,
          CAP_STATUSES,
          'capStatus',
          (capStatus) => set({ capStatus }),
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-fg-secondary">
            {t('warnings.fields.categories')}
          </legend>
          <div className="grid grid-cols-2 gap-1.5">
            {CAP_CATEGORIES.map((category) => (
              <Checkbox
                key={category}
                checked={draft.categories.includes(category)}
                disabled={readOnly}
                label={t(`warnings.category.${category}`)}
                onCheckedChange={(on) =>
                  set({ categories: toggle(draft.categories, category, on === true) })
                }
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-fg-secondary">
            {t('warnings.fields.responseTypes')}
          </legend>
          <div className="grid grid-cols-2 gap-1.5">
            {CAP_RESPONSE_TYPES.map((type) => (
              <Checkbox
                key={type}
                checked={draft.responseTypes.includes(type)}
                disabled={readOnly}
                label={t(`warnings.responseType.${type}`)}
                onCheckedChange={(on) =>
                  set({ responseTypes: toggle(draft.responseTypes, type, on === true) })
                }
              />
            ))}
          </div>
        </fieldset>
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label={t('warnings.fields.effective')} hint={t('warnings.fields.effectiveHint')}>
          <Input
            type="datetime-local"
            readOnly={readOnly}
            value={draft.effective ? toLocalInput(draft.effective, timeZone) : ''}
            onChange={(event) =>
              set({
                effective: event.target.value ? fromLocalInput(event.target.value, timeZone) : null,
              })
            }
          />
        </Field>
        <Field label={t('warnings.fields.expires')}>
          <Input
            type="datetime-local"
            readOnly={readOnly}
            value={draft.expires ? toLocalInput(draft.expires, timeZone) : ''}
            onChange={(event) =>
              set({
                expires: event.target.value ? fromLocalInput(event.target.value, timeZone) : null,
              })
            }
          />
        </Field>
        <Field label={t('warnings.fields.signer')}>
          {readOnly ? (
            <Input value={warning.signer?.displayName ?? '—'} readOnly />
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
              <SelectTrigger>
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
        </Field>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-fg-secondary">{t('warnings.fields.areas')}</h3>
        {draft.areas.map((area, index) => (
          <div
            key={index}
            className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface p-2"
          >
            <Field label={t('warnings.area.territory')} className="min-w-56 flex-1">
              <Select
                value={area.territoryId ?? NO_TERRITORY}
                disabled={readOnly}
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
                readOnly={readOnly}
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
            {readOnly ? null : (
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
            )}
          </div>
        ))}
        {readOnly ? null : (
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
        )}
      </section>
    </div>
  )
}
