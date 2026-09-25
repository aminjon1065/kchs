#!/bin/sh
# Ключ Meilisearch только для /metrics (ADR-0147): действие metrics.get вместо
# мастер-ключа у Prometheus. Идентификатор ключа постоянный, значение выводится
# из мастер-ключа — после его смены ключ меняется сам при следующем запуске.
set -eu

uid=6f1f3a52-9c0d-4d2e-8b7a-4a9e2c1d5b36
api=http://meilisearch:7700
auth="Authorization: Bearer $MEILI_MASTER_KEY"
body="{\"uid\":\"$uid\",\"name\":\"kchs-prometheus\",\"description\":\"Prometheus: только /metrics (ADR-0147)\",\"actions\":[\"metrics.get\"],\"indexes\":[\"*\"],\"expiresAt\":null}"

# Ключ уже есть — сервер отвечает 409, это не ошибка
wget -q -O /dev/null -T 10 --header "$auth" --header 'Content-Type: application/json' \
  --post-data "$body" "$api/keys" 2>/dev/null || true

key="$(wget -q -O - -T 10 --header "$auth" "$api/keys/$uid" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
if [ -z "$key" ]; then
  echo "kchs: ключ метрик Meilisearch не получен" >&2
  exit 1
fi

umask 077
printf '%s' "$key" > /secrets/meilisearch-key.tmp
chown 65534:65534 /secrets/meilisearch-key.tmp
mv /secrets/meilisearch-key.tmp /secrets/meilisearch-key
echo "kchs: ключ метрик Meilisearch готов"
