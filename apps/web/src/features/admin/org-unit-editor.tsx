import type { AdminUser, OrgUnit, OrgUnitKind } from '@kchs/contracts'
import { ORG_UNIT_KINDS } from '@kchs/contracts'
import {
  Button,
  Callout,
  Card,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, orgUnitsQuery, usersQuery } from '~/shared/api/queries.js'
import { TOP_LEVEL } from './org-management.js'
import { unitOptions } from './user-management.js'

/** Никого не назначать руководителем — значение списка, а не пустая строка. */
const NO_HEAD = 'none'

/**
 * Правка подразделения (P0-E04, 15-admin-operations.md §1): название на трёх
 * языках, код, вид, место в дереве, руководитель и признак действующего.
 * Консоль умела только заводить подразделения — изменить их можно было лишь
 * запросом к API (вопрос N86).
 */
export function OrgUnitEditor({ unitId }: { unitId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const locale = useAppearance((s) => s.locale)
  const { data: units = [] } = useQuery(orgUnitsQuery())
  const { data: people } = useQuery(usersQuery({ limit: 200 }))
  const unit = units.find((item) => item.id === unitId)

  const [form, setForm] = useState(() => toForm(unit))
  const [error, setError] = useState<string | null>(null)
  // Выбрали другое подразделение — форма показывает его, а не прежнее
  useEffect(() => setForm(toForm(unit)), [unit])

  const set = (patch: Partial<ReturnType<typeof toForm>>) =>
    setForm((current) => ({ ...current, ...patch }))

  const save = useMutation({
    mutationFn: () =>
      http.patch(`/org/units/${unitId}`, {
        name: {
          ru: form.ru.trim(),
          ...(form.tg.trim() ? { tg: form.tg.trim() } : {}),
          ...(form.en.trim() ? { en: form.en.trim() } : {}),
        },
        code: form.code.trim(),
        kind: form.kind,
        parentId: form.parentId === TOP_LEVEL ? null : form.parentId,
        headUserId: form.headUserId === NO_HEAD ? null : form.headUserId,
        isActive: form.isActive,
      }),
    onSuccess: () => {
      setError(null)
      toast.show({ title: t('admin.org.saved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: keys.orgUnits })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  if (!unit) return null
  const valid = form.ru.trim().length > 0 && form.code.trim().length > 0
  // Подразделение не может стать потомком самого себя
  const parents = unitOptions(units, locale).filter((option) => option.id !== unitId)

  return (
    <Card title={t('admin.org.editUnit')} role="group" aria-label={t('admin.org.editUnit')}>
      <form
        id={formId}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) save.mutate()
        }}
      >
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <Field label={t('admin.org.fields.nameRu')} required htmlFor={`${formId}-ru`}>
          <Input
            id={`${formId}-ru`}
            value={form.ru}
            onChange={(event) => set({ ru: event.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('admin.org.fields.nameTg')} htmlFor={`${formId}-tg`}>
            <Input
              id={`${formId}-tg`}
              value={form.tg}
              onChange={(event) => set({ tg: event.target.value })}
            />
          </Field>
          <Field label={t('admin.org.fields.nameEn')} htmlFor={`${formId}-en`}>
            <Input
              id={`${formId}-en`}
              value={form.en}
              onChange={(event) => set({ en: event.target.value })}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('admin.org.fields.code')} required htmlFor={`${formId}-code`}>
            <Input
              id={`${formId}-code`}
              mono
              value={form.code}
              onChange={(event) => set({ code: event.target.value })}
            />
          </Field>
          <Field label={t('admin.org.fields.kind')}>
            <Select value={form.kind} onValueChange={(next) => set({ kind: next as OrgUnitKind })}>
              <SelectTrigger aria-label={t('admin.org.fields.kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORG_UNIT_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`admin.org.kinds.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label={t('admin.org.fields.parent')}>
          <Select value={form.parentId} onValueChange={(next) => set({ parentId: next })}>
            <SelectTrigger aria-label={t('admin.org.fields.parent')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOP_LEVEL}>{t('admin.org.fields.topLevel')}</SelectItem>
              {parents.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {`${' '.repeat(option.depth)}${option.label}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('admin.org.fields.head')} hint={t('admin.org.fields.headHint')}>
          <Select value={form.headUserId} onValueChange={(next) => set({ headUserId: next })}>
            <SelectTrigger aria-label={t('admin.org.fields.head')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_HEAD}>{t('admin.org.fields.noHead')}</SelectItem>
              {(people?.items ?? []).map((person: AdminUser) => (
                <SelectItem key={person.id} value={person.id}>
                  {person.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">{t('admin.org.fields.active')}</p>
            <p className="text-xs text-fg-secondary">{t('admin.org.fields.activeHint')}</p>
          </div>
          <Switch
            checked={form.isActive}
            onCheckedChange={(next) => set({ isActive: next })}
            aria-label={t('admin.org.fields.active')}
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!valid} loading={save.isPending}>
            {t('common.actions.save')}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function toForm(unit: OrgUnit | undefined) {
  return {
    ru: unit?.name.ru ?? '',
    tg: unit?.name.tg ?? '',
    en: unit?.name.en ?? '',
    code: unit?.code ?? '',
    kind: (unit?.kind ?? 'department') as OrgUnitKind,
    parentId: unit?.parentId ?? TOP_LEVEL,
    headUserId: unit?.head?.id ?? NO_HEAD,
    isActive: unit?.isActive ?? true,
  }
}
