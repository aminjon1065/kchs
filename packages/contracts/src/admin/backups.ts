import { z } from 'zod'

/**
 * Прогон резервной копии (15-admin-operations.md §5, ADR-0117). Копия — дело долгое:
 * запись о прогоне появляется сразу, итог — по завершении.
 */
export const BackupRecord = z.object({
  id: z.uuid(),
  status: z.enum(['running', 'done', 'failed']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  sizeBytes: z.number().int().nullable(),
  requestedBy: z.uuid().nullable(),
  error: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  verifiedNote: z.string().nullable(),
})
export type BackupRecord = z.infer<typeof BackupRecord>

export const BackupList = z.object({ items: z.array(BackupRecord) })
export type BackupList = z.infer<typeof BackupList>
