# Контракт: AutomationRule

```json
{
  "version": 1,
  "name": {"ru": "Крупные договоры — уведомить финансистов"},
  "enabled": true,
  "runAs": "service:automation",
  "trigger": {"kind": "event", "type": "document.registered", "filter": {"object.type": "document"}},
  "conditions": {"and": [
    {"expr": "object.typeKey == 'contract'"},
    {"expr": "object.fields.amount >= 1000000"}
  ]},
  "actions": [
    {"type": "notify", "to": ["group:finance"], "template": "large_contract", "channels": ["app", "telegram"]},
    {"type": "create_task", "kind": "instruction", "title": "Проверить договор {{object.regNumber}}", "assignee": "unit_head('finance')", "dueWorkingDays": 3, "source": "{{object.id}}"},
    {"type": "add_tag", "tag": "крупный"},
    {"type": "webhook", "url": "https://erp.local/hooks/contracts", "payload": {"id": "{{object.id}}", "amount": "{{object.fields.amount}}"}}
  ],
  "limits": {"maxRunsPerHour": 100, "dedupeKey": "{{object.id}}"}
}
```

## Триггеры
`event` (тип из каталога + фильтр по полям конверта), `schedule` (`cron`, `timezone`), `webhook` (входящий), `manual` (кнопка у объекта типа; появляется в меню «⋯»), `metric` (значение показателя по расписанию: `metricId`, `condition`).

## Действия
`notify`, `create_task`, `update_fields`, `set_status`, `assign`, `create_document` (по шаблону), `start_process`, `run_pipeline`, `run_import` (из файла-источника), `add_link`, `add_tag`, `post_message` (в беседу/канал), `create_event`, `send_email`, `send_telegram`, `webhook`, `ai_task` (промпт + куда записать результат), `wait` (задержка/до события — превращает правило в процесс), `stop`.

## Контекст выражений и шаблонов
`event.*`, `object.*` (сводка + поля), `actor.*`, `previous.*` (для `updated`), `now`, `user_attr`, функции языка выражений. Шаблоны `{{…}}` — тот же язык, экранирование по контексту.

## Правила исполнения
- `runAs` — служебный пользователь с ограниченными правами (администратор назначает); правило не может сделать больше, чем `runAs`.
- Идемпотентность по `(ruleId, eventId)` и `dedupeKey`; лимиты; журнал `rule_runs` с логом шагов; ошибки — уведомление владельцу правила.
- Защита от циклов: события, порождённые правилом, несут `causationId`; правило не запускается от собственных событий; глубина цепочки ≤ 5.
- Тестовый режим: прогон на N последних событиях без действий («что бы произошло»).
