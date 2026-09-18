import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/app.js'
import { Providers } from './app/providers.js'
import './styles/app.css'

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
