/** Скачивание по подписанной ссылке: имя файла задаёт сервер. */
export function saveLink(result: { url: string; name: string }): void {
  const link = window.document.createElement('a')
  link.href = result.url
  link.download = result.name
  link.rel = 'noopener'
  window.document.body.appendChild(link)
  link.click()
  link.remove()
}
