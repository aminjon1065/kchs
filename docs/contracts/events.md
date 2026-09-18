# Контракт: конверт события

```json
{
  "id": "01J8X4M3K9Q2Z7C1V5B8N0P2R4",
  "type": "document.registered",
  "version": 1,
  "occurredAt": "2026-09-17T08:15:32.114Z",
  "actor": {"kind": "user", "userId": "01J...", "onBehalfOf": null, "sessionId": "..."},
  "object": {"id": "01J...", "type": "document", "spaceId": "01J...", "title": "Письмо №12-К/2026"},
  "target": {"id": "01J...", "type": "journal"},
  "payload": {"regNumber": "12-К/2026", "journalId": "01J...", "typeKey": "incoming"},
  "changedFields": null,
  "correlationId": "req_...",
  "causationId": null,
  "source": "api|worker|engine|automation|integration:telegram",
  "visibility": {"principals": ["space:01J...:viewer", "user:01J..."]}
}
```

## Правила
- `id` — ULID/UUIDv7 (упорядочен по времени); `type` — из каталога (`16-api-and-events.md`), `version` — версия схемы полезной нагрузки.
- `actor.kind`: `user | system | automation | integration`; действия «от имени» — `onBehalfOf`.
- `object` — краткая ссылка (без содержимого); `payload` — минимум для реакции; `changedFields` — список ключей для `*.updated`.
- `visibility.principals` — принципалы, имеющие право видеть факт события (для realtime-фильтрации и вебхуков); заполняется ядром из ACL на момент события.
- Outbox → Redis Streams `events:<domain>`; потребители — consumer groups с `ack`; повтор до 5 раз, затем DLQ `events:dlq` с алертом.
- Вебхуки получают тот же конверт (без `visibility`), подпись `X-Kchs-Signature: sha256=…`, заголовки `X-Kchs-Event`, `X-Kchs-Delivery`.
- Realtime получает производные компактные сообщения (см. `16-api-and-events.md`, раздел 3), не сырые события.
- Полезные нагрузки описаны zod-схемами в `packages/contracts/src/events/*.ts`; регистрация типа события без схемы запрещена (тест).
