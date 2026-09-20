import type {
  DirectoryChange,
  DirectorySettingsInput,
  DirectoryState,
  DirectorySyncRun,
  DirectoryTestResult,
  GroupRoleMapping,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { localizedText } from '@kchs/i18n'
import {
  Badge,
  type BadgeProps,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  PasswordInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderTree, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { rolesQuery } from '~/shared/api/queries.js'
import { authProviderKeys, directoryQuery, directorySyncsQuery } from './auth-providers.js'

const ACTION_TONES: Record<DirectoryChange['action'], BadgeProps['tone']> = {
  create: 'success',
  update: 'accent',
  block: 'warning',
  unblock: 'accent',
  skip: 'neutral',
}

const STATUS_TONES: Record<DirectorySyncRun['status'], BadgeProps['tone']> = {
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
}

/** Черновик: настройки без состояния плюс поле нового пароля. */
type Draft = DirectorySettingsInput

function toDraft(state: DirectoryState): Draft {
  const { hasBindPassword: _has, updatedAt: _at, lastRun: _run, ...settings } = state
  return settings
}

/**
 * Каталог LDAP / Active Directory (14-automation-integrations.md §5, ADR-0098):
 * подключение, сопоставление полей и групп, предпросмотр «что изменится»,
 * прогон и журнал синхронизаций. Пароль учётной записи чтения сервер обратно
 * не отдаёт — пустое поле означает «оставить прежний».
 */
export function DirectorySection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const urlId = useId()
  const bindDnId = useId()
  const bindPasswordId = useId()
  const baseDnId = useId()
  const filterId = useId()
  const unitBaseDnId = useId()
  const intervalId = useId()

  const { data: state } = useQuery(directoryQuery())
  const { data: runs = [] } = useQuery(directorySyncsQuery())
  const { data: roles = [] } = useQuery(rolesQuery())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tested, setTested] = useState<DirectoryTestResult | null>(null)
  const [plan, setPlan] = useState<DirectorySyncRun | null>(null)

  const failed = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('errors.unknown'))

  const save = useMutation({
    mutationFn: (next: Draft) => http.put<DirectoryState>('/admin/directory', next),
    onSuccess: (saved) => {
      client.setQueryData(authProviderKeys.directory, saved)
      setDraft(null)
      toast.show({ title: t('admin.directory.saved'), tone: 'success' })
    },
    onError: failed,
  })

  const test = useMutation({
    mutationFn: () => http.post<DirectoryTestResult>('/admin/directory/test'),
    onSuccess: setTested,
    onError: failed,
  })

  const preview = useMutation({
    mutationFn: () => http.post<DirectorySyncRun>('/admin/directory/preview'),
    onSuccess: (run) => {
      setPlan(run)
      void client.invalidateQueries({ queryKey: authProviderKeys.directorySyncs })
    },
    onError: failed,
  })

  const run = useMutation({
    mutationFn: () => http.post<DirectorySyncRun>('/admin/directory/sync'),
    onSuccess: (result) => {
      setPlan(result)
      toast.show({
        title: t('admin.directory.syncDone', {
          created: result.stats.created,
          updated: result.stats.updated,
          blocked: result.stats.blocked,
        }),
        tone: result.status === 'failed' ? 'danger' : 'success',
      })
      void client.invalidateQueries({ queryKey: authProviderKeys.directory })
      void client.invalidateQueries({ queryKey: authProviderKeys.directorySyncs })
    },
    onError: failed,
  })

  if (!state) {
    return (
      <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
        <Skeleton className="h-48" />
        <Skeleton className="h-32" />
      </div>
    )
  }

  const value = draft ?? toDraft(state)
  const update = (patch: Partial<Draft>) => setDraft({ ...value, ...patch })
  const setAttribute = (key: keyof Draft['attributes'], next: string) =>
    update({ attributes: { ...value.attributes, [key]: next } })
  const setMapping = (index: number, patch: Partial<GroupRoleMapping>) =>
    update({
      groupMappings: value.groupMappings.map((item, at) =>
        at === index ? { ...item, ...patch } : item,
      ),
    })

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
      <Card title={t('admin.directory.connectionTitle')}>
        <p className="text-xs text-fg-secondary">{t('admin.directory.connectionHint')}</p>
        <div className="mt-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">{t('admin.directory.enabled')}</p>
            <p className="text-xs text-fg-secondary">{t('admin.directory.enabledHint')}</p>
          </div>
          <Switch
            checked={value.enabled}
            onCheckedChange={(next) => update({ enabled: next })}
            aria-label={t('admin.directory.enabled')}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field
            label={t('admin.directory.url')}
            hint={t('admin.directory.urlHint')}
            htmlFor={urlId}
          >
            <Input
              id={urlId}
              value={value.url}
              onChange={(event) => update({ url: event.target.value })}
              placeholder="ldaps://dc.example.org:636"
            />
          </Field>
          <Field label={t('admin.directory.bindDn')} htmlFor={bindDnId}>
            <Input
              id={bindDnId}
              value={value.bindDn}
              onChange={(event) => update({ bindDn: event.target.value })}
              placeholder="cn=reader,dc=example,dc=org"
            />
          </Field>
          <Field
            label={t('admin.directory.bindPassword')}
            hint={
              state.hasBindPassword
                ? t('admin.directory.bindPasswordKeep')
                : t('admin.directory.bindPasswordHint')
            }
            htmlFor={bindPasswordId}
          >
            <PasswordInput
              id={bindPasswordId}
              value={value.bindPassword ?? ''}
              onChange={(event) => update({ bindPassword: event.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t('admin.directory.baseDn')} htmlFor={baseDnId}>
            <Input
              id={baseDnId}
              value={value.baseDn}
              onChange={(event) => update({ baseDn: event.target.value })}
              placeholder="ou=people,dc=example,dc=org"
            />
          </Field>
          <Field
            label={t('admin.directory.userFilter')}
            hint={t('admin.directory.userFilterHint')}
            htmlFor={filterId}
          >
            <Input
              id={filterId}
              mono
              value={value.userFilter}
              onChange={(event) => update({ userFilter: event.target.value })}
            />
          </Field>
          <Field
            label={t('admin.directory.unitBaseDn')}
            hint={t('admin.directory.unitBaseDnHint')}
            htmlFor={unitBaseDnId}
          >
            <Input
              id={unitBaseDnId}
              value={value.unitBaseDn}
              onChange={(event) => update({ unitBaseDn: event.target.value })}
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <Switch
            checked={value.startTls}
            onCheckedChange={(next) => update({ startTls: next })}
            label={t('admin.directory.startTls')}
          />
          <Switch
            checked={value.tlsRejectUnauthorized}
            onCheckedChange={(next) => update({ tlsRejectUnauthorized: next })}
            label={t('admin.directory.verifyCertificate')}
          />
          <Switch
            checked={value.allowPasswordLogin}
            onCheckedChange={(next) => update({ allowPasswordLogin: next })}
            label={t('admin.directory.allowPasswordLogin')}
          />
        </div>
      </Card>

      <Card title={t('admin.directory.mappingTitle')}>
        <p className="text-xs text-fg-secondary">{t('admin.directory.mappingHint')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(
            [
              ['login', t('admin.directory.fields.login')],
              ['email', t('admin.directory.fields.email')],
              ['lastName', t('admin.directory.fields.lastName')],
              ['firstName', t('admin.directory.fields.firstName')],
              ['middleName', t('admin.directory.fields.middleName')],
              ['displayName', t('admin.directory.fields.displayName')],
              ['phone', t('admin.directory.fields.phone')],
              ['externalId', t('admin.directory.fields.externalId')],
              ['disabled', t('admin.directory.fields.disabled')],
              ['unit', t('admin.directory.fields.unit')],
              ['position', t('admin.directory.fields.position')],
              ['memberOf', t('admin.directory.fields.memberOf')],
            ] as Array<[keyof Draft['attributes'], string]>
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Input
                mono
                value={value.attributes[key]}
                onChange={(event) => setAttribute(key, event.target.value)}
                aria-label={label}
              />
            </Field>
          ))}
        </div>
      </Card>

      <Card
        title={t('admin.directory.groupsTitle')}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() =>
              update({
                groupMappings: [
                  ...value.groupMappings,
                  { group: '', roleKey: roles[0]?.key ?? 'employee' },
                ],
              })
            }
          >
            {t('admin.directory.addMapping')}
          </Button>
        }
      >
        <p className="text-xs text-fg-secondary">{t('admin.directory.groupsHint')}</p>
        {value.groupMappings.length === 0 ? (
          <p className="mt-3 text-sm text-fg-muted">{t('admin.directory.noMappings')}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {value.groupMappings.map((mapping, index) => (
              // Порядок строк задаёт человек; идентификатора у строки нет
              <li key={`mapping-${index}`} className="flex items-center gap-2">
                <Input
                  mono
                  className="min-w-0 flex-1"
                  value={mapping.group}
                  onChange={(event) => setMapping(index, { group: event.target.value })}
                  placeholder="cn=gis,ou=groups,dc=example,dc=org"
                  aria-label={t('admin.directory.groupDn')}
                />
                <Select
                  value={mapping.roleKey}
                  onValueChange={(next) => setMapping(index, { roleKey: next })}
                >
                  <SelectTrigger className="w-48" aria-label={t('admin.directory.role')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((role) => (
                      <SelectItem key={role.key} value={role.key}>
                        {localizedText(role.name, locale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={t('common.actions.delete')}
                  onClick={() =>
                    update({
                      groupMappings: value.groupMappings.filter((_, at) => at !== index),
                    })
                  }
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label={t('admin.directory.onMissing')} hint={t('admin.directory.onMissingHint')}>
            <Select
              value={value.onMissing}
              onValueChange={(next) => update({ onMissing: next as Draft['onMissing'] })}
            >
              <SelectTrigger aria-label={t('admin.directory.onMissing')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="block">{t('admin.directory.onMissingBlock')}</SelectItem>
                <SelectItem value="ignore">{t('admin.directory.onMissingIgnore')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={t('admin.directory.interval')}
            hint={t('admin.directory.intervalHint')}
            htmlFor={intervalId}
          >
            <Input
              id={intervalId}
              type="number"
              inputMode="numeric"
              min={15}
              max={1440}
              value={value.syncIntervalMinutes}
              onChange={(event) =>
                update({ syncIntervalMinutes: Number(event.target.value) || 60 })
              }
              className="max-w-32"
            />
          </Field>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!draft}
          loading={save.isPending}
          onClick={() => draft && save.mutate(draft)}
        >
          {t('common.actions.save')}
        </Button>
        <Button variant="ghost" disabled={!draft} onClick={() => setDraft(null)}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="secondary"
          icon={<Plug className="size-3.5" />}
          disabled={Boolean(draft)}
          loading={test.isPending}
          onClick={() => test.mutate()}
        >
          {t('admin.directory.testConnection')}
        </Button>
        <Button
          variant="secondary"
          icon={<FolderTree className="size-3.5" />}
          disabled={Boolean(draft) || !state.enabled}
          loading={preview.isPending}
          onClick={() => preview.mutate()}
        >
          {t('admin.directory.preview')}
        </Button>
        <Button
          variant="secondary"
          icon={<RefreshCw className="size-3.5" />}
          disabled={Boolean(draft) || !state.enabled}
          loading={run.isPending}
          onClick={() => run.mutate()}
        >
          {t('admin.directory.syncNow')}
        </Button>
      </div>

      {tested ? (
        <Callout tone={tested.ok ? 'success' : 'danger'} onDismiss={() => setTested(null)}>
          {tested.ok
            ? t('admin.directory.testOk', {
                users: tested.users,
                units: tested.units,
                sample: tested.sample.join(', ') || '—',
              })
            : t('admin.directory.testFailed', { error: tested.error ?? '' })}
        </Callout>
      ) : null}

      {plan ? <PlanCard run={plan} onClose={() => setPlan(null)} /> : null}

      <Card title={t('admin.directory.historyTitle')} padded={false}>
        {runs.length === 0 ? (
          <EmptyState
            compact
            title={t('admin.directory.noRuns')}
            description={t('admin.directory.noRunsHint')}
          />
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Badge size="sm" tone={STATUS_TONES[item.status]}>
                  {t(`admin.directory.status.${item.status}`)}
                </Badge>
                <span className="text-fg-secondary">{t(`admin.directory.mode.${item.mode}`)}</span>
                <span className="text-fg-muted">{formatDateTime(item.startedAt)}</span>
                <span className="ml-auto text-xs text-fg-secondary">
                  {t('admin.directory.statsShort', {
                    created: item.stats.created,
                    updated: item.stats.updated,
                    blocked: item.stats.blocked,
                    failed: item.stats.failed,
                  })}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setPlan(item)}>
                  {t('common.actions.open')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/** План изменений: предпросмотр и разбор уже выполненного прогона. */
function PlanCard({ run, onClose }: { run: DirectorySyncRun; onClose: () => void }) {
  const t = useT()
  return (
    <Card
      title={
        run.mode === 'preview' ? t('admin.directory.planTitle') : t('admin.directory.runTitle')
      }
      action={
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('common.actions.close')}
        </Button>
      }
      padded={false}
    >
      <div className="flex flex-wrap gap-4 px-4 py-3 text-xs text-fg-secondary">
        <span>{t('admin.directory.statScanned', { count: run.stats.scanned })}</span>
        <span>{t('admin.directory.statCreated', { count: run.stats.created })}</span>
        <span>{t('admin.directory.statUpdated', { count: run.stats.updated })}</span>
        <span>{t('admin.directory.statBlocked', { count: run.stats.blocked })}</span>
        <span>{t('admin.directory.statUnits', { count: run.stats.unitsCreated })}</span>
        <span>{t('admin.directory.statFailed', { count: run.stats.failed })}</span>
      </div>
      {run.error ? (
        <div className="px-4 pb-3">
          <Callout tone="danger">{run.error}</Callout>
        </div>
      ) : null}
      {run.changes.length === 0 ? (
        <EmptyState compact title={t('admin.directory.noChanges')} />
      ) : (
        <ul className="divide-y divide-line">
          {run.changes.slice(0, 200).map((change) => (
            <li
              key={`${change.kind}-${change.login}-${change.action}`}
              className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm"
            >
              <Badge size="sm" tone={ACTION_TONES[change.action]}>
                {t(`admin.directory.action.${change.action}`)}
              </Badge>
              <span className="font-medium text-fg">{change.title || change.login}</span>
              <span className="font-mono text-xs text-fg-muted">{change.login}</span>
              {change.reason ? (
                <span className="text-xs text-fg-secondary">{change.reason}</span>
              ) : null}
              {change.fields.length > 0 ? (
                <span className="ml-auto text-xs text-fg-secondary">
                  {change.fields
                    .map((field) => `${field.field}: ${field.from || '—'} → ${field.to || '—'}`)
                    .join('; ')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
