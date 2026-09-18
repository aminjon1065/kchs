import { test } from '@playwright/test'

/**
 * Замер прокрутки DataGrid: бюджет 04-interaction-patterns.md §1 — 60 fps на
 * 100 столбцах × 100 000 строк (история «Большой набор»). В визуальный стенд
 * не входит, запускается отдельно:
 *
 *   KCHS_PERF=1 pnpm --filter @kchs/ui test:visual grid-perf
 *
 * Прокрутка программная, покадровая: каждый кадр сдвигает таблицу и ждёт
 * следующий requestAnimationFrame. «Кадр» — разность отметок rAF (событие
 * прокрутки, отрисовка React, раскладка, покраска); кадр дольше 25 мс (полтора
 * кадра при 60 Гц) считается пропущенным. «Скрипт» — время обработки события
 * прокрутки: виртуализатор и синхронная отрисовка строк React. Замедление
 * процессора ×4 (CDP) приближает слабый офисный компьютер.
 *
 * Подсветка Storybook (storybook/highlight) на каждое изменение DOM истории
 * обходит все элементы страницы с getComputedStyle — в приложении этого нет,
 * поэтому её наблюдатель на время замера не подключается: меряется таблица,
 * а не обвязка Storybook.
 */
test.skip(!process.env.KCHS_PERF, 'замер производительности — по KCHS_PERF=1')

interface Scenario {
  name: string
  /** Сдвиг за кадр, px. `jump` — случайная строка каждый кадр (худший случай). */
  dy: number
  dx: number
  frames: number
  jump?: boolean
}

const SCENARIOS: Scenario[] = [
  { name: 'вниз, 90 px/кадр (~5 400 px/с)', dy: 90, dx: 0, frames: 300 },
  { name: 'вниз, 600 px/кадр (быстрая прокрутка)', dy: 600, dx: 0, frames: 200 },
  { name: 'вправо, 60 px/кадр', dy: 0, dx: 60, frames: 200 },
  { name: 'по диагонали, 90/40 px/кадр', dy: 90, dx: 40, frames: 200 },
  { name: 'прыжки по всей таблице', dy: 0, dx: 0, frames: 120, jump: true },
]

const RUNS = [
  { latency: 0, cpu: 1 },
  { latency: 120, cpu: 1 },
  { latency: 0, cpu: 4 },
]

for (const { latency, cpu } of RUNS) {
  const title = `данные ${latency ? `через ${latency} мс` : 'сразу'}, процессор ×${cpu}`
  test(`DataGrid: прокрутка 100 × 100 000, ${title}`, async ({ page }) => {
    test.setTimeout(180_000)
    if (cpu > 1) {
      const session = await page.context().newCDPSession(page)
      await session.send('Emulation.setCPUThrottlingRate', { rate: cpu })
    }
    await page.addInitScript(() => {
      const Original = window.MutationObserver
      window.MutationObserver = class extends Original {
        override observe(target: Node, options?: MutationObserverInit) {
          if (target instanceof HTMLElement && target.id === 'storybook-root' && options?.subtree) {
            return
          }
          super.observe(target, options)
        }
      }
    })
    await page.goto(
      `/iframe.html?id=composites-data-grid--large&viewMode=story&args=latency:${latency}`,
    )
    await page.getByRole('grid', { name: 'Показатели' }).waitFor()

    const lines: string[] = []
    for (const scenario of SCENARIOS) {
      const stats = await page.evaluate(async ({ dy, dx, frames, jump }) => {
        const grid = document.querySelector<HTMLElement>('[role="grid"]')
        if (!grid) throw new Error('нет таблицы')
        grid.scrollTo(0, 0)
        const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
        await frame()
        await frame()

        // Обработчик на окне в фазе перехвата срабатывает раньше обработчика
        // виртуализатора, добавленный позже обработчик на таблице — после него
        let start = 0
        const scripts: number[] = []
        const before = () => {
          start = performance.now()
        }
        const after = () => scripts.push(performance.now() - start)
        window.addEventListener('scroll', before, { capture: true })
        grid.addEventListener('scroll', after)

        const maxTop = grid.scrollHeight - grid.clientHeight
        const maxLeft = Math.max(1, grid.scrollWidth - grid.clientWidth)
        let seed = 7
        const random = () => {
          seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
          return seed / 2_147_483_648
        }
        const durations: number[] = []
        let last = await frame()
        for (let i = 0; i < frames; i++) {
          if (jump) grid.scrollTop = random() * maxTop
          else {
            grid.scrollTop = (grid.scrollTop + dy) % maxTop
            grid.scrollLeft = (grid.scrollLeft + dx) % maxLeft
          }
          const now = await frame()
          durations.push(now - last)
          last = now
        }
        window.removeEventListener('scroll', before, { capture: true })
        grid.removeEventListener('scroll', after)

        const sorted = [...durations].sort((a, b) => a - b)
        const mean = (values: number[]) =>
          values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
        return {
          avg: mean(durations),
          p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
          max: sorted[sorted.length - 1] ?? 0,
          dropped: durations.filter((value) => value > 25).length,
          frames: durations.length,
          script: mean(scripts),
          scriptMax: Math.max(0, ...scripts),
          cells: grid.querySelectorAll('[role="gridcell"]').length,
        }
      }, scenario)
      lines.push(
        [
          scenario.name,
          `кадр ${stats.avg.toFixed(2)} мс (${(1000 / stats.avg).toFixed(1)} fps)`,
          `p95 ${stats.p95.toFixed(1)} мс`,
          `макс ${stats.max.toFixed(1)} мс`,
          `пропущено ${stats.dropped}/${stats.frames}`,
          `скрипт ${stats.script.toFixed(2)} мс (макс ${stats.scriptMax.toFixed(1)})`,
          `ячеек в DOM ${stats.cells}`,
        ].join(' · '),
      )
    }
    const report = [title, ...lines].join('\n')
    test.info().annotations.push({ type: 'замер', description: report })
    process.stdout.write(`\n${report}\n`)
  })
}
