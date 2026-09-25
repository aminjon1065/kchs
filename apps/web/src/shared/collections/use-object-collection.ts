import type { ObjectSummary } from '@kchs/contracts'
import type { CollectionState } from '@kchs/ui'
import { useDebouncedValue } from '@kchs/ui'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { http } from '~/shared/api/client.js'

interface Page {
  items: ObjectSummary[]
  nextCursor: string | null
  total?: number
}

export interface ObjectCollectionScope {
  types: string[]
  spaceId?: string
  parentId?: string
  /** По умолчанию — живые объекты; архивное пространство смотрят в архиве. */
  lifecycle?: 'active' | 'archived'
}

/**
 * Данные CollectionView для объектов реестра: фильтр, сортировка и поиск
 * уходят на сервер (`GET /objects`), страницы догружаются при прокрутке.
 * Ключ начинается с `objects` — общая инвалидация списков его обновляет.
 */
export function useObjectCollection(
  scope: ObjectCollectionScope,
  state: CollectionState,
  enabled = true,
) {
  const search = useDebouncedValue(state.search, 250)
  const params = {
    types: scope.types.join(','),
    spaceId: scope.spaceId,
    parentId: scope.parentId,
    lifecycle: scope.lifecycle,
    q: search.trim() || undefined,
    filter: state.filter ? JSON.stringify(state.filter) : undefined,
    sort: state.sort.map((item) => `${item.field}:${item.direction}`).join(',') || undefined,
    count: 'true',
    limit: 100,
  }

  const query = useInfiniteQuery({
    queryKey: ['objects', 'collection', params],
    queryFn: ({ pageParam }) =>
      http.get<Page>('/objects', {
        query: { ...params, cursor: pageParam } as Record<string, string | number | undefined>,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  })

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  return {
    rows: query.data?.pages.flatMap((page) => page.items) ?? [],
    total: query.data?.pages[0]?.total,
    loading: query.isLoading,
    error: query.error,
    hasMore: Boolean(hasNextPage),
    loadMore,
  }
}
