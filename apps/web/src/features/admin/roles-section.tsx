import { SYSTEM_ROLES } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import { Button, Card, cn, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Check, Minus } from 'lucide-react'
import { Fragment } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { rolesQuery } from '~/shared/api/queries.js'
import { CAPABILITY_GROUPS, capabilityLabelKey } from './capabilities.js'

/**
 * «Роли и способности» (15-admin-operations.md): матрица системных ролей по
 * способностям и число сотрудников с ролью — переход к ним в «Пользователи».
 * Способности системных ролей задаёт платформа: здесь они только читаются.
 */
export function RolesSection({
  onShowHolders,
}: {
  /** Переход к держателям роли — только если раздел «Пользователи» доступен (N85). */
  onShowHolders?: (roleKey: string) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: unordered = [], isLoading } = useQuery(rolesQuery())
  // Порядок платформы (от администратора к сотруднику), свои роли — следом
  const rank = (key: string) => {
    const index = (SYSTEM_ROLES as readonly string[]).indexOf(key)
    return index === -1 ? SYSTEM_ROLES.length : index
  }
  const roles = [...unordered].sort((a, b) => rank(a.key) - rank(b.key))

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-5">
      <p className="text-sm text-fg-secondary">{t('admin.roles.hint')}</p>
      <Card padded={false} className="overflow-x-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-6 w-full" />
            ))}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line align-bottom text-xs text-fg-muted">
                <th
                  scope="col"
                  className="sticky left-0 z-(--z-sticky) bg-surface px-3 py-2 text-left font-medium"
                >
                  {t('admin.roles.capability')}
                </th>
                {roles.map((role) => {
                  const name = localizedText(role.name, locale)
                  return (
                    <th key={role.id} scope="col" className="px-2 py-2 text-center font-medium">
                      <span className="block text-fg">{name}</span>
                      {onShowHolders ? (
                        <Button
                          variant="link"
                          size="sm"
                          aria-label={t('admin.roles.showHolders', { role: name })}
                          onClick={() => onShowHolders(role.key)}
                        >
                          {t('admin.roles.holders', { count: role.userCount })}
                        </Button>
                      ) : (
                        <span className="text-xs text-fg-muted">
                          {t('admin.roles.holders', { count: role.userCount })}
                        </span>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_GROUPS.map((group) => (
                <Fragment key={group.key}>
                  <tr className="bg-surface-2">
                    <th
                      scope="colgroup"
                      colSpan={roles.length + 1}
                      className="sticky left-0 px-3 py-1.5 text-left text-2xs font-semibold tracking-wide text-fg-muted uppercase"
                    >
                      {t(`admin.capabilityGroups.${group.key}`)}
                    </th>
                  </tr>
                  {group.capabilities.map((capability) => (
                    <tr key={capability} className="border-b border-line last:border-0">
                      <th
                        scope="row"
                        className="sticky left-0 z-(--z-sticky) min-w-56 bg-surface px-3 py-1.5 text-left font-normal text-fg"
                      >
                        <span className="block">{t(capabilityLabelKey(capability))}</span>
                        <span className="block font-mono text-2xs text-fg-muted">{capability}</span>
                      </th>
                      {roles.map((role) => {
                        const granted = role.capabilities.includes(capability)
                        const Icon = granted ? Check : Minus
                        return (
                          <td key={role.id} className="px-2 text-center">
                            <Icon
                              className={cn(
                                'mx-auto size-4',
                                granted ? 'text-success' : 'text-fg-muted',
                              )}
                              aria-hidden
                            />
                            <span className="sr-only">
                              {granted ? t('admin.roles.granted') : t('admin.roles.notGranted')}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
