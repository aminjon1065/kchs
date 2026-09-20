#!/usr/bin/env bash
# Нагрузка медиасервера встреч (04-verification.md §3, сценарий приёмки фазы 4 №3):
# симулятор поднимает N комнат по M участников и меряет качество потока.
# Симулятор — образ livekit/livekit-cli (`lk load-test`), ставить ничего не нужно.
#
#   bash infra/perf/run-livekit-load.sh                          # проверка стенда: 2 комнаты по 3
#   KCHS_LOAD_ROOMS=20 KCHS_LOAD_PUBLISHERS=5 KCHS_LOAD_SUBSCRIBERS=25 \
#     KCHS_LOAD_DURATION=3m bash infra/perf/run-livekit-load.sh   # приёмка: 20×30 на S1
#
# Переменные: KCHS_LOAD_URL (ws-адрес медиасервера), LIVEKIT_API_KEY и
# LIVEKIT_API_SECRET (окружение или `.env` установки), KCHS_LOAD_QUALITY
# (`high`, `medium`, `low` — качество публикуемого видео), KCHS_LOAD_LAYOUT
# (`speaker`, `3x3`, `4x4`, `5x5` — что видит подписчик).
#
# Критерий фазы — «без деградации API»: параллельно гоняйте профиль API
# (`bash infra/perf/run-k6.sh`) и сверяйте p95 с бюджетом (04-verification.md §4).
# Одна комната — один контейнер симулятора; журналы каждой — в KCHS_LOAD_OUT_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${LIVEKIT_CLI_IMAGE:-livekit/livekit-cli:v2.4.0}"
ROOMS="${KCHS_LOAD_ROOMS:-2}"
PUBLISHERS="${KCHS_LOAD_PUBLISHERS:-1}"
SUBSCRIBERS="${KCHS_LOAD_SUBSCRIBERS:-2}"
DURATION="${KCHS_LOAD_DURATION:-30s}"
QUALITY="${KCHS_LOAD_QUALITY:-high}"
LAYOUT="${KCHS_LOAD_LAYOUT:-speaker}"
OUT_DIR="${KCHS_LOAD_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/kchs-load.XXXXXX")}"
RUN="kchs-load-$(date +%s)"
mkdir -p "$OUT_DIR"

# Ключи: из окружения, иначе из .env установки (значения не печатаются)
env_value() {
  if [[ -n "${!1:-}" ]]; then printf '%s' "${!1}"; return 0; fi
  [[ -f "$ROOT/.env" ]] || return 0
  sed -n "s/^$1=//p" "$ROOT/.env" | head -1 | tr -d '"\r'
}

URL="${KCHS_LOAD_URL:-$(env_value LIVEKIT_URL)}"
KEY="$(env_value LIVEKIT_API_KEY)"
SECRET="$(env_value LIVEKIT_API_SECRET)"
if [[ -z "$URL" || -z "$KEY" || -z "$SECRET" ]]; then
  echo "Не заданы LIVEKIT_URL, LIVEKIT_API_KEY и LIVEKIT_API_SECRET (окружение или .env)" >&2
  exit 2
fi
# Из контейнера localhost — это сам контейнер: подменяем на адрес хоста
URL="${URL//localhost/host.docker.internal}"
URL="${URL//127.0.0.1/host.docker.internal}"

echo "── Нагрузка медиасервера ──────────────────────────────"
echo "комнат: $ROOMS, публикуют: $PUBLISHERS, смотрят: $SUBSCRIBERS,"
echo "длительность: $DURATION, качество: $QUALITY, раскладка: $LAYOUT"
echo "участников всего: $((ROOMS * (PUBLISHERS + SUBSCRIBERS))), журналы: $OUT_DIR"

pids=()
for index in $(seq 1 "$ROOMS"); do
  log="$OUT_DIR/room-$index.log"
  docker run --rm \
    --name "$RUN-$index" \
    --add-host=host.docker.internal:host-gateway \
    -e LIVEKIT_URL="$URL" \
    -e LIVEKIT_API_KEY="$KEY" \
    -e LIVEKIT_API_SECRET="$SECRET" \
    "$IMAGE" load-test \
    --room "$RUN-$index" \
    --identity-prefix "t$index" \
    --video-publishers "$PUBLISHERS" \
    --subscribers "$SUBSCRIBERS" \
    --duration "$DURATION" \
    --video-resolution "$QUALITY" \
    --layout "$LAYOUT" > "$log" 2>&1 &
  pids+=("$!")
done

# Ctrl+C останавливает все комнаты, а не только текущую
cleanup() {
  for index in $(seq 1 "$ROOMS"); do docker rm -f "$RUN-$index" >/dev/null 2>&1 || true; done
}
trap cleanup INT TERM

failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=$((failed + 1))
done
trap - INT TERM

echo
echo "── Итог ───────────────────────────────────────────────"
# Симулятор рисует таблицу с управляющими последовательностями — чистим их
strip_ansi() { LC_ALL=C tr '\r' '\n' | LC_ALL=C sed -e $'s/\x1b\[[0-9;]*[a-zA-Z]//g'; }
for index in $(seq 1 "$ROOMS"); do
  log="$OUT_DIR/room-$index.log"
  summary="$(LC_ALL=C strip_ansi < "$log" 2>/dev/null | grep -a -E "avg|Total" | tail -2 | tr '\n' ' ')"
  printf 'комната %s: %s\n' "$index" "${summary:-нет сводки, см. $log}"
done
if [[ "$failed" -gt 0 ]]; then
  echo "комнат с ошибкой: $failed из $ROOMS (журналы в $OUT_DIR)" >&2
  exit 1
fi
echo "все комнаты отработали; журналы: $OUT_DIR"
