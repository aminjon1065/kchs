import type { ProcessDefinitionInput } from '@kchs/process'
import { ProcessDefinitions } from '~/kernel/process/index.js'
import { WARNING_ROUTE_KEY, WarningSettings } from '~/modules/warnings/public.js'
import { db } from '~/shared/db/client.js'
import type { PackContext } from './context.js'

/**
 * Выпуск предупреждения населению (ADR-0202): решение уполномоченного лица —
 * подпись руководителя штаба или его заместителя (рабочее допущение владельца) с
 * кодом второго фактора. Подписывающего выбирает автор из группы «Руководство
 * штаба ЧС» — модуль сверяет выбор с группой из настроек. Срок — час: ЧС не ждут.
 */
export const WARNING_ROUTE: ProcessDefinitionInput = {
  version: 1,
  key: WARNING_ROUTE_KEY,
  objectType: 'warning',
  name: {
    ru: 'Выпуск предупреждения: решение руководства штаба',
    tg: 'Нашри огоҳӣ: қарори роҳбарияти ситод',
    en: 'Warning release: HQ leadership decision',
  },
  description: {
    ru: 'Подпись руководителя штаба или заместителя с кодом второго фактора — час; после подписи предупреждение публикуется в CAP.',
    en: 'Signature of the HQ head or a deputy with a second-factor code — one hour; the warning is published as CAP once signed.',
  },
  start: 'decision',
  steps: {
    decision: {
      type: 'sign',
      name: { ru: 'Решение о выпуске', tg: 'Қарор дар бораи нашр', en: 'Release decision' },
      assignees: ['field:signer'],
      dueHours: 1,
      requireMfa: true,
      onReject: 'end:refused',
      next: 'end',
    },
    end: { type: 'end', outcome: 'completed' },
  },
  timers: [
    {
      step: '*',
      onOverdue: [
        { action: 'notify', to: 'author' },
        { action: 'notify', to: 'manager(step.assignee)' },
      ],
    },
  ],
}

/**
 * Маршрут выпуска и настройки модуля: пространство штаба, реестр «Сообщения об
 * опасных явлениях» и группа подписывающих. Идемпотентно (ADR-0128): изменённый
 * администратором маршрут и выбранные им настройки не трогаются.
 */
export async function ensureWarnings(
  pack: PackContext,
  datasets: ReadonlyMap<string, string>,
  signerGroupId: string,
): Promise<{ route: boolean }> {
  const route = await db().transaction((tx) =>
    ProcessDefinitions.ensure(tx, pack.ctx, WARNING_ROUTE),
  )
  await db().transaction((tx) =>
    WarningSettings.ensure(tx, pack.ctx, {
      spaceId: pack.spaceId,
      sourceDatasetId: datasets.get('hazard_messages') ?? null,
      signerGroupId,
    }),
  )
  pack.log('предупреждения CAP готовы', { route })
  return { route }
}
