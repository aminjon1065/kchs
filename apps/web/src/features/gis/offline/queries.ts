import { http } from '~/shared/api/client.js'

/**
 * Стиль подложки для расчёта района (ADR-0211): с рельефом, даже если сотрудник его
 * выключил, — архив рельефа тоже ложится на устройство. Тема и язык на набор архивов не
 * влияют.
 */
export async function packStyle(basemapId: string): Promise<Record<string, unknown>> {
  return (await http.get('/gis/basemaps/:id/style.json', {
    params: { id: basemapId },
    query: { theme: 'light', lang: 'ru', relief: 'normal', labels: 'true' },
  })) as Record<string, unknown>
}
