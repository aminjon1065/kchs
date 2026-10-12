import {
  QuerySpec,
  type WarningArea,
  type WarningContent,
  WarningCreateInput,
  type WarningFromMessageInput,
  type WarningInfos,
  type WarningList,
  type WarningListQuery,
  type WarningRecord,
  type WarningSettings,
  type WarningSourceList,
  type WarningSourcesQuery,
  type WarningStatus,
  type WarningUpdateInput,
} from '@kchs/contracts'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { objects } from '~/kernel/objects/schema.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { ProcessService } from '~/kernel/process/index.js'
import { DatasetQueries, datasetRecord } from '~/modules/data/public.js'
import { territoryIndex } from '~/modules/territories/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { warnings } from '../schema.js'
import { ALERT_LEVEL_SEVERITY, HAZARD_EVENTS } from './hazards.js'
import { capUrlOf, feedUrls, WarningSettingsService } from './settings.js'
import {
  areaLabels,
  areasOf,
  capStatusOf,
  infosOf,
  msgTypeOf,
  normalizeAreas,
  statusOf,
  titleOf,
  type WarningEntry,
  WarningStore,
} from './warning-store.js'

/** Ключ маршрута выпуска (стартовый маршрут — в пакете ЧС, ADR-0202). */
export const WARNING_ROUTE_KEY = 'warning_publish'

/** Статусы цепочки, пока уточнение или отмена ещё не выпущены. */
const PENDING: WarningStatus[] = ['draft', 'on_approval', 'approved']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const objectOf = (row: WarningEntry) => ({
  id: row.id,
  type: 'warning' as const,
  spaceId: row.spaceId,
  title: row.title,
})

/** Сводка в `objects.meta`: колонки списка и фильтры реестра. */
const metaOf = (row: {
  status: string
  msgType: string
  severity: string
  urgency: string
  capStatus: string
}) => ({
  status: row.status,
  msgType: row.msgType,
  severity: row.severity,
  urgency: row.urgency,
  capStatus: row.capStatus,
})

async function assertSigner(signerId: string | null | undefined): Promise<void> {
  if (!signerId) return
  const refs = await directory().refs([signerId])
  if (!refs.has(signerId)) {
    throw errors.validation('Подписывающего нет в справочнике', [
      { path: 'signerId', message: 'Подписывающего нет в справочнике' },
    ])
  }
}

/** Сообщение-источник должно быть видно автору: предупреждение не открывает чужие строки. */
async function assertSource(
  ctx: UserCtx,
  source: { datasetId: string; rowId: string } | null | undefined,
) {
  if (!source) return
  await DatasetQueries.row(ctx, source.datasetId, source.rowId)
}

/**
 * Готовность к выпуску — проверяется при отправке на решение: заголовок и
 * описание на государственном и русском языках, явление, категория, область,
 * срок действия в будущем и подписывающий.
 */
function readinessIssues(row: WarningEntry): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = []
  const infos = infosOf(row)
  for (const language of ['tg', 'ru'] as const) {
    const info = infos[language]
    if (!info?.headline) {
      issues.push({ path: `info.${language}.headline`, message: 'Нужен заголовок' })
    }
    if (!info?.description) {
      issues.push({ path: `info.${language}.description`, message: 'Нужно описание' })
    }
  }
  if (!infos.ru?.event && !infos.tg?.event && !infos.en?.event) {
    issues.push({ path: 'info.ru.event', message: 'Назовите явление' })
  }
  if (row.categories.length === 0) {
    issues.push({ path: 'categories', message: 'Выберите категорию' })
  }
  if ((row.areas ?? []).length === 0) {
    issues.push({ path: 'areas', message: 'Укажите хотя бы одну область' })
  }
  const now = Date.now()
  if (!row.expires) {
    issues.push({ path: 'expires', message: 'Укажите срок действия' })
  } else if (new Date(row.expires).getTime() <= now) {
    issues.push({ path: 'expires', message: 'Срок действия уже истёк' })
  } else if (row.effective && new Date(row.effective) >= new Date(row.expires)) {
    issues.push({ path: 'effective', message: 'Начало действия — раньше окончания' })
  }
  if (!row.signerId) {
    issues.push({ path: 'signerId', message: 'Выберите, кто подписывает решение' })
  }
  return issues
}

export const WarningService = {
  /** Создать черновик; пространство — переданное или из настроек установки. */
  async create(
    tx: Tx,
    ctx: UserCtx,
    raw: WarningCreateInput,
    options: { msgType?: 'Alert' | 'Update' | 'Cancel'; referencesId?: string | null } = {},
  ): Promise<string> {
    const input = WarningCreateInput.parse(raw)
    const spaceId = input.spaceId ?? (await WarningSettingsService.current()).spaceId
    if (!spaceId) {
      throw errors.validation('Выберите пространство предупреждения', [
        { path: 'spaceId', message: 'Пространство предупреждений не задано в настройках' },
      ])
    }
    await authorize(ctx, 'create_child', spaceId)
    await assertSigner(input.signerId)
    await assertSource(ctx, input.source)
    const areas = await normalizeAreas(input.areas)
    const id = newId()
    const values = {
      id,
      identifier: `urn:uuid:${id}`,
      status: 'draft',
      msgType: options.msgType ?? 'Alert',
      capStatus: input.capStatus,
      referencesId: options.referencesId ?? null,
      info: input.info as Record<string, unknown>,
      categories: [...input.categories],
      urgency: input.urgency,
      severity: input.severity,
      certainty: input.certainty,
      responseTypes: [...input.responseTypes],
      effective: input.effective,
      expires: input.expires,
      areas: areas as unknown as Array<Record<string, unknown>>,
      sourceDatasetId: input.source?.datasetId ?? null,
      sourceRowId: input.source?.rowId ?? null,
      signerId: input.signerId,
      authorId: ctx.userId,
    }
    const object = await ObjectService.create(tx, ctx, {
      id,
      type: 'warning',
      spaceId,
      title: titleOf(input.info),
      subtitle: input.info.ru?.event || input.info.tg?.event || null,
      meta: metaOf(values),
    })
    await tx.insert(warnings).values(values)
    await publishEvent(tx, ctx, {
      type: 'warning.created',
      object: { ...object, type: 'warning' },
      payload: { msgType: values.msgType, references: values.referencesId },
    })
    return id
  },

  /** Правка черновика: после отправки на решение содержание не меняется. */
  async update(tx: Tx, ctx: UserCtx, id: string, input: WarningUpdateInput): Promise<void> {
    const row = await WarningStore.lock(tx, id)
    if (statusOf(row) !== 'draft') {
      throw errors.conflict('Править можно только черновик', { status: row.status })
    }
    const patch: Partial<typeof warnings.$inferInsert> = {}
    const changed: string[] = []
    if (input.signerId !== undefined) {
      await assertSigner(input.signerId)
      patch.signerId = input.signerId
      changed.push('signerId')
    }
    if (input.source !== undefined) {
      await assertSource(ctx, input.source)
      patch.sourceDatasetId = input.source?.datasetId ?? null
      patch.sourceRowId = input.source?.rowId ?? null
      changed.push('source')
    }
    if (input.areas !== undefined) {
      patch.areas = (await normalizeAreas(input.areas)) as unknown as Array<Record<string, unknown>>
      changed.push('areas')
    }
    const simple = [
      'capStatus',
      'urgency',
      'severity',
      'certainty',
      'effective',
      'expires',
      'categories',
      'responseTypes',
      'info',
    ] as const
    for (const key of simple) {
      if (input[key] === undefined) continue
      ;(patch as Record<string, unknown>)[key] = input[key]
      changed.push(key)
    }
    if (changed.length === 0) return
    await tx.update(warnings).set(patch).where(eq(warnings.id, id))
    const next = await WarningStore.require(tx, id)
    const infos = infosOf(next)
    await ObjectService.update(
      tx,
      ctx,
      id,
      {
        title: titleOf(infos),
        subtitle: infos.ru?.event || infos.tg?.event || null,
        meta: metaOf(next),
        mergeMeta: true,
      },
      { silent: true },
    )
    await publishEvent(tx, ctx, {
      type: 'warning.updated',
      object: objectOf(next),
      payload: { changed },
    })
  },

  /**
   * Черновик из сообщения об опасном явлении: явление и категория — по коду
   * явления, строгость — по уровню тревоги, область — район сообщения, срок —
   * сутки. Строку читают права автора: недоступное сообщение — 404.
   */
  async fromMessage(tx: Tx, ctx: UserCtx, input: WarningFromMessageInput): Promise<string> {
    const settings = await WarningSettingsService.current()
    const datasetId = input.datasetId ?? settings.sourceDatasetId
    if (!datasetId) {
      throw errors.validation('Реестр сообщений об опасных явлениях не задан', [
        { path: 'datasetId', message: 'Реестр сообщений не задан в настройках' },
      ])
    }
    const [row, dataset] = await Promise.all([
      DatasetQueries.row(ctx, datasetId, input.rowId),
      datasetRecord(datasetId),
    ])
    const values = row.values
    const text = (key: string) => (typeof values[key] === 'string' ? (values[key] as string) : '')
    const hazard = text('hazard')
    const known = HAZARD_EVENTS[hazard]
    const hazardLabel = dataset.fields
      .find((field) => field.key === 'hazard')
      ?.options?.find((option) => option.value === hazard)?.label.ru
    const index = await territoryIndex()
    const territoryValue = text('territory')
    const territory = territoryValue
      ? UUID.test(territoryValue)
        ? index.byId.get(territoryValue)
        : index.byCode.get(territoryValue)
      : undefined
    const occurredAt = text('occurred_at')
    const observed = occurredAt ? new Date(occurredAt).getTime() <= Date.now() : false
    const event = {
      tg: known?.event.tg ?? '',
      ru: known?.event.ru ?? hazardLabel ?? '',
      en: known?.event.en ?? '',
    }
    const place = (language: 'tg' | 'ru' | 'en') =>
      territory ? (territory.name[language] ?? territory.name.ru) : ''
    const headline = (language: 'tg' | 'ru' | 'en') =>
      [event[language], place(language)].filter(Boolean).join(': ').slice(0, 160)
    const info: WarningInfos = {
      tg: { event: event.tg, headline: headline('tg'), description: '', instruction: '' },
      ru: {
        event: event.ru,
        headline: headline('ru'),
        description: text('title'),
        instruction: '',
      },
      en: { event: event.en, headline: headline('en'), description: '', instruction: '' },
    }
    const areas: WarningArea[] = territory
      ? [{ territoryId: territory.id, description: '', polygon: null }]
      : []
    return WarningService.create(tx, ctx, {
      spaceId: settings.spaceId ?? dataset.spaceId,
      info,
      categories: known ? [known.category] : ['Other'],
      severity: ALERT_LEVEL_SEVERITY[text('alert_level')] ?? 'Moderate',
      urgency: observed ? 'Immediate' : 'Expected',
      certainty: observed ? 'Observed' : 'Likely',
      expires: new Date(Date.now() + 24 * 3600_000).toISOString(),
      areas,
      source: { datasetId, rowId: input.rowId },
    })
  },

  /**
   * Уточнение или отмена опубликованного (ADR-0202): новый черновик со ссылкой
   * на прежнее и его содержанием; прежнее меняет статус, когда выйдет новое.
   * Пока одно уточнение или отмена в работе, второе не заводится.
   */
  async supersede(tx: Tx, ctx: UserCtx, id: string, msgType: 'Update' | 'Cancel'): Promise<string> {
    const row = await WarningStore.lock(tx, id)
    if (statusOf(row) !== 'published') {
      throw errors.conflict('Уточнить или отменить можно только опубликованное', {
        status: row.status,
      })
    }
    const [pending] = await tx
      .select({ id: warnings.id })
      .from(warnings)
      .innerJoin(objects, eq(objects.id, warnings.id))
      .where(
        and(
          eq(warnings.referencesId, id),
          inArray(warnings.status, PENDING),
          isNull(objects.deletedAt),
        ),
      )
      .limit(1)
    if (pending) {
      throw errors.conflict('Уточнение или отмена уже в работе', { warningId: pending.id })
    }
    const infos = infosOf(row)
    const prefix = { tg: 'Бекор карда шуд: ', ru: 'Отмена: ', en: 'Cancelled: ' }
    const info: WarningInfos = {}
    for (const language of ['tg', 'ru', 'en'] as const) {
      const block = infos[language]
      if (!block) continue
      info[language] =
        msgType === 'Cancel'
          ? { ...block, headline: `${prefix[language]}${block.headline}`.slice(0, 160) }
          : block
    }
    return WarningService.create(
      tx,
      ctx,
      {
        spaceId: row.spaceId ?? undefined,
        capStatus: capStatusOf(row),
        info,
        categories: row.categories as WarningContent['categories'],
        urgency: row.urgency as WarningContent['urgency'],
        severity: row.severity as WarningContent['severity'],
        certainty: row.certainty as WarningContent['certainty'],
        responseTypes:
          msgType === 'Cancel'
            ? ['AllClear']
            : (row.responseTypes as WarningContent['responseTypes']),
        effective: null,
        expires: row.expires ? new Date(row.expires).toISOString() : null,
        areas: areasOf(row),
        signerId: row.signerId,
        source:
          row.sourceDatasetId && row.sourceRowId
            ? { datasetId: row.sourceDatasetId, rowId: row.sourceRowId }
            : null,
      },
      { msgType, referencesId: id },
    )
  },

  /** Можно ли отправлять на решение: черновик, право правки, всё заполнено. */
  async assertCanSubmit(executor: Executor, ctx: UserCtx, id: string): Promise<WarningEntry> {
    await authorize(ctx, 'edit', id)
    const row = await WarningStore.require(executor, id)
    if (statusOf(row) !== 'draft') {
      throw errors.conflict('На решение отправляется только черновик', { status: row.status })
    }
    const issues = readinessIssues(row)
    const { signerGroupId } = await WarningSettingsService.current()
    if (row.signerId && signerGroupId) {
      const members = await directory().groupMembers(signerGroupId)
      if (!members.includes(row.signerId)) {
        issues.push({ path: 'signerId', message: 'Решение подписывает уполномоченное лицо группы' })
      }
    }
    if (issues.length > 0) {
      throw errors.validation('Предупреждение не готово к выпуску', issues)
    }
    return row
  },

  /** Отправить на решение уполномоченного лица: маршрут выпуска пакета. */
  async submit(tx: Tx, ctx: UserCtx, id: string): Promise<string> {
    await WarningService.assertCanSubmit(tx, ctx, id)
    const { instanceId } = await ProcessService.start(tx, ctx, {
      objectId: id,
      definitionKey: WARNING_ROUTE_KEY,
    })
    return instanceId
  },

  async get(ctx: UserCtx, id: string): Promise<WarningRecord> {
    await authorize(ctx, 'view', id)
    const row = await WarningStore.require(db(), id)
    const linkIds = [row.referencesId, row.supersededById].filter((value): value is string =>
      Boolean(value),
    )
    const links = linkIds.length
      ? await db()
          .select({
            id: warnings.id,
            identifier: warnings.identifier,
            title: objects.title,
            status: warnings.status,
            msgType: warnings.msgType,
          })
          .from(warnings)
          .innerJoin(objects, eq(objects.id, warnings.id))
          .where(inArray(warnings.id, linkIds))
      : []
    const linkOf = (linkId: string | null) => {
      const link = links.find((item) => item.id === linkId)
      return link
        ? {
            ...link,
            status: link.status as WarningStatus,
            msgType: link.msgType as WarningRecord['msgType'],
          }
        : null
    }
    const people = [row.signerId, row.authorId, row.approvedById].filter((value): value is string =>
      Boolean(value),
    )
    const [refs, edit, running, index, sourceTitle] = await Promise.all([
      directory().refs(people),
      authorize(ctx, 'edit', id, { soft: true }),
      ProcessService.running(db(), id),
      row.areas.length > 0 ? territoryIndex() : Promise.resolve(null),
      row.sourceDatasetId && row.sourceRowId
        ? DatasetQueries.row(ctx, row.sourceDatasetId, row.sourceRowId)
            .then((source) =>
              typeof source.values.title === 'string' ? source.values.title : null,
            )
            .catch(() => null)
        : Promise.resolve(null),
    ])
    const status = statusOf(row)
    const pendingSupersede =
      status === 'published'
        ? await db()
            .select({ id: warnings.id })
            .from(warnings)
            .where(and(eq(warnings.referencesId, id), inArray(warnings.status, PENDING)))
            .limit(1)
        : []
    return {
      id: row.id,
      identifier: row.identifier,
      spaceId: row.spaceId,
      title: row.title,
      status,
      msgType: msgTypeOf(row),
      capStatus: capStatusOf(row),
      info: infosOf(row),
      categories: row.categories as WarningRecord['categories'],
      urgency: row.urgency as WarningRecord['urgency'],
      severity: row.severity as WarningRecord['severity'],
      certainty: row.certainty as WarningRecord['certainty'],
      responseTypes: row.responseTypes as WarningRecord['responseTypes'],
      effective: row.effective,
      expires: row.expires,
      areas: areasOf(row).map((area) => {
        const territory = area.territoryId ? index?.byId.get(area.territoryId) : undefined
        return {
          territoryId: area.territoryId,
          territoryName: territory ? (territory.name[ctx.locale] ?? territory.name.ru) : null,
          territoryCode: territory?.code ?? null,
          description: area.description,
          polygon: area.polygon,
        }
      }),
      source:
        row.sourceDatasetId && row.sourceRowId
          ? { datasetId: row.sourceDatasetId, rowId: row.sourceRowId, title: sourceTitle }
          : null,
      references: linkOf(row.referencesId),
      supersededBy: linkOf(row.supersededById),
      signer: (row.signerId && refs.get(row.signerId)) || null,
      author: (row.authorId && refs.get(row.authorId)) || null,
      approvedAt: row.approvedAt,
      approvedBy: (row.approvedById && refs.get(row.approvedById)) || null,
      publishedAt: row.publishedAt,
      capUrl: row.publishedAt ? capUrlOf(row.id) : null,
      processId:
        running.find((item) => item.definitionKey === WARNING_ROUTE_KEY)?.instanceId ??
        running[0]?.instanceId ??
        null,
      canEdit: edit.allowed && status === 'draft',
      canSubmit: edit.allowed && status === 'draft',
      canSupersede: edit.allowed && status === 'published' && pendingSupersede.length === 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  },

  async list(ctx: UserCtx, query: WarningListQuery): Promise<WarningList> {
    const conditions = [isNull(objects.deletedAt), eq(objects.type, 'warning')]
    if (query.status) conditions.push(eq(warnings.status, query.status))
    const rows = await db()
      .select({ id: warnings.id })
      .from(warnings)
      .innerJoin(objects, eq(objects.id, warnings.id))
      .where(and(...conditions))
      .orderBy(desc(objects.updatedAt))
      .limit(query.limit)
    const items: WarningList['items'] = []
    for (const { id } of rows) {
      const decision = await authorize(ctx, 'view', id, { soft: true })
      if (!decision.allowed) continue
      const row = await WarningStore.load(db(), id)
      if (!row) continue
      items.push({
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: statusOf(row),
        msgType: msgTypeOf(row),
        capStatus: capStatusOf(row),
        severity: row.severity as WarningRecord['severity'],
        urgency: row.urgency as WarningRecord['urgency'],
        effective: row.effective,
        expires: row.expires,
        publishedAt: row.publishedAt,
        areas: (await areaLabels(row)).filter(Boolean),
        updatedAt: row.updatedAt,
      })
    }
    return { items }
  },

  async settings(): Promise<WarningSettings> {
    const current = await WarningSettingsService.current()
    const members = current.signerGroupId
      ? await directory().groupMembers(current.signerGroupId)
      : []
    const refs = await directory().refs(members)
    return {
      ...current,
      signers: members.flatMap((id) => refs.get(id) ?? []),
      feeds: feedUrls(),
    }
  },

  /**
   * Сообщения-источники для выбора «из сообщения»: последние строки реестра
   * правами смотрящего, с названием района и временем доведения.
   */
  async sources(ctx: UserCtx, query: WarningSourcesQuery): Promise<WarningSourceList> {
    const { sourceDatasetId } = await WarningSettingsService.current()
    if (!sourceDatasetId) return { datasetId: null, items: [] }
    const decision = await authorize(ctx, 'view', sourceDatasetId, { soft: true })
    if (!decision.allowed) return { datasetId: null, items: [] }
    const [visible, dataset, index] = await Promise.all([
      DatasetQueries.visibleFields(ctx, sourceDatasetId),
      datasetRecord(sourceDatasetId),
      territoryIndex(),
    ])
    const wanted = ['code', 'title', 'hazard', 'occurred_at', 'territory', 'status', 'published_at']
    const fields = wanted.filter((key) => visible.has(key))
    if (!fields.includes('title')) return { datasetId: sourceDatasetId, items: [] }
    const spec = QuerySpec.parse({
      version: 1,
      source: { kind: 'dataset', id: sourceDatasetId },
      steps: [
        { type: 'select', fields },
        ...(fields.includes('occurred_at')
          ? [{ type: 'sort', by: [{ field: 'occurred_at', dir: 'desc' }] }]
          : []),
        { type: 'limit', limit: query.limit },
      ],
      options: { cache: false },
    })
    const result = await DatasetQueries.run(ctx, spec, { rowMeta: true, maxRows: query.limit })
    const names = result.fields.map((field) => field.name)
    const value = (row: unknown[], key: string) => {
      const position = names.indexOf(key)
      const raw = position >= 0 ? row[position] : null
      return raw === null || raw === undefined ? null : String(raw)
    }
    const hazards = new Map(
      (dataset.fields.find((field) => field.key === 'hazard')?.options ?? []).map((option) => [
        option.value,
        option.label[ctx.locale] ?? option.label.ru,
      ]),
    )
    return {
      datasetId: sourceDatasetId,
      items: result.rows.map((row) => {
        const territoryValue = value(row, 'territory')
        const territory = territoryValue
          ? (index.byId.get(territoryValue) ?? index.byCode.get(territoryValue))
          : undefined
        const hazard = value(row, 'hazard')
        return {
          rowId: value(row, '_id') ?? '0',
          code: value(row, 'code'),
          title: value(row, 'title') ?? '',
          hazard: hazard ? (hazards.get(hazard) ?? hazard) : null,
          occurredAt: value(row, 'occurred_at'),
          territoryName: territory ? (territory.name[ctx.locale] ?? territory.name.ru) : null,
          status: value(row, 'status'),
          publishedAt: value(row, 'published_at'),
        }
      }),
    }
  },
}
