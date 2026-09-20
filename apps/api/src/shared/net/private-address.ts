import { BlockList, isIP } from 'node:net'

/**
 * Служебные адреса, закрытые для исходящих запросов платформы (17-security.md
 * §5): «этот узел», loopback, link-local (метаданные облака) и multicast.
 * Частные сети (10/8, 172.16/12, 192.168/16) открыты: серверы тайлов и базы
 * закрытого контура обычно в них — за них отвечает отдельная проверка вызова.
 */
const denied = new BlockList()
denied.addSubnet('0.0.0.0', 8, 'ipv4')
denied.addSubnet('127.0.0.0', 8, 'ipv4')
denied.addSubnet('169.254.0.0', 16, 'ipv4')
denied.addSubnet('224.0.0.0', 3, 'ipv4')
denied.addAddress('::', 'ipv6')
denied.addAddress('::1', 'ipv6')
denied.addSubnet('fe80::', 10, 'ipv6')
denied.addSubnet('ff00::', 8, 'ipv6')

/** Адрес закрыт; IPv4 в IPv6 (`::ffff:a.b.c.d`) проверяется как IPv4. */
export function deniedAddress(address: string, allowLoopback = false): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  const ip = mapped?.[1] ?? address
  const family = isIP(ip)
  if (family === 0) return true
  if (allowLoopback && (ip === '::1' || ip.startsWith('127.'))) return false
  return denied.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}
