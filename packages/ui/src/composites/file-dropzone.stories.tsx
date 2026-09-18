import type { Meta, StoryObj } from '@storybook/react-vite'
import { FileDropzone } from './file-dropzone.js'

const meta = {
  title: 'Композиты/Зона загрузки',
  id: 'composites-file-dropzone',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  name: 'Крупная',
  render: () => (
    <div className="max-w-[480px]">
      <FileDropzone onFiles={() => undefined} hint="PDF, DOCX, XLSX, изображения — до 2 ГБ" />
    </div>
  ),
}

export const Compact: Story = {
  name: 'Компактная (панель «Связи»)',
  render: () => (
    <div className="flex max-w-[320px] flex-col gap-3">
      <FileDropzone compact onFiles={() => undefined} label="Перетащите файлы, чтобы прикрепить" />
      <FileDropzone compact disabled onFiles={() => undefined} label="Недоступно" />
    </div>
  ),
}
