import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { BigIntString, Timestamp, Uuid } from '../common/primitives.js'

/**
 * Предупреждения Комитета населению и партнёрам в формате CAP 1.2 (OASIS,
 * ITU-T X.1303), ADR-0202. Предупреждение — объект реестра `warning`: один
 * `alert` CAP с блоками `info` на таджикском, русском и английском, областями —
 * территориями справочника и/или полигонами. Выпуск — решением уполномоченного
 * лица на маршруте `warning_publish`; уточнение и отмена — новое предупреждение
 * со ссылкой (`references`) на прежнее.
 */

/** Жизненный цикл: черновик → на утверждении → утверждено → опубликовано → уточнено | отменено. */
export const WARNING_STATUSES = [
  'draft',
  'on_approval',
  'approved',
  'published',
  'updated',
  'cancelled',
] as const
export const WarningStatus = z.enum(WARNING_STATUSES)
export type WarningStatus = z.infer<typeof WarningStatus>

/** Вид сообщения CAP: новое, уточнение прежнего, отмена прежнего. */
export const CAP_MSG_TYPES = ['Alert', 'Update', 'Cancel'] as const
export const CapMsgType = z.enum(CAP_MSG_TYPES)
export type CapMsgType = z.infer<typeof CapMsgType>

/** Статус CAP: действующее, учения, проверка канала (`System` и `Draft` наружу не уходят). */
export const CAP_STATUSES = ['Actual', 'Exercise', 'Test'] as const
export const CapStatus = z.enum(CAP_STATUSES)
export type CapStatus = z.infer<typeof CapStatus>

export const CAP_CATEGORIES = [
  'Geo',
  'Met',
  'Safety',
  'Security',
  'Rescue',
  'Fire',
  'Health',
  'Env',
  'Transport',
  'Infra',
  'CBRNE',
  'Other',
] as const
export const CapCategory = z.enum(CAP_CATEGORIES)
export type CapCategory = z.infer<typeof CapCategory>

export const CAP_URGENCIES = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'] as const
export const CapUrgency = z.enum(CAP_URGENCIES)
export type CapUrgency = z.infer<typeof CapUrgency>

export const CAP_SEVERITIES = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'] as const
export const CapSeverity = z.enum(CAP_SEVERITIES)
export type CapSeverity = z.infer<typeof CapSeverity>

export const CAP_CERTAINTIES = ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown'] as const
export const CapCertainty = z.enum(CAP_CERTAINTIES)
export type CapCertainty = z.infer<typeof CapCertainty>

export const CAP_RESPONSE_TYPES = [
  'Shelter',
  'Evacuate',
  'Prepare',
  'Execute',
  'Avoid',
  'Monitor',
  'Assess',
  'AllClear',
  'None',
] as const
export const CapResponseType = z.enum(CAP_RESPONSE_TYPES)
export type CapResponseType = z.infer<typeof CapResponseType>

/** Языки блоков `info`: государственный, межнационального общения, английский — партнёрам. */
export const WARNING_LANGUAGES = ['tg', 'ru', 'en'] as const
export const WarningLanguage = z.enum(WARNING_LANGUAGES)
export type WarningLanguage = z.infer<typeof WarningLanguage>

/** Блок `info` одного языка: явление, заголовок, описание, что делать населению. */
export const WarningInfo = z.object({
  event: z.string().trim().max(200).default(''),
  /** CAP советует заголовок до 160 знаков: его показывают SMS и телефоны. */
  headline: z.string().trim().max(160).default(''),
  description: z.string().trim().max(8000).default(''),
  instruction: z.string().trim().max(4000).default(''),
})
export type WarningInfo = z.infer<typeof WarningInfo>

export const WarningInfos = z.object({
  tg: WarningInfo.optional(),
  ru: WarningInfo.optional(),
  en: WarningInfo.optional(),
})
export type WarningInfos = z.infer<typeof WarningInfos>

/** Точка полигона в порядке GeoJSON: долгота, широта. */
const LonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])

/**
 * Область предупреждения: территория справочника (название и код — в `areaDesc`
 * и `geocode`) и/или полигон. Описание своими словами нужно, когда территории нет.
 */
export const WarningArea = z
  .object({
    territoryId: Uuid.nullable().default(null),
    description: z.string().trim().max(500).default(''),
    /** Кольцо полигона; замыкается при сохранении, не меньше трёх разных точек. */
    polygon: z.array(LonLat).min(3).max(1000).nullable().default(null),
  })
  .refine((area) => Boolean(area.territoryId) || area.description.length > 0, {
    message: 'Укажите территорию или опишите область',
    path: ['description'],
  })
export type WarningArea = z.infer<typeof WarningArea>

/** Строка датасета — сообщение-источник реестра «Сообщения об опасных явлениях». */
export const WarningSource = z.object({ datasetId: Uuid, rowId: BigIntString })
export type WarningSource = z.infer<typeof WarningSource>

/** Содержание, которое правит автор в черновике. */
export const WarningContent = z.object({
  capStatus: CapStatus.default('Actual'),
  info: WarningInfos.default({}),
  categories: z.array(CapCategory).max(CAP_CATEGORIES.length).default([]),
  urgency: CapUrgency.default('Expected'),
  severity: CapSeverity.default('Moderate'),
  certainty: CapCertainty.default('Likely'),
  responseTypes: z.array(CapResponseType).max(CAP_RESPONSE_TYPES.length).default([]),
  /** Начало действия; пусто — с момента публикации. */
  effective: Timestamp.nullable().default(null),
  expires: Timestamp.nullable().default(null),
  areas: z.array(WarningArea).max(50).default([]),
  /** Кто подписывает решение о выпуске (`field:signer` маршрута). */
  signerId: Uuid.nullable().default(null),
})
export type WarningContent = z.infer<typeof WarningContent>

export const WarningCreateInput = WarningContent.extend({
  /** Пространство; без него — пространство предупреждений из настроек установки. */
  spaceId: Uuid.optional(),
  source: WarningSource.nullable().default(null),
})
export type WarningCreateInput = z.input<typeof WarningCreateInput>

/** Правка черновика: только переданные части; `null` у источника — отвязать. */
export const WarningUpdateInput = z.object({
  capStatus: CapStatus.optional(),
  info: WarningInfos.optional(),
  categories: z.array(CapCategory).max(CAP_CATEGORIES.length).optional(),
  urgency: CapUrgency.optional(),
  severity: CapSeverity.optional(),
  certainty: CapCertainty.optional(),
  responseTypes: z.array(CapResponseType).max(CAP_RESPONSE_TYPES.length).optional(),
  effective: Timestamp.nullable().optional(),
  expires: Timestamp.nullable().optional(),
  areas: z.array(WarningArea).max(50).optional(),
  signerId: Uuid.nullable().optional(),
  source: WarningSource.nullable().optional(),
})
export type WarningUpdateInput = z.infer<typeof WarningUpdateInput>

/** Черновик из сообщения об опасном явлении: явление, район, время — из строки. */
export const WarningFromMessageInput = z.object({
  rowId: BigIntString,
  /** Датасет сообщений; без него — источник из настроек установки. */
  datasetId: Uuid.optional(),
})
export type WarningFromMessageInput = z.infer<typeof WarningFromMessageInput>

/** Уточнение или отмена опубликованного — новым предупреждением со ссылкой на прежнее. */
export const WarningSupersedeInput = z.object({ msgType: z.enum(['Update', 'Cancel']) })
export type WarningSupersedeInput = z.infer<typeof WarningSupersedeInput>

export const WarningListQuery = z.object({
  status: WarningStatus.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
export type WarningListQuery = z.infer<typeof WarningListQuery>

const WarningLink = z.object({
  id: Uuid,
  identifier: z.string(),
  title: z.string(),
  status: WarningStatus,
  msgType: CapMsgType,
})
export type WarningLink = z.infer<typeof WarningLink>

export const WarningSummary = z.object({
  id: Uuid,
  identifier: z.string(),
  title: z.string(),
  status: WarningStatus,
  msgType: CapMsgType,
  capStatus: CapStatus,
  severity: CapSeverity,
  urgency: CapUrgency,
  effective: Timestamp.nullable(),
  expires: Timestamp.nullable(),
  publishedAt: Timestamp.nullable(),
  areas: z.array(z.string()),
  updatedAt: Timestamp,
})
export type WarningSummary = z.infer<typeof WarningSummary>

export const WarningList = z.object({ items: z.array(WarningSummary) })
export type WarningList = z.infer<typeof WarningList>

export const WarningAreaView = z.object({
  territoryId: Uuid.nullable(),
  territoryName: z.string().nullable(),
  territoryCode: z.string().nullable(),
  description: z.string(),
  polygon: z.array(LonLat).nullable(),
})
export type WarningAreaView = z.infer<typeof WarningAreaView>

export const WarningRecord = z.object({
  id: Uuid,
  identifier: z.string(),
  spaceId: Uuid.nullable(),
  title: z.string(),
  status: WarningStatus,
  msgType: CapMsgType,
  capStatus: CapStatus,
  info: WarningInfos,
  categories: z.array(CapCategory),
  urgency: CapUrgency,
  severity: CapSeverity,
  certainty: CapCertainty,
  responseTypes: z.array(CapResponseType),
  effective: Timestamp.nullable(),
  expires: Timestamp.nullable(),
  areas: z.array(WarningAreaView),
  source: WarningSource.extend({ title: z.string().nullable() }).nullable(),
  /** Прежнее предупреждение, которое это уточняет или отменяет. */
  references: WarningLink.nullable(),
  /** Предупреждение, которым это уточнено или отменено. */
  supersededBy: WarningLink.nullable(),
  signer: UserRef.nullable(),
  author: UserRef.nullable(),
  approvedAt: Timestamp.nullable(),
  approvedBy: UserRef.nullable(),
  publishedAt: Timestamp.nullable(),
  /** Адрес CAP снаружи (через шлюз DMZ) — у опубликованного. */
  capUrl: z.string().nullable(),
  /** Идущий маршрут выпуска. */
  processId: Uuid.nullable(),
  canEdit: z.boolean(),
  canSubmit: z.boolean(),
  canSupersede: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type WarningRecord = z.infer<typeof WarningRecord>

/** Настройки установки: где заводятся предупреждения и откуда берутся сообщения. */
export const WarningSettings = z.object({
  spaceId: Uuid.nullable(),
  sourceDatasetId: Uuid.nullable(),
  /** Группа уполномоченных подписывать решение о выпуске; пусто — любой сотрудник. */
  signerGroupId: Uuid.nullable(),
  /** Её участники — подсказка выбора подписывающего. */
  signers: z.array(UserRef),
  /** Публичные адреса лент: Atom-индекс и RSS по языкам. */
  feeds: z.object({
    atom: z.string(),
    rss: z.object({ tg: z.string(), ru: z.string(), en: z.string() }),
  }),
})
export type WarningSettings = z.infer<typeof WarningSettings>

/** Сообщение-источник для выбора «создать из сообщения». */
export const WarningSourceItem = z.object({
  rowId: BigIntString,
  code: z.string().nullable(),
  title: z.string(),
  hazard: z.string().nullable(),
  occurredAt: z.string().nullable(),
  territoryName: z.string().nullable(),
  status: z.string().nullable(),
  publishedAt: z.string().nullable(),
})
export type WarningSourceItem = z.infer<typeof WarningSourceItem>

export const WarningSourceList = z.object({
  datasetId: Uuid.nullable(),
  items: z.array(WarningSourceItem),
})
export type WarningSourceList = z.infer<typeof WarningSourceList>

export const WarningSourcesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type WarningSourcesQuery = z.infer<typeof WarningSourcesQuery>

/** Параметр пути RSS: язык ленты. */
export const WarningRssParams = z.object({ lang: WarningLanguage })
