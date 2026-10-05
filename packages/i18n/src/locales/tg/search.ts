import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

export const search: DeepPartial<Dictionary['search']> = {
  similar: 'Монанд',
  title: 'Ҷустуҷӯ',
  placeholder: 'Чӣ меҷӯем?',
  results: '{count, plural, =0 {ҳеҷ чиз ёфт нашуд} one {# натиҷа} other {# натиҷа}}',
  empty: 'Ҳеҷ чиз ёфт нашуд',
  emptyHint: 'Имлоро санҷед ё филтрҳоро тағйир диҳед',
  facets: {
    type: 'Навъ',
    space: 'Фазо',
    owner: 'Соҳиб',
    updated: 'Тағйирёфта',
    status: 'Ҳолати ҳуҷҷат',
  },
  semantic: 'Ҷустуҷӯи маъноӣ',
  took: 'дар {ms} мс',
  startHint: 'Дархостро ворид кунед — ҷустуҷӯ дар байни объектҳои ба шумо дастрас анҷом мешавад',
}
