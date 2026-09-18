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
      },
    },
  },
})
