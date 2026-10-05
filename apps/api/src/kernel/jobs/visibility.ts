import type { JobRecord } from '@kchs/contracts'
import type { UserCtx } from '~/shared/context.js'
import { authorize } from '../access/authorize.js'

/**
 * Кто видит задание (ADR-0172): его инициатор и администратор системы, а
 * системное задание без инициатора — ещё и тот, кому виден объект задания.
 * Задание вне реестра объектов, поэтому правило — здесь, а не в политике типа;
 * остальным задание не показывается вовсе (404), как недоступный объект.
 */
export async function canSeeJob(
  ctx: UserCtx,
  job: Pick<JobRecord, 'initiatorId' | 'objectId'>,
): Promise<boolean> {
  if (ctx.isSystemAdmin) return true
  if (job.initiatorId) return job.initiatorId === ctx.userId
  if (!job.objectId) return false
  return (await authorize(ctx, 'view', job.objectId, { soft: true })).allowed
}
