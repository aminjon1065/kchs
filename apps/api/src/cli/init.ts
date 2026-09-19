import { AdminUserCreateInput } from '@kchs/contracts'
import { bootstrapPlatform } from '~/bootstrap.js'
import { seedFixedHolidays } from '~/kernel/business-calendar/service.js'
import { BasemapService, type BasemapSyncSummary } from '~/modules/gis/public.js'
import { UserService } from '~/modules/identity/public.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { runMigrations } from '~/shared/db/migrate.js'

export interface InitOptions {
  adminLogin: string
  adminEmail?: string | null
  adminLastName?: string
  adminFirstName?: string
  /** Для тестов: «сегодня», от которого считаются годы календаря. */
  now?: Date
}

export interface InitSummary {
  migrations: string[]
  roles: number
  searchIndex: boolean
  calendar: Array<{ year: number; added: number }>
  /** Реестр базовых карт: «без подложки» и сборки PMTiles из хранилища (ADR-0066). */
  basemaps: BasemapSyncSummary
  admin: {
    login: string
    created: boolean
    /** Временный пароль — только при создании, выводится один раз. */
    temporaryPassword: string | null
    /** Уже существующие администраторы, если нового не создавали. */
    existing: string[]
  }
  baseUrl: string
}

const AdminInput = AdminUserCreateInput.pick({ login: true, email: true })

/**
 * `kchs init` — первичная настройка установки (15-admin-operations.md,
 * 06-handoff.md): миграции, системные роли и поисковый индекс, базовые
 * справочники (производственный календарь РТ на текущий и следующий год),
 * реестр базовых карт, первый администратор. Идемпотентна: повторный запуск
 * ничего не ломает и администратора не пересоздаёт.
 */
export async function runInit(options: InitOptions): Promise<InitSummary> {
  const admin = AdminInput.parse({ login: options.adminLogin, email: options.adminEmail ?? null })

  const { applied } = await runMigrations()
  const { roles, searchIndex } = await bootstrapPlatform()

  const year = (options.now ?? new Date()).getFullYear()
  const calendar = await db().transaction((tx) => seedFixedHolidays(tx, [year, year + 1]))
  const basemaps = await BasemapService.sync(systemCtx('kchs-init'))

  const existing = await UserService.activeSystemAdminLogins()

  let created = false
  let temporaryPassword: string | null = null
  if (existing.length === 0) {
    // Пароль генерируется временным: при первом входе администратор задаёт свой
    const result = await db().transaction((tx) =>
      UserService.create(tx, systemCtx('kchs-init'), {
        login: admin.login,
        email: admin.email ?? null,
        lastName: options.adminLastName ?? 'Администратор',
        firstName: options.adminFirstName ?? 'Системный',
        roleKeys: ['system_admin'],
        mustChangePassword: true,
        locale: 'ru',
        timezone: config().TZ,
      }),
    )
    created = true
    temporaryPassword = result.temporaryPassword
  }

  return {
    migrations: applied,
    roles,
    searchIndex,
    calendar,
    basemaps,
    admin: {
      login: created ? admin.login : (existing[0] ?? admin.login),
      created,
      temporaryPassword,
      existing,
    },
    baseUrl: config().KCHS_BASE_URL,
  }
}

/** Сводка для терминала: что сделано и как войти. */
export function formatInitSummary(summary: InitSummary): string {
  const lines = ['kchs init — готово', '']
  lines.push(
    summary.migrations.length > 0
      ? `  Миграции: применено ${summary.migrations.length}`
      : '  Миграции: изменений нет',
  )
  lines.push(`  Системные роли: ${summary.roles}`)
  lines.push(
    `  Поисковый индекс: ${summary.searchIndex ? 'готов' : 'недоступен — проверьте Meilisearch'}`,
  )
  lines.push(
    `  Производственный календарь РТ: ${summary.calendar
      .map((entry) => `${entry.year} — добавлено праздничных дней: ${entry.added}`)
      .join('; ')}`,
    '    Иди Рамазон, Иди Қурбон и переносы выходных объявляет Правительство — они вносятся отдельно.',
  )
  lines.push(`  Базовая карта по умолчанию: ${summary.basemaps.defaultName ?? '—'}`)
  if (summary.basemaps.defaultKind === 'none') {
    lines.push(
      '    Векторной подложки нет: infra/basemaps/build-pmtiles.sh (15-admin-operations.md §5).',
    )
  }
  if (summary.admin.created) {
    lines.push(
      `  Администратор: ${summary.admin.login} — создан`,
      `    Временный пароль: ${summary.admin.temporaryPassword ?? '—'}`,
      '    Показывается один раз; при первом входе потребуется задать свой пароль.',
    )
  } else {
    lines.push(
      `  Администратор: уже есть (${summary.admin.existing.join(', ')}) — новый не создавался`,
    )
  }
  lines.push('', `  Вход: ${summary.baseUrl}`, '')
  return lines.join('\n')
}
