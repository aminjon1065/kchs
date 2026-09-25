#!/usr/bin/env bash
# Пользователь MinIO только с правом admin:Prometheus и его токен для Prometheus
# (ADR-0147). Метрики не открываются публично: порт S3 опубликован наружу, а
# MINIO_PROMETHEUS_AUTH_TYPE=public отдал бы размеры бакетов и состав узлов любому.
# Секрет пользователя придумывается при каждом запуске, токен выпускается заново —
# хранить в .env нечего. В образе mc нет sed и grep: разбор — средствами bash.
set -euo pipefail
export MC_CONFIG_DIR=/tmp/mc

mc alias set root http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null

cat > /tmp/kchs-prometheus.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": ["admin:Prometheus"] }]
}
JSON
mc admin policy create root kchs-prometheus /tmp/kchs-prometheus.json >/dev/null

secret="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-40)"
mc admin user add root kchs-prometheus "$secret" >/dev/null
# Повторная привязка той же политики — ошибка «уже привязана», это не сбой
mc admin policy attach root kchs-prometheus --user kchs-prometheus >/dev/null 2>&1 || true

mc alias set prometheus http://minio:9000 kchs-prometheus "$secret" >/dev/null
token=""
while IFS= read -r line; do
  case "$line" in
    *bearer_token:*)
      token="${line#*bearer_token:}"
      token="${token// /}"
      ;;
  esac
done < <(mc admin prometheus generate prometheus)
if [[ -z "$token" ]]; then
  echo "kchs: токен метрик MinIO не выпущен" >&2
  exit 1
fi

umask 077
printf '%s' "$token" > /secrets/minio-token.tmp
chown 65534:65534 /secrets/minio-token.tmp
mv /secrets/minio-token.tmp /secrets/minio-token
echo "kchs: токен метрик MinIO готов"
