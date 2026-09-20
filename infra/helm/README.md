# Helm-чарт kchs (сценарий S2)

Развёртывание kchs в Kubernetes: `api`, `worker`, `engine`, `web`, задание
миграций, вход через Ingress с TLS и отдельная публикация UDP для медиасервера.
Проектные решения — `docs/02-architecture/15-admin-operations.md` §3 и ADR-0118.
Для одного сервера (S1) остаётся Docker Compose — `infra/compose`.

```
infra/helm/kchs/
├── Chart.yaml
├── values.yaml            все значения с комментариями
├── ci/                    наборы значений для проверок (секреты поддельные)
│   ├── external-values.yaml        внешние управляемые службы
│   ├── embedded-values.yaml        всё в чарте — тестовый кластер
│   └── secret-manager-values.yaml  секреты из внешнего менеджера
└── templates/
```

## Быстрый старт: тестовый кластер

Нужны образы `kchs/api`, `kchs/web`, `kchs/engine` и `kchs/postgres` — те же,
что собирает `docker compose --profile app build`. В kind они загружаются
командой `kind load docker-image`.

```bash
kind create cluster --name kchs
kind load docker-image kchs/api:0.1.0 kchs/web:0.1.0 kchs/postgres:17-3.5 --name kchs
helm upgrade --install kchs infra/helm/kchs \
  -f infra/helm/kchs/ci/embedded-values.yaml --wait --timeout 15m
kubectl logs job/kchs-init          # временный пароль администратора
```

`embedded-values.yaml` поднимает Postgres, Redis, MinIO и Meilisearch
манифестами чарта. Это режим стенда: один экземпляр каждой службы, без
репликации и архива WAL.

## Промышленная установка

Данные — управляемые службы (`docs/02-architecture/15-admin-operations.md` §3):
PostgreSQL оператором (CloudNativePG/Patroni) с репликой и PgBouncer, Redis
Sentinel, внешний S3 или распределённый MinIO, Meilisearch с PVC. Чарт знает о
них только адреса и ключи секрета.

```bash
helm upgrade --install kchs infra/helm/kchs \
  --namespace kchs --create-namespace \
  --set image.tag=1.4.0 \
  --set ingress.host=kchs.example.org \
  --set postgres.host=pgbouncer.kchs.svc.cluster.local \
  --set redis.host=redis-master.kchs.svc.cluster.local \
  --set s3.endpoint=https://s3.example.org \
  --set s3.publicEndpoint=https://s3.example.org \
  --set meilisearch.host=http://meilisearch.kchs.svc.cluster.local:7700 \
  --set secrets.existingSecret=kchs-platform \
  --wait --timeout 15m
```

### Секреты

Паролей и ключей в `values.yaml` нет. Два пути:

1. **Внешний менеджер** (рекомендуется): `secrets.existingSecret=<имя>` — чарт
   свой `Secret` не создаёт, ключи берёт из указанного. Его наполняет Vault
   Secrets Operator, External Secrets или SealedSecrets.
2. **Файл значений вне репозитория**: `secrets.values.*`. Чарт создаёт `Secret`
   с `helm.sh/resource-policy: keep` — он переживает удаление релиза, иначе
   переустановка потеряла бы `KCHS_MASTER_KEY` и с ним доступ к зашифрованным
   данным.

Обязательные ключи:

| Ключ | Что это |
|---|---|
| `POSTGRES_APP_PASSWORD` | роль `kchs_app` |
| `POSTGRES_MIGRATOR_PASSWORD` | роль `kchs_migrator` |
| `POSTGRES_QUERY_PASSWORD` | роль `kchs_query` (пользовательские запросы) |
| `REDIS_PASSWORD` | Redis |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | объектное хранилище |
| `MEILI_MASTER_KEY` | поисковый индекс |
| `KCHS_MASTER_KEY` | 32 байта base64: шифрование секретов и TOTP |
| `INTERNAL_SERVICE_TOKEN` | доверие между api и движком |

Необязательные (`secrets.optionalKeys`): `SMTP_URL`, `ONLYOFFICE_JWT_SECRET`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `PUSH_VAPID_*`, `TELEGRAM_BOT_TOKEN`,
`ANTHROPIC_API_KEY`, `OPENAI_COMPAT_API_KEY`.

Строки подключения чарт собирает сам из адреса и пароля (подстановка
`$(ПЕРЕМЕННАЯ)` kubelet). Если в пароле есть `@ : / ? # %` или строке нужны
свои параметры — положите готовые DSN в секрет и включите
`postgres.urlsFromSecret` / `redis.urlFromSecret`.

## Миграции

Задание `kchs migrate` идёт хуком `pre-install,pre-upgrade`: `helm upgrade
--wait` не катит новые поды, пока схема не обновлена. При встроенном Postgres
хук отключается автоматически (службы зависимостей создаются вместе с релизом,
то есть позже хука) — задание идёт обычным ресурсом и ждёт базу в
`initContainer`. Дополнительная страховка: api применяет миграции и сам при
старте под advisory lock (ADR-0044).

`init.enabled=true` добавляет задание `kchs init` после первой установки:
системные роли, индекс поиска, производственный календарь и первый
администратор с временным паролем. Пароль печатается в журнал задания.

## Масштабирование

| Компонент | Как | Значения |
|---|---|---|
| `api` | HPA по CPU | `api.autoscaling.*` |
| `worker` | KEDA по глубине очередей | `worker.autoscaling.mode=keda` |
| `engine` | KEDA по очередям движка или HPA по CPU | `engine.autoscaling.*` |
| `web` | HPA по CPU (обычно не нужен) | `web.autoscaling.*` |

Глубина очереди — не ресурс пода, обычным HPA её не выразить. Чарт создаёт
`ScaledObject` KEDA с запросом к Prometheus по метрике ядра
`kchs_queue_jobs{queue,state}` (ADR-0045). Значит, в кластере должны быть
установлены KEDA и Prometheus, собирающий метрики api/worker (порт 9464,
`observability.serviceMonitor.enabled=true` для Prometheus Operator). Без KEDA
ставьте `worker.autoscaling.mode=cpu` — это грубее: процессор воркера растёт от
работы, а не от длины очереди, и очередь из тысячи дешёвых заданий его почти не
нагрузит.

## Медиасервер встреч

`livekit.embedded.enabled=true` поднимает LiveKit в кластере. Диапазон портов
UDP сервисом Kubernetes не выражается, поэтому в кластере медиатрафик сводится
в один порт (`rtc.udp_port`, по умолчанию 7882) и публикуется отдельным
`Service` типа `LoadBalancer` мимо Ingress; сигнальный канал (WebSocket) идёт
обычным HTTPS через свой Ingress. `externalTrafficPolicy: Local` сохраняет
адрес клиента — иначе кандидаты ICE подбираются неверно.

## Проверки

```bash
helm lint infra/helm/kchs -f infra/helm/kchs/ci/external-values.yaml
helm lint infra/helm/kchs -f infra/helm/kchs/ci/embedded-values.yaml
helm lint infra/helm/kchs -f infra/helm/kchs/ci/secret-manager-values.yaml
helm template kchs infra/helm/kchs -f infra/helm/kchs/ci/external-values.yaml | \
  kubeconform -strict -ignore-missing-schemas -kubernetes-version 1.30.0 -
```

Те же три набора значений проверяет задание «Helm-чарт» в `.github/workflows/ci.yml`.
`helm lint` без файла значений падает намеренно: обязательные секреты не имеют
значений по умолчанию.

## Чего в чарте нет

- Наблюдаемости (Prometheus, Loki, Tempo, Grafana): в кластере это отдельные
  релизы, чарт только отдаёт метрики и трассы (`observability.*`).
- Резервного копирования Postgres: копии делает сама установка заданием
  платформы в бакет копий (ADR-0117); pgBackRest с архивом WAL — дело оператора
  кластера.
- ONLYOFFICE и Egress записи встреч: ставятся своими чартами, чарту kchs
  сообщаются адресами и секретами.
