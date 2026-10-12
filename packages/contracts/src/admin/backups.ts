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

/**
 * Проверка восстановления на резервном узле (ADR-0199): `infra/scripts/dr.sh
 * restore-check` поднимает копию из архива во временном проекте, проверяет её и
 * сообщает итог токеном служебной записи. `pitr` — базовая копия и архив WAL
 * резервного узла, `dump` — копия `pg_dump` из бакета копий (тогда `backupId`).
 */
export const RESTORE_CHECK_KINDS = ['pitr', 'dump'] as const
export const RestoreCheckKind = z.enum(RESTORE_CHECK_KINDS)
export type RestoreCheckKind = z.infer<typeof RestoreCheckKind>

export const RestoreCheckInput = z.object({
  kind: RestoreCheckKind,
  ok: z.boolean(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  /** Копия `pg_dump`, которую восстановили (`kind = dump`): удачная проверка отмечает её. */
  backupId: z.uuid().optional(),
  /** До какого момента восстановились данные: время последней транзакции копии. */
  recoveredTo: z.iso.datetime().nullable().optional(),
  /** Узел, где шла проверка. */
  host: z.string().trim().max(200).optional(),
  /** Что проверено и что не так: строки отчёта скрипта. */
  details: z.string().max(4000).default(''),
})
export type RestoreCheckInput = z.infer<typeof RestoreCheckInput>

export const RestoreCheck = z.object({
  id: z.uuid(),
  kind: RestoreCheckKind,
  ok: z.boolean(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  backupId: z.uuid().nullable(),
  recoveredTo: z.iso.datetime().nullable(),
  host: z.string().nullable(),
  details: z.string(),
  reportedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
})
export type RestoreCheck = z.infer<typeof RestoreCheck>

export const RestoreCheckList = z.object({ items: z.array(RestoreCheck) })
export type RestoreCheckList = z.infer<typeof RestoreCheckList>
