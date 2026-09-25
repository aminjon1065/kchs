# Контракт: AutomationRule

```json
{
  "version": 1,
  "name": {"ru": "Крупные договоры — уведомить финансистов"},
  "description": null,
  "enabled": true,
  "runAs": "01J8X4M3K9Q2Z7C1V5B8N0P2R4",
  "trigger": {"kind": "event", "type": "document.registered", "filter": {"object.type": "document"}},
  "conditions": {"and": [
    {"expr": "object.typeKey == 'contract'"},
    {"expr": "object.fields.amount >= 1000000"}
  ]},
  "actions": [
    {"type": "notify", "to": ["role:finance"], "text": "Крупный договор {{object.title}}", "channels": ["app", "telegram"], "object": "{{object.id}}"},
    {"type": "create_task", "title": "Проверить договор {{object.regNumber}}", "assignee": "unit_head('FIN')", "dueWorkingDays": 3, "source": "{{object.id}}"},
    {"type": "add_tag", "tag": "крупный", "object": "{{object.id}}"},
    {"type": "webhook", "url": "https://erp.local/hooks/contracts", "payload": {"id": "{{object.id}}", "amount": "{{object.fields.amount}}"}}
  ],
  "limits": {"maxRunsPerHour": 100, "dedupeKey": "{{object.id}}", "dedupeWindowMinutes": 60}
}
```

Схема — `packages/contracts/src/automation/rule.ts` (`RuleDefinition`). Правило — объект реестра
типа `rule`: пространство, доступ, поиск и обсуждение — общие (ADR-0096).

## Триггеры
`event` (тип из каталога или префикс домена `task.*` + отбор `filter` по полям конверта),
`schedule` (`cron`, `timezone`, необязательный `objectId`), `webhook` (входящий вызов с ключом
`hookKey`; адрес правила — `POST /api/v1/hooks/rules/{id}/{token}`), `manual` (кнопка у объекта
типов `objectTypes`, с подтверждением по `confirm`), `metric` (значение показателя по
расписанию: `metricId`, `condition` над `value` и `previous`, `cron`, `timezone`).

## Действия
`notify`, `create_task`, `update_fields`, `set_status`, `assign`, `create_document` (по типу
документа), `start_process`, `add_link`, `add_tag`, `post_message` (в обсуждение объекта или
беседу), `create_event`, `send_email`, `send_telegram`, `webhook` (с подписью HMAC-SHA256),
`ai_task` (промпт + куда записать результат: комментарий или поле), `wait` (задержка —
правило продолжается заданием), `stop` (с необязательным условием).

У `notify` и `send_telegram` есть флаг `urgent` (по умолчанию `false`). Срочное уведомление проходит
сквозь тихие часы, «не беспокоить» и встречу получателя — для алертов ЧС, эскалаций и срочных
поручений. Несрочное тишина глушит: Telegram и push молчат, письмо уходит дайджестом после тишины,
значок в приложении остаётся (ADR-0140). Канал `send_telegram` выбран явно и доставляется мимо
режимов категории по умолчанию; снимает его только «выключено» получателя.

Отложены до пайплайнов (P5-E03): `run_pipeline`, `run_import`. Действия `update_fields` и
`set_status` работают для типов с поставщиком данных и переходами (документ, задача);
`assign` — для задач.

## Контекст выражений и шаблонов
`event.*` (`id`, `type`, `occurredAt`, `payload.*`, `changedFields`), `object.*` (сводка,
`fields.*` карточки, свойства типа), `actor.*`, `previous.*` (значения до изменения, если модуль
их публикует), `now`, функции языка выражений (`@kchs/query/expr`): в памяти вычисляются строки,
числа и даты, в том числе `date_diff` и `date_add` — свежесть события ленты:
`date_diff(event.payload.values.occurred_at, now(), 'hour') < 24` (ADR-0128). События строк датасета
(ADR-0133) дают значения строки: `event.payload.values.<поле>`, подписи
`event.payload.labels.<поле>`, территорию с путём кодами
`event.payload.territories.<поле>.path` (условие «в области» —
`contains(event.payload.territories.territory.path, 'TJ-GB')`), у правки — `previous.<поле>`. Шаблоны `{{…}}` — тот же
язык; шаблон целиком из одного выражения сохраняет тип значения (число остаётся числом).
Получатели и исполнители — язык назначений маршрутов (`@kchs/process`): `user:<id>`,
`group:<id>`, `role:<ключ>`, `unit_head(<подразделение>)`, `manager(<люди>)`, `field:<путь>`.

## Правила исполнения
- `runAs` — идентификатор **служебной учётной записи** (ADR-0130: вид `service`, без входа,
  уведомлений и дел; администратором системы не бывает). Сотрудник в `runAs` недопустим: сервер
  отвечает 400 при сохранении и включении, а исполнитель отказывает и в момент запуска, если
  запись не служебная или заблокирована (запуск «Ошибка», уведомление владельцу). Все действия
  проходят `authorize` от её имени, поэтому правило не может сделать больше, чем она. Если
  `run_as` не видит объект события, запуск пропускается — условия и шаблоны не вычисляются.
  При переходе на ADR-0130 миграция выключила включённые правила с `runAs` сотрудником.
- Идемпотентность по `(ruleId, eventId)` и `dedupeKey` (окно `dedupeWindowMinutes`). Ключ повтора
  занимает только запуск по событию с выполненным условием: отсеянный условием запуск его не
  занимает (ADR-0128); лимит
  `maxRunsPerHour`; журнал `rule_runs` с логом шагов; ошибки — событие `rule.run_failed` и
  уведомление владельцу правила.
- Защита от циклов: события, порождённые правилом, несут `causationId` и источник `automation`;
  правило не запускается от собственных событий; глубина цепочки ≤ 5.
- Тестовый режим: прогон на N последних событиях без действий («что бы произошло»).
