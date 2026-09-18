// Сборка api/worker и CLI `kchs` для образа.
//
// Пакеты монорепо (@kchs/contracts, fields, i18n) экспортируют исходники
// TypeScript, а код api импортирует модули через алиас `~/` — ни то, ни другое
// Node не исполнит после простого tsc. Поэтому esbuild собирает их в бандл
// (алиас берётся из tsconfig), а зависимости из npm остаются внешними и
// загружаются из node_modules образа.
import { readFileSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@kchs/'))

rmSync(new URL('dist', root), { recursive: true, force: true })

await build({
  absWorkingDir: new URL('.', root).pathname,
  entryPoints: { main: 'src/main.ts', kchs: 'src/cli/kchs.ts' },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external,
  tsconfig: 'tsconfig.json',
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
})
