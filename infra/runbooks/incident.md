# Реагирование на инцидент

## Быстрая диагностика

```bash
curl -fsS http://localhost:3000/health          # живость api
docker compose ps                                # состояние контейнеров
docker compose logs --tail=200 api worker        # последние ошибки
```

Экран «Администрирование → Здоровье системы» показывает состояние компонентов,
отставание outbox и счётчики заданий.

## Типовые ситуации

| Симптом | Причина | Действие |
|---|---|---|
| Уведомления и поиск отстают | остановлен `worker` или потребители событий | `docker compose --profile app restart worker`; проверить «Неопубликованных событий» |
| Объекты не находятся в поиске | Meilisearch недоступен или индекс потерян | поднять сервис, запустить задание `index/search.reindex` |
| Файлы не загружаются | недоступен MinIO или истекли подписанные URL | проверить `storage` в здоровье системы, время на сервере |
| Массовые 429 | всплеск запросов или неверная интеграция | посмотреть аудит и `rate_limited` в логах, при необходимости поднять лимиты в конфигурации |
| Всплеск `user.login_failed` | подбор пароля | заблокировать источник на прокси, проверить аудит, включить обязательную MFA для ролей |
| Рост задержек БД | тяжёлые запросы | `pg_stat_statements`, `log_min_duration_statement=500` уже включён |

## Поверхности фазы 5

| Симптом | Причина | Действие |
|---|---|---|
| Вебхуки отключились сами | серия отказов получателя (событие `webhook.disabled`) | журнал доставок в карточке: код ответа и ошибка; после починки получателя — «Повторить» и снять паузу |
| Доставка не уходит, в журнале «внутренняя сеть» | имя получателя стало разрешаться в служебный адрес | проверить DNS получателя; на закрытом контуре — `WEBHOOKS_ALLOW_PRIVATE_ADDRESSES=true` осознанно и только там |
| Интеграция шлёт 404 на входящий вебхук | секрет сменили, вход выключен или интеграция отключена | карточка интеграции: «Входящий вебхук» и статус; новый адрес выдаётся кнопкой |
| Массовые 403 `scope_required` | токену не хватает области | `Администрирование → Безопасность → Токены API`: посмотреть области; новую область даёт только новый токен |
| Никто не входит через единый вход | недоступен IdP, сменился секрет клиента, разошлось время | `Администрирование → Вход → Проверить соединение`; вход паролем при этом работает |
| Каталог заблокировал живых сотрудников | неточный фильтр синхронизации | журнал синхронизаций: план прогона; вернуть статус в `Пользователи`, поправить фильтр, прогнать предпросмотр |
| Файлы не открываются в редакторе | недоступен сервер документов или разошёлся `ONLYOFFICE_JWT_SECRET` | `GET /api/v1/files/office/status`; секрет — в `.env` и в конфигурации ONLYOFFICE одновременно |
| Очередь «Из почты» пуста, письма есть | ящик недоступен, правила отбора отсекают, письма уже прочитаны | «Проверить соединение» у интеграции IMAP; журнал синхронизаций показывает причину по каждому письму |
| Пачка писем разбирается по частям | за прогон набирается не больше 128 МБ | это норма: остаток достаётся следующему прогону, непрочитанное не теряется |
| Внешний источник данных не отвечает | недоступна чужая БД или имя стало служебным адресом | `Проверить соединение` в карточке источника; ошибка показывается как есть |
| Запросы к датасету стали медленнее | колоночная копия устарела и запросы вернулись в Postgres | карточка датасета: состояние копии, кнопка пересборки |
| Копий нет несколько дней | выключено расписание или падает `pg_dump` | аудит: `backup.created` и `backup.failed`; `Администрирование → Расписания`, задание `backup.run` |

## Оповещения наблюдаемости

Приходят письмом и в Telegram из Alertmanager профиля `observability` (ADR-0147).
Правила — `infra/observability/prometheus/alerts.yml`, картина — дашборды Grafana
«kchs — обзор» и «kchs — инфраструктура». `critical` — данные недоступны или скоро
будут, `warning` — деградация.

| Оповещение | Что значит | Действие |
|---|---|---|
| `KchsInstanceDown` | api или worker не отдаёт метрики | `docker compose ps`, `docker compose logs --tail=200 api worker`; перезапуск сервиса |
| `KchsHttpErrorRate`, `KchsHttpLatencyBudget` | ошибки 5xx выше 1 % или p95 выше 200 мс | дашборд «kchs — обзор»: маршрут и код; журналы с `trace_id` → трасса в Tempo |
| `KchsOutboxStuck`, `KchsQueueGrowing` | события не публикуются, очередь растёт | worker жив? «Здоровье системы» → «Неопубликованных событий»; журнал worker |
| `KchsMemoryBudget` | RSS процесса выше 1 ГБ | рост за часы — утечка: снять кучу, перезапустить процесс в окно |
| `KchsPostgresDown` | база не отвечает экспортёру | `docker compose ps postgres`, `docker compose logs postgres`; место на диске; см. `restore.md`, если том повреждён |
| `KchsPostgresConnections` | занято больше 80 % `max_connections` | `SELECT usename, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;` — кто держит; утечка пула — перезапуск его процесса |
| `KchsPostgresLongTransaction` | транзакция открыта дольше 30 минут | `SELECT pid, usename, application_name, now() - xact_start AS age, left(query, 120) FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY age DESC LIMIT 5;` — ночная копия (`pg_dump`) допустима; зависший запрос — `SELECT pg_cancel_backend(pid)`, затем `pg_terminate_backend` |
| `KchsPostgresIdleInTransaction` | соединение открыло транзакцию и ничего не делает | тот же запрос с `state = 'idle in transaction'`; `pg_terminate_backend(pid)`; повторяется — ошибка в коде, в журнал проблем |
| `KchsPostgresDeadlocks` | взаимные блокировки в базе | журнал postgres: «deadlock detected» с запросами; единичные при гонке допустимы, серия — баг |
| `KchsPostgresWraparound` | возраст транзакций выше миллиарда, автоочистка не успевает | `SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;`, долгие транзакции мешают очистке; `VACUUM (FREEZE, VERBOSE)` проблемной базы в окно |
| `KchsRedisDown` | Redis не отвечает — очереди и realtime стоят | `docker compose ps redis`, журнал; место на диске (AOF); после подъёма очереди продолжатся сами |
| `KchsRedisMemory`, `KchsRedisMemoryUnbounded` | память у предела или больше 2 ГБ без предела | `redis-cli --bigkeys`; очереди BullMQ: зависшие завершённые задания; задать `maxmemory` с запасом |
| `KchsRedisRejectedConnections` | исчерпан `maxclients` | кто держит соединения: `redis-cli CLIENT LIST`; утечка — перезапуск процесса |
| `KchsRedisWriteErrors`, `KchsRedisPersistence` | отказ записи (OOM, MISCONF) или сбой сохранения на диск | место на диске и права на том `redisdata`; `redis-cli INFO persistence`; после починки — `BGSAVE` |
| `KchsMinioDown` | MinIO не отдаёт метрики: хранилище лежит или устарел токен | `docker compose ps minio`, журнал; хранилище живо — `docker compose --profile observability up -d metrics-init-minio` выпустит новый токен |
| `KchsMinioNodesOffline`, `KchsMinioDrivesOffline` | узел или диск хранилища вне сети | `mc admin info`; диск — по журналу minio и `dmesg` |
| `KchsMinioLowSpace`, `KchsMinioSpaceCritical` | на диске томов свободно меньше 10 % и 5 % | `docker system df`, `du -sh` томов; просроченные экспорты (`kchs-exports` чистится за 30 дней), старые копии в `kchs-backups`; расширить диск |
| `KchsMeilisearchDown` | поиск не работает, данные целы | поднять сервис; индекс потерян — задание `index/search.reindex` |
| `KchsMeilisearchIndexingLag`, `KchsMeilisearchTaskQueueFull` | индексирование отстаёт, очередь задач заполняется | `GET /tasks?statuses=failed` с мастер-ключом; массовая загрузка — дождаться; очередь полна — очистить старые задачи `DELETE /tasks?statuses=succeeded,failed` |
| `KchsMetricsTargetDown` | метрики службы не собираются, сама служба может работать | контейнер экспортёра (`docker compose --profile observability ps`); Postgres — роль `kchs_monitor`: перезапуск `metrics-init-postgres` |
| `KchsAlertDeliveryFailing` | Alertmanager не доставил оповещение | `docker compose logs alertmanager`; почта — `ALERTMANAGER_SMTP_URL` и получатели; Telegram — чат и доступ бота; тестовое оповещение — руководство 28 |

## Утечка секрета

Отдельный порядок — `secret-leak.md`: что отзывать, в каком порядке и что будет
с людьми. Ротация делается по подозрению, не по доказательству.

## Безопасность

Инциденты доступа расследуются по `audit_log`: он неизменяем (роль `kchs_app`
не имеет прав `UPDATE`/`DELETE`) и партиционирован по месяцам.

```sql
SELECT occurred_at, actor_id, action, object_id, ip
  FROM audit_log
 WHERE occurred_at > now() - interval '24 hours'
   AND severity IN ('warning', 'critical')
 ORDER BY occurred_at DESC;
```

## После инцидента

Зафиксировать причину и меры в `docs/progress.md` («Известные проблемы») и, если
меняется решение, — в ADR.
