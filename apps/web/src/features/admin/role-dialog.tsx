import {
  type Capability,
  CUSTOM_ROLE_FORBIDDEN,
  PRIVILEGED_CAPABILITIES,
  type RoleInfo,
} from '@kchs/contracts'
import {
  AlertDialog,
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  Input,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery, rolesQuery } from '~/shared/api/queries.js'
import { CAPABILITY_GROUPS, capabilityLabelKey } from './capabilities.js'

/**
 * Своя роль организации (ADR-0165): название на трёх языках, описание и способности.
 * Выдать можно только то, что есть у самого администратора; администрирование системы —
 * только у системной роли, привилегированные способности — у администратора системы.
 * Проверяет всё это сервер, здесь недоступное просто не отмечается.
 */
export function RoleDialog({ role, onClose }: { role: RoleInfo | null; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const { data: me } = useQuery(meQuery())
  const [form, setForm] = useState({
    ru: role?.name.ru ?? '',
    tg: role?.name.tg ?? '',
    en: role?.name.en ?? '',
    description: role?.description ?? '',
    capabilities: new Set<string>(role?.capabilities ?? []),
  })
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const isSystemAdmin = me?.roles?.includes('system_admin') ?? false
  const mine = new Set<string>(me?.capabilities ?? [])

  const unavailable = (capability: Capability): string | null => {
    if (CUSTOM_ROLE_FORBIDDEN.includes(capability)) return t('admin.roles.onlySystemRole')
    if (isSystemAdmin) return null
    if (PRIVILEGED_CAPABILITIES.includes(capability)) return t('admin.roles.onlySystemAdmin')
    if (!mine.has(capability)) return t('admin.roles.notYours')
    return null
  }

  const done = (message: string) => {
    toast.show({ title: message, tone: 'success' })
    void client.invalidateQueries({ queryKey: rolesQuery().queryKey })
    void client.invalidateQueries({ queryKey: meQuery().queryKey })
    onClose()
  }
  const failed = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : t('errors.unknown'))

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: {
          ru: form.ru.trim(),
          ...(form.tg.trim() ? { tg: form.tg.trim() } : {}),
          ...(form.en.trim() ? { en: form.en.trim() } : {}),
        },
        description: form.description.trim() || null,
        capabilities: [...form.capabilities],
      }
      return role ? http.patch(`/roles/${role.id}`, body) : http.post('/roles', body)
    },
    onSuccess: () => done(t('admin.roles.saved')),
    onError: failed,
  })
  const remove = useMutation({
    mutationFn: () => http.delete(`/roles/${role?.id}`),
    onSuccess: () => done(t('admin.roles.deleted')),
    onError: (err) => {
      setRemoving(false)
      failed(err)
    },
  })

  const toggle = (capability: string, on: boolean) =>
    setForm((current) => {
      const next = new Set(current.capabilities)
      if (on) next.add(capability)
      else next.delete(capability)
      return { ...current, capabilities: next }
    })

  return (
    <>
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent
          title={role ? t('admin.roles.editTitle') : t('admin.roles.createTitle')}
          size="lg"
          footer={
            <>
              {role ? (
                <Button variant="ghost" className="mr-auto" onClick={() => setRemoving(true)}>
                  {t('common.actions.delete')}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={onClose}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={save.isPending}
                disabled={form.ru.trim().length === 0}
                onClick={() => save.mutate()}
              >
                {t('common.actions.save')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('admin.org.fields.nameRu')} required htmlFor={`${formId}-ru`}>
                <Input
                  id={`${formId}-ru`}
                  value={form.ru}
                  onChange={(event) => setForm({ ...form, ru: event.target.value })}
                />
              </Field>
              <Field label={t('admin.org.fields.nameTg')} htmlFor={`${formId}-tg`}>
                <Input
                  id={`${formId}-tg`}
                  value={form.tg}
                  onChange={(event) => setForm({ ...form, tg: event.target.value })}
                />
              </Field>
              <Field label={t('admin.org.fields.nameEn')} htmlFor={`${formId}-en`}>
                <Input
                  id={`${formId}-en`}
                  value={form.en}
                  onChange={(event) => setForm({ ...form, en: event.target.value })}
                />
              </Field>
            </div>
            <Field label={t('admin.roles.description')} htmlFor={`${formId}-description`}>
              <Textarea
                id={`${formId}-description`}
                rows={2}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </Field>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-medium text-fg">
                {t('admin.roles.capabilitiesTitle')}
              </legend>
              {CAPABILITY_GROUPS.map((group) => (
                <div key={group.key} className="flex flex-col gap-1.5">
                  <p className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
                    {t(`admin.capabilityGroups.${group.key}`)}
                  </p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {group.capabilities.map((capability) => {
                      const reason = unavailable(capability)
                      const checked = form.capabilities.has(capability)
                      return (
                        <div key={capability} className="flex flex-col">
                          <Checkbox
                            id={`${formId}-${capability}`}
                            checked={checked}
                            // Отмеченную раньше недоступную можно снять, но не отметить снова
                            disabled={reason !== null && !checked}
                            onCheckedChange={(next) => toggle(capability, next === true)}
                            label={t(capabilityLabelKey(capability))}
                          />
                          {reason ? (
                            <span className="ml-6 text-2xs text-fg-muted">{reason}</span>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </fieldset>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('admin.roles.deleteTitle', { name: role?.name.ru ?? '' })}
        description={t('admin.roles.deleteHint')}
        confirmLabel={t('common.actions.delete')}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  )
}
