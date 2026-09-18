import { formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  cn,
  EmptyState,
  ObjectIcon,
  PanelToolbar,
  SearchInput,
  Skeleton,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Search as SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { searchQuery } from '~/shared/api/queries.js'

export function SearchScreen({ initialQuery = '' }: { initialQuery?: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)

  const [value, setValue] = useState(initialQuery)
  const [types, setTypes] = useState<string[]>([])
  const query = useDebouncedValue(value, 250)

  const { data, isFetching } = useQuery(
    searchQuery({ q: query, types: types.join(',') || undefined, limit: 50 }),
  )

  const typeFacet = data?.facets.find((facet) => facet.field === 'type')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <SearchInput
            value={value}
            onValueChange={setValue}
            autoFocus
            placeholder={t('search.placeholder')}
            className="max-w-xl"
          />
        }
        right={
          data ? (
            <span className="tabular text-xs text-fg-muted">
              {t('search.results', { count: data.total })} · {t('search.took', { ms: data.tookMs })}
            </span>
          ) : null
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr]">
        <aside className="min-h-0 overflow-y-auto border-r border-line p-3">
          <h2 className="mb-2 text-2xs font-medium uppercase tracking-wide text-fg-muted">
            {t('search.facets.type')}
          </h2>
          {typeFacet?.values.length ? (
            <ul className="flex flex-col gap-0.5">
              {typeFacet.values
                .sort((a, b) => b.count - a.count)
                .map((facet) => (
                  <li key={facet.value}>
                    <button
                      type="button"
                      onClick={() =>
                        setTypes((current) =>
                          current.includes(facet.value)
                            ? current.filter((item) => item !== facet.value)
                            : [...current, facet.value],
                        )
                      }
                      className={cn(
                        'flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-sm',
                        types.includes(facet.value)
                          ? 'bg-accent-subtle text-accent'
                          : 'text-fg-secondary hover:bg-surface-3 hover:text-fg',
                      )}
                    >
                      <ObjectIcon type={facet.value} className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {t(`objects.types.${facet.value}`)}
                      </span>
                      <span className="tabular text-2xs text-fg-muted">{facet.count}</span>
                    </button>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-muted">—</p>
          )}
        </aside>

        <div className="min-h-0 overflow-y-auto">
          {!query ? (
            <EmptyState
              icon={<SearchIcon />}
              title={t('search.title')}
              description="Введите запрос — поиск идёт по объектам, доступным вам"
            />
          ) : isFetching && !data ? (
            <div className="flex flex-col gap-3 p-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-64" />
                  <Skeleton className="h-3 w-96" />
                </div>
              ))}
            </div>
          ) : !data?.hits.length ? (
            <EmptyState
              icon={<SearchIcon />}
              title={t('search.empty')}
              description={t('search.emptyHint')}
            />
          ) : (
            <ul className="divide-y divide-line">
              {data.hits.map((hit) => (
                <li key={hit.objectId}>
                  <button
                    type="button"
                    onClick={() =>
                      openTab({
                        kind: 'object',
                        objectId: hit.objectId,
                        objectType: hit.type,
                        title: stripMarks(hit.title),
                        mode: 'permanent',
                      })
                    }
                    className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2"
                  >
                    <ObjectIcon type={hit.type} className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm font-medium text-fg [&_mark]:bg-accent-subtle [&_mark]:text-accent"
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: подсветка Meilisearch, всё кроме <mark> экранируется в sanitizeMarks
                        dangerouslySetInnerHTML={{ __html: sanitizeMarks(hit.title) }}
                      />
                      {hit.snippet ? (
                        <span
                          className="mt-0.5 block line-clamp-2 text-xs text-fg-secondary [&_mark]:bg-accent-subtle"
                          // biome-ignore lint/security/noDangerouslySetInnerHtml: подсветка Meilisearch, всё кроме <mark> экранируется в sanitizeMarks
                          dangerouslySetInnerHTML={{ __html: sanitizeMarks(hit.snippet) }}
                        />
                      ) : null}
                      <span className="mt-1 flex items-center gap-2 text-2xs text-fg-muted">
                        <Badge size="sm">{t(`objects.types.${hit.type}`)}</Badge>
                        {hit.spaceName ? <span>{hit.spaceName}</span> : null}
                        <span>{formatRelativeTime(hit.updatedAt, { locale })}</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function stripMarks(value: string): string {
  return value.replace(/<\/?mark>/g, '')
}

/** Из выдачи допускаются только теги <mark> — остальное экранируется. */
function sanitizeMarks(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}
