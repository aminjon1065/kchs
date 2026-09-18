import { AvatarGroup, Tooltip } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useT } from '~/app/i18n.js'
import { meQuery } from '~/shared/api/queries.js'
import { usePresence } from '~/shared/realtime/client.js'

/** Кто ещё сейчас смотрит объект (02-platform-kernel.md §Realtime, presence). */
export function PresenceAvatars({ objectId }: { objectId: string }) {
  const t = useT()
  const { data: me } = useQuery(meQuery())
  const others = usePresence(objectId).filter((user) => user.id !== me?.user.id)
  if (others.length === 0) return null

  const label = t('objects.presence', { names: others.map((user) => user.displayName).join(', ') })
  return (
    <Tooltip content={label}>
      {/* biome-ignore lint/a11y/useSemanticElements: группа аватаров — не поле формы, fieldset не подходит */}
      <span role="group" aria-label={label} className="inline-flex">
        <AvatarGroup
          people={others.map((user) => ({ name: user.displayName, src: user.avatarUrl }))}
          size="sm"
          max={4}
        />
      </span>
    </Tooltip>
  )
}
