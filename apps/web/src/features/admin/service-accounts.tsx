import {
  type AdminUser,
  SERVICE_ACCOUNT_SPACE_ROLES,
  type ServiceAccount,
  type ServiceAccountSpace,
} from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, MoreHorizontal, Pencil, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import {
  adminSpacesQuery,
  keys,
  meQuery,
  orgUnitsQuery,
  rolesQuery,
  spacesQuery,
} from '~/shared/api/queries.js'
import { unitOptions } from './user-management.js'

const NO_UNIT = '__none__'

/** Роль служебной записи в пространстве: администратором она не бывает (ADR-0130). */
type SpaceRoleChoice = (typeof SERVICE_ACCOUNT_SPACE_ROLES)[number]

interface FormState {
  name: string
  description: string
  unitId: string
  roleKeys: string[]
  spaces: ServiceAccountSpace[]
}

const EMPTY: FormState = {
  name: '',
  description: '',
  unitId: NO_UNIT,
  roleKeys: ['employee'],
  spaces: [],
}

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
}

function stateOf(account: ServiceAccount): FormState {
  return {
    name: account.name,
    description: account.description ?? '',
    unitId: account.unit?.id ?? NO_UNIT,
    roleKeys: account.roles,
    spaces: account.spaces.map((item) => ({
      spaceId: item.spaceId,
      // Роль администратора служебной записи не выдаётся — правится до «редактора»
      role: (SERVICE_ACCOUNT_SPACE_ROLES as readonly string[]).includes(item.role)
        ? (item.role as SpaceRoleChoice)
        : 'editor',
    })),
  }
}

/**
 * Пространства на выбор: администратору системы — все, остальным — свои; право
 * пригласить в пространство всё равно проверяет сервер.
 */
function useSpaceChoices() {
  const { data: me } = useQuery(meQuery())
  const isSystemAdmin = me?.capabilities.includes('admin.system') ?? false
  const all = useQuery({ ...adminSpacesQuery({}), enabled: isSystemAdmin })
  const mine = useQuery({ ...spacesQuery(), enabled: !isSystemAdmin })
  const items = isSystemAdmin
    ? (all.data ?? []).map((space) => ({ id: space.id, name: space.name, kind: space.kind }))
    : (mine.data ?? []).map((space) => ({ id: space.id, name: space.name, kind: space.kind }))
  return items.filter((space) => space.kind !== 'personal')
}

/**
 * Новая или существующая служебная учётная запись (ADR-0130): название,
 * назначение, роли, подразделение и пространства. Пароля нет — войти ею нельзя,
 * от её имени работают правила и интеграции.
 */
export function ServiceAccountDialog({
  accountId,
  open,
  onOpenChange,
  onSaved,
}: {
  /** `null` — новая запись. */
  accountId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (account: ServiceAccount) => void
}) {
  const t = useT()
  const formId = useId()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const { data: units = [] } = useQuery(orgUnitsQuery())
  const { data: roles = [] } = useQuery(rolesQuery())
  const spaces = useSpaceChoices()
  const existing = useQuery({
    queryKey: [...keys.serviceAccounts, accountId],
    queryFn: () => http.get<ServiceAccount>(`/service-accounts/${accountId}`),
    enabled: open && accountId !== null,
  })
  const [form, setForm] = useState<FormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState('')

  useEffect(() => {
    if (!open) return
    setError(null)
    setAdding('')
    setForm(accountId && existing.data ? stateOf(existing.data) : EMPTY)
  }, [open, accountId, existing.data])

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        unitId: form.unitId === NO_UNIT ? null : form.unitId,
        roleKeys: form.roleKeys,
        spaces: form.spaces,
      }
      return accountId
        ? http.patch<ServiceAccount>(`/service-accounts/${accountId}`, payload)
        : http.post<ServiceAccount>('/service-accounts', payload)
    },
    onSuccess: async (account) => {
      await client.invalidateQueries({ queryKey: ['users'] })
      onSaved(account)
      onOpenChange(false)
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  const set = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }))
  const nameOf = (spaceId: string) =>
    spaces.find((space) => space.id === spaceId)?.name ??
    existing.data?.spaces.find((space) => space.spaceId === spaceId)?.title ??
    spaceId
  const available = spaces.filter((space) => !form.spaces.some((item) => item.spaceId === space.id))
  const loading = accountId !== null && existing.isLoading

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={accountId ? t('admin.serviceAccounts.editTitle') : t('admin.serviceAccounts.create')}
        description={t('admin.serviceAccounts.hint')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!form.name.trim() || loading}
              loading={save.isPending}
            >
              {accountId ? t('common.actions.save') : t('common.actions.create')}
            </Button>
          </>
        }
      >
        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <form
            id={formId}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (form.name.trim()) save.mutate()
            }}
          >
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <Field label={t('admin.serviceAccounts.name')} required htmlFor={`${formId}-name`}>
              <Input
                id={`${formId}-name`}
                autoFocus
                maxLength={200}
                value={form.name}
                placeholder={t('admin.serviceAccounts.namePlaceholder')}
                onChange={(event) => set({ name: event.target.value })}
              />
            </Field>
            <Field
              label={t('admin.serviceAccounts.description')}
              hint={t('admin.serviceAccounts.descriptionHint')}
              htmlFor={`${formId}-description`}
            >
              <Textarea
                id={`${formId}-description`}
                rows={2}
                maxLength={1000}
                value={form.description}
                onChange={(event) => set({ description: event.target.value })}
              />
            </Field>
            <Field label={t('common.labels.unit')}>
              <Select value={form.unitId} onValueChange={(next) => set({ unitId: next })}>
                <SelectTrigger aria-label={t('common.labels.unit')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_UNIT}>{t('admin.users.fields.noUnit')}</SelectItem>
                  {unitOptions(units, locale).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {`${' '.repeat(option.depth)}${option.label}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label={t('admin.users.fields.roles')}
              hint={t('admin.serviceAccounts.rolesHint')}
            >
              <div className="grid gap-1.5 sm:grid-cols-2">
                {roles
                  .filter((role) => role.key !== 'system_admin')
                  .map((role) => (
                    <Checkbox
                      key={role.key}
                      id={`${formId}-role-${role.key}`}
                      checked={form.roleKeys.includes(role.key)}
                      onCheckedChange={(next) =>
                        set({
                          roleKeys:
                            next === true
                              ? [...form.roleKeys, role.key]
                              : form.roleKeys.filter((key) => key !== role.key),
                        })
                      }
                      label={localizedText(role.name, locale)}
                    />
                  ))}
              </div>
            </Field>
            <Field
              label={t('admin.serviceAccounts.spaces')}
              hint={t('admin.serviceAccounts.spacesHint')}
            >
              <div className="flex flex-col gap-1.5">
                {form.spaces.map((item) => (
                  <div key={item.spaceId} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {nameOf(item.spaceId)}
                    </span>
                    <Select
                      value={item.role}
                      onValueChange={(next) =>
                        set({
                          spaces: form.spaces.map((space) =>
                            space.spaceId === item.spaceId
                              ? { ...space, role: next as SpaceRoleChoice }
                              : space,
                          ),
                        })
                      }
                    >
                      <SelectTrigger
                        className="w-40"
                        aria-label={t('admin.serviceAccounts.spaceRole', {
                          space: nameOf(item.spaceId),
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SERVICE_ACCOUNT_SPACE_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {t(`access.spaceRoles.${role}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label={t('admin.serviceAccounts.removeSpace', {
                        space: nameOf(item.spaceId),
                      })}
                      onClick={() =>
                        set({
                          spaces: form.spaces.filter((space) => space.spaceId !== item.spaceId),
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                ))}
                {available.length > 0 ? (
                  <Select
                    value={adding}
                    onValueChange={(next) => {
                      set({ spaces: [...form.spaces, { spaceId: next, role: 'editor' }] })
                      setAdding('')
                    }}
                  >
                    <SelectTrigger aria-label={t('admin.serviceAccounts.addSpace')}>
                      <SelectValue placeholder={t('admin.serviceAccounts.addSpace')} />
                    </SelectTrigger>
                    <SelectContent>
                      {available.map((space) => (
                        <SelectItem key={space.id} value={space.id}>
                          {space.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
            </Field>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Действия служебной записи в консоли: правка и блокировка (пароля и MFA у неё нет). */
export function ServiceAccountActions({
  user,
  onChanged,
}: {
  user: AdminUser
  onChanged: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [editing, setEditing] = useState(false)

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'blocked') =>
      http.patch(`/service-accounts/${user.id}`, { status }),
    onSuccess: (_result, status) => {
      toast.show({
        title: status === 'blocked' ? t('admin.users.blocked') : t('admin.users.unblocked'),
        tone: 'info',
      })
      onChanged()
    },
    onError: (err) => toast.error(problemMessage(err, t('errors.unknown'))),
  })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="sm" label={t('admin.users.actions', { name: user.displayName })}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<Pencil className="size-4" />} onSelect={() => setEditing(true)}>
            {t('common.actions.edit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {user.status === 'blocked' ? (
            <DropdownMenuItem
              icon={<ShieldCheck className="size-4" />}
              onSelect={() => setStatus.mutate('active')}
            >
              {t('admin.users.unblock')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              danger
              icon={<Ban className="size-4" />}
              onSelect={() => setStatus.mutate('blocked')}
            >
              {t('admin.users.block')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ServiceAccountDialog
        accountId={user.id}
        open={editing}
        onOpenChange={setEditing}
        onSaved={() => {
          toast.show({ title: t('admin.serviceAccounts.saved'), tone: 'success' })
          onChanged()
        }}
      />
    </>
  )
}
