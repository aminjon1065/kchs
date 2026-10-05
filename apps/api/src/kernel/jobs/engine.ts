import { ENGINE_JOBS, type EngineJobInput, type EngineJobKey } from '@kchs/contracts'
import type { Ctx } from '~/shared/context.js'
import { buckets } from '../storage/s3.js'
import { type EnqueueInput, JobService } from './service.js'

/**
 * Очередь, имя и нагрузка задания Python-движка по контракту (ADR-0190): тип
 * нагрузки знает компилятор, схему `ENGINE_JOBS` проверяет `JobService.schedule`
 * до записи в реестр. Обработчик регистрируется в движке, а не здесь
 * (01-overview.md §Контейнеры).
 */
export function engineJob<K extends EngineJobKey>(
  key: K,
  data: EngineJobInput<K>,
): Pick<EnqueueInput, 'queue' | 'name' | 'data'> {
  const { queue, name } = ENGINE_JOBS[key]
  return { queue, name, data }
}

/** Задания движка, которые ставит само ядро. Очереди общие с TypeScript-воркером. */
export const EngineJobs = {
  /** Проверка сквозного пути api → очередь → движок → результат. */
  echo: (ctx: Ctx, message: string) =>
    JobService.enqueue(ctx, engineJob('transform:engine.echo', { message })),
  /**
   * Файлы демо-данных и manifest.json в хранилище (P1-E10, ADR-0063); готовый
   * манифест того же профиля и seed движок не генерирует заново.
   */
  demoGenerate: (ctx: Ctx, input: Omit<EngineJobInput<'transform:demo.generate'>, 'bucket'>) =>
    JobService.enqueue(ctx, {
      ...engineJob('transform:demo.generate', { ...input, bucket: buckets.files() }),
      options: { attempts: 1 },
    }),
} as const
