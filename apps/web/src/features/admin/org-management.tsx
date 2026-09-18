import { ORG_UNIT_KINDS, type OrgUnitKind } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { orgUnitsQuery } from '~/shared/api/queries.js'
import { unitOptions } from './user-management.js'

const TOP_LEVEL = '__root__'

/** Новое подразделение (P0-E04 S01): название на трёх языках, код, вид, место в дереве. */
export function CreateUnitDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const t = useT()
  const formId = useId()
  const locale = useAppearance((s) => s.locale)
  const { data: units = [] } = useQuery(orgUnitsQuery())
  const empty = {
    ru: '',
    tg: '',
    en: '',
    code: '',
    kind: 'department' as OrgUnitKind,
    parentId: TOP_LEVEL,
    createSpace: true,
  }
  const [form, setForm] = useState(empty)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }))

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setForm(empty)
      setError(null)
    }
  }

  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/org/units', {
        name: {
          ru: form.ru.trim(),
          ...(form.tg.trim() ? { tg: form.tg.trim() } : {}),
          ...(form.en.trim() ? { en: form.en.trim() } : {}),
        },
        code: form.code.trim(),
        kind: form.kind,
        parentId: form.parentId === TOP_LEVEL ? null : form.parentId,
        createSpace: form.createSpace,
      }),
    onSuccess: () => {
      onCreated()
      close(false)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const valid = form.ru.trim() && form.code.trim()

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={t('admin.org.createUnit')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!valid}
              loading={create.isPending}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) create.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('admin.org.fields.nameRu')} required htmlFor={`${formId}-ru`}>
            <Input
              id={`${formId}-ru`}
              autoFocus
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
            <Field
              label={t('admin.org.fields.code')}
              hint={t('admin.org.fields.codeHint')}
              required
              htmlFor={`${formId}-code`}
            >
              <Input
                id={`${formId}-code`}
                mono
                value={form.code}
                onChange={(event) => set({ code: event.target.value })}
              />
            </Field>
            <Field label={t('admin.org.fields.kind')}>
              <Select
                value={form.kind}
                onValueChange={(next) => set({ kind: next as OrgUnitKind })}
              >
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
                {unitOptions(units, locale).map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {`${' '.repeat(option.depth)}${option.label}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{t('admin.org.fields.createSpace')}</p>
              <p className="text-xs text-fg-secondary">{t('admin.org.fields.createSpaceHint')}</p>
            </div>
            <Switch
              checked={form.createSpace}
              onCheckedChange={(next) => set({ createSpace: next })}
              aria-label={t('admin.org.fields.createSpace')}
            />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
