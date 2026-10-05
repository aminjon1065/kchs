#!/bin/sh
# Redis платформы: очереди BullMQ, потоки событий, кэш (ADR-0014, ADR-0015).
#
# noeviction обязателен: у предела памяти запись отклоняется, ключи не вытесняются —
# иначе пропали бы задания и события (оповещение KchsRedisMemory — на 90 %).
#
# Пользователь движка kchs-engine (ADR-0176): только ключи очередей заданий движка
# (исполнитель engine в QUEUE_RUNTIME, packages/contracts/src/jobs/job.ts) и чтение
# флагов отмены. Потоков событий `events:*`, сессий и кэша ему не видно, перечислять
# ключи (SCAN, KEYS) и слушать каналы он не может. Без REDIS_ENGINE_PASSWORD
# (установка до ADR-0176) пользователь не заводится, а движок ходит прежним
# паролем: generate-secrets.sh --add-missing дописывает ключ.
#
# Копия для чарта — infra/helm/kchs/files/redis-start.sh; совпадение и список
# очередей проверяет packages/contracts/src/jobs/engine-access.test.ts.
set -eu

set -- redis-server \
  --appendonly yes \
  --appendfsync everysec \
  --maxmemory "${REDIS_MAXMEMORY:-1gb}" \
  --maxmemory-policy noeviction \
  --requirepass "$REDIS_PASSWORD"

if [ -n "${REDIS_ENGINE_PASSWORD:-}" ]; then
  set -- "$@" --user kchs-engine on ">$REDIS_ENGINE_PASSWORD" resetkeys \
    '~bull:imports:*' '~bull:transform:*' '~bull:render:*' '~bull:media:*' '~bull:ai:*' \
    '%R~kchs:job:cancel:*' resetchannels \
    '+@all' '-@dangerous' '+info' '-scan' '-randomkey' '-@pubsub'
fi

exec "$@"
