/** Демонстрационная организация (04-verification.md §7). Данные синтетические. */

export interface SeedUnit {
  code: string
  name: { ru: string; tg?: string; en?: string }
  kind: 'committee' | 'department' | 'division' | 'regional' | 'sector'
  children?: SeedUnit[]
}

export const ORG_TREE: SeedUnit = {
  code: 'HQ',
  name: { ru: 'Комитет', tg: 'Кумита', en: 'Committee' },
  kind: 'committee',
  children: [
    {
      code: 'UA',
      name: { ru: 'Управление анализа рисков', tg: 'Раёсати таҳлили хатарҳо', en: 'Risk analysis' },
      kind: 'department',
      children: [
        { code: 'UA-MON', name: { ru: 'Отдел мониторинга', en: 'Monitoring' }, kind: 'division' },
        {
          code: 'UA-DATA',
          name: { ru: 'Отдел данных и ГИС', en: 'Data and GIS' },
          kind: 'division',
        },
        {
          code: 'UA-FORE',
          name: { ru: 'Отдел прогнозирования', en: 'Forecasting' },
          kind: 'division',
        },
      ],
    },
    {
      code: 'UO',
      name: { ru: 'Оперативное управление', tg: 'Раёсати оперативӣ', en: 'Operations' },
      kind: 'department',
      children: [
        {
          code: 'UO-DUTY',
          name: { ru: 'Оперативно-дежурная служба', en: 'Duty service' },
          kind: 'division',
        },
        {
          code: 'UO-RESC',
          name: { ru: 'Отдел спасательных работ', en: 'Rescue operations' },
          kind: 'division',
        },
        { code: 'UO-RES', name: { ru: 'Отдел резервов', en: 'Reserves' }, kind: 'division' },
      ],
    },
    {
      code: 'UD',
      name: { ru: 'Управление делами', tg: 'Раёсати корҳо', en: 'Administration' },
      kind: 'department',
      children: [
        { code: 'UD-CANC', name: { ru: 'Канцелярия', en: 'Registry office' }, kind: 'division' },
        { code: 'UD-HR', name: { ru: 'Отдел кадров', en: 'HR' }, kind: 'division' },
        { code: 'UD-LEGAL', name: { ru: 'Юридический отдел', en: 'Legal' }, kind: 'division' },
      ],
    },
    {
      code: 'UT',
      name: { ru: 'Управление информационных технологий', en: 'IT' },
      kind: 'department',
      children: [
        {
          code: 'UT-INFRA',
          name: { ru: 'Отдел инфраструктуры', en: 'Infrastructure' },
          kind: 'division',
        },
        { code: 'UT-DEV', name: { ru: 'Отдел разработки', en: 'Development' }, kind: 'division' },
        {
          code: 'UT-SEC',
          name: { ru: 'Отдел информационной безопасности', en: 'Security' },
          kind: 'division',
        },
      ],
    },
    {
      code: 'RG',
      name: { ru: 'Региональные управления', en: 'Regional offices' },
      kind: 'department',
      children: [
        {
          code: 'RG-SUG',
          name: { ru: 'Согдийская область', tg: 'Вилояти Суғд', en: 'Sughd' },
          kind: 'regional',
        },
        {
          code: 'RG-KHA',
          name: { ru: 'Хатлонская область', tg: 'Вилояти Хатлон', en: 'Khatlon' },
          kind: 'regional',
        },
        { code: 'RG-GBAO', name: { ru: 'ГБАО', tg: 'ВМКБ', en: 'GBAO' }, kind: 'regional' },
        {
          code: 'RG-DRS',
          name: { ru: 'Районы республиканского подчинения', en: 'RRP' },
          kind: 'regional',
        },
      ],
    },
  ],
}

export const POSITIONS = [
  { key: 'chairman', name: { ru: 'Председатель', tg: 'Раис', en: 'Chairman' }, rank: 100 },
  {
    key: 'deputy',
    name: { ru: 'Заместитель председателя', tg: 'Муовини раис', en: 'Deputy chairman' },
    rank: 90,
  },
  {
    key: 'head_dept',
    name: { ru: 'Начальник управления', tg: 'Сардори раёсат', en: 'Head of department' },
    rank: 70,
  },
  {
    key: 'head_div',
    name: { ru: 'Начальник отдела', tg: 'Сардори шуъба', en: 'Head of division' },
    rank: 50,
  },
  { key: 'chief_spec', name: { ru: 'Главный специалист', en: 'Chief specialist' }, rank: 40 },
  { key: 'lead_spec', name: { ru: 'Ведущий специалист', en: 'Lead specialist' }, rank: 30 },
  { key: 'specialist', name: { ru: 'Специалист', tg: 'Мутахассис', en: 'Specialist' }, rank: 20 },
  { key: 'analyst', name: { ru: 'Аналитик', en: 'Analyst' }, rank: 25 },
  { key: 'gis_specialist', name: { ru: 'ГИС-специалист', en: 'GIS specialist' }, rank: 25 },
  {
    key: 'registrar',
    name: { ru: 'Делопроизводитель', tg: 'Коргузор', en: 'Registrar' },
    rank: 20,
  },
] as const

/** Фамилии и имена для генератора — детерминированный набор. */
export const LAST_NAMES = [
  'Каримов',
  'Раҳимов',
  'Назаров',
  'Шарипов',
  'Юсупов',
  'Сафаров',
  'Мирзоев',
  'Холов',
  'Давлатов',
  'Ҷумъаев',
  'Иброхимов',
  'Ализода',
  'Саидов',
  'Хакимов',
  'Бобоев',
  'Одинаев',
  'Рустамов',
  'Салимов',
  'Турсунов',
  'Файзуллоев',
  'Ғаниев',
  'Ҳасанов',
  'Эшонов',
  'Ятимов',
]

export const FIRST_NAMES = [
  'Абдулло',
  'Бахтиёр',
  'Далер',
  'Ёрмахмад',
  'Зафар',
  'Икром',
  'Комил',
  'Лутфулло',
  'Манучеҳр',
  'Нуриддин',
  'Орзу',
  'Парвиз',
  'Рустам',
  'Сафар',
  'Умед',
  'Фаррух',
]

export const FEMALE_FIRST_NAMES = [
  'Азиза',
  'Барно',
  'Гулнора',
  'Дилафруз',
  'Зарина',
  'Малика',
  'Нигора',
  'Рухшона',
  'Сабрина',
  'Фарзона',
  'Хуршеда',
  'Шабнам',
]

export const MIDDLE_NAMES = [
  'Абдуллоевич',
  'Бахтиёрович',
  'Далерович',
  'Зафарович',
  'Икромович',
  'Комилович',
  'Рустамович',
  'Сафарович',
  'Умедович',
  'Фаррухович',
]

export const SPACES = [
  {
    key: 'org',
    name: 'Общее',
    kind: 'org' as const,
    description: 'Справочники, регламенты, общие материалы',
  },
  {
    key: 'flood-2026',
    name: 'Паводок-2026',
    kind: 'team' as const,
    description: 'Оперативная работа по паводковой обстановке',
  },
  {
    key: 'digital-map',
    name: 'Цифровая карта',
    kind: 'team' as const,
    description: 'Проект цифровой карты объектов защиты',
  },
]
