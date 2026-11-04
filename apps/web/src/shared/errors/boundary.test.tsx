import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isChunkLoadError, ViewBoundary } from './boundary.js'

/**
 * Граница вкладки (ADR-0228): упавший экран показывает объяснение и выход, а не
 * роняет оболочку; модуль, не загруженный без сети, — отдельный текст.
 */

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
})

function Exploding({ error }: { error: Error }): never {
  throw error
}

function Flaky() {
  const [broken] = useState(() => (globalThis as { kchsBroken?: boolean }).kchsBroken === true)
  if (broken) throw new Error('сбой показа')
  return <p>экран открыт</p>
}

describe('граница ошибок вкладки', () => {
  it('ошибка показа: соседи живы, «Повторить» перерисовывает, «Закрыть вкладку» закрывает', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const close = vi.fn()
    ;(globalThis as { kchsBroken?: boolean }).kchsBroken = true
    render(
      <div>
        <p>соседняя вкладка</p>
        <ViewBoundary onClose={close}>
          <Flaky />
        </ViewBoundary>
      </div>,
    )
    expect(screen.getByText('соседняя вкладка')).toBeTruthy()
    expect(screen.getByText('Экран не открылся')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть вкладку' }))
    expect(close).toHaveBeenCalledOnce()

    ;(globalThis as { kchsBroken?: boolean }).kchsBroken = false
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(screen.getByText('экран открыт')).toBeTruthy()
  })

  it('модуль экрана не загрузился без сети — экран откроется, когда вернётся связь', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/map.js')
    expect(isChunkLoadError(error)).toBe(true)
    render(
      <ViewBoundary>
        <Exploding error={error} />
      </ViewBoundary>,
    )
    expect(screen.getByText('Экран недоступен без сети')).toBeTruthy()
    const reload = screen.getByRole('button', { name: 'Обновить страницу' }) as HTMLButtonElement
    expect(reload.disabled).toBe(true)
  })

  it('модуль не загрузился со связью — вышла новая версия, нужна перезагрузка', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ViewBoundary>
        <Exploding error={new TypeError('Importing a module script failed.')} />
      </ViewBoundary>,
    )
    expect(screen.getByText('Вышла новая версия портала')).toBeTruthy()
    expect(isChunkLoadError(new Error('обычная ошибка'))).toBe(false)
  })
})
