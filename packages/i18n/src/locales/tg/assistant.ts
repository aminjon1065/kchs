import type { DeepPartial } from '../../types.js'
import type { Dictionary } from '../ru/index.js'

export const assistant: DeepPartial<Dictionary['assistant']> = {
  disabled: 'Ёрдамчӣ хомӯш аст',
  disabledHint: 'Дар ин насб провайдери ЗС танзим нашудааст ё ваколати истифодаи он нест',
  hint: 'Дар бораи объекти кушода пурсед: ёрдамчӣ танҳо он чизеро меҷӯяд ва мехонад, ки ба шумо дастрас аст',
  hintGlobal:
    'Дар бораи ҳар чиз пурсед: ёрдамчӣ дар платформа танҳо он чизеро меҷӯяд, ки ба шумо дастрас аст',
  question: 'Савол ба ёрдамчӣ',
  placeholder: 'Масалан: дар бораи ин обхезӣ чӣ маълум аст?',
  send: 'Пурсидан',
  clear: 'Пок кардани гуфтугӯ',
  steps: 'Ёрдамчӣ чӣ кор кард',
  citations: 'Истинодҳои ҷавоб',
  found: '{count} ёфт',
  createTask: 'Эҷоди супориш',
  roles: {
    user: 'Шумо',
    assistant: 'Ёрдамчӣ',
  },
}
