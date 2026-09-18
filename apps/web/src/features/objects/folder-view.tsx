import { EmptyState, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { FilesScreen } from '~/features/files/files-screen.js'
import { objectQuery } from '~/shared/api/queries.js'

/** Папка — тот же файловый менеджер, открытый на нужном узле. */
export function FolderView({ objectId }: { objectId: string }) {
  const { data: object, isLoading } = useQuery(objectQuery(objectId))

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (!object?.spaceId) return <EmptyState title="Папка недоступна" />

  return <FilesScreen spaceId={object.spaceId} />
}
