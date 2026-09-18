-- Постановка заданий в транзакции (ADR-0036): входные данные и параметры BullMQ
-- хранятся в реестре до передачи в очередь после коммита.
-- emailed_at добавлен ручной миграцией 0002 и попал сюда только из-за отставшего снимка.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "options" jsonb DEFAULT '{}'::jsonb NOT NULL;
