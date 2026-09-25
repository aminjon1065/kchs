import {
  type AdminUser,
  CONFIDENTIALITY_LEVELS,
  type Confidentiality,
  DEFAULT_CLEARANCE,
  type OrgUnit,
} from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import {
  AlertDialog,
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
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  Copy,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  ShieldCheck,
  ShieldOff,
  UserCog,
} from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery, orgUnitsQuery, rolesQuery } from '~/shared/api/queries.js'
import { UserPasskeysDialog } from './user-passkeys-dialog.js'

const NO_UNIT = '__none__'

/** Подразделения в порядке дерева — для выбора с отступом по уровню. */
export function unitOptions(units: OrgUnit[], locale: Parameters<typeof localizedText>[1]) {
  const children = new Map<string | null, OrgUnit[]>()
  for (const unit of units) {
    const list = children.get(unit.parentId) ?? []
    list.push(unit)
    children.set(unit.parentId, list)
  }
  const result: Array<{ id: string; label: string; depth: number }> = []
  const walk = (parentId: string | null, depth: number) => {
    const list = (children.get(parentId) ?? []).sort((a, b) => a.sort - b.sort)
    for (const unit of list) {
      result.push({ id: unit.id, label: localizedText(unit.name, locale), depth })
      walk(unit.id, depth + 1)
    }
  }
  walk(null, 0)
  return result
}

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
}

/** Временный пароль показывается один раз: копировать и передать сотруднику. */
function TemporaryPassword({ password }: { password: string }) {
  const t = useT()
  const toast = useToast()
  return (
    <Callout tone="warning">
      <div className="flex flex-col gap-2">
        <span>{t('admin.users.tempPasswordHint')}</span>
        <div className="flex items-center gap-1.5">
          <code className="rounded-xs bg-surface px-2 py-1 font-mono text-sm text-fg">
            {password}
          </code>
          <IconButton
            size="sm"
            label={t('common.actions.copy')}
            onClick={() => {
              void navigator.clipboard.writeText(password)
              toast.show({ title: t('admin.users.passwordCopied'), tone: 'success' })
            }}
          >
            <Copy className="size-3.5" />
          </IconButton>
        </div>
      </div>
    </Callout>
  )
}

function RolePicker({
  value,
  onChange,
  idPrefix,
}: {
  value: string[]
  onChange: (next: string[]) => void
  idPrefix: string
}) {
  const locale = useAppearance((s) => s.locale)
  const { data: roles = [] } = useQuery(rolesQuery())
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {roles.map((role) => (
        <Checkbox
          key={role.key}
          id={`${idPrefix}-${role.key}`}
          checked={value.includes(role.key)}
          onCheckedChange={(next) =>
            onChange(next === true ? [...value, role.key] : value.filter((key) => key !== role.key))
          }
          label={localizedText(role.name, locale)}
        />
      ))}
    </div>
  )
}

/** Новый сотрудник (P0-E04 S04): учётная запись с временным паролем и ролями. */
export function CreateUserDialog({
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
    lastName: '',
    firstName: '',
    middleName: '',
    login: '',
    email: '',
    unitId: NO_UNIT,
    roleKeys: ['employee'],
  }
  const [form, setForm] = useState(empty)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState<string | null>(null)

  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setForm(empty)
      setError(null)
      setPassword(null)
    }
  }

  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string; temporaryPassword: string | null }>('/users', {
        login: form.login.trim(),
        lastName: form.lastName.trim(),
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim() || null,
        email: form.email.trim() || null,
        unitId: form.unitId === NO_UNIT ? null : form.unitId,
        roleKeys: form.roleKeys,
        mustChangePassword: true,
      }),
    onSuccess: (result) => {
      setError(null)
      setPassword(result.temporaryPassword)
      onCreated()
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }))
  const valid = form.lastName.trim() && form.firstName.trim() && form.login.trim().length >= 3

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={t('admin.users.create')}
        size="md"
        footer={
          password ? (
            <Button variant="primary" onClick={() => close(false)}>
              {t('common.actions.done')}
            </Button>
          ) : (
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
          )
        }
      >
        {password ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg">{t('admin.users.created', { login: form.login })}</p>
            <TemporaryPassword password={password} />
          </div>
        ) : (
          <form
            id={formId}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (valid) create.mutate()
            }}
          >
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('admin.users.fields.lastName')} required htmlFor={`${formId}-last`}>
                <Input
                  id={`${formId}-last`}
                  autoFocus
                  value={form.lastName}
                  onChange={(event) => set({ lastName: event.target.value })}
                />
              </Field>
              <Field label={t('admin.users.fields.firstName')} required htmlFor={`${formId}-first`}>
                <Input
                  id={`${formId}-first`}
                  value={form.firstName}
                  onChange={(event) => set({ firstName: event.target.value })}
                />
              </Field>
              <Field label={t('admin.users.fields.middleName')} htmlFor={`${formId}-middle`}>
                <Input
                  id={`${formId}-middle`}
                  value={form.middleName}
                  onChange={(event) => set({ middleName: event.target.value })}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t('common.labels.login')}
                hint={t('admin.users.fields.loginHint')}
                required
                htmlFor={`${formId}-login`}
              >
                <Input
                  id={`${formId}-login`}
                  mono
                  autoComplete="off"
                  value={form.login}
                  onChange={(event) => set({ login: event.target.value })}
                />
              </Field>
              <Field label={t('common.labels.email')} htmlFor={`${formId}-email`}>
                <Input
                  id={`${formId}-email`}
                  type="email"
                  value={form.email}
                  onChange={(event) => set({ email: event.target.value })}
                />
              </Field>
            </div>
            <Field label={t('common.labels.unit')}>
              <Select value={form.unitId} onValueChange={(next) => set({ unitId: next })}>
                <SelectTrigger aria-label={t('common.labels.unit')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_UNIT}>{t('admin.users.fields.noUnit')}</SelectItem>
                  {unitOptions(units, locale).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {`${' '.repeat(option.depth)}${option.label}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('admin.users.fields.roles')}>
              <RolePicker
                value={form.roleKeys}
                onChange={(roleKeys) => set({ roleKeys })}
                idPrefix={`${formId}-role`}
              />
            </Field>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Роли и обслуживание учётной записи: блокировка, временный пароль, сброс MFA. */
export function UserActions({ user, onChanged }: { user: AdminUser; onChanged: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [editingRoles, setEditingRoles] = useState(false)
  const [roles, setRoles] = useState<string[]>(user.roles)
  const [confirm, setConfirm] = useState<'password' | 'mfa' | null>(null)
  const [password, setPassword] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clearanceOpen, setClearanceOpen] = useState(false)
  const [passkeysOpen, setPasskeysOpen] = useState(false)
  const { data: me } = useQuery(meQuery())
  const canSetClearance = me?.capabilities.includes('admin.system') ?? false

  const failed = (err: unknown) => toast.error(problemMessage(err, t('errors.unknown')))

  const saveRoles = useMutation({
    mutationFn: () => http.patch(`/users/${user.id}`, { roleKeys: roles }),
    onSuccess: () => {
      setEditingRoles(false)
      setError(null)
      toast.show({ title: t('admin.users.rolesSaved'), tone: 'success' })
      onChanged()
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'blocked') => http.patch(`/users/${user.id}`, { status }),
    onSuccess: (_result, status) => {
      toast.show({
        title: status === 'blocked' ? t('admin.users.blocked') : t('admin.users.unblocked'),
        tone: 'info',
        ...(status === 'blocked'
          ? {
              action: {
                label: t('common.actions.undo'),
                onClick: () => setStatus.mutate('active'),
              },
            }
          : {}),
      })
      onChanged()
    },
    onError: failed,
  })

  const resetPassword = useMutation({
    mutationFn: () => http.post<{ temporaryPassword: string }>(`/users/${user.id}/reset-password`),
    onSuccess: (result) => {
      setConfirm(null)
      setPassword(result.temporaryPassword)
      onChanged()
    },
    onError: (err) => {
      setConfirm(null)
      failed(err)
    },
  })

  const resetMfa = useMutation({
    mutationFn: () => http.post(`/users/${user.id}/reset-mfa`),
    onSuccess: () => {
      setConfirm(null)
      toast.show({ title: t('admin.users.mfaResetDone'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['users'] })
      onChanged()
    },
    onError: (err) => {
      setConfirm(null)
      failed(err)
    },
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
          <DropdownMenuItem
            icon={<UserCog className="size-4" />}
            onSelect={() => {
              setRoles(user.roles)
              setEditingRoles(true)
            }}
          >
            {t('admin.users.editRoles')}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<KeyRound className="size-4" />}
            onSelect={() => setConfirm('password')}
          >
            {t('admin.users.resetPassword')}
          </DropdownMenuItem>
          {user.mfaEnabled ? (
            <DropdownMenuItem
              icon={<ShieldOff className="size-4" />}
              onSelect={() => setConfirm('mfa')}
            >
              {t('admin.users.resetMfa')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            icon={<Fingerprint className="size-4" />}
            onSelect={() => setPasskeysOpen(true)}
          >
            {t('admin.users.passkeys')}
          </DropdownMenuItem>
          {canSetClearance ? (
            <DropdownMenuItem
              icon={<LockKeyhole className="size-4" />}
              onSelect={() => setClearanceOpen(true)}
            >
              {t('access.clearance.action')}
            </DropdownMenuItem>
          ) : null}
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

      <Dialog open={editingRoles} onOpenChange={setEditingRoles}>
        <DialogContent
          title={t('admin.users.rolesTitle', { name: user.displayName })}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditingRoles(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={saveRoles.isPending}
                onClick={() => saveRoles.mutate()}
              >
                {t('common.actions.save')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <RolePicker value={roles} onChange={setRoles} idPrefix={`${formId}-roles`} />
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirm === 'password'}
        onOpenChange={(next) => setConfirm(next ? 'password' : null)}
        title={t('admin.users.resetPasswordTitle', { name: user.displayName })}
        description={t('admin.users.resetPasswordHint')}
        confirmLabel={t('admin.users.resetPassword')}
        loading={resetPassword.isPending}
        onConfirm={() => resetPassword.mutate()}
      />
      <AlertDialog
        open={confirm === 'mfa'}
        onOpenChange={(next) => setConfirm(next ? 'mfa' : null)}
        title={t('admin.users.resetMfaTitle', { name: user.displayName })}
        description={t('admin.users.resetMfaHint')}
        confirmLabel={t('admin.users.resetMfa')}
        loading={resetMfa.isPending}
        onConfirm={() => resetMfa.mutate()}
      />
      {passkeysOpen ? (
        <UserPasskeysDialog user={user} onClose={() => setPasskeysOpen(false)} />
      ) : null}
      {clearanceOpen ? (
        <ClearanceDialog
          user={user}
          onClose={() => setClearanceOpen(false)}
          onSaved={() => {
            setClearanceOpen(false)
            onChanged()
          }}
        />
      ) : null}
      <Dialog open={password !== null} onOpenChange={(next) => !next && setPassword(null)}>
        <DialogContent
          title={t('admin.users.newPasswordTitle', { name: user.displayName })}
          size="sm"
          footer={
            <Button variant="primary" onClick={() => setPassword(null)}>
              {t('common.actions.done')}
            </Button>
          }
        >
          {password ? <TemporaryPassword password={password} /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Допуск сотрудника к грифам (ADR-0080): документы строже допуска ему не видны
 * нигде, какие бы права ни были выданы. Смена — с основанием, в аудит.
 */
function ClearanceDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const toast = useToast()
  const reasonId = useId()
  const [clearance, setClearance] = useState<Confidentiality>(user.clearance ?? DEFAULT_CLEARANCE)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => http.put(`/users/${user.id}/clearance`, { clearance, reason: reason.trim() }),
    onSuccess: () => {
      toast.show({ title: t('access.clearance.saved'), tone: 'success' })
      onSaved()
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('access.clearance.title', { name: user.displayName })}
        description={t('access.clearance.hint')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={
                reason.trim().length < 3 || clearance === (user.clearance ?? DEFAULT_CLEARANCE)
              }
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('access.clearance.label')}>
            <Select
              value={clearance}
              onValueChange={(next) => setClearance(next as Confidentiality)}
            >
              <SelectTrigger aria-label={t('access.clearance.label')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONFIDENTIALITY_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(`access.confidentiality.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={t('access.clearance.reason')}
            htmlFor={reasonId}
            hint={t('access.clearance.reasonHint')}
            required
          >
            <Textarea
              id={reasonId}
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
