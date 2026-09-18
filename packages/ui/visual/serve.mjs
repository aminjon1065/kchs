// Статический сервер собранного Storybook для визуальных тестов — без зависимостей.
// Запуск: node visual/serve.mjs <каталог> <порт>
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? 'storybook-static')
const port = Number(process.argv[3] ?? 6007)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  const file = path.resolve(root, relative)
  // Только файлы внутри каталога сборки
  if (!file.startsWith(root)) {
    response.writeHead(403).end()
    return
  }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file')
  } catch {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  })
  createReadStream(file).pipe(response)
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`storybook-static: http://127.0.0.1:${port}\n`)
})
