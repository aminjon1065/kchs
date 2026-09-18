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
