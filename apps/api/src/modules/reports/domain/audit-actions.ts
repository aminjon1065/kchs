/**
 * Действия аудита отчётов (ADR-0182, ADR-0185). Файл отчёта — выгрузка данных с
 * правами того, под кем он построен (17-security.md §6): в аудит идёт и построение,
 * и скачивание файла. Значение `report.generated` прежнее — журналы его уже содержат.
 */
export const REPORTS_AUDIT = {
  reportGenerated: 'report.generated',
  reportDownloaded: 'report.downloaded',
} as const
