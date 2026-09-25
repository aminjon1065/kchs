-- Гриф «Секретно» снят (ADR-0142, вопрос N10): гостайна обрабатывается только в аттестованных
-- системах. Объекты, документы, типы и допуски с ним получают самый строгий из оставшихся —
-- «Конфиденциально»: доступ не расширяется. Ранг таких объектов в поиске обновит переиндексация,
-- задание ставится, только если они были.
INSERT INTO "jobs" ("id", "queue", "name", "status", "message")
SELECT gen_random_uuid(), 'index', 'search.reindex', 'queued',
       'Гриф «Секретно» снят (ADR-0142): переиндексация поиска'
 WHERE EXISTS (SELECT 1 FROM "objects" WHERE "confidentiality" = 'secret');--> statement-breakpoint
UPDATE "objects" SET "confidentiality" = 'confidential' WHERE "confidentiality" = 'secret';--> statement-breakpoint
UPDATE "documents" SET "confidentiality" = 'confidential' WHERE "confidentiality" = 'secret';--> statement-breakpoint
UPDATE "document_types"
   SET "confidentiality_allowed" = ARRAY(
         SELECT l.level
           FROM unnest(ARRAY['public', 'internal', 'confidential']) WITH ORDINALITY AS l(level, ord)
          WHERE l.level = ANY ("confidentiality_allowed")
             OR (l.level = 'confidential' AND 'secret' = ANY ("confidentiality_allowed"))
          ORDER BY l.ord)
 WHERE 'secret' = ANY ("confidentiality_allowed");--> statement-breakpoint
UPDATE "document_types" SET "default_confidentiality" = 'confidential'
 WHERE "default_confidentiality" = 'secret';--> statement-breakpoint
UPDATE "users" SET "attributes" = jsonb_set("attributes", '{clearance}', '"confidential"')
 WHERE "attributes"->>'clearance' = 'secret';--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_confidentiality_check";--> statement-breakpoint
ALTER TABLE "objects" DROP CONSTRAINT "objects_confidentiality_check";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_confidentiality_check" CHECK ("documents"."confidentiality" in ('public', 'internal', 'confidential'));--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_confidentiality_check" CHECK ("objects"."confidentiality" in ('public', 'internal', 'confidential'));