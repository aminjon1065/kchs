import { type Locale, loadLocale } from '@kchs/i18n'
import type { Decorator, Preview } from '@storybook/react-vite'
import {
  readCspNonce,
  setCspNonce,
  ToastProvider,
  TooltipProvider,
  UiLocaleProvider,
} from '../src/index.js'
import './storybook.css'

// Как в приложении (apps/web/src/main.tsx): nonce CSP из <meta name="csp-nonce">.
// В Storybook его нет — кроме проверки строгого CSP (visual/sql-editor.spec.ts)
setCspNonce(readCspNonce())

type Theme = 'light' | 'dark'
type Density = 'comfortable' | 'compact'

/**
 * Внешний вид задаётся так же, как в приложении (apps/web/src/app/appearance.ts):
 * атрибуты `data-theme` и `data-density` на <html>, язык — через UiLocaleProvider.
 */
const withAppearance: Decorator = (Story, context) => {
  const theme = (context.globals.theme ?? 'light') as Theme
  const density = (context.globals.density ?? 'comfortable') as Density
  const locale = (context.globals.locale ?? 'ru') as Locale

  const root = document.documentElement
  root.dataset.theme = theme
  root.dataset.density = density
  root.lang = locale

  return (
    <UiLocaleProvider locale={locale}>
      <TooltipProvider delayDuration={0}>
        <ToastProvider>
          <Story />
        </ToastProvider>
      </TooltipProvider>
    </UiLocaleProvider>
  )
}

const preview: Preview = {
  decorators: [withAppearance],
  // Словари tg и en в браузере догружаются (ADR-0166) — до отрисовки истории
  loaders: [
    async (context) => {
      await loadLocale((context.globals.locale ?? 'ru') as Locale)
      return {}
    },
  ],
  globalTypes: {
    theme: {
      description: 'Тема',
      toolbar: {
        title: 'Тема',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Светлая' },
          { value: 'dark', title: 'Тёмная' },
        ],
        dynamicTitle: true,
      },
    },
    density: {
      description: 'Плотность',
      toolbar: {
        title: 'Плотность',
        icon: 'component',
        items: [
          { value: 'comfortable', title: 'Комфортная' },
          { value: 'compact', title: 'Компактная' },
        ],
        dynamicTitle: true,
      },
    },
    locale: {
      description: 'Язык',
      toolbar: {
        title: 'Язык',
        icon: 'globe',
        items: [
          { value: 'ru', title: 'Русский' },
          { value: 'tg', title: 'Тоҷикӣ' },
          { value: 'en', title: 'English' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light', density: 'comfortable', locale: 'ru' },
  parameters: {
    // По умолчанию Storybook 10 глушит исключения play-функций (только console.error),
    // и упавшая проверка истории выглядела бы успешной — в том числе для визуальных тестов
    throwPlayFunctionExceptions: true,
    layout: 'padded',
    backgrounds: { disable: true },
    controls: { expanded: true },
    options: { storySort: { method: 'alphabetical' } },
  },
}

export default preview
