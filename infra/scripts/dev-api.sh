#!/usr/bin/env bash
# Перезапуск api в фоне с записью лога (используется при разработке и проверках)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${KCHS_API_LOG:-/tmp/kchs-logs/api.log}"
mkdir -p "$(dirname "$LOG")"

lsof -ti tcp:"${PORT:-3000}" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
sleep 1
cd "$ROOT/apps/api"
nohup pnpm exec tsx src/main.ts > "$LOG" 2>&1 &
echo "api запущен, лог: $LOG"

for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://localhost:${PORT:-3000}/health" > /dev/null 2>&1; then
    echo "health: ok"
    exit 0
  fi
  sleep 1
done
echo "api не ответил за 60 с" >&2
tail -30 "$LOG" >&2
exit 1
