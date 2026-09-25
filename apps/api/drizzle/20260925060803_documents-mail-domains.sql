ALTER TABLE "correspondents" ADD COLUMN "mail_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "correspondent_match" text;--> statement-breakpoint
CREATE INDEX "correspondents_mail_domains_idx" ON "correspondents" USING gin ("mail_domains");--> statement-breakpoint
-- Ручной хвост (ADR-0136): корреспондент прежних писем найден по адресу
UPDATE "mail_messages" SET "correspondent_match" = 'email' WHERE "correspondent_id" IS NOT NULL;
