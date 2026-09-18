-- Сессия загрузки хранит идентификаторы файла и версии, выданные клиенту и вписанные в ключ хранения
ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "planned_file_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "planned_version_id" uuid;