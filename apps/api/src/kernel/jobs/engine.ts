import type { Ctx } from '~/shared/context.js'
import { buckets } from '../storage/s3.js'
import { JobService } from './service.js'

/**
 * Задания, исполняемые Python-движком. Очереди общие с TypeScript-воркером;
 * обработчик регистрируется в движке, а не здесь (01-overview.md §Контейнеры).
 */
export const EngineJobs = {
  /** Проверка сквозного пути api → очередь → движок → результат. */
  echo: (ctx: Ctx, message: string) =>
    JobService.enqueue(ctx, {
      queue: 'transform',
      name: 'engine.echo',
      data: { message },
    }),
  /**
   * Файлы демо-данных и manifest.json в хранилище (P1-E10, ADR-0063); готовый
   * манифест того же профиля и seed движок не генерирует заново.
   */
  demoGenerate: (ctx: Ctx, input: { profile: string; seed: number; prefix: string }) =>
    JobService.enqueue(ctx, {
      queue: 'transform',
      name: 'demo.generate',
      data: { ...input, bucket: buckets.files() },
      options: { attempts: 1 },
    }),
} as const
