import type { Meta, StoryObj } from '@storybook/react-vite'
import { within } from 'storybook/test'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card.js'

const meta = {
  title: 'Композиты/Карточка по наведению',
  id: 'composites-hover-card',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  name: 'Открыта',
  render: () => (
    <div className="h-[200px]">
      <HoverCard delay={0}>
        <HoverCardTrigger asChild>
          <button type="button" className="text-sm text-accent underline-offset-4 hover:underline">
            Паводок-2026
          </button>
        </HoverCardTrigger>
        <HoverCardContent className="w-72">
          <div className="text-sm font-medium text-fg">Паводок-2026</div>
          <p className="mt-1 text-xs text-fg-secondary">
            Командное пространство оперативного штаба: 18 участников, 42 объекта.
          </p>
        </HoverCardContent>
      </HoverCard>
    </div>
  ),
  // Карточка открывается и по фокусу — так она доступна с клавиатуры
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole('button', { name: 'Паводок-2026' }).focus()
    await within(document.body).findByText(/оперативного штаба/)
  },
}
