# 0043. Строгий CSP: nonce запроса от Caddy, без inline-скриптов и eval

Статус: Принято
Дата: 2026-09-18

Контекст: `17-security.md` §5 (Решено) требует строгий CSP — `default-src 'self'`, без
`unsafe-inline`, стили через nonce, `X-Frame-Options: DENY`. В Caddyfile, которым образ web
отдаёт SPA, CSP и `X-Frame-Options` не было вовсе. SPA статическая (Vite), сервера,
рендерящего HTML, нет. При этом библиотеки интерфейса вставляют элементы `<style>` во время
работы: Radix ScrollArea и Select рисуют свой `<style>`, react-remove-scroll (под
диалогами Radix) и react-resizable-panels (курсор при перетаскивании панелей) создают их
через `document.createElement('style')`. index.html содержал встроенный скрипт темы, а zod 4
при создании схем проверяет `new Function` — браузер сообщает это как нарушение.

Решение:
- CSP ставит Caddy для всех ответов: `script-src 'self'`, `style-src 'self' 'nonce-…'`,
  `img-src`/`media-src`/`connect-src` — свой origin и origin S3 (`KCHS_STORAGE_ORIGIN`,
  прямые загрузки и превью по подписанным ссылкам), WebSocket `/ws`, `worker-src 'self' blob:`
  (карты), `frame-ancestors 'none'`, `base-uri`/`form-action 'self'`, `object-src 'none'`;
  плюс `X-Frame-Options: DENY`.
- Nonce — `{http.request.uuid}` запроса (UUIDv4, свой на каждый запрос). Тот же плейсхолдер
  подставляется в `<meta name="csp-nonce">` через директиву `templates` (только `text/html`):
  значения совпадают, это проверено. HTML с nonce отдаётся с `Cache-Control: no-store`
  (страница из кеша несла бы старый nonce при новом заголовке), `/assets/*` — `immutable`.
- Приложение при старте читает nonce из `<meta>` и передаёт его всем, кто вставляет
  `<style>`: `setCspNonce` в `@kchs/ui` (get-nonce для react-style-singleton, `setNonce`
  react-resizable-panels, проп `nonce` у Viewport Radix ScrollArea/Select). На dev-сервере
  шаблон не обрабатывается — nonce нет, как нет и CSP.
- Скрипт темы вынесен в `public/theme-init.js` (подключается синхронно в `<head>`); zod
  настраивается `jitless` модулем, который `main.tsx` импортирует первым.
- Проверка `pnpm --filter @kchs/web csp:check`: продакшен-сборка, настоящий Caddy с тем же
  Caddyfile (API проксируется на хост), Playwright обходит ключевые экраны (диалоги,
  выпадающие списки, палитра, разделение панелей, загрузка и превью S3, смена темы) и падает
  на любом `securitypolicyviolation`; статически — нет встроенных скриптов и стилей в
  `dist/index.html`, nonce заголовка совпадает с `<meta>` и различается между запросами.
  Запускается в CI в задании «Сквозные сценарии». Мутации проверены: без передачи nonce,
  со встроенным скриптом, без `jitless` — проверка падает.

Альтернативы: `style-src 'unsafe-inline'` — прямо запрещено документом; хеши вместо nonce —
содержимое `<style>` у react-remove-scroll динамическое (ширина полосы прокрутки); свой
сервер для HTML с nonce — лишний процесс, когда Caddy умеет шаблоны; `strict-dynamic` для
скриптов — не нужен: встроенных скриптов нет, модули грузятся со своего origin.

Последствия: любая новая библиотека, вставляющая `<style>` во время работы, должна получать
nonce через `setCspNonce`/`cspNonce()` — иначе `csp:check` в CI упадёт. Встроенные скрипты и
`eval` запрещены. Изменения политики — только в Caddyfile: проверка читает его же.
