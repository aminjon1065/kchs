#!/bin/sh
# Alertmanager kchs (ADR-0147): конфигурация собирается из переменных окружения при
# каждом старте. Почта — через SMTP установки (тот же адрес, что у api и worker),
# получатели — ALERTMANAGER_EMAIL_TO; Telegram — если задан чат. Без получателей
# оповещения видны только в интерфейсе Alertmanager и в Prometheus.
set -eu

src=/etc/alertmanager-kchs
out="${ALERTMANAGER_CONFIG_DIR:-/tmp/alertmanager}"
mkdir -p "$out"

# Строка YAML в одинарных кавычках: кавычка внутри удваивается
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

# %XX в логине и пароле адреса SMTP (как их понимает nodemailer у api)
urldecode() {
  printf '%s' "$1" | awk '
    function hex(h,   i, n) {
      n = 0; h = toupper(h)
      for (i = 1; i <= 2; i++) n = n * 16 + index("0123456789ABCDEF", substr(h, i, 1)) - 1
      return n
    }
    {
      s = $0; r = ""
      while (match(s, /%[0-9A-Fa-f][0-9A-Fa-f]/)) {
        r = r substr(s, 1, RSTART - 1) sprintf("%c", hex(substr(s, RSTART + 1, 2)))
        s = substr(s, RSTART + 3)
      }
      printf "%s", r s
    }'
}

# ── SMTP: smtp[s]://[логин[:пароль]@]узел[:порт] ─────────────────────────────
url="${ALERTMANAGER_SMTP_URL:-smtp://mailpit:1025}"
scheme="${url%%://*}"
rest="${url#*://}"
rest="${rest%%/*}"
rest="${rest%%\?*}"
creds=""
hostport="$rest"
case "$rest" in
  *@*) creds="${rest%@*}"; hostport="${rest##*@}" ;;
esac
user=""
pass=""
if [ -n "$creds" ]; then
  user="$(urldecode "${creds%%:*}")"
  case "$creds" in *:*) pass="$(urldecode "${creds#*:}")" ;; esac
fi
host="${hostport%:*}"
port="${hostport##*:}"
if [ "$host" = "$hostport" ]; then
  port=""
fi
if [ -z "$port" ]; then
  if [ "$scheme" = smtps ]; then port=465; else port=25; fi
fi
# smtps — порт 465 с TLS сразу (так Alertmanager и работает); smtp с логином —
# STARTTLS обязателен, иначе пароль ушёл бы открытым; без логина — как есть
tls="${ALERTMANAGER_SMTP_REQUIRE_TLS:-}"
if [ -z "$tls" ]; then
  if [ "$scheme" = smtp ] && [ -n "$user" ]; then tls=true; else tls=false; fi
fi

email="${ALERTMANAGER_EMAIL_TO:-}"
telegram=""
if [ -n "${ALERTMANAGER_TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERTMANAGER_TELEGRAM_CHAT_ID:-}" ]; then
  telegram=yes
fi

# ── Название установки — в теме письма и первой строке сообщения ─────────────
name="${ALERTMANAGER_INSTALLATION:-Портал КЧС}"
printf '{{ define "kchs.installation" }}%s{{ end }}\n' \
  "$(printf '%s' "$name" | sed 's/{{/{ {/g; s/}}/} }/g')" > "$out/installation.tmpl"

config="$out/alertmanager.yml"
{
  echo "# Собрано $src/entrypoint.sh при старте контейнера — не править вручную"
  echo "global:"
  echo "  resolve_timeout: 5m"
  echo "  smtp_smarthost: $(q "$host:$port")"
  echo "  smtp_from: $(q "${ALERTMANAGER_SMTP_FROM:-Портал КЧС <no-reply@kchs.local>}")"
  echo "  smtp_require_tls: $tls"
  if [ -n "$user" ]; then
    echo "  smtp_auth_username: $(q "$user")"
    echo "  smtp_auth_password: $(q "$pass")"
  fi
  echo "templates:"
  echo "  - $src/templates/*.tmpl"
  echo "  - $out/installation.tmpl"
  echo "route:"
  echo "  receiver: kchs"
  echo "  group_by: [alertname, job]"
  echo "  group_wait: 30s"
  echo "  group_interval: 5m"
  echo "  repeat_interval: 4h"
  echo "inhibit_rules:"
  echo "  # Упал экземпляр — его предупреждения (задержки, память) не шлются отдельно"
  echo "  - source_matchers: ['severity=\"critical\"']"
  echo "    target_matchers: ['severity=\"warning\"']"
  echo "    equal: [instance]"
  echo "receivers:"
  echo "  - name: kchs"
  if [ -n "$email" ]; then
    echo "    email_configs:"
    echo "      - to: $(q "$email")"
    echo "        send_resolved: true"
    echo "        headers:"
    echo "          Subject: '{{ template \"kchs.subject\" . }}'"
    echo "        html: '{{ template \"kchs.html\" . }}'"
    echo "        text: '{{ template \"kchs.text\" . }}'"
  fi
  if [ -n "$telegram" ]; then
    echo "    telegram_configs:"
    echo "      - bot_token: $(q "$ALERTMANAGER_TELEGRAM_BOT_TOKEN")"
    echo "        chat_id: $ALERTMANAGER_TELEGRAM_CHAT_ID"
    if [ -n "${ALERTMANAGER_TELEGRAM_API_URL:-}" ]; then
      echo "        api_url: $(q "$ALERTMANAGER_TELEGRAM_API_URL")"
    fi
    echo "        send_resolved: true"
    echo "        parse_mode: ''"
    echo "        message: '{{ template \"kchs.telegram\" . }}'"
    echo "        http_config:"
    echo "          proxy_from_environment: true"
  fi
} > "$config"

if [ -z "$email" ] && [ -z "$telegram" ]; then
  echo "kchs: получатели оповещений не заданы (ALERTMANAGER_EMAIL_TO, ALERTMANAGER_TELEGRAM_CHAT_ID) — оповещения видны только в интерфейсе" >&2
fi

exec /bin/alertmanager \
  --config.file="$config" \
  --storage.path=/alertmanager \
  --web.external-url="${ALERTMANAGER_EXTERNAL_URL:-http://127.0.0.1:9093}" \
  "$@"
