import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '~/shared/api/errors.js'
import { LoadFailure } from './load-failure.js'

/** Экран не загрузил объект (ADR-0228): «не найдено» — только по ответу 404. */
const problem = (status: number) =>
  new ApiError({
    type: 'about:blank',
    title: 'x',
    status,
    code: 'internal_error',
    detail: 'Сбой сервера',
  })

describe('объект не загрузился', () => {
  it('404 или объекта нет — «не найдено»', () => {
    render(<LoadFailure error={problem(404)} />)
    expect(screen.getByText('Не найдено')).toBeTruthy()
  })

  it('нет доступа, нет связи и сбой сервера — свои тексты, а не «не найдено»', () => {
    const { unmount } = render(<LoadFailure error={problem(403)} />)
    expect(screen.queryByText('Не найдено')).toBeNull()
    unmount()

    const offline = render(
      <LoadFailure error={new TypeError('Failed to fetch')} onRetry={() => undefined} />,
    )
    expect(screen.getByText('Нет связи с сервером')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
    offline.unmount()

    render(<LoadFailure error={problem(500)} onRetry={() => undefined} />)
    expect(screen.getByText('Сбой сервера')).toBeTruthy()
    expect(screen.queryByText('Не найдено')).toBeNull()
  })
})
