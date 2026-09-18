#!/usr/bin/env bash
# Веб-клиент в фоне под простым супервизором: перезапускается, если процесс упал.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${KCHS_WEB_LOG:-/tmp/kchs-logs/web.log}"
PIDFILE="${KCHS_WEB_PID:-/tmp/kchs-logs/web.pid}"
mkdir -p "$(dirname "$LOG")"

if [[ -f "$PIDFILE" ]]; then
  kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
fi
lsof -ti tcp:5173 2>/dev/null | xargs -r kill -9 2>/dev/null || true
sleep 1

cd "$ROOT/apps/web"
nohup bash -c 'while true; do pnpm exec vite --host 127.0.0.1; echo "[supervisor] vite остановился, перезапуск через 2 с"; sleep 2; done' \
  > "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
echo "web запущен (супервизор pid $(cat "$PIDFILE")), лог: $LOG"

for _ in $(seq 1 45); do
  if curl -fsS -m 2 "http://localhost:5173/" > /dev/null 2>&1; then
    echo "web: ok"
    exit 0
  fi
  sleep 1
done
echo "web не ответил за 45 с" >&2
tail -30 "$LOG" >&2
exit 1
