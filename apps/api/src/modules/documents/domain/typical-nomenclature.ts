import { and, eq, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { cases } from '~/shared/db/schema/index.js'
import { CaseService } from './case-service.js'
import { DocumentTypeService } from './type-service.js'

/** Дело типовой номенклатуры: номер в разделе, заголовок, типы документов, срок хранения. */
export interface TypicalCase {
  n: string
  title: string
  /** Ключи типов документов: дело предлагается им при регистрации и подшивке. */
  types?: readonly string[]
  /** Срок хранения, лет; null — постоянно. */
  years: number | null
  note?: string
}

/** Раздел номенклатуры — подразделение и его индекс («03» — оперативное управление). */
export interface TypicalSection {
  /** Код подразделения оргструктуры демо-мира. */
  unitCode: string
  index: string
  name: string
  cases: readonly TypicalCase[]
}

const regional = (unitCode: string, index: string, name: string): TypicalSection => ({
  unitCode,
  index,
  name,
  cases: [
    { n: '01', title: 'Суточные сводки обстановки в области', years: 5 },
    { n: '02', title: 'Донесения о чрезвычайных ситуациях в области', years: 10 },
    { n: '03', title: 'Переписка с местными исполнительными органами власти', years: 5 },
  ],
})

/**
 * Типовая номенклатура дел по подразделениям (N20, ADR-0135) — по практике органов СНГ:
 * индекс дела — индекс подразделения и номер дела в разделе, срок хранения — по перечню
 * (приказы по основной деятельности — постоянно, по личному составу — 75 лет). Демо-сид
 * заводит её для подразделений демо-мира, образец импорта из Excel показывает её же.
 */
export const TYPICAL_NOMENCLATURE: readonly TypicalSection[] = [
  {
    unitCode: 'HQ',
    index: '01',
    name: 'Руководство Комитета',
    cases: [
      {
        n: '01',
        title: 'Законы, постановления и распоряжения Правительства по вопросам ЧС и ГО (копии)',
        years: 5,
        note: 'Копии; подлинники — в органе, издавшем акт',
      },
      {
        n: '02',
        title: 'Приказы председателя по основной деятельности',
        types: ['order'],
        years: null,
      },
      { n: '03', title: 'Распоряжения председателя', types: ['directive'], years: null },
      { n: '04', title: 'Протоколы заседаний коллегии и документы к ним', years: null },
      {
        n: '05',
        title: 'Переписка руководства с Исполнительным аппаратом Президента и Правительством',
        years: 5,
      },
    ],
  },
  {
    unitCode: 'UD-CANC',
    index: '02',
    name: 'Канцелярия',
    cases: [
      { n: '01', title: 'Номенклатура дел Комитета', years: null },
      {
        n: '02',
        title: 'Журналы регистрации входящих, исходящих и внутренних документов',
        years: 5,
      },
      { n: '05', title: 'Входящая корреспонденция', types: ['incoming_letter'], years: 5 },
      { n: '06', title: 'Исходящая корреспонденция', types: ['outgoing_letter'], years: 5 },
      {
        n: '07',
        title: 'Обращения граждан и документы по их рассмотрению',
        types: ['appeal'],
        years: 5,
      },
      {
        n: '08',
        title: 'Служебные и докладные записки',
        types: ['memo', 'report_memo'],
        years: 3,
      },
      {
        n: '09',
        title: 'Договоры и соглашения',
        types: ['contract'],
        years: 5,
        note: 'После окончания срока действия договора',
      },
      { n: '10', title: 'Акты о выделении к уничтожению документов', years: null },
    ],
  },
  {
    unitCode: 'UO',
    index: '03',
    name: 'Оперативное управление',
    cases: [
      { n: '01', title: 'Положение об управлении и должностные инструкции', years: 5 },
      {
        n: '05',
        title: 'Оперативные сводки об обстановке',
        types: ['summary_report'],
        years: 5,
      },
      {
        n: '10',
        title: 'Распоряжения оперативного штаба ЧС',
        types: ['hq_directive'],
        years: null,
      },
      {
        n: '11',
        title: 'Протоколы заседаний оперативного штаба ЧС',
        types: ['hq_protocol'],
        years: null,
      },
      {
        n: '12',
        title: 'Донесения о чрезвычайных ситуациях',
        types: ['situation_report'],
        years: 10,
      },
      { n: '14', title: 'Переписка с региональными управлениями по вопросам ЧС', years: 5 },
      { n: '15', title: 'Планы действий по предупреждению и ликвидации ЧС', years: null },
    ],
  },
  {
    unitCode: 'UA',
    index: '04',
    name: 'Управление анализа рисков',
    cases: [
      { n: '01', title: 'Положение об управлении и должностные инструкции', years: 5 },
      { n: '03', title: 'Паспорта безопасности территорий и оценки рисков', years: null },
      {
        n: '05',
        title: 'Переписка с Агентством по гидрометеорологии и Геофизической службой',
        years: 5,
      },
      { n: '07', title: 'Аналитические обзоры и прогнозы обстановки', years: 10 },
    ],
  },
  {
    unitCode: 'UT',
    index: '05',
    name: 'Управление информационных технологий',
    cases: [
      { n: '01', title: 'Положение об управлении и должностные инструкции', years: 5 },
      { n: '03', title: 'Документы по эксплуатации информационных систем', years: 5 },
      { n: '04', title: 'Документы по защите информации', years: 5 },
    ],
  },
  {
    unitCode: 'UD-HR',
    index: '06',
    name: 'Отдел кадров',
    cases: [
      { n: '01', title: 'Приказы по личному составу', years: 75 },
      { n: '02', title: 'Личные дела уволенных сотрудников', years: 75 },
      { n: '05', title: 'Графики отпусков', years: 1 },
    ],
  },
  {
    unitCode: 'UD-LEGAL',
    index: '07',
    name: 'Юридический отдел',
    cases: [
      { n: '01', title: 'Заключения на проекты документов', years: 5 },
      { n: '02', title: 'Документы претензионной и исковой работы', years: 5 },
    ],
  },
  regional('RG-SUG', '08', 'Согдийское областное управление'),
  regional('RG-KHA', '09', 'Хатлонское областное управление'),
  regional('RG-GBAO', '10', 'Управление по ГБАО'),
  regional('RG-DRS', '11', 'Управление по районам республиканского подчинения'),
]

/** Строки дел типовой номенклатуры: индекс, заголовок, раздел, срок, отметка, типы. */
export function typicalCases(): Array<{
  section: TypicalSection
  index: string
  item: TypicalCase
}> {
  return TYPICAL_NOMENCLATURE.flatMap((section) =>
    section.cases.map((item) => ({ section, index: `${section.index}-${item.n}`, item })),
  )
}

/**
 * Типовая номенклатура для подразделений, которые есть в оргструктуре (демо-сид): дела на
 * указанные годы; уже заведённые не меняются, кроме типов документов — недостающие
 * дописываются (типы пакета ЧС появляются позже номенклатуры). Повтор ничего не дублирует.
 */
export async function seedTypicalNomenclature(
  ctx: Ctx,
  unitIds: ReadonlyMap<string, string>,
  years: readonly number[],
): Promise<{ created: number; linked: number }> {
  const typeIds = new Map<string, string>()
  for (const { item } of typicalCases()) {
    for (const key of item.types ?? []) {
      if (typeIds.has(key)) continue
      const type = await DocumentTypeService.byKey(db(), key)
      if (type) typeIds.set(key, type.id)
    }
  }
  let created = 0
  let linked = 0
  for (const year of years) {
    for (const { section, index, item } of typicalCases()) {
      const unitId = unitIds.get(section.unitCode)
      if (!unitId) continue
      const types = (item.types ?? [])
        .map((key) => typeIds.get(key))
        .filter((id): id is string => Boolean(id))
      const [found] = await db()
        .select({ id: cases.id, unitId: cases.unitId, documentTypeIds: cases.documentTypeIds })
        .from(cases)
        .where(and(eq(cases.year, year), sql`lower(${cases.index}) = lower(${index})`))
        .limit(1)
      if (found) {
        const missing = types.filter((id) => !found.documentTypeIds.includes(id))
        // Чужое дело с тем же индексом (заведено вручную) не трогается
        if (missing.length === 0 || found.unitId !== unitId) continue
        await db().transaction((tx) =>
          CaseService.update(tx, ctx, found.id, {
            documentTypeIds: [...found.documentTypeIds, ...missing],
          }),
        )
        linked += 1
        continue
      }
      await db().transaction((tx) =>
        CaseService.create(tx, ctx, {
          index,
          title: item.title,
          year,
          unitId,
          retentionYears: item.years,
          retentionNote: item.years === null ? 'Хранится постоянно' : (item.note ?? null),
          documentTypeIds: types,
          note: item.years === null ? (item.note ?? null) : null,
        }),
      )
      created += 1
    }
  }
  return { created, linked }
}
