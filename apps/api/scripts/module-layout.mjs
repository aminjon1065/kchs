#!/usr/bin/env node
/**
 * Устройство модуля (ADR-0210): у каждого `src/modules/<модуль>/` есть регистрация
 * `module.ts` и логика в `domain/`; публичный вход `public.ts` — когда модуль нужен
 * другим; маршруты — `http.ts` или `http/`; адаптеры внешних систем и физического
 * хранения — `infra/`. Других каталогов верхнего уровня нет: новый модуль сразу получает
 * общий вид.
 *
 *   node scripts/module-layout.mjs     проверка (часть `pnpm deps:check`)
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULES = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src/modules')

/** Каталоги верхнего уровня модуля и зачем они. */
const DIRECTORIES = {
  domain: 'сервисы, инварианты и запросы к своим таблицам',
  http: 'маршруты, когда их больше одного файла',
  infra: 'адаптеры внешних систем и физическое хранение',
  providers: 'поставщики внешнего сервиса за портом модуля (ИИ)',
}
const REQUIRED = ['module.ts', 'domain']

const problems = []
const names = readdirSync(MODULES).filter((name) =>
  statSync(path.join(MODULES, name)).isDirectory(),
)
for (const name of names) {
  const dir = path.join(MODULES, name)
  const entries = readdirSync(dir)
  for (const required of REQUIRED) {
    if (!entries.includes(required)) problems.push(`${name}: нет ${required}`)
  }
  for (const entry of entries) {
    if (statSync(path.join(dir, entry)).isDirectory() && !(entry in DIRECTORIES)) {
      problems.push(
        `${name}: каталог ${entry}/ вне шаблона (${Object.keys(DIRECTORIES).join(', ')})`,
      )
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`✘ устройство модулей (ADR-0210):\n  ${problems.join('\n  ')}\n`)
  process.exit(1)
}
process.stdout.write(`✔ модули устроены по шаблону (${names.length} модулей)\n`)
