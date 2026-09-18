# Контракт: типы полей, схема полей, фильтры

## Типы полей

| type | Хранение (ds) | Контрол | Форматирование | Примечания |
|---|---|---|---|---|
| `text` | text | Input | как есть | ≤ 1 000 символов; поиск trigram при `indexed` |
| `long_text` | text | Textarea/RichText (`rich: true` → Tiptap JSON) | усечение | |
| `integer` | bigint | NumberInput | разделители тысяч | |
| `number` | double precision | NumberInput | `precision`, разделители | |
| `decimal` | numeric(p,s) | NumberInput | фиксированная точность | деньги/точные |
| `money` | numeric(18,2) | NumberInput + валюта | `currency` | |
| `percent` | double precision | NumberInput | `%` | значение 0–1 или 0–100 (`scale`) |
| `boolean` | boolean | Switch/Checkbox | Да/Нет | |
| `date` | date | DatePicker | локаль | |
| `datetime` | timestamptz | DateTimePicker | локаль + tz | |
| `time` | time | TimePicker | | |
| `duration` | interval / integer minutes | DurationInput | `1 ч 30 мин` | |
| `select` | text | Select | подпись из `options` или справочника | `options: [{value, label{ru,tg,en}, color?}]` или `lookup` |
| `multi_select` | text[] | MultiSelect | чипы | |
| `user` | uuid | UserPicker | аватар+имя | |
| `unit` | uuid | UnitPicker | название | |
| `territory` | uuid | TerritoryPicker | чип с уровнем | семантика `territory` для агрегаций |
| `object_ref` | uuid | ObjectPicker | чип объекта | `objectTypes: []` ограничение |
| `file` | uuid | FileDropzone | иконка+имя | |
| `url` / `email` / `phone` | text | Input (валидация) | ссылка | |
| `geometry` | geometry | Map draw | глиф + координаты | `geometryType: point|line|polygon|any` |
| `json` | jsonb | JSON editor | | |
| `formula` | — (вычисляется) | ExpressionInput | по результату | `expression`, `resultType` |
| `lookup` | — (через связь) | — | подпись | `relation`, `field` |
| `rollup` | — (агрегат по связи) | — | число | `relation`, `agg`, `field` |
| `identifier` | text | Input | моно | семантика ключа; уникальность |
| `signature` | jsonb | — | | служебный (документы) |

Общие атрибуты `FieldDef`:

```json
{
  "key": "region_code", "label": {"ru": "Код региона", "tg": "...", "en": "Region code"},
  "type": "text", "semantic": "territory", "required": false, "unique": false,
  "indexed": true, "sensitive": false, "description": "...", "unit": null,
  "format": {"precision": 2, "thousands": true, "dateFormat": "dd.MM.yyyy"},
  "default": null, "options": [], "lookup": {"datasetId": "...", "keyField": "code", "labelField": "name"},
  "validation": {"min": 0, "max": 100, "pattern": "^[A-Z]{2}$", "maxLength": 200},
  "visibleIf": {"field": "kind", "op": "eq", "value": "incoming"},
  "requiredIf": null, "readOnly": false, "order": 3, "group": "Реквизиты"
}
```

Семантики: `dimension`, `measure`, `identifier`, `time`, `geometry`, `territory`, `category`, `text`, `lookup`, `system`.

## Фильтр (общий формат)

```json
{"and": [
  {"field": "status", "op": "in", "value": ["assigned", "in_progress"]},
  {"or": [
    {"field": "due_at", "op": "relative", "value": {"unit": "day", "from": -7, "to": 0}},
    {"field": "assignee_id", "op": "eq", "value": "@me"}
  ]},
  {"field": "territory_id", "op": "within", "value": {"id": "...", "includeChildren": true}},
  {"field": "geom", "op": "intersects", "value": {"type": "Polygon", "coordinates": []}}
]}
```

Операторы по типам: текст — `eq, neq, contains, not_contains, starts_with, ends_with, is_empty, not_empty, in, regex`; числа/деньги — `eq, neq, lt, lte, gt, gte, between, is_empty, not_empty`; даты — `eq, before, after, between, relative, is_empty, not_empty`; выбор/справочник — `in, not_in, is_empty`; булево — `is_true, is_false`; пользователь/подразделение — `in, not_in, is_me, is_my_subordinate, in_my_unit`; территория — `within, eq, in`; геометрия — `intersects, within, dwithin (m), is_empty`; объект — `in, not_in`. Макросы значений: `@me`, `@my_unit`, `@my_territories`, `@today`, `@now`, `@param:<name>`.

Тот же формат используется в QuerySpec (`filter`), списках объектов, политиках строк, условиях правил и представлениях.
