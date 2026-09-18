import { ToastProvider, TooltipProvider, UiLocaleProvider } from '@kchs/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { ApiError } from '~/shared/api/client.js'
import { useAppearance } from './appearance.js'

export function Providers({ children }: { children: ReactNode }) {
  // Подписи дизайн-системы (кнопки «Закрыть», «Отмена»…) — на языке интерфейса
  const locale = useAppearance((s) => s.locale)
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Отсутствие прав и «не найдено» повторять бессмысленно
              if (error instanceof ApiError && error.status < 500) return false
              return failureCount < 2
            },
          },
          mutations: { retry: false },
        },
      }),
  )

  return (
    <QueryClientProvider client={client}>
      <UiLocaleProvider locale={locale}>
        <TooltipProvider delayDuration={400} skipDelayDuration={300}>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </UiLocaleProvider>
    </QueryClientProvider>
  )
}
