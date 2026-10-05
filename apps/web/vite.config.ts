import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const API_TARGET = process.env.KCHS_API_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Chromium движка печатает отчёты со страницы `/print/*` из своего контейнера:
    // при разработке веб для него — host.docker.internal (ADR-0078)
    allowedHosts: ['host.docker.internal'],
    watch: {
      ignored: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/drizzle/**'],
    },
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
      '/collab': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Шрифты — всегда отдельные файлы: data:-URI не пропустит CSP font-src 'self'
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
    rollupOptions: {
      output: {
        // Оболочка отдельно от тяжёлых модулей — бюджет бандла ≤ 400 КБ gz
        manualChunks: {
          react: ['react', 'react-dom'],
          query: ['@tanstack/react-query'],
        },
        // Словари — `i18n-<язык>-<неймспейс>-<хэш>.js` (ADR-0191): у файлов неймспейсов
        // одинаковые имена во всех языках, без языка в имени чанки не различить
        chunkFileNames: (chunk) => {
          const locale = /\/i18n\/src\/locales\/(\w+)\/(\w+)\.ts$/.exec(chunk.facadeModuleId ?? '')
          return locale
            ? `assets/i18n-${locale[1]}-${locale[2]}-[hash].js`
            : 'assets/[name]-[hash].js'
        },
      },
    },
  },
})
