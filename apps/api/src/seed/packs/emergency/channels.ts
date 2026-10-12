import type { PageBlock } from '@kchs/contracts'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { PageService } from '~/modules/knowledge/domain/page-service.js'
import { db } from '~/shared/db/client.js'
import { findPackObject, markPackObject, type PackContext } from './context.js'

/**
 * Каталог каналов обмена (ADR-0206): раздел базы знаний «Каналы обмена» в пространстве
 * «Общее» и 16 паспортов по шаблону «Паспорт канала» — по приложению C концепт-ноты
 * КЧСиГО ред. 2.0. Состояние указано честно на дату выпуска: что есть в платформе и что
 * создаётся проектом. Каталог — содержание, а не функция: Комитет правит страницы как
 * обычные, назначает ответственных и публикует новые редакции. Заводится один раз по
 * ключу пакета; правки администратора не трогаются.
 */

type Node = Record<string, unknown>
type Block = Omit<PageBlock, 'id'>

const text = (value: string): Node => ({ type: 'text', text: value })
const p = (...parts: string[]): Node => ({ type: 'paragraph', content: parts.map(text) })
const list = (kind: 'bulletList' | 'orderedList', items: string[]): Node => ({
  type: kind,
  content: items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [text(item)] }],
  })),
})
const ul = (...items: string[]) => list('bulletList', items)
const ol = (...items: string[]) => list('orderedList', items)
const section = (title: string, ...content: Node[]): Block =>
  ({ kind: 'text', title, body: { type: 'doc', content } }) as Block
const grid = (title: string, columns: string[], rows: string[][]): Block =>
  ({ kind: 'table', title, columns, rows }) as Block

const API_DOCS =
  'Описание API: /api/docs (интерактивное) и /api/openapi.json (OpenAPI 3) — внутри сети Комитета.'
const OWNER_TODO =
  'Ответственного назначает Комитет: впишите подразделение, сотрудника и способ связи. До назначения — администратор платформы.'
const TOKEN_ACCESS = [
  'Партнёр направляет в Комитет заявку: цель обмена, состав данных, контактное лицо.',
  'Администратор заводит служебную учётную запись партнёра и выдаёт ей права только на нужные пространства и датасеты.',
  'Администратор выпускает токен API с минимальными областями доступа и сроком действия; токен показывается один раз и передаётся партнёру защищённым каналом.',
  'Партнёр проверяет обмен в песочнице с тестовыми данными, затем получает токен рабочего контура.',
  'Использование токена видно в датасете «Подключения» и на дашборде «Интеграции»; отзыв токена прекращает доступ сразу.',
]

interface Channel {
  key: string
  no: number
  title: string
  direction: string
  standard: string
  /** Состояние в таблице раздела: коротко. */
  state: string
  purpose: Node[]
  status: Node[]
  format: Node[]
  example: Node[]
  access: Node[]
  owner: Node[]
  openapi: Node[]
}

const CHANNELS: readonly Channel[] = [
  {
    key: 'forms',
    no: 1,
    title: 'Веб-формы сбора данных',
    direction: 'Вход',
    standard: 'Формы платформы, в том числе табличные',
    state: 'Есть',
    purpose: [
      p(
        'Сбор сведений от подразделений и партнёров по утверждённой форме: суточные сводки, донесения, отчёты по периодам. Строки формы сразу попадают в реестр (датасет), на ситуационный экран и в сводки.',
      ),
    ],
    status: [
      p(
        'Есть. Формы с контролем сдачи по периодам, табличные формы, напоминания и просрочка (ADR-0103, ADR-0129). Сдачи учитываются в журнале подключений как канал «form».',
      ),
    ],
    format: [
      ul(
        'Поля формы — поля датасета-получателя: текст, числа, даты, выбор из справочника, территория, точка на карте, файлы.',
        'Табличная форма — несколько строк за одну сдачу; итоги по столбцам считаются сами.',
        'Сдача — в интерфейсе или по API (JSON) от служебной учётной записи.',
      ),
    ],
    example: [
      p(
        'POST /api/v1/forms/{id}/submissions — тело: { "periodKey": "2026-10-12", "subjectId": "<подразделение>", "rows": [ { "kind": "Паводок", "district": "<территория>", "victims": 0 } ] }',
      ),
    ],
    access: [
      ol(
        'Владелец формы назначает сдающих: подразделения или сотрудников.',
        'Внешнему партнёру — служебная учётная запись и токен API с областью записи форм (см. канал «REST API Комитета»).',
      ),
    ],
    owner: [p('Владелец формы — подразделение, которое собирает данные.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршруты: /forms, /forms/{id}/submissions.')],
  },
  {
    key: 'file-import',
    no: 2,
    title: 'Импорт файлов',
    direction: 'Вход',
    standard: 'XLSX, CSV по шаблону',
    state: 'Есть',
    purpose: [
      p(
        'Загрузка таблиц партнёров и подразделений в реестры платформы: разовые выгрузки, архивы, сведения без постоянного канала.',
      ),
    ],
    status: [
      p(
        'Есть. Мастер импорта разбирает структуру, сопоставляет поля, показывает сводку изменений до публикации; загружаются также TSV, JSON, GeoJSON, Shapefile, GeoPackage, KML/KMZ, GPX.',
      ),
    ],
    format: [
      ul(
        'XLSX или CSV в кодировке UTF-8, первая строка — заголовки.',
        'Шаблон — выгрузка пустого датасета-получателя: столбцы и их типы совпадают.',
        'Режимы: замена, добавление, обновление по ключу.',
      ),
    ],
    example: [p('Файл «Гидропосты_2026-10.xlsx»: столбцы post_code, date, level_cm, danger_cm.')],
    access: [
      ol(
        'Сотрудник с правом правки датасета загружает файл в интерфейсе.',
        'Партнёр без доступа к платформе передаёт файл ответственному Комитета.',
        'По API: анализ файла и запуск импорта токеном с областью записи датасетов.',
      ),
    ],
    owner: [p('Владелец датасета-получателя.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршруты: /datasets/imports/analyze, /datasets/imports.')],
  },
  {
    key: 'mail-intake',
    no: 3,
    title: 'Приём писем в документооборот',
    direction: 'Вход',
    standard: 'Электронная почта (IMAP)',
    state: 'Есть',
    purpose: [
      p(
        'Входящие письма организаций из ящика канцелярии становятся черновиками входящих документов с вложениями; делопроизводитель регистрирует их или отклоняет с причиной.',
      ),
    ],
    status: [
      p(
        'Есть (ADR-0113). Письма учитываются в журнале подключений как канал «mail_in» интеграции IMAP.',
      ),
    ],
    format: [
      ul(
        'IMAP с TLS, папка входящих канцелярии.',
        'Вложения — файлы документа; тема и отправитель — карточка черновика.',
      ),
    ],
    example: [p('Письмо на ящик канцелярии с темой «О паводковой обстановке» и вложением PDF.')],
    access: [
      ol(
        'Администратор заводит интеграцию IMAP: адрес сервера, ящик, пароль (хранится зашифрованным).',
        'Отправителям сообщают адрес ящика канцелярии; иных действий от них не требуется.',
      ),
    ],
    owner: [p('Канцелярия Комитета.'), p(OWNER_TODO)],
    openapi: [p('Не применяется: канал — почта.')],
  },
  {
    key: 'feeds',
    no: 4,
    title: 'Ленты по адресу',
    direction: 'Вход',
    standard: 'GeoJSON, JSON, CSV',
    state: 'Есть (GDACS, USGS, EMSC, FIRMS)',
    purpose: [
      p(
        'Регулярный опрос открытых лент партнёров и мировых служб: землетрясения, наводнения, пожары. Новые записи попадают в реестр, на карту обстановки и дежурной смене.',
      ),
    ],
    status: [
      p(
        'Есть (ADR-0132). В пакете ЧС подключены GDACS, USGS, EMSC и NASA FIRMS. Синхронизации и сбои видны в журнале подключений как канал «feed».',
      ),
    ],
    format: [
      ul(
        'GeoJSON FeatureCollection, массив JSON (путь к записям задаётся), CSV.',
        'Ключ записи — поле ленты: повторный опрос обновляет, а не дублирует.',
        'Расписание опроса — от 1 минуты; заголовки и ключи доступа — секреты интеграции.',
      ),
    ],
    example: [
      p(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson — опрос каждые 5 минут, ключ — id.',
      ),
    ],
    access: [
      ol(
        'Партнёр сообщает адрес ленты, формат и, если нужно, ключ доступа.',
        'Администратор данных заводит ленту, проверяет первую загрузку и включает расписание.',
      ),
    ],
    owner: [p('Аналитики рисков и дежурная служба.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршруты: /sources (вид feed).')],
  },
  {
    key: 'cap-intake',
    no: 5,
    title: 'Приём предупреждений CAP',
    direction: 'Вход',
    standard: 'CAP 1.2 (МСЭ-Т X.1303), RSS/Atom',
    state: 'Есть',
    purpose: [
      p(
        'Приём предупреждений национальных служб (Агентство по гидрометеорологии, SmartMet Alert и другие) в стандарте CAP: сообщение попадает в реестр, на карту и дежурному с отметками времени решения.',
      ),
    ],
    status: [
      p(
        'Есть в платформе (ADR-0201): формат ленты «cap», индексы Atom/RSS со встроенными сообщениями и ссылками, уточнения и отмены по references. Подключение конкретных служб — по соглашениям с ними.',
      ),
    ],
    format: [
      ul(
        'XML CAP 1.2; блоки info на разных языках, area с полигонами и геокодами.',
        'Индекс Atom или RSS со ссылками на сообщения или с сообщениями внутри.',
        'DOCTYPE и внешние сущности отклоняются.',
      ),
    ],
    example: [
      p(
        '<alert><identifier>TJ-HYDROMET-2026-0412</identifier><sent>2026-10-12T06:00:00+05:00</sent><status>Actual</status><msgType>Alert</msgType><info><event>Сильный дождь</event><severity>Severe</severity>…</info></alert>',
      ),
    ],
    access: [
      ol(
        'Служба сообщает адрес ленты CAP или индекса и порядок доступа.',
        'Администратор данных заводит ленту формата «cap» и проверяет первую загрузку.',
      ),
    ],
    owner: [p('Дежурная служба Комитета.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршруты: /sources (вид feed, формат cap).')],
  },
  {
    key: 'databases',
    no: 6,
    title: 'Подключение внешних баз данных',
    direction: 'Вход',
    standard: 'PostgreSQL, MySQL, MS SQL, ClickHouse',
    state: 'Есть PostgreSQL и MySQL; MS SQL и ClickHouse — создаётся',
    purpose: [
      p(
        'Регулярная загрузка таблиц из информационных систем партнёров в датасеты платформы без ручных выгрузок.',
      ),
    ],
    status: [
      p(
        'PostgreSQL и MySQL — есть (ADR-0107): снимок или добор по полю-курсору, по расписанию. MS SQL и ClickHouse — создаётся проектом. Синхронизации видны в журнале подключений как канал «database».',
      ),
    ],
    format: [
      ul(
        'Запрос SELECT к представлению партнёра; только чтение.',
        'Учётная запись базы партнёра — с правом чтения нужных представлений, хранится зашифрованной.',
      ),
    ],
    example: [p('SELECT post_code, measured_at, level_cm FROM public.v_water_levels')],
    access: [
      ol(
        'Партнёр открывает доступ к представлению с адреса платформы и выдаёт учётную запись только для чтения.',
        'Администратор данных заводит интеграцию и источник, проверяет связь и первую загрузку.',
      ),
    ],
    owner: [p('Администратор данных Комитета и ответственный партнёра.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршруты: /integrations, /sources (вид database).')],
  },
  {
    key: 'gis-services',
    no: 7,
    title: 'ГИС-службы',
    direction: 'Вход',
    standard: 'WMS, WMTS, WFS, ArcGIS REST',
    state: 'Есть',
    purpose: [
      p(
        'Подключение картографических служб партнёров слоями карт и подложками: космоснимки, кадастр, гидрография.',
      ),
    ],
    status: [p('Есть: слои служб XYZ, WMS, WMTS, WFS, ArcGIS REST и подложки WMS/WMTS.')],
    format: [ul('WMS 1.3, WMTS 1.0, WFS 2.0, ArcGIS REST MapServer/FeatureServer, XYZ.')],
    example: [p('https://example.org/geoserver/wms — слой hydro:rivers, EPSG:3857.')],
    access: [
      ol(
        'Партнёр сообщает адрес службы и условия использования.',
        'Администратор ГИС добавляет слой или подложку и проверяет отображение.',
      ),
    ],
    owner: [p('Администратор ГИС Комитета.'), p(OWNER_TODO)],
    openapi: [p('Не применяется: подключение настраивается в интерфейсе карт.')],
  },
  {
    key: 'rest-api',
    no: 8,
    title: 'REST API Комитета',
    direction: 'Вход и выход',
    standard: 'REST/JSON, OpenAPI 3, токены доступа',
    state: 'Есть; шлюз DMZ — есть',
    purpose: [
      p(
        'Обмен данными с информационными системами партнёров: чтение и запись датасетов, объектов, форм — с теми же правами, что у служебной учётной записи партнёра.',
      ),
    ],
    status: [
      p(
        'Есть (ADR-0097). Снаружи — только через шлюз DMZ и только по токену (ADR-0200); открытые маршруты перечислены в белом списке шлюза. Запросы и записанные строки по каждому токену считаются по суткам (ADR-0206).',
      ),
    ],
    format: [
      ul(
        'HTTPS, JSON, заголовок Authorization: Bearer <токен>.',
        'Области токена (read:datasets, write:datasets…) закрывают всё, что не нужно партнёру.',
        'Лимит запросов в минуту — общий установки или свой у токена.',
      ),
    ],
    example: [
      p(
        'curl -H "Authorization: Bearer kchs_…" https://<адрес шлюза>/api/v1/datasets/{id}/rows?limit=100',
      ),
    ],
    access: [ol(...TOKEN_ACCESS)],
    owner: [p('Администратор платформы.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS)],
  },
  {
    key: 'inbound-webhooks',
    no: 9,
    title: 'Входящие вебхуки',
    direction: 'Вход',
    standard: 'HTTPS POST с секретом',
    state: 'Есть',
    purpose: [
      p(
        'Уведомление платформы о событии в системе партнёра: вызов адреса интеграции запускает правила автоматизации (записать строку, уведомить дежурного, поставить задачу).',
      ),
    ],
    status: [
      p(
        'Есть. Адрес открыт через шлюз DMZ (ADR-0200). Вызовы учитываются в журнале подключений как канал «webhook_in».',
      ),
    ],
    format: [
      ul(
        'POST https://<адрес шлюза>/api/v1/hooks/{интеграция}/{секрет}, тело — JSON-объект.',
        'Подпись отправителя (необязательно) — в заголовке; правило может её проверять.',
      ),
    ],
    example: [p('{ "event": "level_exceeded", "post": "PJ-04", "level_cm": 412 }')],
    access: [
      ol(
        'Администратор включает входящий вебхук у интеграции партнёра и передаёт адрес с секретом защищённым каналом.',
        'Аналитик настраивает правило автоматизации на событие webhook.received этой интеграции.',
      ),
    ],
    owner: [p('Администратор платформы и владелец правила.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршрут: POST /hooks/{integrationId}/{secret}.')],
  },
  {
    key: 'positions',
    no: 10,
    title: 'Приём координат техники и групп',
    direction: 'Вход',
    standard: 'REST/JSON; протоколы трекеров — у поставщика услуг',
    state: 'Создаётся проектом',
    purpose: [
      p(
        'Положение техники и оперативных групп на карте обстановки в реальном времени: маршрут, последняя отметка, связь с происшествием.',
      ),
    ],
    status: [
      p(
        'Создаётся проектом (модуль positions, ADR-0203). Протоколы трекеров (Teltonika, Wialon IPS) принимает поставщик услуг мониторинга и передаёт в платформу по REST.',
      ),
    ],
    format: [
      ul('JSON: устройство, время, широта, долгота, скорость, курс — пачками до сотен отметок.'),
    ],
    example: [
      p(
        '{ "positions": [ { "device": "CHS-UAZ-017", "at": "2026-10-12T09:15:00+05:00", "lat": 38.56, "lon": 68.78 } ] }',
      ),
    ],
    access: [p('После выпуска модуля — как у REST API: служебная учётная запись и токен.')],
    owner: [p(OWNER_TODO)],
    openapi: [p('Маршруты появятся в описании API с выпуском модуля.')],
  },
  {
    key: 'outbound-webhooks',
    no: 11,
    title: 'Исходящие вебхуки',
    direction: 'Выход',
    standard: 'HTTPS POST, подпись HMAC-SHA256',
    state: 'Есть',
    purpose: [
      p(
        'Мгновенная передача событий платформы в системы партнёров: новое происшествие, сданная сводка, зарегистрированный документ.',
      ),
    ],
    status: [
      p(
        'Есть (ADR-0097): повторы с нарастающей паузой, журнал доставок, отключение после серии отказов. Доставки и отказы учитываются в журнале подключений как канал «webhook_out».',
      ),
    ],
    format: [
      ul(
        'POST JSON — конверт события (тип, время, объект, данные).',
        'Заголовки x-kchs-event, x-kchs-delivery, x-kchs-timestamp, x-kchs-signature: sha256=HMAC(секрет, время.тело).',
        'Вебхук видит только то, что видит его учётная запись.',
      ),
    ],
    example: [
      p('{ "type": "dataset.row_created", "occurredAt": "…", "object": { … }, "payload": { … } }'),
    ],
    access: [
      ol(
        'Партнёр сообщает адрес приёма (HTTPS) и нужные типы событий.',
        'Администратор заводит вебхук и передаёт секрет подписи защищённым каналом; партнёр проверяет подпись каждого вызова.',
      ),
    ],
    owner: [p('Администратор платформы.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршруты: /webhooks, /webhooks/{id}/deliveries.')],
  },
  {
    key: 'cap-feed',
    no: 12,
    title: 'CAP-лента предупреждений Комитета',
    direction: 'Выход',
    standard: 'CAP 1.2, RSS',
    state: 'Создаётся проектом',
    purpose: [
      p(
        'Публикация предупреждений Комитета в стандарте CAP для СМИ, операторов связи, сайта Комитета и международных агрегаторов.',
      ),
    ],
    status: [
      p(
        'Создаётся проектом (модуль warnings, ADR-0202): выпуск предупреждения с подписью уполномоченного лица, лента CAP/RSS наружу через шлюз, вебхук сайту.',
      ),
    ],
    format: [ul('CAP 1.2 XML, индекс RSS; языки — таджикский, русский, английский.')],
    example: [p('Появится с выпуском модуля.')],
    access: [p('Лента будет открытой: без токена, только чтение.')],
    owner: [p(OWNER_TODO)],
    openapi: [p('Не применяется: лента CAP/RSS.')],
  },
  {
    key: 'map-services',
    no: 13,
    title: 'Картографические службы Комитета',
    direction: 'Выход',
    standard: 'WMS, WFS, GeoJSON',
    state: 'Создаётся проектом',
    purpose: [
      p(
        'Публикация слоёв Комитета (зоны риска, ПВР, обстановка) для ГИС партнёров стандартными службами.',
      ),
    ],
    status: [
      p(
        'Создаётся проектом. Сейчас слой можно получить по REST API токеном: запрос к датасету с геометрией и выгрузка GeoJSON.',
      ),
    ],
    format: [ul('WMS 1.3, WFS 2.0 — после выпуска; сейчас — GeoJSON по API.')],
    example: [p('POST /api/v1/queries/export — запрос к датасету «Зоны риска», формат geojson.')],
    access: [ol(...TOKEN_ACCESS.slice(0, 3))],
    owner: [p('Администратор ГИС Комитета.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршруты: /queries/run, /queries/export.')],
  },
  {
    key: 'scheduled-exports',
    no: 14,
    title: 'Выгрузки и отчёты по расписанию',
    direction: 'Выход',
    standard: 'XLSX, CSV, GeoJSON, PDF',
    state: 'Есть',
    purpose: [
      p(
        'Регулярные сводки и отчёты для руководства и партнёров: суточная обстановка, итоги месяца, отчёты по форме.',
      ),
    ],
    status: [
      p(
        'Есть: отчёты по расписанию в PDF и DOCX с рассылкой (ADR-0078), выгрузка датасетов и запросов в XLSX, CSV, GeoJSON — в интерфейсе и по API.',
      ),
    ],
    format: [ul('PDF, DOCX — отчёты; XLSX, CSV, GeoJSON — данные.')],
    example: [
      p('Отчёт «Сводка обстановки за сутки» — ежедневно в 08:30, PDF на почту руководства.'),
    ],
    access: [
      ol(
        'Получатели внутри Комитета — подписка на отчёт.',
        'Внешний получатель — рассылка на адрес или выгрузка по API токеном.',
      ),
    ],
    owner: [p('Владелец отчёта.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS), p('Маршруты: /reports, /queries/export.')],
  },
  {
    key: 'notifications',
    no: 15,
    title: 'Уведомления сотрудников',
    direction: 'Выход',
    standard: 'Приложение, push, почта, Telegram',
    state: 'Есть',
    purpose: [
      p(
        'Доведение событий до сотрудников: поручения, сроки, происшествия, сработавшие правила дежурной службы.',
      ),
    ],
    status: [
      p(
        'Есть: «Входящие» в приложении, push в браузере и на телефоне (ADR-0094), почта, Telegram. Оповещение населения — вне системы.',
      ),
    ],
    format: [ul('Канал и частоту выбирает сотрудник в профиле; срочные — без задержки.')],
    example: [p('«Происшествие с пострадавшими: Паводок, Вахдатский район — открыть карточку».')],
    access: [p('Сотрудникам — по учётной записи; Telegram — привязкой в профиле.')],
    owner: [p('Администратор платформы.'), p(OWNER_TODO)],
    openapi: [p('Не применяется: внутренний канал.')],
  },
  {
    key: 'docs-sandbox',
    no: 16,
    title: 'Документация и тестовая среда',
    direction: '—',
    standard: 'Документация API, песочница с тестовыми данными',
    state: 'Документация есть; песочница создаётся',
    purpose: [
      p(
        'Партнёр проверяет обмен до подключения к рабочему контуру: читает описание API и паспорта каналов, получает тестовый токен, отлаживает запросы на тестовых данных.',
      ),
    ],
    status: [
      p(
        'Документация есть: описание OpenAPI 3 и этот каталог. Песочница создаётся проектом: вторая установка демо-профиля со сбросом по расписанию и токенами только в ней; настройка переносится в рабочий контур пакетом конфигурации.',
      ),
    ],
    format: [ul('OpenAPI 3 (JSON), страницы базы знаний, демо-данные генератора.')],
    example: [p('/api/openapi.json — описание для генераторов клиентов.')],
    access: [p('Тестовый токен песочницы выдаёт администратор платформы по заявке партнёра.')],
    owner: [p('Администратор платформы.'), p(OWNER_TODO)],
    openapi: [p(API_DOCS)],
  },
]

function passportBlocks(channel: Channel): Block[] {
  return [
    section('Назначение', ...channel.purpose),
    section('Состояние', ...channel.status),
    section('Формат', ...channel.format),
    section('Пример', ...channel.example),
    section('Порядок доступа', ...channel.access),
    section('Ответственный', ...channel.owner),
    section('Описание API', ...channel.openapi),
  ]
}

function rootBlocks(): Block[] {
  return [
    section(
      'О каталоге',
      p(
        'Каналы, по которым платформа Комитета обменивается данными с министерствами, службами, партнёрами и сотрудниками. Для каждого канала — паспорт: назначение, состояние, формат, пример, порядок доступа, ответственный и описание API.',
      ),
      p(
        'Состояние указано на дату выпуска: «есть» — канал работает в платформе, «создаётся проектом» — будет выпущен по плану концепт-ноты. Кто и сколько передаёт по каналам — датасет «Подключения» и дашборд «Интеграции».',
      ),
    ),
    grid(
      'Каналы',
      ['№', 'Канал', 'Направление', 'Стандарт, формат', 'Состояние'],
      CHANNELS.map((channel) => [
        String(channel.no),
        channel.title,
        channel.direction,
        channel.standard,
        channel.state,
      ]),
    ),
    section('Как подключиться', ol(...TOKEN_ACCESS)),
  ]
}

async function publish(ownerId: string, pageId: string): Promise<boolean> {
  const ctx = await buildUserCtxFor(ownerId)
  if (!ctx) return false
  try {
    await PageService.publish(ctx, pageId, { note: 'Первая редакция каталога каналов' })
    return true
  } catch {
    // Нет сервера совместной правки — страница остаётся черновиком (как у сида руководства)
    return false
  }
}

const withIds = (blocks: Block[], prefix: string) =>
  blocks.map((item, index) => ({ ...item, id: `${prefix}-${index + 1}` }) as PageBlock)

/** Раздел «Каналы обмена» и паспорта каналов; возвращает, сколько страниц заведено. */
export async function ensureChannelCatalog(pack: PackContext): Promise<number> {
  const spaceId = pack.orgSpaceId
  let created = 0
  let published = 0
  let rootId = await findPackObject('page', 'channels.root')
  if (!rootId) {
    rootId = await db().transaction(async (tx) => {
      const id = await PageService.create(
        tx,
        pack.ctx,
        {
          title: 'Каналы обмена',
          spaceId,
          template: 'blank',
          blocks: withIds(rootBlocks(), 'ch'),
        },
        'ru',
      )
      await markPackObject(tx, pack.ctx, id, 'channels.root')
      return id
    })
    created += 1
    if (await publish(pack.adminId, rootId)) published += 1
  }
  for (const channel of CHANNELS) {
    const key = `channels.${channel.key}`
    if (await findPackObject('page', key)) continue
    const parentId = rootId
    const id = await db().transaction(async (tx) => {
      const pageId = await PageService.create(
        tx,
        pack.ctx,
        {
          title: `${channel.no}. ${channel.title}`,
          spaceId,
          parentId,
          template: 'channel_passport',
          blocks: withIds(passportBlocks(channel), 'ch'),
        },
        'ru',
      )
      await markPackObject(tx, pack.ctx, pageId, key)
      return pageId
    })
    created += 1
    if (await publish(pack.adminId, id)) published += 1
  }
  pack.log('каталог каналов обмена в базе знаний', { created, published })
  return created
}
