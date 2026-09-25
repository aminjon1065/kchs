import '~/shared/config/load-env.js'
import './quiet.js'
import { parseArgs } from 'node:util'
import { ZodError } from 'zod'
import { seedCommand } from '~/seed/command.js'
import { formatRotation, rotateSecrets } from '~/shared/crypto/rotation.js'
import { closeDb, closeQueryRole } from '~/shared/db/client.js'
import { runMigrations } from '~/shared/db/migrate.js'
import { closeRedis } from '~/shared/redis/index.js'
import { formatSyncSummary, runBasemapsSync, runBasemapsUpload } from './basemaps.js'
import { formatInitSummary, runInit } from './init.js'
import { formatMailSync, runMailSync } from './mail.js'

const HELP = `kchs — служебные команды установки

  kchs init      миграции, системные роли, базовые справочники, первый администратор
                   --admin-login <логин>  (или KCHS_ADMIN_LOGIN; по умолчанию admin)
                   --admin-email <почта>  (или KCHS_ADMIN_EMAIL)
  kchs migrate   только миграции базы
  kchs seed      демо-данные: --profile demo|minimal; --reset --yes сначала удаляет данные;
                   --data small|demo — демо-датасеты генератора (нужны api, worker и engine);
                   --pack emergency|none — предметный пакет ЧС (демо-профиль ставит его сам)
  kchs basemaps upload <каталог> [--key <ключ>] [--no-register]
                 сборка infra/basemaps/build-pmtiles.sh → хранилище (шрифты, спрайты,
                   PMTiles, манифест), затем регистрация в реестре базовых карт
  kchs basemaps sync
                 реестр базовых карт по манифестам в хранилище и подложка по умолчанию
  kchs secrets rotate [--dry-run]
  kchs mail sync                  ящики сотрудников и канцелярии → почтовый сервер (ADR-0150)
                 перешифровать секреты текущим KCHS_MASTER_KEY; прежний ключ —
                   в KCHS_MASTER_KEY_PREVIOUS (порядок — infra/runbooks/secret-leak.md)
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
      data: { type: 'string', default: 'none' },
      pack: { type: 'string' },
      reset: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      key: { type: 'string' },
      'no-register': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
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
      const data = values.data === 'small' || values.data === 'demo' ? values.data : 'none'
      const result = await seedCommand({
        profile: values.profile === 'minimal' ? 'minimal' : 'demo',
        reset: values.reset,
        data,
        ...(values.pack === 'emergency' || values.pack === 'none' ? { pack: values.pack } : {}),
      })
      process.stdout.write(
        result.units === 0
          ? 'Демо-данные уже загружены — пропуск\n'
          : `Демо-данные загружены: пользователей ${result.users}, подразделений ${result.units}, пространств ${result.spaces}\n`,
      )
      if (result.datasets) {
        process.stdout.write(
          `Демо-датасеты: ${result.datasets.datasets} (новых ${result.datasets.created}), строк загружено ${result.datasets.rows}\n`,
        )
      }
      if (result.pack) {
        process.stdout.write(
          `Пакет ЧС: датасетов ${result.pack.datasets}, дашбордов ${result.pack.dashboards}, новых страниц регламентов ${result.pack.pages}\n`,
        )
      }
      return 0
    }
    case 'basemaps': {
      const action = positionals[1]
      if (action === 'upload' && positionals[2]) {
        const { upload, sync } = await runBasemapsUpload(positionals[2], {
          key: values.key,
          register: !values['no-register'],
          log: (line) => process.stdout.write(`  ${line}\n`),
        })
        process.stdout.write(
          `Базовые карты загружены: ${upload.builds.map((build) => `${build.key} ${build.version}`).join(', ') || 'сборок нет'}\n`,
        )
        if (sync) process.stdout.write(formatSyncSummary(sync))
        return 0
      }
      if (action === 'sync') {
        process.stdout.write(`Реестр базовых карт\n${formatSyncSummary(await runBasemapsSync())}`)
        return 0
      }
      process.stderr.write(`kchs basemaps upload <каталог> | sync\n\n${HELP}`)
      return 2
    }
    case 'secrets': {
      if (positionals[1] !== 'rotate') {
        process.stderr.write(`kchs secrets rotate [--dry-run]\n\n${HELP}`)
        return 2
      }
      const dryRun = values['dry-run']
      const report = await rotateSecrets({ dryRun })
      process.stdout.write(formatRotation(report, dryRun))
      return report.some((line) => line.unreadable > 0) ? 1 : 0
    }
    case 'mail': {
      if (positionals[1] !== 'sync') {
        process.stderr.write(`kchs mail sync\n\n${HELP}`)
        return 2
      }
      await runMigrations()
      process.stdout.write(formatMailSync(await runMailSync()))
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
