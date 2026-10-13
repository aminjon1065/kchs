import type { FieldDef } from '@kchs/contracts'
import { Field } from '@kchs/ui'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithClient } from '~/test/render.js'
import { PhotoField } from './photo-field.js'

/**
 * Имя кнопки фото (ADR-0208): подпись поля и видимый текст кнопки вместе. Одна подпись
 * не содержала бы текста «Добавить фото» (голосовое управление), один текст — поля, а в
 * табличной форме — номера строки (экранный диктор).
 */
const field = { key: 'photo', label: { ru: 'Снимок места' }, type: 'file' } as FieldDef

function photo(id: string) {
  return (
    <PhotoField
      id={id}
      field={field}
      value={null}
      onChange={() => undefined}
      invalid={false}
      disabled={false}
      userId="00000000-0000-4000-8000-0000000000a1"
    />
  )
}

describe('PhotoField', () => {
  it('в форме: подпись поля и текст кнопки', () => {
    renderWithClient(
      <Field label="Снимок места" htmlFor="photo-1">
        {photo('photo-1')}
      </Field>,
    )
    expect(screen.getByRole('button', { name: 'Снимок места Добавить фото' })).toBeVisible()
  })

  it('в ячейке таблицы: номер строки не теряется', () => {
    renderWithClient(
      <div>
        <label id="photo-2-label" htmlFor="photo-2" className="sr-only">
          Снимок места, строка 2
        </label>
        {photo('photo-2')}
      </div>,
    )
    expect(
      screen.getByRole('button', { name: 'Снимок места, строка 2 Добавить фото' }),
    ).toBeVisible()
  })
})
