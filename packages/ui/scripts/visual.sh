#!/usr/bin/env bash
# Визуальные снимки и доступность дизайн-системы в Linux-образе Playwright.
# Снимки снимаются в той же среде, что и в CI: шрифты и сглаживание совпадают.
#
#   pnpm --filter @kchs/ui test:visual                   # сверка со снимками
#   pnpm --filter @kchs/ui test:visual:update            # обновить снимки
#   pnpm --filter @kchs/ui test:visual -- -g "Кнопки"    # часть историй
set -euo pipefail

UI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "${UI_DIR}/../.." && pwd)"

VERSION="$(node -p "require('${UI_DIR}/node_modules/@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${VERSION}-noble"

# Storybook собирается на хосте: статическая сборка не зависит от платформы,
# а в контейнере нужны только JS-зависимости Playwright и axe
(cd "${UI_DIR}" && pnpm exec storybook build --output-dir storybook-static --quiet)

# Репозиторий монтируется целиком: node_modules pnpm — символические ссылки в корень
docker run --rm --ipc=host \
  -v "${ROOT}:/repo" \
  -w /repo/packages/ui \
  -e CI="${CI:-}" \
  "${IMAGE}" \
  node node_modules/@playwright/test/cli.js test "$@"
