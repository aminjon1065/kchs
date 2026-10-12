#!/usr/bin/env bash
# Зеркало хранилища основного сервера на резервном узле (ADR-0199). Пользователь
# kchs-dr на основном только читает (minio/dr-policy.json). На каждый бакет — свой
# `mc mirror --watch`: сначала полная сверка, затем копирование по уведомлениям.
# Любой упавший процесс роняет контейнер, и после перезапуска сверка идёт заново —
# так не теряется то, что пришло, пока слежения не было.
set -euo pipefail

mc alias set primary "$KCHS_DR_PRIMARY_S3" "$S3_DR_ACCESS_KEY" "$S3_DR_SECRET_KEY" >/dev/null
mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null

flags=(--watch --overwrite --quiet)
[[ -n "${KCHS_DR_MIRROR_REMOVE:-}" ]] && flags+=(--remove)

for bucket in $KCHS_DR_BUCKETS; do
  mc mb --ignore-existing "local/$bucket" >/dev/null
  echo "kchs: зеркало $bucket — сверка и слежение"
  mc mirror "${flags[@]}" "primary/$bucket" "local/$bucket" &
done

# Первый завершившийся процесс — сбой: контейнер перезапустится и сверит всё заново
wait -n
echo "kchs: зеркало остановилось — перезапуск" >&2
exit 1
