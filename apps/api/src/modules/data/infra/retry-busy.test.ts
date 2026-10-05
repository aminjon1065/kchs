import { describe, expect, it } from 'vitest'
import { AppError, errors } from '~/shared/errors.js'
import { isDatasetBusy, retryWhileBusy } from './physical.js'

const busy = () =>
  new AppError('conflict', 'Датасет сейчас занят', 409, { details: { reason: 'dataset_busy' } })
const noSleep = async () => {}

describe('retryWhileBusy', () => {
  it('повторяет, пока таблица занята, и отдаёт результат', async () => {
    let calls = 0
    const result = await retryWhileBusy(
      async () => {
        calls++
        if (calls < 3) throw busy()
        return 'готово'
      },
      { sleep: noSleep },
    )
    expect(result).toBe('готово')
    expect(calls).toBe(3)
  })

  it('после последней попытки отдаёт ошибку занятой таблицы', async () => {
    let calls = 0
    const failure = await retryWhileBusy(
      async () => {
        calls++
        throw busy()
      },
      { attempts: 2, sleep: noSleep },
    ).catch((error: unknown) => error)
    expect(isDatasetBusy(failure)).toBe(true)
    expect(calls).toBe(2)
  })

  it('прочие ошибки не повторяет', async () => {
    let calls = 0
    const failure = await retryWhileBusy(
      async () => {
        calls++
        throw errors.conflict('Идёт импорт')
      },
      { sleep: noSleep },
    ).catch((error: unknown) => error)
    expect(isDatasetBusy(failure)).toBe(false)
    expect(calls).toBe(1)
  })

  it('пауза растёт с номером попытки', async () => {
    const pauses: number[] = []
    await retryWhileBusy(
      async () => {
        if (pauses.length < 2) throw busy()
        return null
      },
      { pauseMs: 100, sleep: async (ms) => void pauses.push(ms) },
    )
    expect(pauses).toEqual([100, 200])
  })
})
