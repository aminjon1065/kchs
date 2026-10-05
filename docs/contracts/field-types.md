# Контракт: типы полей, схема полей, фильтры

## Типы полей

| type | Хранение (ds) | Контрол | Форматирование | Примечания |
|---|---|---|---|---|
| `text` | text | Input | как есть | ≤ 1 000 символов; поиск trigram при `indexed` |
| `long_text` | text | Textarea/RichText (`rich: true` → Tiptap JSON) | усечение | |
| `integer` | bigint | NumberInput | разделители тысяч | |
| `number` | double precision | NumberInput | `precision`, разделители | |
| `decimal` | numeric(38,s) | NumberInput | фиксированная точность | `s` — `format.precision` (≤ 12); без неё — numeric |
| `money` | numeric(18,2) | NumberInput + валюта | `currency` | |
| `percent` | double precision | NumberInput | `%` | значение 0–1 или 0–100 (`scale`) |
| `boolean` | boolean | Switch/Checkbox | Да/Нет | |
| `date` | date | DatePicker | локаль | |
| `datetime` | timestamptz | DateTimePicker | локаль + tz | |
| `time` | time | TimePicker | | |
| `duration` | interval | DurationInput | `1 ч 30 мин` | в колоночной копии и выражениях — минуты (double) |
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

## Реестр хранения (ADR-0190)

Хранение хранимых типов — один реестр `FIELD_STORAGE` в
`packages/contracts/src/data/field-storage.ts`; движок читает его копию
`apps/engine/kchs_engine/contracts/field_types.json` (`pnpm --filter @kchs/contracts gen:engine`).
Своих таблиц соответствия у читателей нет.

| Что | Кто читает |
|---|---|
| Тип столбца Postgres таблицы `ds.t_*` (`pg`, `pgColumnType`) | `apps/api/src/modules/data/infra/physical.ts` |
| Тип столбца колоночной копии в DuckDB (`duckdb`), `COLUMNAR_DECIMAL` | `packages/query/src/dialect.ts` |
| Тип Arrow колоночной копии (`arrow`; `null` — в копии нет, это геометрия) | `kchs_engine/data/columnar.py`, `COLUMNAR_FIELD_TYPES` в api |
| Семейство значений геовыгрузки (`exportFamily`) | `kchs_engine/data/geo_export.py` |
| Слова «да/нет» (`BOOLEAN_WORDS`) | `@kchs/fields` (`parse.ts`, вставка в таблицу) и `kchs_engine/data/values.py` (импорт файла) |

- `decimal` и `money` в колоночной копии и DuckDB — `DECIMAL(38,12)`.
- `duration` в колоночной копии и выражениях компилятора — минуты (`DURATION_UNIT`, double): DuckDB и
  Parquet не хранят интервал Postgres.
- `json` в копии — строка: сравнение и группировка посимвольные.
- Логическое значение при вставке и при импорте понимает одно множество слов без учёта регистра и
  пробелов по краям: «да» — `true`, `t`, `1`, `yes`, `y`, `on`, `+`, `да`, `д`, `истина`, `вкл`, `ҳа`,
  `ха`, `✓`, `✔`; «нет» — `false`, `f`, `0`, `no`, `n`, `off`, `-`, `нет`, `н`, `ложь`, `не`, `выкл`.
- Тест согласованности: `packages/query/test/field-storage.test.ts` (приведения компилятора и типы
  столбцов) и `apps/engine/tests/test_field_types.py` (копия, геовыгрузка, слова «да/нет»).

`default` поля датасета — значение для вставки строки, в которой поля нет (форма, лента,
правка из API): сервер подставляет его и проверяет по типу поля; обязательное поле со
значением по умолчанию можно не передавать. Макросы (`@today`, `@me`) при вставке строки
не раскрываются.

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
