import type { StorybookConfig } from '@storybook/react-vite'

/**
 * Storybook дизайн-системы (03-ui/02-design-system.md): все компоненты
 * `@kchs/ui` в обеих темах, плотностях и на трёх языках интерфейса.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  typescript: { reactDocgen: false },
  async viteFinal(viteConfig) {
    const { mergeConfig } = await import('vite')
    const { default: tailwindcss } = await import('@tailwindcss/vite')
    return mergeConfig(viteConfig, {
      plugins: [tailwindcss()],
      // Шрифты — отдельными файлами, как в приложении (apps/web/vite.config.ts)
      build: { assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? false : undefined) },
    })
  },
}

export default config
