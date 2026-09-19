import { useEffect, useState } from 'react'

/** Текущий момент с шагом в минуту: линия «сейчас», «Сегодня», смена дня. */
export function useNow(stepMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(Date.now())
      // Следующий тик — на границе шага, чтобы минута менялась вовремя
      timer = setTimeout(tick, stepMs - (Date.now() % stepMs) + 50)
    }
    timer = setTimeout(tick, stepMs - (Date.now() % stepMs) + 50)
    return () => clearTimeout(timer)
  }, [stepMs])
  return now
}
