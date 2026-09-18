"""Импорт файлов в датасеты (06-analytics-engine.md §2, ADR-0046).

`analyze` — анализ головы файла для мастера импорта (синхронный маршрут
`POST /data/analyze`); `normalize` — весь файл в нормализованный CSV и CSV
ошибок (задание `imports:dataset.normalize`). Чтение файлов — `readers`,
общая разметка и локаль — `profile`, значения — `values`, геометрия —
`geometry`, ключи полей — `keys`.
"""
