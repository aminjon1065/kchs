// Первым: до модулей со схемами zod (см. zod-jitless.ts)
import './app/zod-jitless.js'
import { readCspNonce, setCspNonce } from '@kchs/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app.js'
import { Providers } from './app/providers.js'
import './styles/app.css'

// CSP страницы (ADR-0043): <style>, которые библиотеки вставляют во время работы,
// помечаются nonce запроса
setCspNonce(readCspNonce())

const container = document.getElementById('root')
// i18n-ignore — ошибка сборки страницы для разработчика, не текст интерфейса
if (!container) throw new Error('Не найден корневой элемент #root')

createRoot(container).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
)
