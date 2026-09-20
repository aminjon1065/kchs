import { resolveAssignees } from '@kchs/process'
import { kernelDirectory } from '~/kernel/process/directory.js'

/**
 * Получатели и ответственные — тот же язык назначений, что у маршрутов и
 * правил автоматизации (ADR-0079, ADR-0096): `user:`, `role:`, `unit_head(…)`,
 * `manager(…)`. Второго языка в продукте нет.
 */
export async function resolvePeople(
  expressions: readonly string[],
  context: { spaceId: string | null; authorId: string | null },
): Promise<string[]> {
  if (expressions.length === 0) return []
  const { assignees } = await resolveAssignees(
    expressions,
    {
      authorId: context.authorId,
      initiatorId: context.authorId,
      spaceId: context.spaceId,
      variables: {},
      variableTypes: {},
      fields: {},
    },
    kernelDirectory,
  )
  return [...new Set(assignees.map((item) => item.userId))]
}
