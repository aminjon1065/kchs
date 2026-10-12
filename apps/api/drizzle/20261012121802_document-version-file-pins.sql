ALTER TABLE "document_versions" ADD COLUMN "file_versions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- ADR-0197: версия документа закреплена за версиями файлов. Прежние версии получают
-- текущие версии своих файлов — то, что карточка показывала до этой миграции; с этой
-- минуты содержимое версии документа неизменно.
UPDATE "document_versions" dv
   SET "file_versions" = coalesce((
     SELECT jsonb_object_agg(f.id::text, f.current_version_id::text)
       FROM "files" f
      WHERE f.current_version_id IS NOT NULL
        AND (f.id = dv.main_file_id OR f.id = dv.pdf_file_id OR dv.attachments ? f.id::text)
   ), '{}'::jsonb);
