# 0024. Монорепо pnpm + Turborepo; Biome + dependency-cruiser; локали ru/tg/en
Статус: Принято. Дата: 2026-09-17

## Контекст
Общие контракты и пакеты между web, api и engine; необходимость проверки границ модулей; три языка интерфейса.

## Решение
pnpm workspaces + Turborepo; Biome для формата/линта; dependency-cruiser для границ; knip для мёртвого кода; i18next + ICU с ключами `module.screen.element`, `ru` основной, `tg`/`en` с fallback.

## Альтернативы
Nx (тяжелее); ESLint+Prettier (допустимая альтернатива при потребности в специфичных правилах); FormatJS.

## Последствия
Быстрые проверки; единая конфигурация; словари как часть DoD.
