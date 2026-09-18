import type { Ctx } from '~/shared/context.js'
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
} as const
