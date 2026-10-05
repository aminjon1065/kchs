import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

export const search: DeepPartial<Dictionary['search']> = {
  similar: 'Similar',
  title: 'Search',
  placeholder: 'What are you looking for?',
  results: '{count, plural, =0 {nothing found} one {# result} other {# results}}',
  empty: 'Nothing found',
  emptyHint: 'Check the spelling or change filters',
  facets: {
    type: 'Type',
    space: 'Space',
    owner: 'Owner',
    updated: 'Updated',
    status: 'Document status',
  },
  semantic: 'Semantic search',
  took: 'in {ms} ms',
  startHint: 'Type a query — search covers the objects available to you',
}
