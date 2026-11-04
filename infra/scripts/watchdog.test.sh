#!/usr/bin/env bash
# Проверка сторожа (infra/scripts/watchdog.sh, ADR-0227) с поддельным API Telegram:
# беды находятся, одно и то же сообщение не повторяется, прошедшая беда даёт «снова в
# порядке». Docker не нужен: проект с несуществующим именем — служб нет.
#
#   bash infra/scripts/watchdog.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kchs-watchdog-test.XXXXXX")"
trap 'kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# Поддельный Telegram: каждое тело POST — строкой в файл
cat >"$WORK/fake-telegram.py" <<'PY'
import http.server, socketserver, sys, urllib.parse
out = sys.argv[1]
class S(http.server.HTTPServer):
    # Без обратного запроса DNS (getfqdn): на части машин он висит секундами
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0))).decode()
        fields = urllib.parse.parse_qs(body)
        with open(out, 'a') as f:
            f.write(self.path.split('/')[1] + '|' + fields['chat_id'][0] + '|' + fields['text'][0].replace('\n', ' ') + '\n')
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
s = S(('127.0.0.1', 0), H)
print(s.server_port, flush=True)
s.serve_forever()
PY
python3 "$WORK/fake-telegram.py" "$WORK/sent.txt" >"$WORK/port" &
SERVER=$!
for _ in $(seq 1 100); do [[ -s "$WORK/port" ]] && break; sleep 0.1; done
PORT="$(cat "$WORK/port")"
[[ -n "$PORT" ]] || { echo "watchdog.test: поддельный Telegram не запустился" >&2; exit 1; }

mkdir -p "$WORK/backup"
# Последняя копия — 30 часов назад
python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=30)).strftime("%Y-%m-%dT%H:%M:%SZ"))' >"$WORK/backup/last-success"
cat >"$WORK/env" <<EOF
TELEGRAM_BOT_TOKEN=test-token
KCHS_ALERT_TELEGRAM_CHAT=42
TELEGRAM_API_URL=http://127.0.0.1:$PORT
API_PORT=1
KCHS_BACKUP_DIR=$WORK/backup
KCHS_PILOT_PROJECT=kchs-watchdog-test-none
KCHS_WATCHDOG_STATE=$WORK/state
EOF

run() { KCHS_PILOT_ENV_FILE="$WORK/env" bash "$ROOT/infra/scripts/watchdog.sh" "$@" >>"$WORK/log" 2>&1; }
sent() { [[ -f "$WORK/sent.txt" ]] && wc -l <"$WORK/sent.txt" | tr -d ' ' || echo 0; }
fail() { printf 'watchdog.test: %s\n' "$*" >&2; cat "$WORK/log" >&2; cat "$WORK/sent.txt" >&2 2>/dev/null; exit 1; }

# 1. Диск (порог 1 %), устаревшая копия, api не отвечает — три сообщения
KCHS_WATCHDOG_DISK_PCT=1 run
[[ "$(sent)" -ge 3 ]] || fail "ожидалось не меньше трёх сообщений, отправлено $(sent)"
grep -q 'bottest-token|42|' "$WORK/sent.txt" || fail "сообщение ушло не тем ботом или не в тот чат"
grep -q 'последняя удачная копия — 30 ч назад' "$WORK/sent.txt" || fail "нет сообщения о копии"
grep -q 'api не отвечает' "$WORK/sent.txt" || fail "нет сообщения об api"
grep -q 'диск .* занят' "$WORK/sent.txt" || fail "нет сообщения о диске"
first="$(sent)"

# 2. Те же беды сразу же — повторов нет
KCHS_WATCHDOG_DISK_PCT=1 run
[[ "$(sent)" == "$first" ]] || fail "повтор того же сообщения раньше часа"

# 3. Копия свежая, диск в порядке — «снова в порядке» о двух бедах; api по-прежнему лежит
date -u +%Y-%m-%dT%H:%M:%SZ >"$WORK/backup/last-success"
KCHS_WATCHDOG_DISK_PCT=100 run
[[ "$(grep -c 'снова в порядке' "$WORK/sent.txt")" -ge 2 ]] || fail "нет сообщений «снова в порядке»"
grep 'снова в порядке' "$WORK/sent.txt" | grep -q 'api не отвечает' && fail "api ещё лежит, а пришло «в порядке»"

# 4. --dry-run ничего не отправляет
before="$(sent)"
rm -rf "$WORK/state"
KCHS_WATCHDOG_DISK_PCT=1 run --dry-run
[[ "$(sent)" == "$before" ]] || fail "--dry-run отправил сообщение"
grep -q '\[dry-run\] Telegram' "$WORK/log" || fail "--dry-run не показал сообщения"

echo "watchdog.test: ок ($(sent) сообщений поддельному Telegram)"
