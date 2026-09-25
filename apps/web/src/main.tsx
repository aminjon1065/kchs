// Первым: до модулей со схемами zod (см. zod-jitless.ts)
import './app/zod-jitless.js'
import { loadLocale } from '@kchs/i18n'
import { readCspNonce, setCspNonce } from '@kchs/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app.js'
import { useAppearance } from './app/appearance.js'
import { Providers } from './app/providers.js'
import './styles/app.css'

// CSP страницы (ADR-0043): <style>, которые библиотеки вставляют во время работы,
// помечаются nonce запроса
setCspNonce(readCspNonce())

const container = document.getElementById('root')
// i18n-ignore — ошибка сборки страницы для разработчика, не текст интерфейса
if (!container) throw new Error('Не найден корневой элемент #root')

// Словарь выбранного языка — отдельный чанк (ADR-0166): интерфейс рисуется, когда он
// загружен, иначе первые экраны мелькнули бы по-русски. Не загрузился — основной язык
void loadLocale(useAppearance.getState().locale)
  .catch(() => undefined)
  .then(() =>
    createRoot(container).render(
      <StrictMode>
        <Providers>
          <App />
        </Providers>
      </StrictMode>,
    ),
  )
