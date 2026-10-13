import type { ActiveDelegation, MeResponse, UserRef } from '@kchs/contracts'
import { ToastProvider, TooltipProvider, UiLocaleProvider } from '@kchs/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderResult, render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { vi } from 'vitest'

/**
 * Помощники тестов компонентов (ADR-0209): клиент запросов без повторов, ответы API по
 * пути и вошедший сотрудник `/me`.
 */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
      },
      mutations: { retry: false },
    },
  })
}

/** Компонент в окружении оболочки (`app/providers.tsx`): запросы, язык, подсказки, тосты. */
export function renderWithClient(
  ui: ReactElement,
  client: QueryClient = testQueryClient(),
): Pick<RenderResult, 'rerender' | 'unmount'> & { client: QueryClient } {
  // Обёртка, а не часть разметки: `rerender` сохраняет окружение
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <UiLocaleProvider locale="ru">
        <TooltipProvider delayDuration={0}>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </UiLocaleProvider>
    </QueryClientProvider>
  )
  const { rerender, unmount } = render(ui, { wrapper })
  return { client, rerender, unmount }
}

type Reply = unknown | ((request: { url: URL; init: RequestInit | undefined }) => unknown)

export interface ApiCall {
  method: string
  path: string
  body: unknown
}

/**
 * `fetch` отвечает JSON по пути без `/api/v1`: ключ `'POST /documents'` или просто `'/me'` для
 * GET. Неизвестный путь — 404. Возвращает журнал запросов.
 */
export function stubApi(routes: Record<string, Reply>): ApiCall[] {
  const calls: ApiCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = input instanceof Request ? input.url : String(input)
      const url = new URL(raw, 'http://localhost')
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.pathname.replace(/^\/api\/v1/, '')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, path, body })
      const reply = routes[`${method} ${path}`] ?? (method === 'GET' ? routes[path] : undefined)
      if (reply === undefined) return json({ code: 'NOT_FOUND', message: path }, 404)
      return json(typeof reply === 'function' ? reply({ url, init }) : reply)
    }),
  )
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const NOW = '2026-10-13T08:00:00.000Z'
export const ME_ID = '00000000-0000-4000-8000-000000000001'

export function userRef(id: string, displayName: string): UserRef {
  return { id, displayName, avatarUrl: null, position: null, unitName: null }
}

/** `/me` вошедшего сотрудника: минимальный, поля — по контракту. */
export function meFixture(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user: {
      id: ME_ID,
      login: 'user001',
      email: null,
      phone: null,
      displayName: 'Сотрудник Проверочный',
      firstName: null,
      lastName: null,
      middleName: null,
      avatarUrl: null,
      locale: 'ru',
      timezone: 'Asia/Dushanbe',
      status: 'active',
      attributes: {},
    },
    personalSpaceId: null,
    roles: [],
    capabilities: [],
    units: [],
    positions: [],
    actingFor: [],
    delegatedTo: [],
    mfaEnabled: false,
    mustChangePassword: false,
    mfaEnrollmentRequired: false,
    preferences: {},
    features: [],
    hiddenScreens: [],
    clearance: 'internal',
    adminMode: null,
    session: {
      id: '00000000-0000-4000-8000-0000000000aa',
      expiresAt: NOW,
      createdAt: NOW,
      csrfToken: 'csrf',
      onBehalfOf: null,
    },
    ...overrides,
  }
}

/** Замещение: вошедший сотрудник исполняет обязанности `from`. */
export function delegationFixture(id: string, from: UserRef): ActiveDelegation {
  return {
    id,
    fromUser: from,
    toUser: userRef(ME_ID, 'Сотрудник Проверочный'),
    scope: 'all',
    startsAt: NOW,
    endsAt: '2026-10-20T08:00:00.000Z',
    note: null,
  }
}
