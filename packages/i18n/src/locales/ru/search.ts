export const search = {
  similar: 'Похожие',
  title: 'Поиск',
  placeholder: 'Что ищем?',
  results:
    '{count, plural, =0 {ничего не найдено} one {# результат} few {# результата} many {# результатов} other {# результата}}',
  empty: 'Ничего не найдено',
  emptyHint: 'Проверьте написание или измените фильтры',
  facets: {
    type: 'Тип',
    space: 'Пространство',
    owner: 'Владелец',
    updated: 'Изменён',
    status: 'Статус документа',
  },
  semantic: 'Семантический поиск',
  took: 'за {ms} мс',
  startHint: 'Введите запрос — поиск идёт по объектам, доступным вам',
} as const
