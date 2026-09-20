import type { PushStatus } from '@kchs/contracts'
import { http } from '~/shared/api/client.js'

/**
 * Push-уведомления браузера (ADR-0094): служебный поток `/sw.js` показывает
 * уведомление, когда вкладка закрыта. Подписка — по ключу VAPID установки;
 * без него и в браузере без поддержки карточка профиля не показывается.
 */
export const PUSH_SUPPORTED =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/** Регистрация служебного потока — один раз при старте приложения. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!PUSH_SUPPORTED) return null
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch {
    // Служебный поток недоступен (приватный режим, http без localhost) — push просто не будет
    return null
  }
}

function keyToBytes(base64: string): ArrayBuffer {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes.buffer
}

function keyToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Подписка этого устройства: разрешение браузера, затем регистрация на сервере. */
export async function subscribeDevice(publicKey: string): Promise<'subscribed' | 'denied'> {
  const registration = (await navigator.serviceWorker.getRegistration('/')) ?? null
  const ready = registration ?? (await registerServiceWorker())
  if (!ready) return 'denied'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  const existing = await ready.pushManager.getSubscription()
  const subscription =
    existing ??
    (await ready.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(publicKey),
    }))
  await http.post('/me/push/subscriptions', {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: keyToBase64(subscription.getKey('p256dh')),
      auth: keyToBase64(subscription.getKey('auth')),
    },
    userAgent: navigator.userAgent.slice(0, 500),
  })
  return 'subscribed'
}

/** Отписка этого устройства: снимаем и в браузере, и на сервере. */
export async function unsubscribeDevice(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration('/')
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  await http.delete('/me/push/subscriptions', { endpoint: subscription.endpoint })
  await subscription.unsubscribe()
}

/** Подписано ли это устройство (браузер знает это точнее сервера). */
export async function deviceSubscribed(): Promise<boolean> {
  if (!PUSH_SUPPORTED) return false
  const registration = await navigator.serviceWorker.getRegistration('/')
  return Boolean(await registration?.pushManager.getSubscription())
}

export const pushStatusQuery = {
  queryKey: ['me', 'push'] as const,
  queryFn: () => http.get<PushStatus>('/me/push'),
}
