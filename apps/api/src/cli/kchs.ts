import '~/shared/config/load-env.js'
import './quiet.js'
import { parseArgs } from 'node:util'
import { ZodError } from 'zod'
import { seedCommand } from '~/seed/command.js'
import { closeDb, closeQueryRole } from '~/shared/db/client.js'
import { runMigrations } from '~/shared/db/migrate.js'
import { closeRedis } from '~/shared/redis/index.js'
import { formatInitSummary, runInit } from './init.js'

const HELP = `kchs — служебные команды установки

  kchs init      миграции, системные роли, базовые справочники, первый администратор
                   --admin-login <логин>  (или KCHS_ADMIN_LOGIN; по умолчанию admin)
                   --admin-email <почта>  (или KCHS_ADMIN_EMAIL)
  kchs migrate   только миграции базы
  kchs seed      демо-данные: --profile demo|minimal; --reset --yes сначала удаляет данные
  kchs help      эта справка

  --verbose      показывать журнал выполнения
`

async function run(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'admin-login': { type: 'string' },
      'admin-email': { type: 'string' },
      profile: { type: 'string', default: 'demo' },
      reset: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const command = values.help ? 'help' : (positionals[0] ?? 'help')

  switch (command) {
    case 'init': {
      const summary = await runInit({
        adminLogin: values['admin-login'] || process.env.KCHS_ADMIN_LOGIN || 'admin',
        adminEmail: values['admin-email'] || process.env.KCHS_ADMIN_EMAIL || null,
      })
      process.stdout.write(formatInitSummary(summary))
      return 0
    }
    case 'migrate': {
      const { applied } = await runMigrations()
      process.stdout.write(
        applied.length > 0
          ? `Миграции применены: ${applied.join(', ')}\n`
          : 'Миграции: изменений нет\n',
      )
      return 0
    }
    case 'seed': {
      if (values.reset && !values.yes) {
        process.stderr.write('--reset удаляет все данные: подтвердите флагом --yes\n')
        return 2
      }
      const result = await seedCommand({
        profile: values.profile === 'minimal' ? 'minimal' : 'demo',
        reset: values.reset,
      })
      process.stdout.write(
        result.units === 0
          ? 'Демо-данные уже загружены — пропуск\n'
          : `Демо-данные загружены: пользователей ${result.users}, подразделений ${result.units}, пространств ${result.spaces}\n`,
      )
      return 0
    }
    case 'help':
      process.stdout.write(HELP)
      return 0
    default:
      process.stderr.write(`Неизвестная команда: ${command}\n\n${HELP}`)
      return 2
  }
}

async function shutdown(): Promise<void> {
  await closeRedis().catch(() => undefined)
  await closeQueryRole().catch(() => undefined)
  await closeDb().catch(() => undefined)
}

run(process.argv.slice(2))
  .then(async (code) => {
    await shutdown()
    process.exit(code)
  })
  .catch(async (error: unknown) => {
    const message =
      error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        : error instanceof Error
          ? error.message
          : String(error)
    process.stderr.write(`Ошибка: ${message}\n`)
    await shutdown()
    process.exit(1)
  })
