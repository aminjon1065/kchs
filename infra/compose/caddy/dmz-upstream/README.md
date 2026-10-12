# Транспорт шлюза DMZ до установки

Каталог монтируется в шлюз как `/etc/caddy/upstream`; файлы `*.caddy` отсюда
вставляются в блок `reverse_proxy` шлюза (`infra/compose/caddy/dmz.Caddyfile`,
ADR-0200). Пустой каталог — транспорт по умолчанию: HTTP или HTTPS с публичным
центром сертификации.

Свой центр сертификации внутреннего контура — положите рядом `ca.pem` и файл
`transport.caddy`:

```caddyfile
transport http {
	tls_trust_pool file /etc/caddy/upstream/ca.pem
}
```
