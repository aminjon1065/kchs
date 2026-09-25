import { ToastProvider, TooltipProvider, UiLocaleProvider, UiTimeZoneProvider } from '@kchs/ui'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { ApiError } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
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
        <ProfileTimeZone>
          <TooltipProvider delayDuration={400} skipDelayDuration={300}>
            <ToastProvider>{children}</ToastProvider>
          </TooltipProvider>
        </ProfileTimeZone>
      </UiLocaleProvider>
    </QueryClientProvider>
  )
}

/**
 * Поля даты-времени дизайн-системы — в поясе профиля сотрудника: поле `datetime-local`
 * пояса не знает, и без него время вводилось бы в поясе браузера. До входа — пояс браузера.
 * Сам `/me` здесь не запрашивается (`enabled: false`), только читается из кэша: приложение
 * намеренно не ходит за ним на гостевых страницах, при сбросе пароля и после выхода.
 */
function ProfileTimeZone({ children }: { children: ReactNode }) {
  const { data: me } = useQuery({ ...meQuery(), enabled: false })
  return <UiTimeZoneProvider timeZone={me?.user.timezone}>{children}</UiTimeZoneProvider>
}
