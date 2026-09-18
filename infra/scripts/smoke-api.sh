#!/usr/bin/env bash
# Дымовой прогон ядра kchs через HTTP API на демо-данных (kchs seed / pnpm db:seed).
#   KCHS_SMOKE_BASE          адрес API (по умолчанию api разработки на :3000;
#                            для установки в контейнерах — http://localhost:8080/api/v1)
#   KCHS_SMOKE_ADMIN         логин администратора (admin)
#   KCHS_SMOKE_ADMIN_PASSWORD, KCHS_SMOKE_USER_PASSWORD — пароли демо-данных
set -uo pipefail
BASE="${KCHS_SMOKE_BASE:-http://localhost:3000/api/v1}"
ADMIN_LOGIN="${KCHS_SMOKE_ADMIN:-admin}"
ADMIN_PASSWORD="${KCHS_SMOKE_ADMIN_PASSWORD:-Kchs!Start-2026-7q}"
USER_PASSWORD="${KCHS_SMOKE_USER_PASSWORD:-Kchs!Work-2026-3v}"
JAR="$(mktemp -t kchs-smoke.XXXXXX)"
trap 'rm -f "$JAR"' EXIT
PASS=0; FAIL=0

login() {
  CSRF=$(curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
    -d "{\"login\":\"$1\",\"password\":\"$2\"}" -c "$JAR" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("csrfToken",""))')
}

req() { # method url [body]
  local m=$1 u=$2 b=${3:-}
  if [ -n "$b" ]; then
    curl -s -X "$m" "$BASE$u" -b "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -d "$b"
  else
    curl -s -X "$m" "$BASE$u" -b "$JAR" -H "x-csrf-token: $CSRF"
  fi
}

code() { # method url [body]
  local m=$1 u=$2 b=${3:-}
  if [ -n "$b" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X "$m" "$BASE$u" -b "$JAR" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -d "$b"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "$m" "$BASE$u" -b "$JAR" -H "x-csrf-token: $CSRF"
  fi
}

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; PASS=$((PASS+1));
  else echo "  ✗ $1 — ожидалось [$2], получено [$3]"; FAIL=$((FAIL+1)); fi
}

jq_() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null || echo ""; }

echo "── Вход и контекст ───────────────────────────────────"
login "$ADMIN_LOGIN" "$ADMIN_PASSWORD"
check "csrf выдан" "yes" "$([ -n "$CSRF" ] && echo yes || echo no)"
ME=$(req GET /me)
ADMIN_ID=$(echo "$ME" | jq_ 'd["user"]["id"]')
PERSONAL=$(echo "$ME" | jq_ 'd["personalSpaceId"]')
check "роль администратора" "system_admin" "$(echo "$ME" | jq_ 'd["roles"][0]')"

echo "── CSRF обязателен для изменяющих запросов ───────────"
RAW=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/spaces" -b "$JAR" \
  -H 'content-type: application/json' -d '{"key":"nocsrf","name":"Без CSRF"}')
check "POST без csrf → 403" "403" "$RAW"

echo "── Пространства ──────────────────────────────────────"
SPACES=$(req GET /spaces)
check "пространства видны" "yes" "$([ "$(echo "$SPACES" | jq_ 'len(d["items"])')" -gt 0 ] && echo yes || echo no)"
ORG_SPACE=$(echo "$SPACES" | jq_ '[s["id"] for s in d["items"] if s["key"]=="org"][0]')
FLOOD=$(echo "$SPACES" | jq_ '[s["id"] for s in d["items"] if s["key"]=="flood-2026"][0]')
check "общее пространство найдено" "yes" "$([ -n "$ORG_SPACE" ] && echo yes || echo no)"

SUFFIX=$(date +%s)
NEW_SPACE=$(req POST /spaces "{\"key\":\"smoke-$SUFFIX\",\"name\":\"Дымовой тест\",\"kind\":\"team\",\"description\":\"Проверка\"}")
SPACE_ID=$(echo "$NEW_SPACE" | jq_ 'd["id"]')
check "пространство создано" "yes" "$([ -n "$SPACE_ID" ] && echo yes || echo no)"

echo "── Папки и реестр объектов ───────────────────────────"
FOLDER=$(req POST /folders "{\"name\":\"Документы проверки\",\"spaceId\":\"$SPACE_ID\"}")
FOLDER_ID=$(echo "$FOLDER" | jq_ 'd["id"]')
check "папка создана" "yes" "$([ -n "$FOLDER_ID" ] && echo yes || echo no)"

OBJ=$(req GET "/objects/$FOLDER_ID")
check "карточка объекта: тип" "folder" "$(echo "$OBJ" | jq_ 'd["type"]')"
check "карточка объекта: уровень" "owner" "$(echo "$OBJ" | jq_ 'd["level"]')"

SUB=$(req POST /folders "{\"name\":\"Вложенная\",\"spaceId\":\"$SPACE_ID\",\"parentId\":\"$FOLDER_ID\"}")
SUB_ID=$(echo "$SUB" | jq_ 'd["id"]')
SUBOBJ=$(req GET "/objects/$SUB_ID")
check "крошки от предка" "1" "$(echo "$SUBOBJ" | jq_ 'len(d["breadcrumbs"])')"

echo "── Обсуждение ────────────────────────────────────────"
MSG=$(req POST "/objects/$FOLDER_ID/discussion/messages" \
  '{"body":{"type":"doc","content":[]},"text":"Первое сообщение в обсуждении","attachments":[],"mentions":[],"mentionedObjectIds":[]}')
check "сообщение отправлено" "yes" "$([ -n "$(echo "$MSG" | jq_ 'd["id"]')" ] && echo yes || echo no)"
DISC=$(req GET "/objects/$FOLDER_ID/discussion")
check "сообщение читается" "Первое сообщение в обсуждении" "$(echo "$DISC" | jq_ 'd["items"][0]["text"]')"

echo "── Доступ ────────────────────────────────────────────"
USERS=$(req GET '/users?limit=5&q=user0')
OTHER_ID=$(echo "$USERS" | jq_ 'd["items"][0]["id"]')
check "пользователь найден" "yes" "$([ -n "$OTHER_ID" ] && echo yes || echo no)"

GRANT_BODY="{\"grants\":[{\"principal\":{\"type\":\"user\",\"id\":\"$OTHER_ID\"},\"level\":\"edit\"}]}"
GRANT_RESP=$(req POST "/objects/$FOLDER_ID/access" "$GRANT_BODY")
check "выдача доступа" "200" "$(code POST "/objects/$FOLDER_ID/access" "$GRANT_BODY")"
ACCESS=$(req GET "/objects/$FOLDER_ID/access")
check "в списке доступа есть выданный" "yes" \
  "$(echo "$ACCESS" | jq_ "'yes' if any(e['principal']['id']=='$OTHER_ID' for e in d['entries']) else 'no'")"

EXPLAIN=$(req POST "/objects/$FOLDER_ID/access/explain" "{\"userId\":\"$OTHER_ID\"}")
check "объяснение доступа: уровень" "edit" "$(echo "$EXPLAIN" | jq_ 'd["level"]')"
check "объяснение доступа: причина" "explicit" "$(echo "$EXPLAIN" | jq_ 'd["reasons"][0]["kind"]')"

echo "── Негативные проверки доступа ───────────────────────"
login user020 "$USER_PASSWORD"
check "вход обычного сотрудника" "yes" "$([ -n "$CSRF" ] && echo yes || echo no)"
check "чужой объект → 404" "404" "$(code GET "/objects/$FOLDER_ID")"
LIST=$(req GET "/objects?spaceId=$SPACE_ID")
check "чужой объект не в списке" "0" "$(echo "$LIST" | jq_ 'len(d["items"])')"
SEARCH=$(curl -s -G --data-urlencode 'q=Документы проверки' "$BASE/search" -b "$JAR")
check "чужой объект не в поиске" "0" "$(echo "$SEARCH" | jq_ "len([h for h in d['hits'] if h['objectId']=='$FOLDER_ID'])")"
INTRUDE_BODY="{\"name\":\"Взлом\",\"spaceId\":\"$SPACE_ID\"}"
check "чужое пространство: 404 вместо 403" "404" "$(code POST /folders "$INTRUDE_BODY")"
check "нет способности admin.system" "403" "$(code GET /admin/health)"

echo "── Пользователь с выданным доступом ──────────────────"
GRANTED_LOGIN=$(echo "$USERS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["items"][0]["login"])')
login "$GRANTED_LOGIN" "$USER_PASSWORD"
check "видит объект по явному ACL" "200" "$(code GET "/objects/$FOLDER_ID")"
OBJ2=$(req GET "/objects/$FOLDER_ID")
check "уровень доступа edit" "edit" "$(echo "$OBJ2" | jq_ 'd["level"]')"
check "не может делиться (нужен manage)" "403" "$(code POST "/objects/$FOLDER_ID/access" \
  '{"grants":[{"principal":{"type":"everyone","id":"*"},"level":"view"}]}')"

echo "── Администрирование и здоровье ──────────────────────"
login "$ADMIN_LOGIN" "$ADMIN_PASSWORD"
HEALTH=$(req GET /admin/health)
check "здоровье: postgres" "ok" "$(echo "$HEALTH" | jq_ "[c['status'] for c in d['components'] if c['name']=='postgres'][0]")"
check "здоровье: redis" "ok" "$(echo "$HEALTH" | jq_ "[c['status'] for c in d['components'] if c['name']=='redis'][0]")"
check "здоровье: meilisearch" "ok" "$(echo "$HEALTH" | jq_ "[c['status'] for c in d['components'] if c['name']=='meilisearch'][0]")"
check "здоровье: хранилище" "ok" "$(echo "$HEALTH" | jq_ "[c['status'] for c in d['components'] if c['name']=='storage'][0]")"
check "outbox без отставания" "yes" "$(echo "$HEALTH" | jq_ "'yes' if d['outbox']['pending'] < 50 else 'no'")"

AUDIT=$(req GET '/admin/audit?limit=5')
check "аудит непустой" "yes" "$([ "$(echo "$AUDIT" | jq_ 'len(d["items"])')" -gt 0 ] && echo yes || echo no)"
check "аудит содержит вход" "yes" "$(req GET '/admin/audit?action=user.login&limit=1' | jq_ "'yes' if d['items'] else 'no'")"

echo "── Оргструктура ──────────────────────────────────────"
UNITS=$(req GET /org/units)
check "подразделений 22" "22" "$(echo "$UNITS" | jq_ 'len(d["items"])')"
check "у комитета есть руководитель" "yes" \
  "$(echo "$UNITS" | jq_ "'yes' if [u for u in d['items'] if u['code']=='HQ'][0]['head'] else 'no'")"

echo "── Поиск ─────────────────────────────────────────────"
sleep 2
S=$(curl -s -G --data-urlencode 'q=Документы проверки' "$BASE/search" -b "$JAR")
check "поиск находит папку" "yes" "$(echo "$S" | jq_ "'yes' if any(h['objectId']=='$FOLDER_ID' for h in d['hits']) else 'no'")"

echo "── Корзина и восстановление ──────────────────────────"
check "объект в корзину" "200" "$(code DELETE "/objects/$SUB_ID")"
check "из корзины не читается" "404" "$(code GET "/objects/$SUB_ID")"
TRASH=$(req GET /trash)
check "объект в корзине" "yes" "$(echo "$TRASH" | jq_ "'yes' if any(i['id']=='$SUB_ID' for i in d['items']) else 'no'")"
check "восстановление" "200" "$(code POST "/objects/$SUB_ID/restore")"
check "после восстановления читается" "200" "$(code GET "/objects/$SUB_ID")"

echo
echo "═══ Итог: успешно $PASS, ошибок $FAIL ═══"
[ "$FAIL" -eq 0 ]
