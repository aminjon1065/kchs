import { randomUUID } from 'node:crypto'
import type { ReportFormat } from '@kchs/contracts'
import { desc, eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buckets, copyObject, storageKey } from '~/kernel/storage/s3.js'
import { DocumentsPublic } from '~/modules/documents/public.js'
import { registerGeneratedFile } from '~/modules/files/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, reportRuns } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { ReportService } from './report-service.js'
import { ReportRuns } from './run-service.js'

/**
 * Отчёт исходящим документом (P5-E09, сценарий C, ADR-0127): готовый отчёт
 * уходит за пределы организации как документ — со своим маршрутом
 * согласования, подписью, регистрацией и рассылкой. Файл последнего удачного
 * прогона становится первой версией документа: второго рендера не делаем,
 * подписывают ровно то, что видели.
 */

/** PDF подписывают охотнее: он не меняется от версии редактора. */
const ORDER: ReportFormat[] = ['pdf', 'docx']

const MIME: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export const ReportToDocument = {
  /**
   * Черновик исходящего документа с файлом отчёта первой версией.
   * Возвращает идентификатор документа — дальше обычная карточка и маршрут.
   */
  async create(
    ctx: UserCtx,
    reportId: string,
    input: { typeId: string; subject?: string },
  ): Promise<{ documentId: string }> {
    await authorize(ctx, 'view', reportId)
    const report = await ReportService.get(reportId)

    const [lastRun] = await db()
      .select({ id: reportRuns.id })
      .from(reportRuns)
      .where(eq(reportRuns.reportId, reportId))
      .orderBy(desc(reportRuns.createdAt))
      .limit(20)
    if (!lastRun) throw errors.conflict('Отчёт ещё не строился — сначала постройте его')

    // Берём последний прогон, у которого есть файлы: пустые и упавшие пропускаем
    const runs = await ReportRuns.list(ctx, reportId)
    let picked: { runId: string; format: ReportFormat } | null = null
    for (const run of runs) {
      if (run.status !== 'succeeded') continue
      const format = ORDER.find((item) => run.files.some((file) => file.format === item))
      if (format) {
        picked = { runId: run.id, format }
        break
      }
    }
    if (!picked) throw errors.conflict('Нет готового файла отчёта — постройте отчёт заново')

    const stored = await ReportRuns.files(picked.runId)
    const chosen = picked
    const file = stored?.files.find((item) => item.format === chosen.format)
    if (!file) throw errors.conflict('Файл отчёта не найден в хранилище')

    const [object] = await db()
      .select({ spaceId: objects.spaceId })
      .from(objects)
      .where(eq(objects.id, reportId))
      .limit(1)
    const spaceId = object?.spaceId
    if (!spaceId) throw errors.notFound('Отчёт')

    const subject = (input.subject ?? report.name).slice(0, 500)
    const fileId = randomUUID()
    const versionId = randomUUID()
    const key = storageKey(spaceId, fileId, versionId, file.fileName)
    // Копия, а не ссылка: выгрузки живут 30 дней (ilm), а документ — вечно
    await copyObject(file.key, key, buckets.files(), buckets.exports())

    const documentId = await db().transaction(async (tx) => {
      const id = await DocumentsPublic.create(tx, ctx, {
        typeId: input.typeId,
        subject,
        summary: `Отчёт «${report.name}»`,
      })
      await registerGeneratedFile(tx, ctx, {
        fileId,
        versionId,
        spaceId,
        name: file.fileName,
        mime: MIME[chosen.format],
        size: file.size,
        storageKey: key,
        checksum: null,
        attachToObjectId: id,
      })
      return id
    })

    // Версия — отдельной транзакцией: проверка прав на документ читает базу, а
    // права черновика появляются только после фиксации первой транзакции
    await db().transaction((tx) =>
      DocumentsPublic.addVersion(tx, ctx, documentId, {
        mainFileId: fileId,
        note: `Отчёт «${report.name}»`,
      }),
    )
    return { documentId }
  },
}
