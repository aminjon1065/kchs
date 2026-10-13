import type { DatasetRecord } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithClient, stubApi } from '~/test/render.js'
import { AddFieldDialog } from './schema-dialogs.js'

/** Диалог «Новое поле» вкладки «Схема»: ключ проверяется до запроса, занятый ключ не уходит. */
const t = createTranslator('ru')

// Диалогу нужны только идентификатор датасета и его поля
const dataset = {
  id: '00000000-0000-4000-8000-0000000000d1',
  fields: [{ key: 'level', label: { ru: 'Уровень' }, type: 'decimal' }],
} as unknown as DatasetRecord

describe('AddFieldDialog', () => {
  it('занятый ключ — ошибка и кнопка недоступна; свободный — поле уходит в API', async () => {
    const user = userEvent.setup()
    const calls = stubApi({ [`POST /datasets/${dataset.id}/fields`]: { id: dataset.id } })
    const onAdded = vi.fn()
    renderWithClient(<AddFieldDialog dataset={dataset} onClose={() => {}} onAdded={onAdded} />)

    // Ключ — до названия: пустое поле ключа показывает ключ, выведенный из названия
    const key = screen.getByLabelText(t('data.dataset.editor.key'))
    await user.type(key, 'level')
    await user.type(screen.getByLabelText(t('data.dataset.editor.label')), 'Уровень воды')
    const create = screen.getByRole('button', { name: t('common.actions.create') })
    expect(create).toBeDisabled()
    expect(screen.getByText(t('data.import.mapping.errors.keyFormat'))).toBeInTheDocument()

    // Подчёркивание в конце ключ отбрасывает — дописываем цифру
    await user.type(key, '2')
    expect(create).toBeEnabled()
    await user.click(create)
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('level2'))
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      key: 'level2',
      label: { ru: 'Уровень воды' },
      type: 'text',
    })
  })
})
