# Контракт: ProcessDefinition

```json
{
  "version": 1,
  "key": "outgoing_letter_default",
  "objectType": "document",
  "name": {"ru": "Исходящее письмо: стандартный маршрут"},
  "variables": {"signer": {"type": "user", "label": {"ru": "Подписант"}, "required": true}},
  "start": "legal_review",
  "steps": {
    "legal_review": {
      "type": "approval", "name": {"ru": "Согласование"},
      "mode": "parallel", "quorum": "all",
      "assignees": ["role_in_space:legal", "unit_head(author.unit)"],
      "dueWorkingDays": 3, "onReject": "return_to_author", "allowAddApprover": true,
      "next": "deputy_review"
    },
    "deputy_review": {"type": "approval", "mode": "sequential", "assignees": ["manager(unit_head(author.unit))"], "dueWorkingDays": 2, "next": "sign"},
    "sign": {"type": "sign", "assignees": ["var:signer"], "dueWorkingDays": 2, "requireMfa": true, "next": "register"},
    "register": {"type": "register", "assignees": ["role:registrar"], "journal": "outgoing", "next": "dispatch"},
    "dispatch": {"type": "task", "title": {"ru": "Отправить корреспонденту"}, "assignees": ["role:registrar"], "dueWorkingDays": 1, "next": "end"},
    "return_to_author": {"type": "return", "to": "author", "reapproval": "rejecters_only", "next": "legal_review"},
    "end": {"type": "end", "outcome": "completed"}
  },
  "timers": [{"step": "*", "onOverdue": [{"action": "notify", "to": "manager(step.assignee)"}, {"action": "notify", "to": "author"}]}],
  "conditions": [
    {"at": "start", "if": "object.fields.amount > 1000000", "insertBefore": "deputy_review", "step": {"type": "approval", "assignees": ["role_in_space:finance"], "dueWorkingDays": 2}}
  ]
}
```

## Типы шагов
| type | Назначение | Результат |
|---|---|---|
| `approval` | согласование (`mode: parallel|sequential|any`, `quorum: all|any|n`) | `approved|rejected|remarks` по каждому назначенному |
| `sign` | подпись (`requireMfa`, `signatureKind`) | `signed|refused` |
| `register` | регистрация в журнале (`journal`) | номер |
| `acknowledge` | ознакомление (список) | отметки |
| `task` | создать поручение/задачу и ждать завершения | `done` |
| `condition` | ветвление по выражению (`branches[{if, next}]`, `else`) | — |
| `parallel` | параллельные ветви (`branches[[steps]]`, `join: all|any`) | — |
| `wait` | ждать событие (`event`, `filter`) или срок (`until`, `durationWorkingDays`) | — |
| `notify` | уведомление (`to`, `template`) | — |
| `set` | изменить поле объекта (`field`, `value`) | — |
| `call` | действие модуля (`action: 'documents.dispatch'`, `params`) | результат |
| `return` | возврат автору (`reapproval: full|rejecters_only`) | — |
| `end` | завершение (`outcome`) | — |

## Назначения (assignee expressions)
`user:<id>`, `group:<id>`, `unit:<id>` (все), `unit_head(<unitExpr>)`, `manager(<userExpr>)`, `role:<key>`, `role_in_space:<key>`, `var:<name>` (переменная процесса, задаётся инициатором), `field:<path>` (поле объекта, например `field:responsible_id`), `author`, `author.unit`, `chosen_by_initiator` (выбор при запуске), `previous_step.assignees`.

## Семантика
- Экземпляр хранит текущее множество активных шагов; шаг-действие создаёт элементы Входящих каждому назначенному (с учётом делегирования); завершение по `quorum`.
- Сроки — в рабочих днях по бизнес-календарю от активации шага; таймеры — отложенные задания.
- Отклонение в `approval` → `onReject` (`return_to_author`, `end:rejected`, `continue`).
- Версии определений: экземпляр закрепляется за версией; публикация новой не трогает запущенные.
- Валидация определения: достижимость шагов, отсутствие циклов без `return`, наличие `end`, корректность выражений; предпросмотр назначений на примере объекта.
- События: `process.started`, `process.step_activated`, `process.step_completed`, `process.step_overdue`, `process.finished`.

## Уточнения реализации (ADR-0079)

Совместимые добавления и точная семантика; схема — `@kchs/process` (`ProcessDefinition`), проверка — `validateDefinition`.

**Поля шагов.** Ключи шагов — `[a-z][a-z0-9_]*`. `next` обязателен у шагов верхнего уровня (кроме `end` и `condition`). `approval`: `mode` (по умолчанию `parallel`), `quorum` (`all`), `onReject`, `allowAddApprover` (`false`), `allowDelegate` — согласующий может передать шаг (`true`). `sign`: `mode` (`parallel|sequential`), `onReject` — переход при отказе. `register`: `assignees` необязательны — без них модуль регистрирует автоматически. `task`: `params` для модуля. `wait`: `event` — событие каталога об этом же объекте (из разрешённых модулями), `filter` — условие над `event.*`, `until` — дата, момент ISO 8601, `var:<имя>` или `field:<путь>`. `notify`: `to` — выражение или список. `return`: `to` (по умолчанию `author`), `dueWorkingDays`. `end`: `outcome` (по умолчанию `completed`). Условие запуска: `key` вставляемого шага (по умолчанию `cond_<номер>`); у вставляемого шага нет `next` — он ведёт к `insertBefore`. Действие таймера: `{action: 'notify', to, template?}`.

**Назначения.** Кроме форм контракта: запись через вызов — `role_in_space('legal')`, `field('responsible')`, `var('signer')`; `unit_head('КОД')` — подразделение по коду; `initiator` — запустивший маршрут; `step.assignee` (`step.assignees`) — в таймерах: не ответившие на просроченном шаге. `unit:<id>` и `author.unit` на месте людей — сотрудники подразделения и вложенных. `role:<ключ>` — роль без ограничения и ограниченная пространством объекта. `role_in_space:<ключ>` — для `viewer|member|editor|admin` участники пространства объекта с ролью не ниже; для прочих ключей — роль, ограниченная пространством объекта, а если таких нет — та же роль без ограничения. Порядок выражений задаёт очередь последовательного режима; повторы и неактивные убираются.

**Условия.** Язык выражений платформы с составными ссылками: `object.<свойство>`, `object.fields.<ключ>`, `var.<имя>`, `author.id`, `author.unit`, `initiator.id`; в шаге `condition` — ещё `steps.<ключ>.outcome`; в фильтре `wait` — `event.*`. Функции — строковые, числовые и даты (`lower`, `contains`, `coalesce`, `year`, `today()`…). Условие выполнено только при строгом `true`.

**Решения и итоги.** Отклонение в параллельном согласовании завершает шаг, как только одобрение невозможно; замечания ждут ответов всех. Итог шага: `approved`, иначе `rejected` (было отклонение), иначе `remarks`; отклонение и замечания идут в `onReject` (по умолчанию `end:rejected`; `continue`; `end:<исход>`; ключ шага верхнего уровня). Отказ в подписи — сразу в `onReject`. Возврат: «отправить повторно» — новый круг, «отозвать» — маршрут отменён (`withdrawn`). `rejecters_only`: одобрившие прошлый круг того же шага засчитываются (`carried`), решают не одобрившие; подпись повторяется всегда.

**Ветви.** `branches` — списки ключей; шаги ветви идут по порядку, без `next`; `condition`, `return`, `end` в ветвях запрещены; вложенные `parallel` — разрешены. `join: any` снимает остальные ветви.

**Проверка.** Ссылки, места шагов в ветвях (шаг — в одной ветви, начальный — не в ветви, переходы — только на шаги верхнего уровня), достижимость, путь к завершению от каждого шага, циклы только через `return`, выражения назначений и условий, наличие у `condition` ветви `else`, у `wait` — события или срока. Публикация дополнительно проверяет, что модули зарегистрировали исполнителей `register`/`task`/`call` и поддержку `set` для типа объекта.

**События** сверх перечисленных: `process.step_decided` (каждое решение; актор — кто нажал, `userId` — чья очередь), `process.step_assignees_changed` (добавлен согласующий, шаг передан или переназначен), `process.step_due_soon` (напоминание за рабочий день и в день срока), `process.definition_changed` (черновик сохранён или снят, версия опубликована).
