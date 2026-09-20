#!/usr/bin/env bash
# Пассивное сканирование установки ZAP baseline (17-security.md §8,
# 04-delivery/04-verification.md §1). ZAP запускается в Docker — ставить его не
# нужно. Активные атаки не выполняются: паук обходит адреса и смотрит ответы.
#
#   bash infra/security/zap-baseline.sh                      # установка в контейнерах, :8080
#   KCHS_ZAP_TARGETS='http://host.docker.internal:58080' \
#     bash infra/security/zap-baseline.sh                    # стенд verify-stack.sh (KEEP=1)
#   KCHS_ZAP_PROFILE=dev KCHS_ZAP_TARGETS='http://host.docker.internal:5173 \
#     http://host.docker.internal:3000/api/docs' bash infra/security/zap-baseline.sh
#
# Профили:
#   app (по умолчанию) — установка целиком: заголовки ставит Caddy (ADR-0043),
#                        и правила про CSP, кадры и типы содержимого работают;
#   dev                — стенд разработки (vite :5173, api :3000 напрямую): Caddy
#                        нет, поэтому к списку добавляется zap-baseline-dev.conf
#                        с правилами тех самых заголовков. Настоящую проверку
#                        заголовков даёт профиль app.
#
# Список игнорируемых правил — zap-baseline.conf, каждое с объяснением. Всё, чего
# в списке нет, роняет прогон: и FAIL, и WARN. Отчёты (HTML, JSON, Markdown) —
# в KCHS_ZAP_OUT_DIR, в CI — в артефактах.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="${KCHS_ZAP_PROFILE:-app}"
TARGETS="${KCHS_ZAP_TARGETS:-http://host.docker.internal:8080 http://host.docker.internal:8080/api/docs}"
ZAP_IMAGE="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}"
SPIDER_MINUTES="${KCHS_ZAP_SPIDER_MINUTES:-2}"
START_MINUTES="${KCHS_ZAP_START_MINUTES:-10}"
OUT_DIR="${KCHS_ZAP_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/kchs-zap.XXXXXX")}"

mkdir -p "$OUT_DIR"
# Отчёты пишет пользователь zap внутри контейнера — каталог открыт на запись
chmod 777 "$OUT_DIR"

# Список правил профиля собирается в каталог отчётов: у zap-baseline.py один -c
CONF="$OUT_DIR/rules.conf"
cat "$ROOT/infra/security/zap-baseline.conf" > "$CONF"
if [[ "$PROFILE" == dev ]]; then
  cat "$ROOT/infra/security/zap-baseline-dev.conf" >> "$CONF"
fi

status=0
index=0
for target in $TARGETS; do
  index=$((index + 1))
  name="scan-$index"
  step=0
  echo "── ZAP baseline: $target (профиль $PROFILE) ──"
  # host.docker.internal — адрес хоста из контейнера (в Linux его даёт host-gateway)
  docker run --rm \
    --add-host host.docker.internal:host-gateway \
    -v "$OUT_DIR:/zap/wrk" \
    "$ZAP_IMAGE" zap-baseline.py \
    -t "$target" \
    -c "rules.conf" \
    -m "$SPIDER_MINUTES" \
    -T "$START_MINUTES" \
    -r "$name.html" -J "$name.json" -w "$name.md" \
    2>&1 | tee "$OUT_DIR/$name.txt" || step=$?
  # Худший исход по всем целям: удачная вторая цель не отменяет замечаний первой
  if ((step > status)); then status=$step; fi
done

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '### ZAP baseline (профиль %s)\n\n' "$PROFILE"
    for file in "$OUT_DIR"/scan-*.txt; do
      printf '```\n%s\n```\n' "$(grep -E '^(WARN|FAIL|IGNORE|INFO)' "$file" || echo 'без замечаний')"
    done
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "Отчёты ZAP: $OUT_DIR"
# 0 — чисто; 1 — есть FAIL; 2 — есть WARN вне списка; 3 — ZAP не запустился
exit "$status"
