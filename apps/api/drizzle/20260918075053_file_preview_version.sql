-- Превью привязаны к версии файла: при новой версии старые заменяются (P0-E11 S03)
ALTER TABLE "file_previews" ADD COLUMN IF NOT EXISTS "version_id" uuid;
